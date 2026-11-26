-- Блок «Ангрен Каолин» — миграция 7 (2026-11-26): ежедневная загрузка курса ЦБ.
-- 04:00 UTC = 09:00 по Ташкенту (ЦБ к этому времени уже опубликовал курс дня);
-- функция заодно дозагружает пропущенные дни за последние 10 дней.
select cron.schedule(
  'ak-fx-daily',
  '0 4 * * *',
  $$
  select net.http_post(
    url := 'https://otzerelogdbinclmalyp.supabase.co/functions/v1/ak-fx',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
