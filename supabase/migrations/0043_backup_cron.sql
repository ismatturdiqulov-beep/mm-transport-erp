-- MM Transport ERP — миграция 43: расписание ежедневного бэкапа (2026-08-10).
-- Два независимых задания: сам бэкап рано утром, и отдельная проверка-"сторож"
-- днём того же дня — если бы job'а с бэкапом вообще не сработала (например
-- pg_cron сам сломался), сторож всё равно заметит по backup_log, что успешного
-- запуска давно не было, и предупредит отдельно (см. db-backup ?mode=check).
select cron.schedule(
  'db-backup-daily',
  '0 2 * * *', -- каждый день в 02:00 UTC (06:00 по Ташкенту)
  $$
  select net.http_post(
    url := 'https://otzerelogdbinclmalyp.supabase.co/functions/v1/db-backup?mode=run',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);

select cron.schedule(
  'db-backup-watchdog',
  '0 14 * * *', -- каждый день в 14:00 UTC (18:00 по Ташкенту) — через 12 часов после бэкапа
  $$
  select net.http_post(
    url := 'https://otzerelogdbinclmalyp.supabase.co/functions/v1/db-backup?mode=check',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
