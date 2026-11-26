-- Блок «Ангрен Каолин» — миграция 2: ежедневный бэкап (2026-11-26).
--
-- Отдельно от бэкапа mm_transport (db-backup): своя функция ak-backup, свой журнал,
-- своя папка на Яндекс Диске (app:/angren/). Список таблиц берётся из базы
-- (все ak_*), поэтому таблицы следующих этапов попадут в бэкап автоматически.

create table ak_backup_log (
  id         uuid primary key default gen_random_uuid(),
  run_at     timestamptz not null default now(),
  status     text not null check (status in ('success', 'error')),
  file_name  text,
  detail     text
);
create index ak_backup_log_run_at on ak_backup_log (run_at desc);
alter table ak_backup_log enable row level security;
-- Из браузера не читается и не пишется: только service_role (функция бэкапа).
revoke all on ak_backup_log from anon, authenticated;

-- Таблицы блока для бэкапа. Только service_role.
create or replace function ak_backup_tables()
returns setof text
language sql stable security definer
set search_path = public
as $$
  select tablename::text from pg_tables
  where schemaname = 'public' and tablename like 'ak\_%' and tablename <> 'ak_backup_log'
  order by tablename
$$;
revoke execute on function ak_backup_tables() from public, anon, authenticated;
grant execute on function ak_backup_tables() to service_role;

-- 02:30 UTC (06:30 Ташкент) — через полчаса после бэкапа mm_transport, чтобы не
-- нагружать базу одновременно. Сторож — 14:30 UTC (18:30 Ташкент).
select cron.schedule(
  'ak-backup-daily',
  '30 2 * * *',
  $$
  select net.http_post(
    url := 'https://otzerelogdbinclmalyp.supabase.co/functions/v1/ak-backup?mode=run',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

select cron.schedule(
  'ak-backup-watchdog',
  '30 14 * * *',
  $$
  select net.http_post(
    url := 'https://otzerelogdbinclmalyp.supabase.co/functions/v1/ak-backup?mode=check',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
