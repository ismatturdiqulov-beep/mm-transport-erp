-- Блок «Ангрен Каолин» — миграция 1: основа (2026-11-26).
--
-- Отдельный независимый модуль учёта перевозок по контракту с заводом ANGREN KAOLIN.
-- Живёт в той же базе, что и mm_transport, ТОЛЬКО ради общего входа (решение
-- владельца 2026-11-26: один логин на обе вкладки). Всё остальное раздельно:
--   * свои таблицы с префиксом ak_ — ни одна таблица mm_transport не читается и не
--     пишется отсюда, и наоборот; ни одного внешнего ключа на таблицы mm_transport;
--   * свой список допуска ak_members — к блоку пускает только он, а не profiles/
--     companies mm_transport (профиль mm_transport не даёт доступа к блоку, и
--     наоборот: член блока без профиля mm_transport не видит mm_transport);
--   * свой журнал изменений ak_audit_log (заполняется триггером, обойти из браузера
--     нельзя) и запрет удаления: ничего не удаляется, только архивируется.
--
-- Реальные данные (перевозчики, ИНН, реквизиты, директора) сюда НЕ кладутся —
-- репозиторий публичный. Они заливаются отдельным SQL из Angren_kaolin/ (в .gitignore).
--
-- Деньги везде — bigint в минимальных единицах (тийин / цент) + явная валюта.

-- ============================================================
-- Допуск
-- ============================================================
create table ak_members (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  role         text not null check (role in ('owner', 'partner')),
  partner_key  text check (partner_key in ('ismat', 'sarvar')),  -- чья доля / касса
  display_name text not null,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

create or replace function ak_role()
returns text
language sql stable security definer
set search_path = public
as $$
  select role from ak_members where user_id = auth.uid() and active
$$;

create or replace function ak_can_read()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists(select 1 from ak_members where user_id = auth.uid() and active)
$$;

create or replace function ak_is_owner()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists(select 1 from ak_members where user_id = auth.uid() and active and role = 'owner')
$$;

grant execute on function ak_role(), ak_can_read(), ak_is_owner() to authenticated;

alter table ak_members enable row level security;
-- Каждый видит свою строку (чтобы страница узнала «кто я»); участники блока видят
-- друг друга (имена нужны в журнале «кто изменил»). Записи в ak_members из браузера
-- нет: участников добавляют SQL-ом.
create policy ak_members_read on ak_members for select to authenticated
  using (user_id = auth.uid() or ak_can_read());

-- ============================================================
-- Нормализация госномеров: «10V560 РА» и «10V560РА» — одна машина. Кириллические
-- буквы-двойники → латиница, пробелы/дефисы/точки убираются, верхний регистр.
-- ============================================================
create or replace function ak_norm_plate(p text)
returns text
language sql immutable
as $$
  select translate(
    regexp_replace(upper(coalesce(p, '')), '[\s\-\.]', '', 'g'),
    'АВЕКМНОРСТУХ',
    'ABEKMHOPCTYX'
  )
$$;

-- ============================================================
-- Справочники
-- ============================================================
create table ak_carriers (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  inn                text,
  phone              text,
  contact_person     text,
  accountant_phone   text,
  director_name      text,                 -- обычно пусто: в заявке подчёркивания
  contract_no        text,
  contract_date      date,
  contract_status    text not null default 'none' check (contract_status in ('signed', 'none', 'expired')),
  pay_timing         text not null default 'after_loading' check (pay_timing in ('advance', 'after_loading', 'after_delivery')),
  pay_method         text not null default 'transfer' check (pay_method in ('transfer', 'cash')),
  pay_days           integer not null default 5 check (pay_days >= 0),  -- рабочих дней
  price_fixed_uzs    boolean not null default false,  -- цена фиксируется в сумах, а не в $
  is_own             boolean not null default false,  -- собственные машины MM
  notes              text,
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  created_by         uuid default auth.uid(),
  updated_at         timestamptz not null default now(),
  updated_by         uuid default auth.uid()
);
create unique index ak_carriers_inn_uniq on ak_carriers (inn) where inn is not null and inn <> '';

create table ak_vehicles (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('tractor', 'trailer')),
  plate       text not null,
  plate_norm  text generated always as (ak_norm_plate(plate)) stored,
  notes       text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);
create unique index ak_vehicles_plate_uniq on ak_vehicles (plate_norm);

-- Машина → фирма с даты. Заявка берёт фирму, действующую на дату погрузки.
create table ak_vehicle_owners (
  id          uuid primary key default gen_random_uuid(),
  vehicle_id  uuid not null references ak_vehicles(id),
  carrier_id  uuid not null references ak_carriers(id),
  valid_from  date not null,
  notes       text,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid(),
  unique (vehicle_id, valid_from)
);

create or replace function ak_vehicle_owner_on(p_vehicle uuid, p_date date)
returns uuid
language sql stable
as $$
  select carrier_id from ak_vehicle_owners
  where vehicle_id = p_vehicle and valid_from <= p_date
  order by valid_from desc limit 1
$$;

create table ak_routes (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  kind                 text not null check (kind in ('international', 'local')),
  unload_address       text,
  import_customs_code  text,
  import_customs       text,   -- название и адрес поста растаможки импорта
  export_customs       text not null default 'г. Ангрен',
  default_price_minor  bigint check (default_price_minor >= 0),  -- подсказка, не обязательна
  default_price_cur    text check (default_price_cur in ('UZS', 'USD')),
  notes                text,
  active               boolean not null default true,
  created_at           timestamptz not null default now(),
  created_by           uuid default auth.uid(),
  updated_at           timestamptz not null default now(),
  updated_by           uuid default auth.uid()
);
create unique index ak_routes_name_uniq on ak_routes (lower(name));

-- Директора для заявок. Смена директора = новая запись с датой; выпущенные заявки
-- хранят ФИО у себя и не меняются.
create table ak_directors (
  id             uuid primary key default gen_random_uuid(),
  party          text not null check (party in ('factory', 'mm')),
  position       text not null check (position in ('director', 'deputy')),
  full_name      text not null,  -- «Иванов И.И.»
  name_genitive  text not null,  -- «Иванова И.И.» (в лице Директора …)
  valid_from     date not null,
  created_at     timestamptz not null default now(),
  created_by     uuid default auth.uid(),
  updated_at     timestamptz not null default now(),
  updated_by     uuid default auth.uid()
);

-- Кошельки. В каждом только его валюта; у наличных есть держатель.
create table ak_wallets (
  id          text primary key,  -- стабильный slug: rs, cash_uzs_ismat, …
  name        text not null,
  kind        text not null check (kind in ('bank', 'cash')),
  currency    text not null check (currency in ('UZS', 'USD')),
  holder      text check (holder in ('ismat', 'sarvar')),
  sort_order  integer not null default 0,
  active      boolean not null default true,
  check ((kind = 'cash') = (holder is not null))
);

insert into ak_wallets (id, name, kind, currency, holder, sort_order) values
  ('rs',              'Расчётный счёт (сум)',   'bank', 'UZS', null,     1),
  ('cash_uzs_ismat',  'Касса сум — у Исмата',   'cash', 'UZS', 'ismat',  2),
  ('cash_uzs_sarvar', 'Касса сум — у Сарвара',  'cash', 'UZS', 'sarvar', 3),
  ('cash_usd_ismat',  'Касса USD — у Исмата',   'cash', 'USD', 'ismat',  4),
  ('cash_usd_sarvar', 'Касса USD — у Сарвара',  'cash', 'USD', 'sarvar', 5);

-- Стартовые остатки (расчёты в блоке начинаются с нуля — Исмат вводит их вручную).
-- Знак: положительная сумма всегда «в нашу пользу или наше имущество» для wallet /
-- factory_debt; для долгов MM — положительная = MM должна.
--   wallet          — остаток кошелька (wallet_id), ≥ 0
--   factory_debt    — завод должен MM
--   carrier_debt    — MM должна перевозчику (carrier_id); минус = перевозчик должен MM (аванс/переплата)
--   oformlenie_debt — MM должна заводу оформление
--   partner_share   — расчёт с партнёром по доле: плюс = проект должен партнёру, минус = партнёр взял авансом
--   partner_help    — финансовая помощь: проект должен партнёру (в валюте внесения)
create table ak_opening_balances (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('wallet', 'factory_debt', 'carrier_debt', 'oformlenie_debt', 'partner_share', 'partner_help')),
  wallet_id     text references ak_wallets(id),
  carrier_id    uuid references ak_carriers(id),
  partner_key   text check (partner_key in ('ismat', 'sarvar')),
  amount_minor  bigint not null,
  currency      text not null check (currency in ('UZS', 'USD')),
  note          text,
  archived      boolean not null default false,  -- вместо удаления
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid(),
  updated_at    timestamptz not null default now(),
  updated_by    uuid default auth.uid(),
  check ((kind = 'wallet') = (wallet_id is not null)),
  check ((kind = 'carrier_debt') = (carrier_id is not null)),
  check ((kind in ('partner_share', 'partner_help')) = (partner_key is not null)),
  check (kind <> 'wallet' or amount_minor >= 0)
);

-- Валюта кошелька и валюта остатка обязаны совпадать.
create or replace function ak_opening_check_currency()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.wallet_id is not null and new.currency <> (select currency from ak_wallets where id = new.wallet_id) then
    raise exception 'Валюта остатка (%) не совпадает с валютой кошелька', new.currency;
  end if;
  return new;
end $$;

create trigger ak_opening_currency before insert or update on ak_opening_balances
  for each row execute function ak_opening_check_currency();

-- Зафиксированные стартовые остатки (ak_settings 'opening'.locked = true) не меняются.
-- Разблокировать может только владелец, сменив флаг — это видно в журнале.
create or replace function ak_opening_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce((select (value ->> 'locked')::boolean from ak_settings where key = 'opening'), false) then
    raise exception 'Стартовые остатки зафиксированы — изменения запрещены';
  end if;
  return new;
end $$;

create trigger ak_opening_guard before insert or update on ak_opening_balances
  for each row execute function ak_opening_guard();

-- Настройки и постоянные тексты заявок (реквизиты сторон, контакт погрузки, дата
-- стартовых остатков и т. п.). key → jsonb.
create table ak_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);

-- ============================================================
-- Журнал изменений: кто, когда, было → стало, причина.
-- Причину браузер передаёт заголовком x-ak-reason (encodeURIComponent).
-- ============================================================
create table ak_audit_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  user_id     uuid,
  table_name  text not null,
  row_id      text,
  action      text not null check (action in ('insert', 'update', 'delete')),
  old_data    jsonb,
  new_data    jsonb,
  reason      text
);
create index ak_audit_log_row on ak_audit_log (table_name, row_id);

create or replace function ak_audit()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_reason text;
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
begin
  if tg_op = 'UPDATE' and v_old - 'updated_at' - 'updated_by' = v_new - 'updated_at' - 'updated_by' then
    return new;  -- ничего по сути не поменялось
  end if;
  begin
    v_reason := current_setting('request.headers', true)::json ->> 'x-ak-reason';
  exception when others then
    v_reason := null;
  end;
  insert into ak_audit_log (user_id, table_name, row_id, action, old_data, new_data, reason)
  values (auth.uid(), tg_table_name, coalesce(v_new, v_old) ->> coalesce(nullif(tg_argv[0], ''), 'id'),
          lower(tg_op), v_old, v_new, v_reason);
  return coalesce(new, old);
end $$;

create or replace function ak_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['ak_carriers', 'ak_vehicles', 'ak_vehicle_owners', 'ak_routes',
                           'ak_directors', 'ak_opening_balances', 'ak_settings'] loop
    execute format('create trigger ak_touch before update on %I for each row execute function ak_touch()', t);
  end loop;
  foreach t in array array['ak_carriers', 'ak_vehicles', 'ak_vehicle_owners', 'ak_routes',
                           'ak_directors', 'ak_wallets', 'ak_opening_balances'] loop
    execute format('create trigger ak_audit after insert or update or delete on %I for each row execute function ak_audit()', t);
  end loop;
  execute 'create trigger ak_audit after insert or update or delete on ak_settings for each row execute function ak_audit(''key'')';
  execute 'create trigger ak_audit after insert or update or delete on ak_members for each row execute function ak_audit(''user_id'')';
end $$;

-- ============================================================
-- RLS. Читать — любой активный участник блока (владелец и партнёр).
-- Писать — только владелец блока. Удалять — никто (нет политики delete):
-- записи архивируются флагом active/archived.
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array['ak_carriers', 'ak_vehicles', 'ak_vehicle_owners', 'ak_routes',
                           'ak_directors', 'ak_wallets', 'ak_opening_balances', 'ak_settings'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy ak_read on %I for select to authenticated using (ak_can_read())', t);
    execute format('create policy ak_insert on %I for insert to authenticated with check (ak_is_owner())', t);
    execute format('create policy ak_update on %I for update to authenticated using (ak_is_owner()) with check (ak_is_owner())', t);
  end loop;
end $$;

alter table ak_audit_log enable row level security;
create policy ak_read on ak_audit_log for select to authenticated using (ak_can_read());
-- вставка только триггером ak_audit (security definer), из браузера — никак.

-- Анонимам блок недоступен вовсе (RLS и так не пускает, отзываем и права).
do $$
declare t text;
begin
  foreach t in array array['ak_members', 'ak_carriers', 'ak_vehicles', 'ak_vehicle_owners', 'ak_routes',
                           'ak_directors', 'ak_wallets', 'ak_opening_balances', 'ak_settings', 'ak_audit_log'] loop
    execute format('revoke all on %I from anon', t);
    execute format('revoke delete, truncate on %I from authenticated', t);
  end loop;
end $$;
