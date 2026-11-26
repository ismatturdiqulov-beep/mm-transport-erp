-- Блок «Ангрен Каолин» — миграция 4: этап 2 — курсы ЦБ, заявки завода, рейсы,
-- движения денег, доп. расходы (2026-11-26).
--
-- Принципы (ТЗ разделы 3–7):
--   * деньги — bigint в минимальных единицах (тийин / цент), курс — numeric(14,2) сум за $;
--     цент × курс = тийин (2150 $ = 215000 ц × 11975 = 2 574 625 000 тийин = 25 746 250 сум);
--   * движения денег пишутся ТОЛЬКО через функции ak_post_movement / ak_reverse_movement /
--     ak_confirm_movement — прямой insert/update/delete из браузера закрыт. Ошибочный
--     платёж не редактируется: отменяется встречной записью и вносится верный;
--   * «списано = получено + потери», иначе запись не сохраняется; курсовая разница
--     считается к курсу ЦБ на день операции, реальный курс сохраняется;
--   * комиссии банка добавляются сами: платёжное поручение с Р/С — 0,1% + 1 120 сум,
--     снятие наличных по чеку — 0,5%;
--   * отрицательный остаток кошелька запрещён;
--   * заявки и рейсы не удаляются — только статус «отменена» / «не состоялся».

-- ============================================================
-- Курсы ЦБ Узбекистана (сум за 1 $)
-- ============================================================
create table ak_fx_rates (
  rate_date   date primary key,
  usd_uzs     numeric(14, 2) not null check (usd_uzs > 0),
  source      text not null default 'cbu' check (source in ('cbu', 'manual')),
  fetched_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);

-- Курс на дату: последний известный на эту дату или раньше.
create or replace function ak_cbu_rate(p_date date)
returns numeric
language sql stable
as $$
  select usd_uzs from ak_fx_rates where rate_date <= p_date order by rate_date desc limit 1
$$;

-- ============================================================
-- Нумерация заявок. Два независимых счётчика: 'factory' (заявка завода — на
-- направление в день) и 'carrier' (заявка перевозчику — на каждую машину).
--   до 31.12.2026 — тест, прежний формат «партия-номер» (6-37, 6-81 …);
--   с 01.01.2027 — «квартал-номер-год» (1-1-2027), счётчик с единицы в каждом квартале.
-- Номера не переиспользуются.
-- ============================================================
create table ak_counters (
  series  text not null check (series in ('factory', 'carrier')),
  period  text not null,
  last    integer not null default 0,
  primary key (series, period)
);
-- Продолжение 6-й партии (по Excel: последние — заявка завода 6-36, перевозчику 6-80).
insert into ak_counters (series, period, last) values ('factory', 'batch6', 36), ('carrier', 'batch6', 80);

create or replace function ak_next_number(p_series text, p_date date)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_period text;
  v_n integer;
  v_q integer := extract(quarter from p_date);
  v_y integer := extract(year from p_date);
begin
  v_period := case when p_date < date '2027-01-01' then 'batch6' else v_q || '-' || v_y end;
  insert into ak_counters (series, period, last) values (p_series, v_period, 1)
  on conflict (series, period) do update set last = ak_counters.last + 1
  returning last into v_n;
  return case when v_period = 'batch6' then '6-' || v_n else v_q || '-' || v_n || '-' || v_y end;
end $$;

-- ============================================================
-- Заявки завода
-- ============================================================
create table ak_requests (
  id                uuid primary key default gen_random_uuid(),
  number            text unique,                   -- присваивается при выпуске
  route_id          uuid not null references ak_routes(id),
  kind              text not null check (kind in ('international', 'local')),
  loading_date      date not null,
  trucks_ordered    integer not null default 0 check (trucks_ordered >= 0),
  trucks_confirmed  integer check (trucks_confirmed >= 0),  -- подтверждено менеджером завода
  confirmed_on      date,
  confirmed_doc     text,
  price_minor       bigint not null check (price_minor >= 0),  -- за 1 ТС, в price_cur; местные — с НДС
  price_cur         text not null check (price_cur in ('USD', 'UZS')),
  fx_rate           numeric(14, 2) check (fx_rate > 0),       -- международные: курс заявки
  price_uzs_minor   bigint not null default 0,                -- за 1 ТС в тийинах (считает триггер)
  oformlenie_minor  bigint not null default 0 check (oformlenie_minor >= 0),  -- $ (центы) за машину
  payment_days      integer not null default 90 check (payment_days >= 0),
  status            text not null default 'draft' check (status in ('draft', 'issued', 'cancelled')),
  issued_on         date,
  version           integer not null default 1,
  notes             text,
  created_at        timestamptz not null default now(),
  created_by        uuid default auth.uid(),
  updated_at        timestamptz not null default now(),
  updated_by        uuid default auth.uid(),
  check (kind = 'international' or (price_cur = 'UZS' and oformlenie_minor = 0)),
  check (price_cur = 'UZS' or fx_rate is not null)
);
-- Одна международная заявка на направление за день погрузки (местные — на каждый рейс).
create unique index ak_requests_route_day on ak_requests (route_id, loading_date)
  where kind = 'international' and status <> 'cancelled';
create index ak_requests_loading on ak_requests (loading_date);

-- Версии: изменение выпущенной заявки (менеджер завода добавил машину, поменялась
-- цена) = новая версия с тем же номером, прежняя сохраняется здесь.
create table ak_request_versions (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references ak_requests(id),
  version     integer not null,
  snapshot    jsonb not null,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  unique (request_id, version)
);

create or replace function ak_requests_before()
returns trigger
language plpgsql
set search_path = public
as $$
declare v_route_kind text;
begin
  -- тип заявки всегда берётся из маршрута
  if tg_op = 'INSERT' or new.route_id is distinct from old.route_id then
    select kind into v_route_kind from ak_routes where id = new.route_id;
    new.kind := v_route_kind;
  end if;
  if new.kind = 'local' then
    new.price_cur := 'UZS';
    new.fx_rate := null;
    new.oformlenie_minor := 0;
  elsif new.fx_rate is null then
    new.fx_rate := ak_cbu_rate(new.loading_date);
    if new.fx_rate is null then
      raise exception 'Нет курса ЦБ на %: загрузите курс или укажите вручную', to_char(new.loading_date, 'DD.MM.YYYY');
    end if;
  end if;
  new.price_uzs_minor := case when new.price_cur = 'USD' then round(new.price_minor * new.fx_rate) else new.price_minor end;
  if tg_op = 'UPDATE' and old.status = 'issued' and new.status = 'issued' and
     (old.trucks_confirmed, old.price_minor, old.price_cur, old.fx_rate, old.oformlenie_minor, old.loading_date, old.route_id)
     is distinct from
     (new.trucks_confirmed, new.price_minor, new.price_cur, new.fx_rate, new.oformlenie_minor, new.loading_date, new.route_id) then
    insert into ak_request_versions (request_id, version, snapshot) values (old.id, old.version, to_jsonb(old));
    new.version := old.version + 1;
  end if;
  if tg_op = 'UPDATE' and old.number is not null and new.number is distinct from old.number then
    raise exception 'Номер выпущенной заявки менять нельзя';
  end if;
  return new;
end $$;

create trigger ak_requests_before before insert or update on ak_requests
  for each row execute function ak_requests_before();

-- ============================================================
-- Рейсы (одна машина в заявке)
-- ============================================================
create table ak_trips (
  id               uuid primary key default gen_random_uuid(),
  request_id       uuid not null references ak_requests(id),
  number           text unique,                      -- № заявки перевозчику, при выпуске
  tractor_id       uuid references ak_vehicles(id),
  trailer_id       uuid references ak_vehicles(id),
  carrier_id       uuid references ak_carriers(id),  -- пусто = «рейс без перевозчика» (контроль)
  price_minor      bigint check (price_minor >= 0),  -- цена перевозчику в price_cur
  price_cur        text check (price_cur in ('USD', 'UZS')),
  fx_rate          numeric(14, 2) check (fx_rate > 0),
  price_uzs_minor  bigint,                           -- в тийинах (считает триггер)
  vat_included     boolean not null default false,   -- местный рейс, перевозчик — плательщик НДС
  pay_timing       text check (pay_timing in ('advance', 'after_loading', 'after_delivery')),
  pay_method       text check (pay_method in ('transfer', 'cash')),
  pay_days         integer check (pay_days >= 0),
  status           text not null default 'assigned' check (status in ('assigned', 'loaded', 'delivered', 'failed')),
  loaded_on        date,
  delivered_on     date,
  failed_on        date,
  failed_reason    text,
  status_by        uuid,                             -- кто подтвердил статус (сайт / бот)
  issued_on        date,
  notes            text,
  created_at       timestamptz not null default now(),
  created_by       uuid default auth.uid(),
  updated_at       timestamptz not null default now(),
  updated_by       uuid default auth.uid()
);
create index ak_trips_request on ak_trips (request_id);
create index ak_trips_carrier on ak_trips (carrier_id);

create or replace function ak_trips_before()
returns trigger
language plpgsql
set search_path = public
as $$
declare r ak_requests;
begin
  select * into r from ak_requests where id = new.request_id;
  if new.price_cur = 'USD' and new.fx_rate is null then new.fx_rate := r.fx_rate; end if;
  if r.kind = 'local' and new.price_cur = 'USD' then
    raise exception 'Местный рейс: цена перевозчику только в сумах';
  end if;
  new.price_uzs_minor := case
    when new.price_minor is null then null
    when new.price_cur = 'USD' then round(new.price_minor * new.fx_rate)
    else new.price_minor end;
  if r.kind <> 'local' then new.vat_included := false; end if;
  if new.status = 'loaded' and new.loaded_on is null then new.loaded_on := r.loading_date; end if;
  if new.status = 'failed' and new.failed_on is null then new.failed_on := current_date; end if;
  if new.status is distinct from (case when tg_op = 'UPDATE' then old.status end) then
    new.status_by := coalesce(auth.uid(), new.status_by);
  end if;
  if tg_op = 'UPDATE' and old.number is not null and new.number is distinct from old.number then
    raise exception 'Номер выпущенной заявки перевозчику менять нельзя';
  end if;
  return new;
end $$;

create trigger ak_trips_before before insert or update on ak_trips
  for each row execute function ak_trips_before();

-- Выпуск заявки завода: присвоить номер (один раз) и выпустить заявки перевозчикам
-- на все погруженные машины.
create or replace function ak_issue_request(p_id uuid)
returns text
language plpgsql security definer
set search_path = public
as $$
declare r ak_requests; t record;
begin
  if not ak_is_owner() then raise exception 'Нет прав'; end if;
  select * into r from ak_requests where id = p_id for update;
  if r.id is null then raise exception 'Заявка не найдена'; end if;
  if r.status = 'cancelled' then raise exception 'Заявка отменена'; end if;
  if coalesce(r.trucks_confirmed, 0) = 0 then raise exception 'Укажите, сколько машин подтвердил завод'; end if;
  if r.number is null then
    update ak_requests set number = ak_next_number('factory', r.loading_date), status = 'issued',
      issued_on = coalesce(issued_on, current_date) where id = p_id;
  else
    update ak_requests set status = 'issued' where id = p_id;
  end if;
  for t in select id from ak_trips where request_id = p_id and status in ('loaded', 'delivered') and number is null
           order by created_at loop
    update ak_trips set number = ak_next_number('carrier', r.loading_date), issued_on = current_date where id = t.id;
  end loop;
  return (select number from ak_requests where id = p_id);
end $$;

-- ============================================================
-- Движения денег
-- ============================================================
create table ak_movements (
  id                uuid primary key default gen_random_uuid(),
  op_date           date not null,
  kind              text not null check (kind in (
                      'factory_income',      -- поступление от завода на Р/С
                      'carrier_payment',     -- оплата перевозчику
                      'cash_withdrawal',     -- снятие наличных по чеку (Р/С → касса сум)
                      'transfer',            -- перевод / обмен / получение нала через контрагента
                      'handover',            -- передача наличных между держателями
                      'oformlenie_payment',  -- оплата оформления заводу
                      'expense',             -- расход (доп. / постоянный / налог)
                      'partner_withdrawal',  -- изъятие партнёром в счёт доли
                      'help_return',         -- возврат финансовой помощи партнёру
                      'income_other',        -- прочее поступление
                      'reversal')),          -- отмена ошибочной записи
  from_wallet       text references ak_wallets(id),
  to_wallet         text references ak_wallets(id),
  amount_out_minor  bigint check (amount_out_minor > 0),  -- списано с from_wallet (всего, с потерями)
  cur_out           text check (cur_out in ('UZS', 'USD')),
  amount_in_minor   bigint not null check (amount_in_minor > 0), -- получено (в to_wallet или контрагентом)
  cur_in            text not null check (cur_in in ('UZS', 'USD')),
  fx_rate           numeric(14, 4),   -- реальный курс (при смене валюты)
  cbu_rate          numeric(14, 2),   -- курс ЦБ на день операции (фиксируется один раз)
  counterparty      text,             -- реальное название контрагента
  carrier_id        uuid references ak_carriers(id),
  request_id        uuid references ak_requests(id),
  trip_id           uuid references ak_trips(id),
  partner_key       text check (partner_key in ('ismat', 'sarvar')),
  expense_id        uuid,             -- ссылка на ak_expenses (FK ниже)
  status            text not null default 'done' check (status in ('done', 'in_transit')),
  confirmed_by      uuid,
  confirmed_at      timestamptz,
  reverses_id       uuid references ak_movements(id),
  note              text,
  attachment_path   text,
  created_at        timestamptz not null default now(),
  created_by        uuid default auth.uid(),
  check (from_wallet is not null or to_wallet is not null),
  check ((from_wallet is null) = (amount_out_minor is null)),
  check (from_wallet is distinct from to_wallet)
);
create index ak_movements_date on ak_movements (op_date);
create index ak_movements_from on ak_movements (from_wallet);
create index ak_movements_to on ak_movements (to_wallet);
create index ak_movements_trip on ak_movements (trip_id);
create unique index ak_movements_reversed_once on ak_movements (reverses_id) where reverses_id is not null;

create table ak_movement_losses (
  id           uuid primary key default gen_random_uuid(),
  movement_id  uuid not null references ak_movements(id),
  kind         text not null check (kind in ('payment_order_fee', 'cash_withdrawal_fee', 'bank_fee',
                                             'third_party_fee', 'fx_diff', 'cash_delivery', 'other')),
  amount_minor bigint not null,  -- в валюте списания (cur_out); fx_diff может быть < 0 (выгода)
  note         text
);
create index ak_movement_losses_mv on ak_movement_losses (movement_id);

-- Доп. и постоянные расходы. Кто заплатил: кошелёк проекта или лично партнёр
-- (тогда это финансовая помощь — долг проекта перед партнёром, без движения кошельков).
create table ak_expenses (
  id              uuid primary key default gen_random_uuid(),
  exp_date        date not null,
  category        text not null check (category in ('loaders', 'broker', 'notary', 'logist_fee',
                    'accountant_salary', 'profit_tax', 'other_fixed', 'other')),
  amount_minor    bigint not null check (amount_minor > 0),
  currency        text not null check (currency in ('UZS', 'USD')),
  paid_by         text not null check (paid_by in ('wallet', 'ismat', 'sarvar')),
  movement_id     uuid references ak_movements(id),
  counterparty    text,
  docs_confirmed  boolean not null default false,  -- подтверждён документами (для налога)
  note            text,
  cancelled       boolean not null default false,  -- вместо удаления
  cancel_reason   text,
  created_at      timestamptz not null default now(),
  created_by      uuid default auth.uid(),
  updated_at      timestamptz not null default now(),
  updated_by      uuid default auth.uid(),
  check ((paid_by = 'wallet') = (movement_id is not null) or cancelled)
);
alter table ak_movements add constraint ak_movements_expense_fk foreign key (expense_id) references ak_expenses(id)
  deferrable initially deferred;  -- движение и расход создаются в одной транзакции

-- Расход может относиться к одной или нескольким заявкам (на машины не делится).
create table ak_expense_requests (
  expense_id  uuid not null references ak_expenses(id),
  request_id  uuid not null references ak_requests(id),
  primary key (expense_id, request_id)
);

-- ============================================================
-- Остатки кошельков
-- ============================================================
create or replace function ak_wallet_balance(p_wallet text)
returns bigint
language sql stable
as $$
  select coalesce((select sum(amount_minor) from ak_opening_balances
                   where kind = 'wallet' and wallet_id = p_wallet and not archived), 0)
       + coalesce((select sum(amount_in_minor) from ak_movements where to_wallet = p_wallet and status = 'done'), 0)
       - coalesce((select sum(amount_out_minor) from ak_movements where from_wallet = p_wallet), 0)
$$;

create view ak_wallet_balances with (security_invoker = true) as
  select w.id as wallet_id, w.currency, ak_wallet_balance(w.id) as balance_minor,
         coalesce((select sum(m.amount_in_minor) from ak_movements m
                   where m.to_wallet = w.id and m.status = 'in_transit'
                     and not exists (select 1 from ak_movements r where r.reverses_id = m.id)), 0) as in_transit_minor
  from ak_wallets w;

-- ============================================================
-- Запись движения. p — jsonb:
--   kind, op_date, from_wallet, to_wallet,
--   amount_in  — получено (в кошелёк to_wallet или контрагентом), минимальные единицы;
--   amount_out — списано с from_wallet БЕЗ автокомиссии банка (необязательно, если
--                валюта одна: тогда = получено + ручные потери; при обмене — обязательно);
--   losses     — ручные потери [{kind, amount, note}] в валюте списания
--                (комиссия третьих лиц, доставка наличных, прочее);
--   counterparty, carrier_id, request_id, trip_id, partner_key, expense_id, note,
--   in_transit (bool, только передача наличных), attachment_path.
-- Автоматически: комиссия за платёжное поручение (любой исходящий платёж с Р/С:
-- 0,1% + 1 120 сум), комиссия за снятие наличных по чеку (0,5%), курсовая разница
-- к курсу ЦБ. Итог: списано всего = получено (в валюте списания по ЦБ) + все потери.
-- ============================================================
create or replace function ak_post_movement(p jsonb)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_id uuid := gen_random_uuid();
  v_kind text := p ->> 'kind';
  v_date date := coalesce(nullif(p ->> 'op_date', '')::date, current_date);
  v_from text := nullif(p ->> 'from_wallet', '');
  v_to text := nullif(p ->> 'to_wallet', '');
  v_from_w ak_wallets;
  v_to_w ak_wallets;
  v_in bigint := nullif(p ->> 'amount_in', '')::bigint;
  v_base bigint := nullif(p ->> 'amount_out', '')::bigint;
  v_cur_in text;
  v_cur_out text;
  v_cbu numeric;
  v_manual bigint := 0;
  v_fee bigint := 0;
  v_fee_kind text;
  v_fx_diff bigint := 0;
  v_fx_rate numeric;
  v_out bigint;
  v_status text := case when coalesce((p ->> 'in_transit')::boolean, false) then 'in_transit' else 'done' end;
  l jsonb;
  v_bal bigint;
begin
  if not ak_is_owner() then raise exception 'Нет прав на запись движений'; end if;
  if v_kind is null or v_kind = 'reversal' then raise exception 'Неверный вид операции'; end if;
  if v_in is null or v_in <= 0 then raise exception 'Сумма должна быть больше нуля'; end if;
  if v_from is null and v_to is null then raise exception 'Укажите кошелёк'; end if;
  if v_from is not null then
    select * into v_from_w from ak_wallets where id = v_from and active;
    if v_from_w.id is null then raise exception 'Нет кошелька %', v_from; end if;
  end if;
  if v_to is not null then
    select * into v_to_w from ak_wallets where id = v_to and active;
    if v_to_w.id is null then raise exception 'Нет кошелька %', v_to; end if;
  end if;
  v_cur_out := v_from_w.currency;
  v_cur_in := coalesce(v_to_w.currency, v_from_w.currency);

  -- правила по видам операций
  if v_status = 'in_transit' and v_kind <> 'handover' then
    raise exception '«В пути» бывает только при передаче наличных между держателями';
  end if;
  if v_kind = 'handover' and (v_from_w.kind is distinct from 'cash' or v_to_w.kind is distinct from 'cash' or v_cur_in <> v_cur_out) then
    raise exception 'Передача наличных — только между кассами одной валюты';
  end if;
  if v_kind = 'cash_withdrawal' and (v_from_w.kind is distinct from 'bank' or v_to_w.kind is distinct from 'cash' or v_cur_in <> 'UZS') then
    raise exception 'Снятие наличных по чеку — с Р/С в кассу сум';
  end if;
  if v_kind in ('factory_income', 'income_other') and (v_to is null or v_from is not null) then
    raise exception 'Поступление — только приход в кошелёк';
  end if;
  if v_kind in ('carrier_payment', 'oformlenie_payment', 'expense', 'partner_withdrawal', 'help_return') and (v_from is null or v_to is not null) then
    raise exception 'Платёж — только расход из кошелька';
  end if;
  if v_kind = 'transfer' and (v_from is null or v_to is null) then
    raise exception 'Перевод — из кошелька в кошелёк';
  end if;
  if v_kind = 'carrier_payment' and nullif(p ->> 'carrier_id', '') is null then raise exception 'Укажите перевозчика'; end if;
  if v_kind in ('partner_withdrawal', 'help_return') and nullif(p ->> 'partner_key', '') is null then raise exception 'Укажите партнёра'; end if;

  v_cbu := ak_cbu_rate(v_date);

  if v_from is not null then
    -- ручные потери (автокомиссии и курсовую разницу считаем сами)
    for l in select * from jsonb_array_elements(coalesce(p -> 'losses', '[]'::jsonb)) loop
      if (l ->> 'kind') in ('fx_diff', 'payment_order_fee', 'cash_withdrawal_fee') then continue; end if;
      v_manual := v_manual + coalesce(nullif(l ->> 'amount', '')::bigint, 0);
    end loop;

    if v_cur_in = v_cur_out then
      if v_base is null then v_base := v_in + v_manual; end if;
      if v_base <> v_in + v_manual then
        raise exception 'Не сходится: списано % ≠ получено % + потери %', v_base / 100.0, v_in / 100.0, v_manual / 100.0;
      end if;
    else
      if v_base is null then raise exception 'При обмене валюты укажите, сколько списано'; end if;
      if v_cbu is null then raise exception 'Нет курса ЦБ на % — нужен для курсовой разницы', to_char(v_date, 'DD.MM.YYYY'); end if;
      if v_base - v_manual <= 0 then raise exception 'Потери больше суммы списания'; end if;
      v_fx_diff := v_base - v_manual - (case when v_cur_out = 'UZS' then round(v_in * v_cbu) else round(v_in / v_cbu) end)::bigint;
      v_fx_rate := case when v_cur_out = 'UZS' then round((v_base - v_manual)::numeric / v_in, 4)
                        else round(v_in::numeric / (v_base - v_manual), 4) end;
    end if;

    if v_kind = 'cash_withdrawal' then
      v_fee := round(v_in * 0.005); v_fee_kind := 'cash_withdrawal_fee';
    elsif v_from_w.kind = 'bank' then
      v_fee := round(v_base * 0.001) + 112000; v_fee_kind := 'payment_order_fee';  -- 0,1% + 1 120 сум
    end if;
    v_out := v_base + v_fee;
  end if;

  insert into ak_movements (id, op_date, kind, from_wallet, to_wallet, amount_out_minor, cur_out, amount_in_minor, cur_in,
    fx_rate, cbu_rate, counterparty, carrier_id, request_id, trip_id, partner_key, expense_id, status, note, attachment_path)
  values (v_id, v_date, v_kind, v_from, v_to, v_out, v_cur_out, v_in, v_cur_in, v_fx_rate, v_cbu,
    nullif(p ->> 'counterparty', ''), nullif(p ->> 'carrier_id', '')::uuid, nullif(p ->> 'request_id', '')::uuid,
    nullif(p ->> 'trip_id', '')::uuid, nullif(p ->> 'partner_key', ''), nullif(p ->> 'expense_id', '')::uuid,
    v_status, nullif(p ->> 'note', ''), nullif(p ->> 'attachment_path', ''));

  if v_from is not null then
    for l in select * from jsonb_array_elements(coalesce(p -> 'losses', '[]'::jsonb)) loop
      if (l ->> 'kind') in ('fx_diff', 'payment_order_fee', 'cash_withdrawal_fee') then continue; end if;
      if coalesce(nullif(l ->> 'amount', '')::bigint, 0) = 0 then continue; end if;
      insert into ak_movement_losses (movement_id, kind, amount_minor, note)
      values (v_id, l ->> 'kind', (l ->> 'amount')::bigint, nullif(l ->> 'note', ''));
    end loop;
    if v_fee > 0 then
      insert into ak_movement_losses (movement_id, kind, amount_minor, note) values (v_id, v_fee_kind, v_fee,
        case v_fee_kind when 'cash_withdrawal_fee' then 'Комиссия за снятие наличных по чеку 0,5%'
                        else 'Комиссия за платёжное поручение: 0,1% + 1 120 сум' end);
    end if;
    if v_fx_diff <> 0 then
      insert into ak_movement_losses (movement_id, kind, amount_minor, note)
      values (v_id, 'fx_diff', v_fx_diff, 'Курсовая разница к курсу ЦБ ' || v_cbu || '; реальный курс ' || v_fx_rate);
    end if;
    v_bal := ak_wallet_balance(v_from);
    if v_bal < 0 then
      raise exception 'Недостаточно денег в кошельке «%»: после операции остаток был бы %', v_from_w.name, v_bal / 100.0;
    end if;
  end if;
  return v_id;
end $$;

-- Отмена ошибочной записи встречной: кошельки возвращаются ровно как были.
create or replace function ak_reverse_movement(p_id uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  m ak_movements;
  v_id uuid := gen_random_uuid();
  v_from text;
  v_to text;
  v_bal bigint;
begin
  if not ak_is_owner() then raise exception 'Нет прав'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Укажите причину отмены'; end if;
  select * into m from ak_movements where id = p_id;
  if m.id is null then raise exception 'Запись не найдена'; end if;
  if m.kind = 'reversal' then raise exception 'Отмену отменить нельзя — внесите запись заново'; end if;
  if exists (select 1 from ak_movements where reverses_id = p_id) then raise exception 'Запись уже отменена'; end if;

  -- что пришло в кошелёк — уходит обратно (если «в пути» — получатель ничего не получал);
  -- что ушло из кошелька — возвращается полностью, вместе с комиссиями
  v_from := case when m.status = 'done' then m.to_wallet end;
  v_to := m.from_wallet;
  perform set_config('request.headers', jsonb_build_object('x-ak-reason', p_reason)::text, true);
  insert into ak_movements (id, op_date, kind, from_wallet, to_wallet, amount_out_minor, cur_out, amount_in_minor, cur_in,
    fx_rate, cbu_rate, counterparty, carrier_id, request_id, trip_id, partner_key, expense_id, status, reverses_id, note)
  values (v_id, current_date, 'reversal', v_from, v_to,
    case when v_from is not null then m.amount_in_minor end,
    case when v_from is not null then m.cur_in end,
    case when v_to is not null then m.amount_out_minor else m.amount_in_minor end,
    case when v_to is not null then m.cur_out else m.cur_in end,
    m.fx_rate, m.cbu_rate, m.counterparty, m.carrier_id, m.request_id, m.trip_id, m.partner_key, m.expense_id,
    'done', m.id, 'Отмена: ' || p_reason);
  if v_from is not null then
    v_bal := ak_wallet_balance(v_from);
    if v_bal < 0 then raise exception 'Отмена увела бы кошелёк в минус (%) — деньги уже потрачены', v_bal / 100.0; end if;
  end if;
  return v_id;
end $$;

-- Подтверждение получения наличных принимающей стороной.
create or replace function ak_confirm_movement(p_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not ak_is_owner() then raise exception 'Нет прав'; end if;
  update ak_movements set status = 'done', confirmed_by = auth.uid(), confirmed_at = now()
  where id = p_id and status = 'in_transit'
    and not exists (select 1 from ak_movements r where r.reverses_id = p_id);
  if not found then raise exception 'Нечего подтверждать (уже получено или отменено)'; end if;
end $$;

-- Расход: если платит кошелёк — сразу движение; если лично партнёр — финансовая помощь.
create or replace function ak_add_expense(p jsonb)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare v_id uuid := gen_random_uuid(); v_mv uuid; v_req text;
begin
  if not ak_is_owner() then raise exception 'Нет прав'; end if;
  if p ->> 'paid_by' = 'wallet' then
    if (select currency from ak_wallets where id = p ->> 'wallet') is distinct from p ->> 'currency' then
      raise exception 'Валюта расхода не совпадает с валютой кошелька';
    end if;
    -- сначала движение (ссылка на расход проверится в конце транзакции)
    v_mv := ak_post_movement(jsonb_build_object('kind', 'expense', 'op_date', p ->> 'exp_date', 'from_wallet', p ->> 'wallet',
      'amount_in', p ->> 'amount', 'counterparty', p ->> 'counterparty', 'expense_id', v_id, 'note', p ->> 'note',
      'losses', coalesce(p -> 'losses', '[]'::jsonb)));
  end if;
  insert into ak_expenses (id, exp_date, category, amount_minor, currency, paid_by, counterparty, docs_confirmed, note, movement_id)
  values (v_id, (p ->> 'exp_date')::date, p ->> 'category', (p ->> 'amount')::bigint, p ->> 'currency', p ->> 'paid_by',
    nullif(p ->> 'counterparty', ''), coalesce((p ->> 'docs_confirmed')::boolean, false), nullif(p ->> 'note', ''), v_mv);
  for v_req in select jsonb_array_elements_text(coalesce(p -> 'request_ids', '[]'::jsonb)) loop
    insert into ak_expense_requests (expense_id, request_id) values (v_id, v_req::uuid);
  end loop;
  return v_id;
end $$;

-- ============================================================
-- Журнал, отметка времени, RLS
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array['ak_requests', 'ak_trips', 'ak_expenses'] loop
    execute format('create trigger ak_touch before update on %I for each row execute function ak_touch()', t);
  end loop;
  foreach t in array array['ak_requests', 'ak_trips', 'ak_movements', 'ak_movement_losses', 'ak_expenses', 'ak_request_versions'] loop
    execute format('create trigger ak_audit after insert or update or delete on %I for each row execute function ak_audit()', t);
  end loop;
  execute 'create trigger ak_audit after insert or update or delete on ak_fx_rates for each row execute function ak_audit(''rate_date'')';
  execute 'create trigger ak_audit after insert or update or delete on ak_expense_requests for each row execute function ak_audit(''expense_id'')';
  execute 'create trigger ak_audit after insert or update or delete on ak_counters for each row execute function ak_audit(''series'')';

  -- чтение — все участники блока
  foreach t in array array['ak_fx_rates', 'ak_counters', 'ak_requests', 'ak_request_versions', 'ak_trips', 'ak_movements',
                           'ak_movement_losses', 'ak_expenses', 'ak_expense_requests'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy ak_read on %I for select to authenticated using (ak_can_read())', t);
    execute format('revoke all on %I from anon', t);
    execute format('revoke delete, truncate on %I from authenticated', t);
  end loop;
  -- прямая запись владельцем — справочные и рабочие таблицы (но не деньги)
  foreach t in array array['ak_fx_rates', 'ak_requests', 'ak_trips'] loop
    execute format('create policy ak_insert on %I for insert to authenticated with check (ak_is_owner())', t);
    execute format('create policy ak_update on %I for update to authenticated using (ak_is_owner()) with check (ak_is_owner())', t);
  end loop;
  -- расходы: только отметки (документы подтверждены, заметка, отмена) — сумма меняется через отмену движения
  execute 'create policy ak_update on ak_expenses for update to authenticated using (ak_is_owner()) with check (ak_is_owner())';
  -- деньги, счётчики, версии — только через функции выше
  foreach t in array array['ak_movements', 'ak_movement_losses', 'ak_counters', 'ak_request_versions', 'ak_expense_requests'] loop
    execute format('revoke insert, update on %I from authenticated', t);
  end loop;
  execute 'revoke insert on ak_expenses from authenticated';
end $$;

-- Расход: сумму, валюту, кошелёк из браузера не поменять (только отметки).
create or replace function ak_expenses_guard()
returns trigger
language plpgsql
as $$
begin
  if (old.amount_minor, old.currency, old.paid_by, old.movement_id, old.exp_date)
     is distinct from (new.amount_minor, new.currency, new.paid_by, new.movement_id, new.exp_date)
     and current_user = 'authenticated' then
    raise exception 'Сумму и оплату расхода не меняют — отмените расход и внесите заново';
  end if;
  return new;
end $$;
create trigger ak_expenses_guard before update on ak_expenses for each row execute function ak_expenses_guard();

grant execute on function ak_post_movement(jsonb), ak_reverse_movement(uuid, text), ak_confirm_movement(uuid),
  ak_add_expense(jsonb), ak_issue_request(uuid), ak_cbu_rate(date), ak_wallet_balance(text) to authenticated;
revoke execute on function ak_post_movement(jsonb), ak_reverse_movement(uuid, text), ak_confirm_movement(uuid),
  ak_add_expense(jsonb), ak_issue_request(uuid), ak_next_number(text, date) from anon;
revoke execute on function ak_next_number(text, date) from authenticated;
