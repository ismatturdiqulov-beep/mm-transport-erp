-- Блок «Ангрен Каолин» — миграция 11 (2026-11-26): долг по рейсу в сумах считается
-- напрямую в сумах (стоимость − оплаты − удержания), без промежуточного перевода в
-- доллары: иначе удержание 200 000 сум у долларового рейса превращалось в 199 982,50
-- из-за двойного округления (найдено тестом этапа 3).
create or replace view ak_trip_calc_uzs with (security_invoker = true) as
select tc.*,
       case when tc.debt_minor is null then null else
         tc.cost_uzs - tc.paid_uzs - tc.ded_uzs
         - coalesce(ak_conv(tc.paid_usd, 'USD', 'UZS', tc.rate), 0)
         - coalesce(ak_conv(tc.ded_usd, 'USD', 'UZS', tc.rate), 0)
       end as debt_uzs
from ak_trip_calc tc;

create or replace view ak_carrier_calc with (security_invoker = true) as
select c.id as carrier_id, c.name,
       coalesce((select sum(tc.debt_uzs) from ak_trip_calc_uzs tc where tc.carrier_id = c.id), 0)
     + coalesce((select sum(ak_conv(o.amount_minor, o.currency, 'UZS', ak_cbu_rate(current_date)))
                 from ak_opening_balances o where o.kind = 'carrier_debt' and o.carrier_id = c.id and not o.archived), 0)
     - coalesce((select sum(ak_conv(m.amount_in_minor, m.cur_in, 'UZS', coalesce(m.cbu_rate, ak_cbu_rate(m.op_date))))
                 from ak_live_movements m where m.kind = 'carrier_payment' and m.carrier_id = c.id and m.trip_id is null), 0)
       as debt_uzs,
       (select count(*) from ak_trip_calc tc where tc.carrier_id = c.id and tc.debt_minor > 0) as trips_unpaid
from ak_carriers c;
