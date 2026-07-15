-- MM Transport ERP — миграция 16: настройки, которые раньше жили только в
-- localStorage браузера (типы ТИР и их цены, цены на дозволы, страны/типы
-- дозволов, курсы валют, префикс/счётчик номеров рейсов, префиксы и
-- ответственные лица путёвок, покупные цены, реестры сдачи в АСМАП/Минтранс).
--
-- Проблема: у каждого сотрудника компании в своём браузере могли быть свои
-- значения этих настроек — не общие. Плюс TRIP_COUNTER.counters (следующий
-- номер рейса) нигде не сохранялся централизованно, что реально могло привести
-- к повторяющимся номерам рейсов при работе с разных браузеров/устройств.
--
-- Одна строка на компанию, произвольные JSONB-поля — это ровно те же объекты,
-- что раньше лежали в localStorage под ключами mm_tir_types/mm_doz_prices/...,
-- поэтому JS-код почти не меняется, меняется только откуда эти объекты
-- загружаются и куда сохраняются.
create table company_settings (
  company_id        uuid primary key references companies(id) on delete cascade,
  tir_types         jsonb not null default '[]',
  doz_prices        jsonb not null default '{}',
  doz_countries     jsonb not null default '[]',
  fx_rates          jsonb not null default '{}',
  trip_counter      jsonb not null default '{}',
  waybill_settings  jsonb not null default '{}',
  buy_prices        jsonb not null default '{}',
  asmaf_registries  jsonb not null default '[]',
  doz_registries    jsonb not null default '[]',
  updated_at        timestamptz not null default now()
);

alter table company_settings enable row level security;
create policy service_role_all on company_settings for all to service_role using (true) with check (true);
create policy company_scoped on company_settings for all to authenticated
  using (is_owner() or company_id = current_profile_company_id())
  with check (is_owner() or company_id = current_profile_company_id());
