-- MM Transport ERP — первая миграция Supabase
-- Источник: MM_Transport_TZ_Schema_v1.md (14.07.2026)
-- Создаёт схему из текущего localStorage-состояния (mm_transport_v24) как таблицы Postgres,
-- включает RLS на всех таблицах с единственной политикой "service_role" (логин появится в Фазе 2).

create extension if not exists "pgcrypto";

-- ============================================================
-- 1. companies (заготовка под SaaS, Фаза 4)
-- ============================================================
create table companies (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

-- ============================================================
-- 2. kontragenty
-- ============================================================
create table kontragenty (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid references companies(id),
  name          text not null,
  short         text,
  type          text check (type in ('tenant','driver_mm','client','service','other')),
  phone         text,
  passport      text,
  pinfl         text,
  active        boolean not null default true,
  contract_num  text,
  contract_date date,
  contract_end  date,
  note          text,
  created_at    timestamptz not null default now()
);
create index idx_kontragenty_company on kontragenty(company_id);

-- ============================================================
-- 3. people (водители)
-- ============================================================
create table people (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid references companies(id),
  kontragent_id uuid references kontragenty(id),
  name          text not null,
  short         text,
  pinfl         text,
  birth         date,
  phone         text,
  passport      text,
  address       text,
  active        boolean not null default true,
  note          text,
  created_at    timestamptz not null default now()
);
create index idx_people_company on people(company_id);
create index idx_people_kontragent on people(kontragent_id);

-- ============================================================
-- 4. person_docs (документы водителя — было docs[] внутри people)
-- ============================================================
create table person_docs (
  id         uuid primary key default gen_random_uuid(),
  person_id  uuid not null references people(id),
  doc_type   text,
  doc_number text,
  issued     date,
  expires    date,
  note       text
);
create index idx_person_docs_person on person_docs(person_id);

-- ============================================================
-- 5. transport (весь транспорт: тягачи, прицепы, легковой)
-- ============================================================
create table transport (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid references companies(id),
  type          text check (type in ('truck','trailer','other')),
  plate         text,
  brand         text,
  model         text,
  year          int,
  vin           text,
  osago_expires date,
  mileage       numeric,
  active        boolean not null default true,
  note          text,
  created_at    timestamptz not null default now()
);
create index idx_transport_company on transport(company_id);

-- ============================================================
-- 6. fleet (тягач+прицеп+контрагент)
-- ============================================================
create table fleet (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid references companies(id),
  kontragent_id uuid references kontragenty(id),
  truck_id      uuid references transport(id),
  trailer_id    uuid references transport(id),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create index idx_fleet_company on fleet(company_id);
create index idx_fleet_kontragent on fleet(kontragent_id);
create index idx_fleet_truck on fleet(truck_id);
create index idx_fleet_trailer on fleet(trailer_id);

-- ============================================================
-- 7. trips (рейсы)
-- ============================================================
create table trips (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid references companies(id),
  trip_num     text,                    -- MM-2026-0001
  type         text,
  status       text,                    -- 10 текущих статусов
  fleet_id     uuid references fleet(id),
  truck_id     uuid references transport(id),
  trailer_id   uuid references transport(id),
  driver_id    uuid references people(id),
  load_date    date,
  unload_date  date,
  km_start     numeric,
  km_end       numeric,
  fuel_start   numeric,
  fuel_end     numeric,
  adblue_start numeric,
  adblue_end   numeric,
  advance_paid numeric not null default 0,
  note         text,
  created_at   timestamptz not null default now()
);
create index idx_trips_company on trips(company_id);
create index idx_trips_fleet on trips(fleet_id);
create index idx_trips_driver on trips(driver_id);

-- ============================================================
-- 8. trip_legs (плечи рейса — было legs[] внутри trip)
-- ============================================================
create table trip_legs (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid not null references trips(id),
  leg_num     int,
  from_point  text,
  to_point    text,
  client_id   uuid references kontragenty(id),
  rate        numeric,
  rate_final  numeric,
  cargo       text,
  load_date   date,
  unload_date date
);
create index idx_trip_legs_trip on trip_legs(trip_id);

-- ============================================================
-- 9. trip_expenses (расходы в рейсе — было expenses[] внутри trip)
-- ============================================================
create table trip_expenses (
  id         uuid primary key default gen_random_uuid(),
  trip_id    uuid not null references trips(id),
  date       date,
  category   text,
  amount     numeric,
  currency   text,
  fx_rate    numeric,
  wallet     text,
  liters     numeric,
  note       text,
  source     text not null default 'manual' check (source in ('manual','telegram_bot')),
  created_at timestamptz not null default now()
);
create index idx_trip_expenses_trip on trip_expenses(trip_id);

-- ============================================================
-- 10. trip_payments (оплаты от заказчика — было payments[] внутри trip)
-- ============================================================
create table trip_payments (
  id      uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id),
  date    date,
  amount  numeric,
  method  text,
  note    text
);
create index idx_trip_payments_trip on trip_payments(trip_id);

-- ============================================================
-- 11. trip_surcharges (штрафы/доплаты, привязаны к плечу — v24)
-- ============================================================
create table trip_surcharges (
  id         uuid primary key default gen_random_uuid(),
  trip_id    uuid not null references trips(id),
  leg_id     uuid references trip_legs(id),
  category   text,                       -- TRIP_SURCHARGE_CATS
  amount     numeric,
  note       text,
  created_at timestamptz not null default now()
);
create index idx_trip_surcharges_trip on trip_surcharges(trip_id);
create index idx_trip_surcharges_leg on trip_surcharges(leg_id);

-- ============================================================
-- 12. tirs (ТИР карнеты)
-- ============================================================
create table tirs (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid references companies(id),
  num             text,
  type            text,
  received        date,
  expires         date,
  person_id       uuid references people(id),
  plate           text,
  transferred     date,
  returned_office date,
  returned_asmap  date,
  used            boolean,
  comp            numeric not null default 0,
  buy_price       numeric,
  trip_id         uuid references trips(id),
  note            text,
  created_at      timestamptz not null default now()
);
create index idx_tirs_company on tirs(company_id);
create index idx_tirs_person on tirs(person_id);
create index idx_tirs_trip on tirs(trip_id);

-- ============================================================
-- 13. dozv (дозволы)
-- ============================================================
create table dozv (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid references companies(id),
  country         text,
  kind            text,
  epermit         boolean,
  num             text,
  received        date,
  expires         date,
  issued          date,
  person_id       uuid references people(id),
  plate           text,
  fleet_id        uuid references fleet(id),
  returned_office date,
  returned_mt     date,
  used            boolean,
  comp            numeric not null default 0,
  buy_price       numeric,
  trip_id         uuid references trips(id),
  created_at      timestamptz not null default now()
);
create index idx_dozv_company on dozv(company_id);
create index idx_dozv_person on dozv(person_id);
create index idx_dozv_fleet on dozv(fleet_id);
create index idx_dozv_trip on dozv(trip_id);

-- ============================================================
-- 14. finance (начисления/оплаты по контрагентам)
-- ============================================================
create table finance (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid references companies(id),
  date          date,
  fleet_id      uuid references fleet(id),
  kontragent_id uuid references kontragenty(id),
  person_name   text,
  type          text check (type in ('charge','payment','vacation')),
  category      text,
  description   text,
  amount        numeric not null default 0,
  paid          numeric not null default 0,
  wallet        text,
  created_at    timestamptz not null default now()
);
create index idx_finance_company on finance(company_id);
create index idx_finance_fleet on finance(fleet_id);
create index idx_finance_kontragent on finance(kontragent_id);

-- ============================================================
-- 15. kassa (движения по кассе)
-- ============================================================
create table kassa (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid references companies(id),
  wallet      text,
  type        text check (type in ('income','expense','transfer','trip_payment','payout')),
  date        date,
  category    text,
  from_name   text,
  to_name     text,
  description text,
  amount      numeric,
  created_at  timestamptz not null default now()
);
create index idx_kassa_company on kassa(company_id);

-- ============================================================
-- 16. kassa_wallets (динамические кошельки)
-- ============================================================
create table kassa_wallets (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id),
  name       text,
  hidden     boolean not null default false,
  sort_order int
);
create index idx_kassa_wallets_company on kassa_wallets(company_id);

-- ============================================================
-- 17. maintenance (ТО и ремонты)
-- ============================================================
create table maintenance (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid references companies(id),
  transport_id           uuid references transport(id),
  date                   date,
  mileage                numeric,
  works                  jsonb,           -- комплекс работ, несколько позиций
  cost                   numeric,
  service_kontragent_id  uuid references kontragenty(id),
  next_planned_km        numeric,
  note                   text,
  created_at             timestamptz not null default now()
);
create index idx_maintenance_company on maintenance(company_id);
create index idx_maintenance_transport on maintenance(transport_id);

-- ============================================================
-- 18. waybills (путёвки/документооборот)
-- ============================================================
create table waybills (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid references companies(id),
  trip_id     uuid references trips(id),
  type        text,
  issued_date date,
  note        text
);
create index idx_waybills_company on waybills(company_id);
create index idx_waybills_trip on waybills(trip_id);

-- ============================================================
-- 19. telegram_links (привязка Telegram-аккаунта к контрагенту)
-- ============================================================
create table telegram_links (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid references companies(id),
  kontragent_id     uuid not null references kontragenty(id),
  telegram_user_id  bigint not null unique,
  telegram_username text,
  link_code         text,        -- одноразовый код для /start <код>
  linked_at         timestamptz,
  active            boolean not null default true
);
create index idx_telegram_links_company on telegram_links(company_id);
create index idx_telegram_links_kontragent on telegram_links(kontragent_id);

-- ============================================================
-- 20. driver_messages (инбокс расходов от водителей)
-- ============================================================
create table driver_messages (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid references companies(id),
  telegram_link_id      uuid references telegram_links(id),
  trip_id               uuid references trips(id),          -- если удалось определить активный рейс, иначе null
  message_text          text,
  photo_url             text,                                -- ссылка на фото чека (облачное хранилище)
  status                text not null default 'new' check (status in ('new','processed')),
  processed_expense_id  uuid references trip_expenses(id),   -- заполняется, когда диспетчер внёс расход
  processed_by          text,
  processed_at          timestamptz,
  created_at            timestamptz not null default now()
);
create index idx_driver_messages_company on driver_messages(company_id);
create index idx_driver_messages_link on driver_messages(telegram_link_id);
create index idx_driver_messages_status on driver_messages(status);

-- ============================================================
-- 21. notification_log (журнал отправленных уведомлений)
-- ============================================================
create table notification_log (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid references companies(id),
  telegram_link_id  uuid references telegram_links(id),
  event_type        text check (event_type in ('finance_charge','finance_payment','doc_issued','doc_returned','doc_expiring')),
  ref_table         text,        -- 'finance' | 'tirs' | 'dozv' | ...
  ref_id            uuid,
  message_text      text,
  sent_at           timestamptz not null default now(),
  delivery_status   text not null default 'sent' check (delivery_status in ('sent','failed'))
);
create index idx_notification_log_company on notification_log(company_id);
create index idx_notification_log_link on notification_log(telegram_link_id);

-- ============================================================
-- RLS: включаем на всех таблицах с первого дня.
-- Пока разрешено только service-role (бэкенд/скрипты миграции/Edge Functions).
-- Логин и политики для конечных пользователей появятся в Фазе 2.
-- ============================================================
do $$
declare
  t text;
begin
  for t in
    select unnest(array[
      'companies','kontragenty','people','person_docs','transport','fleet',
      'trips','trip_legs','trip_expenses','trip_payments','trip_surcharges',
      'tirs','dozv','finance','kassa','kassa_wallets','maintenance','waybills',
      'telegram_links','driver_messages','notification_log'
    ])
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy service_role_all on %I for all to service_role using (true) with check (true)',
      t
    );
  end loop;
end $$;
