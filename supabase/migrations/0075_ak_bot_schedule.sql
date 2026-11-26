-- Блок «Ангрен Каолин» — миграция 25 (2026-11-26): расписание бота (этап 5, часть 3).
--   09:00 (04:00 UTC) — утро: вопрос по машинам вчерашней погрузки «загрузилась / не
--     приехала / заменена» (ответить может Исмат или Сарвар, кто ответил — записывается);
--     напоминания о кошельке (3 дня без ответа — расход как оплаченный лично автором);
--     подтверждение месячных / квартальных отчётов кнопками и напоминание о налоге.
--   21:00 (16:00 UTC) — ежедневный отчёт в «Расчёты».

alter table ak_trips add column load_asked_at timestamptz,
                     add column load_answer text check (load_answer in ('loaded', 'failed', 'replaced')),
                     add column load_answer_by text;
alter table ak_periods add column last_reminded date;

select cron.schedule('ak-bot-morning', '0 4 * * *', $$
  select net.http_post(url := 'https://otzerelogdbinclmalyp.supabase.co/functions/v1/ak-bot?mode=morning',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 120000);
$$);
select cron.schedule('ak-bot-evening', '0 16 * * *', $$
  select net.http_post(url := 'https://otzerelogdbinclmalyp.supabase.co/functions/v1/ak-bot?mode=evening',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 120000);
$$);
