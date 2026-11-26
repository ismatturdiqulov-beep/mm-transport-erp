-- Блок «Ангрен Каолин» — миграция 20 (2026-11-26): корректировки по сверке с заводом
-- попадают в прибыль ПО СВОЕЙ ДАТЕ, а не по дате заявки. Иначе корректировка к заявке
-- закрытого месяца меняла бы прибыль этого закрытого месяца, а по правилу владельца
-- исправления после закрытия вносятся в текущем периоде. Долг завода и сумма заявки
-- в карточке по-прежнему с корректировкой (это «на сегодня»).

-- Сумма корректировок: p_inside = true — привязанные к заявкам с датой погрузки в
-- диапазоне; false — датированные диапазоном (любые). НДС — для местных заявок.
create or replace function ak_adj_sum(f date, t date, p_inside boolean)
returns jsonb
language sql stable
set search_path = public
as $$
  select jsonb_build_object(
    'gross', coalesce(sum(a.amount_minor), 0),
    'vat', coalesce(sum(case when r.kind = 'local' then round(a.amount_minor * 1200 / 11200.0) else 0 end), 0))
  from ak_factory_adjustments a left join ak_requests r on r.id = a.request_id
  where not a.cancelled and (r.id is null or r.status <> 'cancelled')
    and case when p_inside then a.request_id is not null and r.loading_date between f and t
             else a.adj_date between f and t end
$$;

create or replace function ak_summary_core(p_from date default null, p_to date default null)
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
  v_taxj jsonb;
  v_adj_in jsonb;    -- корректировки, сидящие внутри заявок диапазона (убираем)
  v_adj_on jsonb;    -- корректировки, датированные диапазоном (добавляем)
  v_d_factory bigint;
  v_d_vat bigint;
begin

  select coalesce(sum(factory_uzs), 0) as factory, coalesce(sum(vat_out_uzs), 0) as vat_out,
         coalesce(sum(carriers_uzs), 0) as carriers, coalesce(sum(carriers_vat_uzs), 0) as vat_in,
         coalesce(sum(oformlenie_uzs), 0) as oform_uzs, coalesce(sum(oformlenie_usd), 0) as oform_usd,
         coalesce(sum(expenses_uzs), 0) as exp_linked, coalesce(sum(profit_uzs), 0) as profit,
         coalesce(sum(profit_uzs) filter (where kind = 'international'), 0) as profit_intl,
         coalesce(sum(profit_uzs) filter (where kind = 'local'), 0) as profit_local,
         count(*) filter (where status <> 'cancelled') as requests, coalesce(sum(trucks), 0) as trucks
  into v_req
  from ak_request_calc where loading_date between f and t and status <> 'cancelled';

  -- корректировки по сверке относятся к периоду своей даты (закрытый месяц не меняется,
  -- исправление попадает в текущий): вычитаем их из заявок диапазона и добавляем те,
  -- что датированы диапазоном (по любым заявкам и общие)
  v_adj_in := ak_adj_sum(f, t, true);
  v_adj_on := ak_adj_sum(f, t, false);
  v_d_factory := (v_adj_on ->> 'gross')::bigint - (v_adj_in ->> 'gross')::bigint;
  v_d_vat := (v_adj_on ->> 'vat')::bigint - (v_adj_in ->> 'vat')::bigint;

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

  v_pre_tax := v_req.profit + v_d_factory - v_d_vat - v_losses - v_fixed;
  v_taxj := ak_tax_for(f, t);   -- по кварталам: фактический, если вписан, иначе оценка 15%
  v_tax := (v_taxj ->> 'tax')::bigint;
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
    'factory_uzs', v_req.factory + v_d_factory, 'vat_out_uzs', v_req.vat_out + v_d_vat, 'adjustments_uzs', (v_adj_on ->> 'gross')::bigint, 'carriers_uzs', v_req.carriers, 'vat_in_uzs', v_req.vat_in,
    'vat_payable_uzs', v_req.vat_out + v_d_vat - v_req.vat_in,
    'oformlenie_usd', v_req.oform_usd, 'oformlenie_uzs', v_req.oform_uzs,
    'expenses_linked_uzs', v_req.exp_linked, 'expenses_fixed_uzs', v_fixed, 'losses_uzs', v_losses,
    'losses_bank_uzs', v_l_bank, 'losses_fx_uzs', v_l_fx, 'losses_other_uzs', v_l_other, 'losses_detail', v_l_detail,
    'profit_requests_uzs', v_req.profit + v_d_factory - v_d_vat, 'profit_intl_uzs', v_req.profit_intl, 'profit_local_uzs', v_req.profit_local, 'adjustments_net_uzs', v_d_factory - v_d_vat,
    'profit_pre_tax_uzs', v_pre_tax, 'tax_estimate_uzs', v_tax, 'tax_actual_part_uzs', (v_taxj ->> 'actual')::bigint,
    'tax_estimate_part_uzs', (v_taxj ->> 'estimate')::bigint, 'net_profit_uzs', v_net,
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

-- прибыль до налога (для налога по кварталам) — с тем же сдвигом корректировок
create or replace function ak_pretax(f date, t date)
returns bigint
language sql stable
set search_path = public
as $$
  select coalesce((select sum(profit_uzs) from ak_request_calc where loading_date between f and t and status <> 'cancelled'), 0)
       + ((ak_adj_sum(f, t, false) ->> 'gross')::bigint - (ak_adj_sum(f, t, false) ->> 'vat')::bigint)
       - ((ak_adj_sum(f, t, true) ->> 'gross')::bigint - (ak_adj_sum(f, t, true) ->> 'vat')::bigint)
       - coalesce((select sum(ak_conv(l.amount_minor, m.cur_out, 'UZS', coalesce(m.cbu_rate, ak_cbu_rate(m.op_date))))
                   from ak_movement_losses l join ak_live_movements m on m.id = l.movement_id where m.op_date between f and t), 0)
       - coalesce((select sum(ak_conv(e.amount_minor, e.currency, 'UZS', ak_cbu_rate(e.exp_date))) from ak_expenses e
                   where not e.cancelled and e.category <> 'profit_tax' and e.exp_date between f and t
                     and not exists (select 1 from ak_expense_requests l where l.expense_id = e.id)), 0)
$$;
revoke execute on function ak_summary_core(date, date) from public, anon, authenticated;
