-- Блок «Ангрен Каолин» — миграция 27 (2026-11-27): две ошибки, найденные денежными сценариями.
--
-- 1) Старый долг перевозчику в долларах (стартовый остаток) пересчитывался в сумы по курсу
--    ЦБ на сегодня, а оплаты этого долга без рейса — по курсу дня оплаты. Долг 2000 $,
--    оплаченный 2000 $, при смене курса 12 000 → 12 100 «висел» на 200 000 сум.
--    Теперь оплаты без рейса пересчитываются по тому же курсу, что и стартовый долг (на
--    сегодня): доллар гасит доллар. Оплата сумами долга в долларах — честная курсовая разница.
--
-- 2) Доля партнёров считается по реально поступившим от завода деньгам. Поступления
--    засчитывались целиком в новые заявки, хотя сначала завод гасит старый долг (стартовый
--    остаток). После перехода на программу деньги за октябрь–ноябрь выглядели бы как оплата
--    декабрьских рейсов, и доля «к выдаче» показалась бы раньше времени.
--    Теперь поступления сначала гасят стартовый долг завода, остаток — новые заявки.

create or replace view ak_carrier_calc as
 select id as carrier_id,
    name,
    ((coalesce(( select sum(tc.debt_uzs) as sum
           from ak_trip_calc_uzs tc
          where (tc.carrier_id = c.id)), (0)::numeric) + coalesce(( select sum(ak_conv((o.amount_minor)::numeric, o.currency, 'UZS'::text, ak_cbu_rate(current_date))) as sum
           from ak_opening_balances o
          where ((o.kind = 'carrier_debt'::text) and (o.carrier_id = c.id) and (not o.archived))), (0)::numeric)) - coalesce(( select sum(ak_conv((m.amount_in_minor)::numeric, m.cur_in, 'UZS'::text, ak_cbu_rate(current_date))) as sum
           from ak_live_movements m
          where ((m.kind = 'carrier_payment'::text) and (m.carrier_id = c.id) and (m.trip_id is null))), (0)::numeric)) as debt_uzs,
    ( select count(*) as count
           from ak_trip_calc tc
          where ((tc.carrier_id = c.id) and (tc.debt_minor > 0))) as trips_unpaid
   from ak_carriers c;

create or replace function ak_partners_core(p_to date default null)
returns jsonb
language plpgsql stable
set search_path = public
as $$
declare
  t date := coalesce(p_to, current_date);
  s jsonb := ak_summary_core(null, t);
  v_net bigint := (s ->> 'net_profit_uzs')::bigint;
  v_inv bigint := (s ->> 'factory_uzs')::bigint;
  -- сначала поступления гасят стартовый долг завода, в новые заявки идёт только остаток
  v_rec bigint := greatest(0, (s ->> 'factory_received_uzs')::bigint
    - coalesce((select sum(amount_minor) from ak_opening_balances where kind = 'factory_debt' and not archived), 0));
  -- предварительное решение ТЗ: доля считается по реально поступившим деньгам
  v_cash_net bigint := case when v_inv > 0 then round(v_net * least(1, greatest(0, v_rec::numeric / v_inv))) else 0 end;
  out jsonb := '{}'::jsonb;
  p text;
  v_taken bigint;
  v_open bigint;
  v_help jsonb;
begin
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
