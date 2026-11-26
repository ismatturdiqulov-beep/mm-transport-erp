-- Блок «Ангрен Каолин» — миграция 16 (2026-11-26): сумма завода — по факту.
--
-- Решение владельца: подтверждение количества машин менеджером завода убирается
-- (он подтверждает раз в неделю / месяц, а без подтверждения заявка «уходила в минус»).
-- Машин в заявке = заполненные лоты (есть тягач, не «не состоялся», не закрыт) —
-- те же, по которым считаются перевозчики. Долг завода = по факту: сумма всех
-- действующих заявок − поступления. Расхождения, найденные при сверке с заводом, —
-- отдельной «корректировкой по сверке» (±, с причиной, по заявке или общей).
-- Столбцы trucks_confirmed / confirmed_on / confirmed_doc в ak_requests остаются
-- (история), но в расчётах больше не используются.

create table ak_factory_adjustments (
  id             uuid primary key default gen_random_uuid(),
  adj_date       date not null default current_date,
  request_id     uuid references ak_requests(id),     -- пусто = общая по сверке
  amount_minor   bigint not null check (amount_minor <> 0),  -- сум (тийин): + завод должен больше, − меньше
  reason         text not null check (length(trim(reason)) > 0),
  cancelled      boolean not null default false,
  cancel_reason  text,
  created_at     timestamptz not null default now(),
  created_by     uuid default auth.uid(),
  updated_at     timestamptz not null default now(),
  updated_by     uuid default auth.uid()
);
create index ak_factory_adjustments_req on ak_factory_adjustments (request_id);
create trigger ak_touch before update on ak_factory_adjustments for each row execute function ak_touch();
create trigger ak_audit after insert or update or delete on ak_factory_adjustments for each row execute function ak_audit();
alter table ak_factory_adjustments enable row level security;
create policy ak_read on ak_factory_adjustments for select to authenticated using (ak_can_read());
create policy ak_insert on ak_factory_adjustments for insert to authenticated with check (ak_is_owner());
create policy ak_update on ak_factory_adjustments for update to authenticated using (ak_is_owner()) with check (ak_is_owner());
revoke all on ak_factory_adjustments from anon;
revoke delete, truncate on ak_factory_adjustments from authenticated;
create or replace function ak_adjustments_guard()
returns trigger language plpgsql as $$
begin
  if (old.request_id, old.amount_minor, old.adj_date) is distinct from (new.request_id, new.amount_minor, new.adj_date) then
    raise exception 'Корректировка не правится — отмените её и внесите заново';
  end if;
  if old.cancelled and not new.cancelled then raise exception 'Отменённая корректировка не восстанавливается'; end if;
  return new;
end $$;
create trigger ak_adjustments_guard before update on ak_factory_adjustments for each row execute function ak_adjustments_guard();

drop view ak_request_calc;
create view ak_request_calc with (security_invoker = true) as
with tr as (
  select tc.request_id,
         count(*) filter (where not dead) as trips_live,
         count(*) filter (where tc.status in ('loaded', 'delivered') and not dead) as trips_loaded,
         count(*) filter (where not dead and tractor_id is not null) as trips_filled,
         count(*) filter (where tc.carrier_id is null and not dead) as trips_no_carrier,
         sum(cost_uzs) as carriers_uzs,
         sum(vat_in_uzs) as carriers_vat_uzs
  from ak_trip_calc tc join ak_trips t on t.id = tc.trip_id group by tc.request_id
),
adj as (
  select request_id, sum(amount_minor) as adj_uzs from ak_factory_adjustments where not cancelled and request_id is not null group by request_id
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
         case when r.status = 'cancelled' then 0 else coalesce(tr.trips_filled, 0) end as trucks,
         case when r.status = 'cancelled' then 0 else coalesce(adj.adj_uzs, 0) end as adjust_uzs
  from ak_requests r
  left join tr on tr.request_id = r.id
  left join exp_share es on es.request_id = r.id
  left join of_paid op on op.request_id = r.id
  left join adj on adj.request_id = r.id
),
calc as (
  select b.*,
         b.trucks * b.price_uzs_minor + b.adjust_uzs as factory_uzs,
         case when b.kind = 'local' then round((b.trucks * b.price_uzs_minor + b.adjust_uzs) * 1200 / 11200.0)::bigint else 0 end as vat_out_uzs,
         case when b.kind = 'international' then b.trucks * b.oformlenie_minor else 0 end as oformlenie_usd
  from base b
)
select c.id as request_id, c.number, c.route_id, c.kind, c.status, c.loading_date, c.trucks,
       true as confirmed, c.adjust_uzs, c.trips_live, c.trips_loaded, c.trips_no_carrier,
       c.factory_uzs, c.vat_out_uzs, c.carriers_uzs, c.carriers_vat_uzs,
       case when c.trips_live > 0 then round(c.carriers_uzs::numeric / c.trips_live)::bigint end as carrier_avg_uzs,
       c.oformlenie_usd, c.oformlenie_paid_usd, c.oformlenie_usd - c.oformlenie_paid_usd as oformlenie_debt_usd,
       coalesce(ak_conv(c.oformlenie_usd, 'USD', 'UZS', c.fx_rate), 0) as oformlenie_uzs,
       c.expenses_uzs,
       (c.factory_uzs - c.vat_out_uzs) - (c.carriers_uzs - c.carriers_vat_uzs)
         - coalesce(ak_conv(c.oformlenie_usd, 'USD', 'UZS', c.fx_rate), 0) - c.expenses_uzs as profit_uzs
from calc c;

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
  v_l_bank bigint;
  v_l_fx bigint;
  v_l_other bigint;
  v_l_detail jsonb;
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
  with ls as (
    select l.kind, ak_conv(l.amount_minor, m.cur_out, 'UZS', coalesce(m.cbu_rate, ak_cbu_rate(m.op_date))) as uzs
    from ak_movement_losses l join ak_live_movements m on m.id = l.movement_id
    where m.op_date between f and t
  )
  select coalesce(sum(uzs) filter (where kind in ('payment_order_fee', 'cash_withdrawal_fee', 'bank_fee')), 0),
         coalesce(sum(uzs) filter (where kind = 'fx_diff'), 0),
         coalesce(sum(uzs) filter (where kind in ('third_party_fee', 'cash_delivery', 'other')), 0),
         coalesce(sum(uzs), 0),
         coalesce((select jsonb_object_agg(kind, s) from (select kind, sum(uzs) as s from ls group by kind) d), '{}'::jsonb)
  into v_l_bank, v_l_fx, v_l_other, v_losses, v_l_detail
  from ls;

  -- расходы без привязки к заявкам (постоянные и прочие), кроме налога на прибыль
  select coalesce(sum(ak_conv(e.amount_minor, e.currency, 'UZS', ak_cbu_rate(e.exp_date))), 0) into v_fixed
  from ak_expenses e
  where not e.cancelled and e.category <> 'profit_tax' and e.exp_date between f and t
    and not exists (select 1 from ak_expense_requests l where l.expense_id = e.id);

  v_pre_tax := v_req.profit - v_losses - v_fixed;
  v_tax := greatest(round(v_pre_tax * 0.15), 0);   -- ОЦЕНКА; фактическая — при закрытии квартала
  v_net := v_pre_tax - v_tax;

  -- завод: выставлено по подтверждённым, получено (за всё время — долг на сегодня)
  -- по факту: все действующие заявки + общие корректировки по сверке
  select coalesce(sum(factory_uzs) filter (where status <> 'cancelled'), 0)
       + (select coalesce(sum(amount_minor), 0) from ak_factory_adjustments where not cancelled and request_id is null)
  into v_inv_conf from ak_request_calc;
  select coalesce(sum(amount_in_minor), 0) into v_received from ak_live_movements where kind = 'factory_income';
  select coalesce(sum(amount_minor), 0) into v_opening_factory from ak_opening_balances where kind = 'factory_debt' and not archived;

  v := jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'requests', v_req.requests, 'trucks', v_req.trucks,
    'factory_uzs', v_req.factory, 'vat_out_uzs', v_req.vat_out, 'carriers_uzs', v_req.carriers, 'vat_in_uzs', v_req.vat_in,
    'vat_payable_uzs', v_req.vat_out - v_req.vat_in,
    'oformlenie_usd', v_req.oform_usd, 'oformlenie_uzs', v_req.oform_uzs,
    'expenses_linked_uzs', v_req.exp_linked, 'expenses_fixed_uzs', v_fixed, 'losses_uzs', v_losses,
    'losses_bank_uzs', v_l_bank, 'losses_fx_uzs', v_l_fx, 'losses_other_uzs', v_l_other, 'losses_detail', v_l_detail,
    'profit_requests_uzs', v_req.profit, 'profit_intl_uzs', v_req.profit_intl, 'profit_local_uzs', v_req.profit_local,
    'profit_pre_tax_uzs', v_pre_tax, 'tax_estimate_uzs', v_tax, 'net_profit_uzs', v_net,
    -- на сегодня (не зависит от периода)
    'factory_invoiced_uzs', v_inv_conf, 'factory_received_uzs', v_received,
    'factory_debt_uzs', v_opening_factory + v_inv_conf - v_received,
    'factory_unconfirmed_uzs', 0,
    'factory_adjust_general_uzs', (select coalesce(sum(amount_minor), 0) from ak_factory_adjustments where not cancelled and request_id is null),
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
