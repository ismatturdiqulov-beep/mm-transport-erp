-- MM Transport ERP — миграция 2: поля, которых не было в MM_Transport_TZ_Schema_v1.md,
-- но которые реально используются в mm_transport_v24 (7).html.
--
-- Зачем этот файл отдельно от 0001_init.sql: 0001 — это буквально схема из ТЗ.
-- При сверке ТЗ с реальным кодом (см. saveTransport/saveKontragent/saveTrip/saveMaintenance
-- и т.д. в mm_transport_v24 (7).html) обнаружились поля, которые ТЗ не описывает, но которые
-- содержат реальные данные пользователя (позывной машины, баланс арендатора, состав ТО,
-- доверенности/труд.договоры как отдельные разделы меню и т.п.). Без этих колонок скрипт
-- экспорта данных (scripts/migrate-data.mjs) терял бы часть данных при переносе в Postgres.
-- Все изменения — только ADD COLUMN / CREATE TABLE, ничего из 0001 не меняется и не удаляется.

-- ============================================================
-- transport: позывной, владелец/аренда, ответственный, техпаспорт,
-- начало договора аренды, произвольные документы (цвет/двигатель/вес/тех.осмотр/ОСАГО и т.д.)
-- ============================================================
alter table transport
  add column callsign          text,
  add column owner             text,   -- 'ММ' | 'Аренда' (кто владеет/арендует)
  add column resp_kontragent_id uuid references kontragenty(id),
  add column techpass          text,
  add column contract_start    date,
  add column docs              jsonb;  -- {color,fuel,eng,weight,tp,lic,svid,tech,dopog,osago[]}
create index idx_transport_resp on transport(resp_kontragent_id);

-- ============================================================
-- fleet: позывной единицы ПС, план начислений, текущий баланс (та самая цифра
-- долга/переплаты, которую показывает дашборд "Топ должников"), история операций
-- ============================================================
alter table fleet
  add column driver_id   uuid references people(id),  -- кто фактически едет (fleet.driverId в приложении)
  add column label       text,
  add column plan        numeric,
  add column plan_type   text,
  add column contract_end date,   -- срок договора аренды этой ед. ПС (свой, отдельно от kontragenty.contract_end)
  add column balance     numeric not null default 0,
  add column ops         jsonb;   -- история операций по ед. ПС (addFleetOp), если использовалась
create index idx_fleet_driver on fleet(driver_id);

-- ============================================================
-- maintenance: статус ремонта, состав работ построчно, простой, интервал ТО, кошелёк списания
-- (next_planned_km уже есть в 0001 — это nextMileage из формы)
-- ============================================================
alter table maintenance
  add column status      text,
  add column items       jsonb,   -- построчный состав работ/запчастей с ценами и валютой
  add column downtime    numeric,
  add column interval_km numeric,
  add column next_date   date,
  add column wallet      text;

-- ============================================================
-- tirs / dozv: в приложении поле "person" — это денормализованное имя (ФИО водителя
-- или наименование арендатора), а не ссылка. person_id заполняется миграцией по совпадению
-- имени с people.name/kontragenty.name, но совпадение не всегда однозначно (омонимы,
-- служебные значения вроде "(Рейс)") — поэтому исходный текст сохраняем как факт.
-- ============================================================
alter table tirs add column person_name text;
alter table dozv add column person_name text;

-- ============================================================
-- kassa_wallets: ТЗ не описывает иконку и признак активности кошелька, а в приложении
-- скрытые/неактивные кошельки (KASSA_WALLETS[].active) — рабочий сценарий, не мусор.
-- ============================================================
alter table kassa_wallets
  add column icon   text,
  add column active boolean not null default true;

-- ============================================================
-- trip_payments: в приложении оплата привязана к конкретному плечу (legIdx) и к тому,
-- от кого пришли деньги (fromId) — ТЗ этого не описывает, но терять эту привязку
-- при переносе финансовых данных недопустимо.
-- ============================================================
alter table trip_payments
  add column leg_id            uuid references trip_legs(id),
  add column from_kontragent_id uuid references kontragenty(id);
create index idx_trip_payments_leg on trip_payments(leg_id);
create index idx_trip_payments_from on trip_payments(from_kontragent_id);

-- ============================================================
-- trip_surcharges: приложение различает начисление и скидку (type: 'discount' | иное)
-- отдельно от категории (cat: downtime/delay/damage/other)
-- ============================================================
alter table trip_surcharges
  add column kind text,  -- 'charge' | 'discount' (исходное поле "type" в приложении)
  add column date date;

-- ============================================================
-- waybills: реальная форма путёвки — направление, номер, тягач/прицеп, два водителя,
-- срок в днях. ТЗ описывает только trip_id/type/issued_date/note, чего недостаточно
-- (у путёвки в приложении часто вообще нет trip_id — путёвки не привязывались к рейсам).
-- ============================================================
alter table waybills
  add column dir     text,   -- направление (в рейс / из рейса и т.п.)
  add column num     int,
  add column truck   text,
  add column trailer text,
  add column drv1    text,
  add column drv2    text,
  add column days    int;

-- ============================================================
-- poa (доверенности) и labor (трудовые договоры) — разделы меню "Документооборот" в
-- приложении, которых нет в MM_Transport_TZ_Schema_v1.md вообще. Добавлены по факту
-- использования (saveLabor/savePoa), чтобы не терять эти данные при переносе.
-- ============================================================
create table poa (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id),
  num        text,
  date       date,
  name       text,
  passport   text,
  expires    date,
  hired      text,
  created_at timestamptz not null default now()
);
create index idx_poa_company on poa(company_id);

create table labor (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id),
  num        text,
  name       text,
  days       text,
  date       date,
  passport   text,
  address    text,
  created_at timestamptz not null default now()
);
create index idx_labor_company on labor(company_id);

alter table poa   enable row level security;
alter table labor enable row level security;
create policy service_role_all on poa   for all to service_role using (true) with check (true);
create policy service_role_all on labor for all to service_role using (true) with check (true);
