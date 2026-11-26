-- Блок «Ангрен Каолин» — миграция 10: этап 3 — расчёты (2026-11-26).
--
-- Все цифры считаются здесь, в базе, ОДИН раз — сайт, отчёты (этап 4) и бот (этап 5)
-- читают одни и те же представления. Ручного ввода «средней цены», прибыли и долгов
-- нет (в Excel он давал ошибки).
--
--   ak_trip_calc     — по рейсу: стоимость, НДС к зачёту, оплачено, удержано, долг
--   ak_request_calc  — по заявке: сумма завода, НДС, перевозчики, оформление, доп.
--                      расходы, прибыль
--   ak_carrier_calc  — по перевозчику: сколько должны (с удержаниями и стартовыми)
--   ak_summary()     — итоги: долг завода, оформление, НДС к уплате, потери, прибыль,
--                      оценка налога, доли партнёров, финансовая помощь
--
-- Правила (ТЗ раздел 4 + решения владельца):
--   * международная: прибыль = сумма завода − перевозчики − оформление × курс заявки − доп. расходы
--     (= (цена − средняя цена перевозчика − оформление) × машины − доп. расходы);
--   * местная: всё без НДС — (сумма завода − НДС) − (перевозчики − их НДС) − доп. расходы;
--   * НДС к уплате (оценка) = НДС от завода по местным − НДС перевозчиков-плательщиков;
--   * машин в заявке = подтверждено заводом, а пока не подтверждено — погружено;
--     долг завода — только по подтверждённым;
--   * доп. расход, привязанный к нескольким заявкам, делится между ними поровну
--     (на машины не делится);
--   * «не состоялся» / отменённая заявка: стоимость рейса 0 — всё, что уже заплачено
--     перевозчику, становится его долгом перед MM;
--   * налог на прибыль — только ОЦЕНКА 15% (резерв); фактическую сумму владелец вписывает
--     при закрытии квартала (этап 4), т. к. у MM есть расходы и вне блока.

-- ============================================================
-- Удержания у перевозчика (порча товара, опоздание и т. п.)
-- ============================================================
create table ak_trip_deductions (
  id             uuid primary key default gen_random_uuid(),
  trip_id        uuid not null references ak_trips(id),
  ded_date       date not null default current_date,
  amount_minor   bigint not null check (amount_minor > 0),
  currency       text not null check (currency in ('UZS', 'USD')),
  reason         text not null check (length(trim(reason)) > 0),
  cancelled      boolean not null default false,
  cancel_reason  text,
  created_at     timestamptz not null default now(),
  created_by     uuid default auth.uid(),
  updated_at     timestamptz not null default now(),
  updated_by     uuid default auth.uid()
);
create index ak_trip_deductions_trip on ak_trip_deductions (trip_id);
create trigger ak_touch before update on ak_trip_deductions for each row execute function ak_touch();
create trigger ak_audit after insert or update or delete on ak_trip_deductions for each row execute function ak_audit();
alter table ak_trip_deductions enable row level security;
create policy ak_read on ak_trip_deductions for select to authenticated using (ak_can_read());
create policy ak_insert on ak_trip_deductions for insert to authenticated with check (ak_is_owner());
create policy ak_update on ak_trip_deductions for update to authenticated using (ak_is_owner()) with check (ak_is_owner());
revoke all on ak_trip_deductions from anon;
revoke delete, truncate on ak_trip_deductions from authenticated;
-- удержание не правится — только отменяется (как платёж)
create or replace function ak_deductions_guard()
returns trigger language plpgsql as $$
begin
  if (old.trip_id, old.amount_minor, old.currency, old.ded_date) is distinct from (new.trip_id, new.amount_minor, new.currency, new.ded_date) then
    raise exception 'Удержание не правится — отмените его и внесите заново';
  end if;
  if old.cancelled and not new.cancelled then raise exception 'Отменённое удержание не восстанавливается'; end if;
  return new;
end $$;
create trigger ak_deductions_guard before update on ak_trip_deductions for each row execute function ak_deductions_guard();

-- Живые движения: не отменённые и не сами отмены.
create or replace view ak_live_movements with (security_invoker = true) as
  select m.* from ak_movements m
  where m.kind <> 'reversal' and not exists (select 1 from ak_movements r where r.reverses_id = m.id);

-- Перевод суммы в другую валюту по курсу (цент × курс = тийин).
create or replace function ak_conv(p_amount numeric, p_from text, p_to text, p_rate numeric)
returns bigint language sql immutable as $$
  select case when p_amount is null then null
              when p_from = p_to then round(p_amount)::bigint
              when p_rate is null or p_rate = 0 then null
              when p_to = 'UZS' then round(p_amount * p_rate)::bigint
              else round(p_amount / p_rate)::bigint end
$$;

-- ============================================================
-- Рейсы
-- ============================================================
create or replace view ak_trip_calc with (security_invoker = true) as
with base as (
  select t.*, r.kind as req_kind, r.status as req_status, r.loading_date,
         (t.status = 'failed' or r.status = 'cancelled') as dead,
         coalesce(t.fx_rate, r.fx_rate, ak_cbu_rate(current_date)) as rate
  from ak_trips t join ak_requests r on r.id = t.request_id
),
pay as (
  select trip_id, cur_in as cur, sum(amount_in_minor) as amt
  from ak_live_movements where kind = 'carrier_payment' and trip_id is not null group by trip_id, cur_in
),
ded as (
  select trip_id, currency as cur, sum(amount_minor) as amt
  from ak_trip_deductions where not cancelled group by trip_id, currency
)
select b.id as trip_id, b.request_id, b.carrier_id, b.status, b.req_kind, b.req_status, b.loading_date, b.dead,
       b.price_cur, b.rate,
       case when b.dead then 0 else coalesce(b.price_uzs_minor, 0) end as cost_uzs,
       case when b.dead or b.req_kind <> 'local' or not b.vat_included then 0
            else round(coalesce(b.price_uzs_minor, 0) * 1200 / 11200.0)::bigint end as vat_in_uzs,
       coalesce((select amt from pay where trip_id = b.id and cur = 'UZS'), 0) as paid_uzs,
       coalesce((select amt from pay where trip_id = b.id and cur = 'USD'), 0) as paid_usd,
       coalesce((select amt from ded where trip_id = b.id and cur = 'UZS'), 0) as ded_uzs,
       coalesce((select amt from ded where trip_id = b.id and cur = 'USD'), 0) as ded_usd,
       -- долг MM перед перевозчиком в валюте цены рейса (минус = перевозчик должен MM)
       case when b.price_minor is null and not b.dead then null else
         (case when b.dead then 0 else b.price_minor end)
         - coalesce(ak_conv((select amt from pay where trip_id = b.id and cur = 'UZS'), 'UZS', coalesce(b.price_cur, 'UZS'), b.rate), 0)
         - coalesce(ak_conv((select amt from pay where trip_id = b.id and cur = 'USD'), 'USD', coalesce(b.price_cur, 'UZS'), b.rate), 0)
         - coalesce(ak_conv((select amt from ded where trip_id = b.id and cur = 'UZS'), 'UZS', coalesce(b.price_cur, 'UZS'), b.rate), 0)
         - coalesce(ak_conv((select amt from ded where trip_id = b.id and cur = 'USD'), 'USD', coalesce(b.price_cur, 'UZS'), b.rate), 0)
       end as debt_minor
from base b;

-- ============================================================
-- Заявки
-- ============================================================
create or replace view ak_request_calc with (security_invoker = true) as
with tr as (
  select request_id,
         count(*) filter (where not dead) as trips_live,
         count(*) filter (where status in ('loaded', 'delivered') and not dead) as trips_loaded,
         count(*) filter (where carrier_id is null and not dead) as trips_no_carrier,
         sum(cost_uzs) as carriers_uzs,
         sum(vat_in_uzs) as carriers_vat_uzs
  from ak_trip_calc group by request_id
),
exp_share as (
  -- доп. расход делится поровну между привязанными заявками
  select l.request_id,
         sum(round(ak_conv(e.amount_minor, e.currency, 'UZS', ak_cbu_rate(e.exp_date))::numeric
                   / (select count(*) from ak_expense_requests l2 where l2.expense_id = e.id))) as expenses_uzs
  from ak_expense_requests l join ak_expenses e on e.id = l.expense_id and not e.cancelled
  group by l.request_id
),
of_paid as (
  select request_id, sum(case when cur_in = 'USD' then amount_in_minor
                              else ak_conv(amount_in_minor, 'UZS', 'USD', cbu_rate) end) as paid_usd
  from ak_live_movements where kind = 'oformlenie_payment' and request_id is not null group by request_id
),
base as (
  select r.*, coalesce(tr.trips_live, 0) as trips_live, coalesce(tr.trips_loaded, 0) as trips_loaded,
         coalesce(tr.trips_no_carrier, 0) as trips_no_carrier,
         coalesce(tr.carriers_uzs, 0) as carriers_uzs, coalesce(tr.carriers_vat_uzs, 0) as carriers_vat_uzs,
         coalesce(es.expenses_uzs, 0)::bigint as expenses_uzs, coalesce(op.paid_usd, 0)::bigint as oformlenie_paid_usd,
         case when r.status = 'cancelled' then 0 else coalesce(r.trucks_confirmed, tr.trips_loaded, 0) end as trucks
  from ak_requests r
  left join tr on tr.request_id = r.id
  left join exp_share es on es.request_id = r.id
  left join of_paid op on op.request_id = r.id
),
calc as (
  select b.*,
         b.trucks * b.price_uzs_minor as factory_uzs,
         case when b.kind = 'local' then round(b.trucks * b.price_uzs_minor * 1200 / 11200.0)::bigint else 0 end as vat_out_uzs,
         case when b.kind = 'international' then b.trucks * b.oformlenie_minor else 0 end as oformlenie_usd
  from base b
)
select c.id as request_id, c.number, c.route_id, c.kind, c.status, c.loading_date, c.trucks,
       (c.trucks_confirmed is not null) as confirmed, c.trips_live, c.trips_loaded, c.trips_no_carrier,
       c.factory_uzs, c.vat_out_uzs, c.carriers_uzs, c.carriers_vat_uzs,
       case when c.trips_live > 0 then round(c.carriers_uzs::numeric / c.trips_live)::bigint end as carrier_avg_uzs,
       c.oformlenie_usd, c.oformlenie_paid_usd, c.oformlenie_usd - c.oformlenie_paid_usd as oformlenie_debt_usd,
       coalesce(ak_conv(c.oformlenie_usd, 'USD', 'UZS', c.fx_rate), 0) as oformlenie_uzs,
       c.expenses_uzs,
       (c.factory_uzs - c.vat_out_uzs) - (c.carriers_uzs - c.carriers_vat_uzs)
         - coalesce(ak_conv(c.oformlenie_usd, 'USD', 'UZS', c.fx_rate), 0) - c.expenses_uzs as profit_uzs
from calc c;

-- ============================================================
-- Перевозчики: сколько MM должна (минус — перевозчик должен MM), в сумах
-- ============================================================
create or replace view ak_carrier_calc with (security_invoker = true) as
select c.id as carrier_id, c.name,
       coalesce((select sum(ak_conv(tc.debt_minor, coalesce(tc.price_cur, 'UZS'), 'UZS', tc.rate))
                 from ak_trip_calc tc where tc.carrier_id = c.id), 0)
     + coalesce((select sum(ak_conv(o.amount_minor, o.currency, 'UZS', ak_cbu_rate(current_date)))
                 from ak_opening_balances o where o.kind = 'carrier_debt' and o.carrier_id = c.id and not o.archived), 0)
     -- оплаты перевозчику без привязки к рейсу уменьшают долг напрямую
     - coalesce((select sum(ak_conv(m.amount_in_minor, m.cur_in, 'UZS', coalesce(m.cbu_rate, ak_cbu_rate(m.op_date))))
                 from ak_live_movements m where m.kind = 'carrier_payment' and m.carrier_id = c.id and m.trip_id is null), 0)
       as debt_uzs,
       (select count(*) from ak_trip_calc tc where tc.carrier_id = c.id and tc.debt_minor > 0) as trips_unpaid
from ak_carriers c;

-- ============================================================
-- Итоги за период (по дате погрузки / операции / расхода).
-- Возвращает jsonb — его читают сайт, отчёты и бот.
-- ============================================================
create or replace function ak_summary(p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable
set search_path = public
as $$
declare
  f date := coalesce(p_from, date '2000-01-01');
  t date := coalesce(p_to, date '2999-12-31');
  v jsonb;
  v_req record;
  v_losses bigint;
  v_fixed bigint;
  v_pre_tax bigint;
  v_tax bigint;
  v_net bigint;
  v_inv_conf bigint;
  v_received bigint;
  v_opening_factory bigint;
begin
  if not ak_can_read() then raise exception 'Нет доступа'; end if;

  select coalesce(sum(factory_uzs), 0) as factory, coalesce(sum(vat_out_uzs), 0) as vat_out,
         coalesce(sum(carriers_uzs), 0) as carriers, coalesce(sum(carriers_vat_uzs), 0) as vat_in,
         coalesce(sum(oformlenie_uzs), 0) as oform_uzs, coalesce(sum(oformlenie_usd), 0) as oform_usd,
         coalesce(sum(expenses_uzs), 0) as exp_linked, coalesce(sum(profit_uzs), 0) as profit,
         coalesce(sum(profit_uzs) filter (where kind = 'international'), 0) as profit_intl,
         coalesce(sum(profit_uzs) filter (where kind = 'local'), 0) as profit_local,
         count(*) filter (where status <> 'cancelled') as requests, coalesce(sum(trucks), 0) as trucks
  into v_req
  from ak_request_calc where loading_date between f and t and status <> 'cancelled';

  -- потери по движениям (комиссии банка, курсовая разница, доставка наличных…)
  select coalesce(sum(ak_conv(l.amount_minor, m.cur_out, 'UZS', coalesce(m.cbu_rate, ak_cbu_rate(m.op_date)))), 0)
  into v_losses
  from ak_movement_losses l join ak_live_movements m on m.id = l.movement_id
  where m.op_date between f and t;

  -- расходы без привязки к заявкам (постоянные и прочие), кроме налога на прибыль
  select coalesce(sum(ak_conv(e.amount_minor, e.currency, 'UZS', ak_cbu_rate(e.exp_date))), 0) into v_fixed
  from ak_expenses e
  where not e.cancelled and e.category <> 'profit_tax' and e.exp_date between f and t
    and not exists (select 1 from ak_expense_requests l where l.expense_id = e.id);

  v_pre_tax := v_req.profit - v_losses - v_fixed;
  v_tax := greatest(round(v_pre_tax * 0.15), 0);   -- ОЦЕНКА; фактическая — при закрытии квартала
  v_net := v_pre_tax - v_tax;

  -- завод: выставлено по подтверждённым, получено (за всё время — долг на сегодня)
  select coalesce(sum(factory_uzs) filter (where confirmed and status = 'issued'), 0) into v_inv_conf from ak_request_calc;
  select coalesce(sum(amount_in_minor), 0) into v_received from ak_live_movements where kind = 'factory_income';
  select coalesce(sum(amount_minor), 0) into v_opening_factory from ak_opening_balances where kind = 'factory_debt' and not archived;

  v := jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'requests', v_req.requests, 'trucks', v_req.trucks,
    'factory_uzs', v_req.factory, 'vat_out_uzs', v_req.vat_out, 'carriers_uzs', v_req.carriers, 'vat_in_uzs', v_req.vat_in,
    'vat_payable_uzs', v_req.vat_out - v_req.vat_in,
    'oformlenie_usd', v_req.oform_usd, 'oformlenie_uzs', v_req.oform_uzs,
    'expenses_linked_uzs', v_req.exp_linked, 'expenses_fixed_uzs', v_fixed, 'losses_uzs', v_losses,
    'profit_requests_uzs', v_req.profit, 'profit_intl_uzs', v_req.profit_intl, 'profit_local_uzs', v_req.profit_local,
    'profit_pre_tax_uzs', v_pre_tax, 'tax_estimate_uzs', v_tax, 'net_profit_uzs', v_net,
    -- на сегодня (не зависит от периода)
    'factory_invoiced_uzs', v_inv_conf, 'factory_received_uzs', v_received,
    'factory_debt_uzs', v_opening_factory + v_inv_conf - v_received,
    'factory_unconfirmed_uzs', (select coalesce(sum(factory_uzs), 0) from ak_request_calc where status <> 'cancelled' and not confirmed),
    'oformlenie_debt_usd',
      (select coalesce(sum(oformlenie_usd), 0) from ak_request_calc where status <> 'cancelled')
      + (select coalesce(sum(ak_conv(amount_minor, currency, 'USD', ak_cbu_rate(current_date))), 0) from ak_opening_balances where kind = 'oformlenie_debt' and not archived)
      - (select coalesce(sum(case when cur_in = 'USD' then amount_in_minor else ak_conv(amount_in_minor, 'UZS', 'USD', cbu_rate) end), 0)
         from ak_live_movements where kind = 'oformlenie_payment'),
    'carriers_debt_uzs', (select coalesce(sum(debt_uzs) filter (where debt_uzs > 0), 0) from ak_carrier_calc),
    'carriers_owe_us_uzs', (select coalesce(-sum(debt_uzs) filter (where debt_uzs < 0), 0) from ak_carrier_calc)
  );
  return v;
end $$;

-- Партнёры: доля 50% чистой прибыли (на дату, по поступившим деньгам), взято в счёт
-- доли, финансовая помощь и её возврат.
create or replace function ak_partners(p_to date default null)
returns jsonb
language plpgsql stable
set search_path = public
as $$
declare
  t date := coalesce(p_to, current_date);
  s jsonb := ak_summary(null, t);
  v_net bigint := (s ->> 'net_profit_uzs')::bigint;
  v_inv bigint := (s ->> 'factory_uzs')::bigint;
  v_rec bigint := (s ->> 'factory_received_uzs')::bigint;
  -- предварительное решение ТЗ: доля считается по реально поступившим деньгам
  v_cash_net bigint := case when v_inv > 0 then round(v_net * least(1, greatest(0, v_rec::numeric / v_inv))) else 0 end;
  out jsonb := '{}'::jsonb;
  p text;
  v_taken bigint;
  v_open bigint;
  v_help jsonb;
begin
  if not ak_can_read() then raise exception 'Нет доступа'; end if;
  foreach p in array array['ismat', 'sarvar'] loop
    select coalesce(sum(ak_conv(amount_in_minor, cur_in, 'UZS', cbu_rate)), 0) into v_taken
    from ak_live_movements where kind = 'partner_withdrawal' and partner_key = p and op_date <= t;
    select coalesce(sum(ak_conv(amount_minor, currency, 'UZS', ak_cbu_rate(t))), 0) into v_open
    from ak_opening_balances where kind = 'partner_share' and partner_key = p and not archived;
    -- фин. помощь по валютам: дал лично − вернули + стартовая
    select jsonb_object_agg(cur, amt) into v_help from (
      select cur, sum(amt) as amt from (
        select currency as cur, amount_minor as amt from ak_expenses where paid_by = p and not cancelled and exp_date <= t
        union all select cur_in, -amount_in_minor from ak_live_movements where kind = 'help_return' and partner_key = p and op_date <= t
        union all select currency, amount_minor from ak_opening_balances where kind = 'partner_help' and partner_key = p and not archived
      ) x group by cur) y;
    out := out || jsonb_build_object(p, jsonb_build_object(
      'share_uzs', round(v_cash_net * 0.5), 'taken_uzs', v_taken, 'opening_uzs', v_open,
      'balance_uzs', round(v_cash_net * 0.5) + v_open - v_taken,   -- минус = взял авансом
      'help_owed', coalesce(v_help, '{}'::jsonb)));
  end loop;
  return jsonb_build_object('as_of', t, 'net_profit_uzs', v_net, 'net_profit_cash_uzs', v_cash_net,
    'received_share', case when v_inv > 0 then round(least(1, v_rec::numeric / v_inv), 4) end, 'partners', out);
end $$;

grant execute on function ak_summary(date, date), ak_partners(date), ak_conv(numeric, text, text, numeric) to authenticated;
revoke execute on function ak_summary(date, date), ak_partners(date) from anon;
