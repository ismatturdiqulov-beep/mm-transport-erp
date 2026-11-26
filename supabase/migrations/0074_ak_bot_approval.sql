-- Блок «Ангрен Каолин» — миграция 24 (2026-11-26): одобрение на сайте того, что записал бот.
-- Решение владельца: заявки и лоты, созданные или заполненные через Telegram-бота (даже
-- после «✅ Верно» в группе), остаются помеченными «из бота — ждёт одобрения», пока Исмат
-- не одобрит их на сайте.

alter table ak_requests add column bot_pending boolean not null default false,
                        add column bot_approved_by uuid, add column bot_approved_at timestamptz;
alter table ak_trips    add column bot_pending boolean not null default false,
                        add column bot_approved_by uuid, add column bot_approved_at timestamptz;

-- Одобрить заявку вместе с её лотами из бота (или один лот).
create or replace function ak_bot_approve(p_request_id uuid, p_trip_id uuid default null)
returns integer
language plpgsql security definer
set search_path = public
as $$
declare n integer := 0; k integer;
begin
  if not exists (select 1 from ak_members where user_id = auth.uid() and active and role = 'owner') then
    raise exception 'Одобряет только владелец';
  end if;
  if p_trip_id is not null then
    update ak_trips set bot_pending = false, bot_approved_by = auth.uid(), bot_approved_at = now() where id = p_trip_id and bot_pending;
    get diagnostics n = row_count;
    return n;
  end if;
  update ak_requests set bot_pending = false, bot_approved_by = auth.uid(), bot_approved_at = now() where id = p_request_id and bot_pending;
  get diagnostics k = row_count; n := n + k;
  update ak_trips set bot_pending = false, bot_approved_by = auth.uid(), bot_approved_at = now() where request_id = p_request_id and bot_pending;
  get diagnostics k = row_count; n := n + k;
  return n;
end $$;
grant execute on function ak_bot_approve(uuid, uuid) to authenticated;
revoke execute on function ak_bot_approve(uuid, uuid) from anon;
