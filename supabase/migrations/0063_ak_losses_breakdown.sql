-- Блок «Ангрен Каолин» — миграция 13 (2026-11-26): потери по видам.
-- Решение владельца: «банковские потери» — отдельной строкой; курсовая разница к ЦБ —
-- своей строкой (бывает и выгодой, в ТЗ «потери на обменах» в отчёте отдельно);
-- прочие (доставка наличных, комиссии третьих лиц) — третьей. ak_summary отдаёт
-- разбивку losses_bank_uzs / losses_fx_uzs / losses_other_uzs и детализацию по видам;
-- общий losses_uzs остаётся (= сумма трёх). Остальное в функции — как в 0060.
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
    'losses_bank_uzs', v_l_bank, 'losses_fx_uzs', v_l_fx, 'losses_other_uzs', v_l_other, 'losses_detail', v_l_detail,
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
