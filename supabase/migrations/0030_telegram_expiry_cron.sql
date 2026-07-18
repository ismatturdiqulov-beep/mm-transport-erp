-- MM Transport ERP — миграция 30: планировщик проверки истекающих сроков (этап 3 бота)
-- (2026-07-20). Раз в день вызывает Edge Function telegram-expiry-check, которая
-- проверяет ТИР/Дозвол на руках, договоры аренды и документы водителей — и шлёт
-- Telegram-напоминания в контрольных точках (10/5/3/1/0 дней до истечения).
--
-- Секрет (CRON_SECRET) и service_role ключ, нужные для вызова функции, хранятся
-- в Supabase Vault (supabase_vault, уже установлен) — НЕ в этом файле, чтобы не
-- закоммитить чувствительные значения в git. Сама запись секретов в vault сделана
-- отдельной разовой командой (см. историю сессии 2026-07-20), эта миграция только
-- ссылается на них по имени.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

select cron.schedule(
  'telegram-expiry-check-daily',
  '0 5 * * *', -- каждый день в 05:00 UTC (09:00 по Ташкенту)
  $$
  select net.http_post(
    url := 'https://otzerelogdbinclmalyp.supabase.co/functions/v1/telegram-expiry-check',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
