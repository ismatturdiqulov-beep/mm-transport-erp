-- Блок «Ангрен Каолин» — миграция 14 (2026-11-26): лоты и «заполнено / не заполнено».
--
-- Решение владельца:
--   1) Заявка завода создаётся с одним обязательным: маршрут, дата, сколько машин.
--      Цену, оформление и прочее можно дописать потом (до тех пор заявка «жёлтая»).
--      → price_minor и oformlenie_minor могут быть пустыми (пусто ≠ 0: оформление 0 —
--        это осознанно «без оформления», пусто — «ещё не вписали»).
--   2) На каждую машину заявки сразу открывается лот (пустой рейс). Добавили машину
--      в заявку — добавился лот; убрали — закрывается пустой лот (статус 'cancelled');
--      заполненный лот сам не закрывается — только «не состоялся».

alter table ak_requests alter column price_minor drop not null;
alter table ak_requests alter column oformlenie_minor drop not null;
alter table ak_requests alter column oformlenie_minor drop default;

alter table ak_trips drop constraint ak_trips_status_check;
alter table ak_trips add constraint ak_trips_status_check
  check (status in ('assigned', 'loaded', 'delivered', 'failed', 'cancelled'));
comment on column ak_trips.status is 'assigned — назначен (лот), loaded — погружен, delivered — доставлен, failed — не состоялся, cancelled — лот закрыт (завод уменьшил число машин)';

-- MEGATRANSBRIDGE и др.: «цена в сумах» больше не по умолчанию (владелец: обычно в $).
update ak_carriers set price_fixed_uzs = false where price_fixed_uzs;

create or replace function ak_requests_before()
returns trigger
language plpgsql
set search_path = public
as $$
declare v_route_kind text;
begin
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

create or replace view ak_trip_calc with (security_invoker = true) as
with base as (
  select t.*, r.kind as req_kind, r.status as req_status, r.loading_date,
         (t.status in ('failed', 'cancelled') or r.status = 'cancelled') as dead,
         coalesce(t.fx_rate, r.fx_rate, ak_cbu_rate(current_date)) as rate
  from ak_trips t join ak_requests r on r.id = t.request_id
),
pay as (
  select trip_id, cur_in as cur, sum(amount_in_minor) as amt
  from ak_live_movements where kind = 'carrier_payment' and trip_id is not null group by trip_id, cur_in
),
ded as (
  select trip_id, currency as cur, sum(amount_minor) as amt
  from ak_trip_deductions where not cancelled group by trip_id, currency
)
select b.id as trip_id, b.request_id, b.carrier_id, b.status, b.req_kind, b.req_status, b.loading_date, b.dead,
       b.price_cur, b.rate,
       case when b.dead then 0 else coalesce(b.price_uzs_minor, 0) end as cost_uzs,
       case when b.dead or b.req_kind <> 'local' or not b.vat_included then 0
            else round(coalesce(b.price_uzs_minor, 0) * 1200 / 11200.0)::bigint end as vat_in_uzs,
       coalesce((select amt from pay where trip_id = b.id and cur = 'UZS'), 0) as paid_uzs,
       coalesce((select amt from pay where trip_id = b.id and cur = 'USD'), 0) as paid_usd,
       coalesce((select amt from ded where trip_id = b.id and cur = 'UZS'), 0) as ded_uzs,
       coalesce((select amt from ded where trip_id = b.id and cur = 'USD'), 0) as ded_usd,
       -- долг MM перед перевозчиком в валюте цены рейса (минус = перевозчик должен MM)
       case when b.price_minor is null and not b.dead then null else
         (case when b.dead then 0 else b.price_minor end)
         - coalesce(ak_conv((select amt from pay where trip_id = b.id and cur = 'UZS'), 'UZS', coalesce(b.price_cur, 'UZS'), b.rate), 0)
         - coalesce(ak_conv((select amt from pay where trip_id = b.id and cur = 'USD'), 'USD', coalesce(b.price_cur, 'UZS'), b.rate), 0)
         - coalesce(ak_conv((select amt from ded where trip_id = b.id and cur = 'UZS'), 'UZS', coalesce(b.price_cur, 'UZS'), b.rate), 0)
         - coalesce(ak_conv((select amt from ded where trip_id = b.id and cur = 'USD'), 'USD', coalesce(b.price_cur, 'UZS'), b.rate), 0)
       end as debt_minor
from base b;

-- Лоты: число действующих рейсов (не отменённых и не «не состоялся») = машин заказано.
create or replace function ak_request_slots()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_active integer;
  v_need integer;
  v_free integer;
begin
  if new.status = 'cancelled' then return new; end if;
  select count(*) into v_active from ak_trips where request_id = new.id and status not in ('cancelled', 'failed');
  v_need := coalesce(new.trucks_ordered, 0) - v_active;
  if v_need > 0 then
    insert into ak_trips (request_id, status) select new.id, 'assigned' from generate_series(1, v_need);
  elsif v_need < 0 then
    select count(*) into v_free from ak_trips t
    where t.request_id = new.id and t.status = 'assigned' and t.tractor_id is null and t.carrier_id is null
      and not exists (select 1 from ak_movements m where m.trip_id = t.id);
    if v_free < -v_need then
      raise exception 'Нельзя уменьшить до % машин: заполненных лотов больше. Отметьте лишние машины «не состоялся».', new.trucks_ordered;
    end if;
    update ak_trips set status = 'cancelled', notes = 'лот закрыт: завод уменьшил число машин'
    where id in (select t.id from ak_trips t
                 where t.request_id = new.id and t.status = 'assigned' and t.tractor_id is null and t.carrier_id is null
                   and not exists (select 1 from ak_movements m where m.trip_id = t.id)
                 order by t.created_at desc limit -v_need);
  end if;
  return new;
end $$;

create trigger ak_request_slots after insert or update of trucks_ordered, status on ak_requests
  for each row execute function ak_request_slots();
