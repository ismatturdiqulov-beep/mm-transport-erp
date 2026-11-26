-- Блок «Ангрен Каолин» — миграция 17 (2026-11-26): номера без кнопки «Выпустить».
--
-- Решение владельца:
--   * номер заявки завода присваивается сразу при создании заявки;
--   * номер заявки перевозчику — лоту, как только в него поставили машину; при замене
--     машины номер остаётся за лотом (машина/перевозчик меняются с историей — ТЗ);
--   * лот с машиной считается погруженным сам (дата погрузки = дата заявки);
--     вручную отмечаются только исключения — «не состоялся».
-- Номера по-прежнему не переиспользуются; отменённая заявка остаётся со своим номером.
create or replace function ak_requests_before()
returns trigger
language plpgsql
set search_path = public
as $$
declare v_route_kind text;
begin
  -- номер — сразу при создании
  if tg_op = 'INSERT' and new.number is null and new.status <> 'cancelled' then
    new.number := ak_next_number('factory', new.loading_date);
    new.status := 'issued';
    new.issued_on := coalesce(new.issued_on, current_date);
  end if;
  -- тип заявки всегда берётся из маршрута
  if tg_op = 'INSERT' or new.route_id is distinct from old.route_id then
    select kind into v_route_kind from ak_routes where id = new.route_id;
    new.kind := v_route_kind;
  end if;
  if new.kind = 'local' then
    new.price_cur := 'UZS';
    new.fx_rate := null;
    new.oformlenie_minor := 0;
  elsif new.fx_rate is null then
    new.fx_rate := ak_cbu_rate(new.loading_date);
    if new.fx_rate is null then
      raise exception 'Нет курса ЦБ на %: загрузите курс или укажите вручную', to_char(new.loading_date, 'DD.MM.YYYY');
    end if;
  end if;
  new.price_uzs_minor := case when new.price_minor is null then 0
                              when new.price_cur = 'USD' then round(new.price_minor * new.fx_rate) else new.price_minor end;
  if tg_op = 'UPDATE' and old.status = 'issued' and new.status = 'issued' and
     (old.trucks_confirmed, old.price_minor, old.price_cur, old.fx_rate, old.oformlenie_minor, old.loading_date, old.route_id)
     is distinct from
     (new.trucks_confirmed, new.price_minor, new.price_cur, new.fx_rate, new.oformlenie_minor, new.loading_date, new.route_id) then
    insert into ak_request_versions (request_id, version, snapshot) values (old.id, old.version, to_jsonb(old));
    new.version := old.version + 1;
  end if;
  if tg_op = 'UPDATE' and old.number is not null and new.number is distinct from old.number then
    raise exception 'Номер выпущенной заявки менять нельзя';
  end if;
  return new;
end $$;

create or replace function ak_trips_before()
returns trigger
language plpgsql
set search_path = public
as $$
declare r ak_requests;
begin
  select * into r from ak_requests where id = new.request_id;
  if new.price_cur = 'USD' and new.fx_rate is null then new.fx_rate := r.fx_rate; end if;
  if r.kind = 'local' and new.price_cur = 'USD' then
    raise exception 'Местный рейс: цена перевозчику только в сумах';
  end if;
  new.price_uzs_minor := case
    when new.price_minor is null then null
    when new.price_cur = 'USD' then round(new.price_minor * new.fx_rate)
    else new.price_minor end;
  if r.kind <> 'local' then new.vat_included := false; end if;
  -- лот с машиной считается погруженным сам
  if new.tractor_id is not null and new.status = 'assigned' then new.status := 'loaded'; end if;
  if new.status = 'loaded' and new.loaded_on is null then new.loaded_on := r.loading_date; end if;
  -- номер заявки перевозчику — как только в лоте появилась машина; остаётся за лотом
  if new.tractor_id is not null and new.number is null and new.status not in ('cancelled') and r.status <> 'cancelled' then
    new.number := ak_next_number('carrier', r.loading_date);
    new.issued_on := coalesce(new.issued_on, current_date);
  end if;
  if new.status = 'failed' and new.failed_on is null then new.failed_on := current_date; end if;
  if new.status is distinct from (case when tg_op = 'UPDATE' then old.status end) then
    new.status_by := coalesce(auth.uid(), new.status_by);
  end if;
  if tg_op = 'UPDATE' and old.number is not null and new.number is distinct from old.number then
    raise exception 'Номер выпущенной заявки перевозчику менять нельзя';
  end if;
  return new;
end $$;

-- create or replace сбрасывает security definer — возвращаем (триггеры пишут версии
-- и берут номера из счётчика, куда браузеру писать нельзя).
alter function ak_requests_before() security definer;
alter function ak_trips_before() security definer;

-- уже созданные заявки и лоты — привести к новым правилам
update ak_requests set number = ak_next_number('factory', loading_date), status = 'issued', issued_on = coalesce(issued_on, current_date)
where number is null and status <> 'cancelled';
update ak_trips t set tractor_id = t.tractor_id
where t.tractor_id is not null and (t.number is null or t.status = 'assigned')
  and exists (select 1 from ak_requests r where r.id = t.request_id and r.status <> 'cancelled');
