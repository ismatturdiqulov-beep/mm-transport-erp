-- Блок «Ангрен Каолин» — миграция 8 (2026-11-26): выпуск заявки без подтверждения завода.
-- Менеджер завода подтверждает заявку ПОСЛЕ погрузки, поэтому номер присваивается по
-- факту погрузки (нужна хотя бы одна погруженная машина), а «подтверждено заводом»
-- вносится позже. Долг завода по-прежнему считается по подтверждённым машинам.
create or replace function ak_issue_request(p_id uuid)
returns text
language plpgsql security definer
set search_path = public
as $$
declare r ak_requests; t record;
begin
  if not ak_is_owner() then raise exception 'Нет прав'; end if;
  select * into r from ak_requests where id = p_id for update;
  if r.id is null then raise exception 'Заявка не найдена'; end if;
  if r.status = 'cancelled' then raise exception 'Заявка отменена'; end if;
  if not exists (select 1 from ak_trips where request_id = p_id and status in ('loaded', 'delivered')) then
    raise exception 'Нет погруженных машин: отметьте в рейсах статус «погружен»';
  end if;
  if r.number is null then
    update ak_requests set number = ak_next_number('factory', r.loading_date), status = 'issued',
      issued_on = coalesce(issued_on, current_date) where id = p_id;
  else
    update ak_requests set status = 'issued' where id = p_id;
  end if;
  for t in select id from ak_trips where request_id = p_id and status in ('loaded', 'delivered') and number is null
           order by created_at loop
    update ak_trips set number = ak_next_number('carrier', r.loading_date), issued_on = current_date where id = t.id;
  end loop;
  return (select number from ak_requests where id = p_id);
end $$;
