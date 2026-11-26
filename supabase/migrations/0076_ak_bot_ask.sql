-- Блок «Ангрен Каолин» — миграция 26 (2026-11-26): вопросы боту в личке («сколько перевозок
-- на Ишимбай за ноябрь»). Claude пишет SELECT, бот выполняет его через ak_bot_query.
-- Защита (тройная):
--   1) функция принадлежит роли ak_reader: у неё есть только SELECT на таблицы/представления ak_*
--      (без ak_settings — там печать, ak_members, ak_backup_log, ak_counters); к таблицам
--      mm_transport, auth, vault доступа нет;
--   2) транзакция переводится в режим «только чтение» — никакая запись невозможна, даже через
--      SECURITY DEFINER функции;
--   3) JWT-claims очищаются — ak_is_owner()/ak_can_read() внутри запроса возвращают false.
-- Вызывать может только service_role (бот).

create role ak_reader nologin;
grant ak_reader to postgres;
grant usage on schema public to ak_reader;

do $$
declare r record;
begin
  for r in select c.relname, c.relkind, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname like 'ak\_%' and c.relkind in ('r', 'v')
             and c.relname not in ('ak_settings', 'ak_members', 'ak_backup_log', 'ak_counters')
  loop
    execute format('grant select on %I to ak_reader', r.relname);
    if r.relkind = 'r' and r.relrowsecurity then
      execute format('create policy ak_reader_select on %I for select to ak_reader using (true)', r.relname);
    end if;
  end loop;
end $$;

grant execute on function ak_summary_core(date, date) to ak_reader;
grant execute on function ak_partners_core(date) to ak_reader;

create or replace function ak_bot_query(q text) returns jsonb
language plpgsql security definer
set search_path = public
set statement_timeout = '8s'
as $$
declare res jsonb; qq text := regexp_replace(q, ';\s*$', '');
begin
  perform set_config('transaction_read_only', 'on', true);
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('request.jwt.claim.role', '', true);
  if qq ~ ';' then raise exception 'только один запрос SELECT'; end if;
  execute format('select coalesce(jsonb_agg(x), ''[]''::jsonb) from (select * from (%s) s limit 200) x', qq) into res;
  return res;
end $$;

grant create on schema public to ak_reader;   -- нужно только на момент смены владельца
alter function ak_bot_query(text) owner to ak_reader;
revoke create on schema public from ak_reader;
revoke all on function ak_bot_query(text) from public, anon, authenticated;
grant execute on function ak_bot_query(text) to service_role;
