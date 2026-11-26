-- Блок «Ангрен Каолин» — миграция 18 (2026-11-26): отчётные периоды и закрытие.
--
-- Решение владельца:
--   * месяц: оба партнёра подтверждают отчёт до 15-го числа следующего месяца;
--   * исправления — до 20-го числа следующего месяца включительно (для третьего месяца
--     квартала к этому дню бухгалтер даёт фактический налог на прибыль — она сдаёт
--     отчёт 20-го);
--   * с 21-го числа следующего месяца месяц ЗАКРЫТ: цифры фиксируются снимком, правки
--     записей с датами этого месяца запрещены базой; ошибка, найденная позже, вносится
--     корректировкой / отменой с текущей датой. Закрытый отчёт не меняется;
--   * квартал закрывается вместе со своим третьим месяцем; налог за квартал —
--     фактический (если вписан), иначе оценка 15%.
-- Закрытие — автоматически по календарю (pg_cron), даже если кто-то не подтвердил.

create table ak_periods (
  id                  text primary key,             -- 'M2027-01' | 'Q2027-1'
  kind                text not null check (kind in ('month', 'quarter')),
  date_from           date not null,
  date_to             date not null,
  confirm_due         date not null,                -- до какого числа подтвердить
  lock_from           date not null,                -- с какого дня закрыт
  tax_actual_minor    bigint check (tax_actual_minor >= 0),  -- квартал: фактический налог (тийин)
  tax_note            text,
  confirmed_ismat_at  timestamptz,
  confirmed_ismat_by  uuid,
  confirmed_sarvar_at timestamptz,
  confirmed_sarvar_by uuid,
  status              text not null default 'open' check (status in ('open', 'closed')),
  closed_at           timestamptz,
  snapshot            jsonb,                        -- зафиксированные цифры отчёта
  created_at          timestamptz not null default now()
);
create trigger ak_audit after insert or update or delete on ak_periods for each row execute function ak_audit();
alter table ak_periods enable row level security;
create policy ak_read on ak_periods for select to authenticated using (ak_can_read());
revoke all on ak_periods from anon;
revoke insert, update, delete, truncate on ak_periods from authenticated;   -- только через функции ниже

create or replace function ak_today()
returns date language sql stable as $$ select (now() at time zone 'Asia/Tashkent')::date $$;

-- Месяц даты d закрыт с 21-го числа следующего месяца.
create or replace function ak_lock_from(d date)
returns date language sql immutable as $$ select (date_trunc('month', d) + interval '1 month' + interval '20 days')::date $$;
create or replace function ak_is_locked(d date)
returns boolean language sql stable as $$ select d is not null and ak_today() >= ak_lock_from(d) $$;

create or replace function ak_lock_error(d date)
returns void language plpgsql as $$
begin
  raise exception 'Период % закрыт (после 20-го числа следующего месяца). Исправление вносите в текущем периоде: корректировкой, удержанием или отменой с сегодняшней датой.',
    to_char(d, 'MM.YYYY');
end $$;

-- ---------- запрет правок в закрытых месяцах ----------
create or replace function ak_lock_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare d_new date; d_old date;
begin
  if tg_table_name = 'ak_requests' then
    d_new := new.loading_date; d_old := case when tg_op = 'UPDATE' then old.loading_date end;
  elsif tg_table_name = 'ak_trips' then
    d_new := (select loading_date from ak_requests where id = new.request_id);
    d_old := case when tg_op = 'UPDATE' then (select loading_date from ak_requests where id = old.request_id) end;
  elsif tg_table_name = 'ak_movements' then
    if tg_op = 'UPDATE' then return new; end if;            -- подтверждение получения «в пути» — можно
    if new.kind = 'reversal' then return new; end if;        -- отмена пишется сегодняшним днём
    d_new := new.op_date;
  elsif tg_table_name = 'ak_expenses' then
    -- отметку «есть документы» можно ставить и в закрытом периоде
    if tg_op = 'UPDATE' and (to_jsonb(old) - 'docs_confirmed' - 'updated_at' - 'updated_by')
                          = (to_jsonb(new) - 'docs_confirmed' - 'updated_at' - 'updated_by') then
      return new;
    end if;
    d_new := new.exp_date; d_old := case when tg_op = 'UPDATE' then old.exp_date end;
  elsif tg_table_name = 'ak_trip_deductions' then
    d_new := new.ded_date; d_old := case when tg_op = 'UPDATE' then old.ded_date end;
  elsif tg_table_name = 'ak_factory_adjustments' then
    d_new := new.adj_date; d_old := case when tg_op = 'UPDATE' then old.adj_date end;
  elsif tg_table_name = 'ak_expense_requests' then
    d_new := (select exp_date from ak_expenses where id = new.expense_id);
  end if;
  if ak_is_locked(d_new) then perform ak_lock_error(d_new); end if;
  if ak_is_locked(d_old) then perform ak_lock_error(d_old); end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['ak_requests', 'ak_trips', 'ak_movements', 'ak_expenses', 'ak_trip_deductions',
                           'ak_factory_adjustments', 'ak_expense_requests'] loop
    execute format('create trigger ak_lock_guard before insert or update on %I for each row execute function ak_lock_guard()', t);
  end loop;
end $$;

-- ---------- прибыль до налога за диапазон (для налога по кварталам) ----------
create or replace function ak_pretax(f date, t date)
returns bigint
language sql stable
set search_path = public
as $$
  select coalesce((select sum(profit_uzs) from ak_request_calc where loading_date between f and t and status <> 'cancelled'), 0)
       - coalesce((select sum(ak_conv(l.amount_minor, m.cur_out, 'UZS', coalesce(m.cbu_rate, ak_cbu_rate(m.op_date))))
                   from ak_movement_losses l join ak_live_movements m on m.id = l.movement_id where m.op_date between f and t), 0)
       - coalesce((select sum(ak_conv(e.amount_minor, e.currency, 'UZS', ak_cbu_rate(e.exp_date))) from ak_expenses e
                   where not e.cancelled and e.category <> 'profit_tax' and e.exp_date between f and t
                     and not exists (select 1 from ak_expense_requests l where l.expense_id = e.id)), 0)
$$;

-- Налог за диапазон: по каждому кварталу — фактический, если вписан и квартал целиком
-- в диапазоне; иначе оценка 15% от прибыли до налога этой части квартала.
create or replace function ak_tax_for(f date, t date)
returns jsonb
language plpgsql stable
set search_path = public
as $$
declare
  v_min date; v_max date; v_f date; v_t date; q date; qf date; qt date; sf date; st date;
  v_actual bigint := 0; v_est bigint := 0; r ak_periods;
begin
  select least((select min(loading_date) from ak_requests), (select min(op_date) from ak_movements), (select min(exp_date) from ak_expenses)),
         greatest((select max(loading_date) from ak_requests), (select max(op_date) from ak_movements), (select max(exp_date) from ak_expenses), ak_today())
  into v_min, v_max;
  if v_min is null then return jsonb_build_object('tax', 0, 'actual', 0, 'estimate', 0); end if;
  v_f := greatest(f, date_trunc('quarter', v_min)::date);
  v_t := least(t, (date_trunc('quarter', v_max) + interval '3 months - 1 day')::date);
  q := date_trunc('quarter', v_f)::date;
  while q <= v_t loop
    qf := q; qt := (q + interval '3 months - 1 day')::date;
    sf := greatest(v_f, qf); st := least(v_t, qt);
    select * into r from ak_periods where id = 'Q' || extract(year from q) || '-' || extract(quarter from q);
    if sf = qf and st = qt and r.tax_actual_minor is not null then
      v_actual := v_actual + r.tax_actual_minor;
    else
      v_est := v_est + greatest(round(ak_pretax(sf, st) * 0.15), 0);
    end if;
    q := (q + interval '3 months')::date;
  end loop;
  return jsonb_build_object('tax', v_actual + v_est, 'actual', v_actual, 'estimate', v_est);
end $$;

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
    'factory_uzs', v_req.factory, 'vat_out_uzs', v_req.vat_out, 'carriers_uzs', v_req.carriers, 'vat_in_uzs', v_req.vat_in,
    'vat_payable_uzs', v_req.vat_out - v_req.vat_in,
    'oformlenie_usd', v_req.oform_usd, 'oformlenie_uzs', v_req.oform_uzs,
    'expenses_linked_uzs', v_req.exp_linked, 'expenses_fixed_uzs', v_fixed, 'losses_uzs', v_losses,
    'losses_bank_uzs', v_l_bank, 'losses_fx_uzs', v_l_fx, 'losses_other_uzs', v_l_other, 'losses_detail', v_l_detail,
    'profit_requests_uzs', v_req.profit, 'profit_intl_uzs', v_req.profit_intl, 'profit_local_uzs', v_req.profit_local,
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
  v_rec bigint := (s ->> 'factory_received_uzs')::bigint;
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

-- Обёртки для браузера — с проверкой доступа (ядро без проверки нужно для pg_cron).
create or replace function ak_summary(p_from date default null, p_to date default null)
returns jsonb language plpgsql stable set search_path = public as $$
begin
  if not ak_can_read() then raise exception 'Нет доступа'; end if;
  return ak_summary_core(p_from, p_to);
end $$;
create or replace function ak_partners(p_to date default null)
returns jsonb language plpgsql stable set search_path = public as $$
begin
  if not ak_can_read() then raise exception 'Нет доступа'; end if;
  return ak_partners_core(p_to);
end $$;
revoke execute on function ak_summary_core(date, date), ak_partners_core(date) from public, anon, authenticated;

-- ---------- периоды ----------
create or replace function ak_period_id(p_kind text, d date)
returns text language sql immutable as $$
  select case when p_kind = 'month' then 'M' || to_char(d, 'YYYY-MM')
              else 'Q' || extract(year from d) || '-' || extract(quarter from d) end
$$;

create or replace function ak_period_ensure(p_id text)
returns ak_periods
language plpgsql security definer
set search_path = public
as $$
declare r ak_periods; v_kind text; v_from date; v_to date;
begin
  select * into r from ak_periods where id = p_id;
  if r.id is not null then return r; end if;
  if p_id ~ '^M\d{4}-\d{2}$' then
    v_kind := 'month'; v_from := to_date(substr(p_id, 2) || '-01', 'YYYY-MM-DD');
    v_to := (v_from + interval '1 month - 1 day')::date;
  elsif p_id ~ '^Q\d{4}-[1-4]$' then
    v_kind := 'quarter';
    v_from := make_date(substr(p_id, 2, 4)::int, (substr(p_id, 7, 1)::int - 1) * 3 + 1, 1);
    v_to := (v_from + interval '3 months - 1 day')::date;
  else
    raise exception 'Неверный период %', p_id;
  end if;
  insert into ak_periods (id, kind, date_from, date_to, confirm_due, lock_from)
  values (p_id, v_kind, v_from, v_to,
          case when v_kind = 'month' then (v_to + interval '15 days')::date else (v_to + interval '20 days')::date end,
          ak_lock_from(v_to))
  returning * into r;
  return r;
end $$;

-- Подтверждение отчёта: каждый партнёр подтверждает за себя (Сарвару — только это действие).
create or replace function ak_confirm_period(p_id text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare v_key text;
begin
  select partner_key into v_key from ak_members where user_id = auth.uid() and active;
  if v_key is null then raise exception 'Подтверждать могут только партнёры'; end if;
  perform ak_period_ensure(p_id);
  if v_key = 'ismat' then
    update ak_periods set confirmed_ismat_at = now(), confirmed_ismat_by = auth.uid() where id = p_id and confirmed_ismat_at is null;
  else
    update ak_periods set confirmed_sarvar_at = now(), confirmed_sarvar_by = auth.uid() where id = p_id and confirmed_sarvar_at is null;
  end if;
end $$;

-- Фактический налог за квартал (от бухгалтерии) — до закрытия квартала.
create or replace function ak_set_quarter_tax(p_id text, p_amount bigint, p_note text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare r ak_periods;
begin
  if not ak_is_owner() then raise exception 'Нет прав'; end if;
  if p_id !~ '^Q' then raise exception 'Налог вписывается за квартал'; end if;
  r := ak_period_ensure(p_id);
  if r.status = 'closed' or ak_today() >= r.lock_from then raise exception 'Квартал уже закрыт — налог не меняется'; end if;
  if p_amount is not null and p_amount < 0 then raise exception 'Сумма налога не может быть отрицательной'; end if;
  update ak_periods set tax_actual_minor = p_amount, tax_note = nullif(trim(coalesce(p_note, '')), '') where id = p_id;
end $$;

-- Закрыть все периоды, срок которых наступил: зафиксировать снимок цифр.
create or replace function ak_close_due_periods()
returns integer
language plpgsql security definer
set search_path = public
as $$
declare v_min date; m date; r ak_periods; n integer := 0; qid text;
begin
  select least((select min(loading_date) from ak_requests), (select min(op_date) from ak_movements), (select min(exp_date) from ak_expenses)) into v_min;
  if v_min is null then return 0; end if;
  m := date_trunc('month', v_min)::date;
  while ak_lock_from(m) <= ak_today() loop
    r := ak_period_ensure(ak_period_id('month', m));
    if r.status = 'open' then
      update ak_periods set status = 'closed', closed_at = now(),
        snapshot = jsonb_build_object('summary', ak_summary_core(r.date_from, r.date_to), 'partners', ak_partners_core(r.date_to), 'closed_on', ak_today())
      where id = r.id;
      n := n + 1;
    end if;
    -- третий месяц квартала — закрываем и квартал
    if extract(month from m)::int % 3 = 0 then
      qid := ak_period_id('quarter', m);
      r := ak_period_ensure(qid);
      if r.status = 'open' then
        update ak_periods set status = 'closed', closed_at = now(),
          snapshot = jsonb_build_object('summary', ak_summary_core(r.date_from, r.date_to), 'partners', ak_partners_core(r.date_to), 'closed_on', ak_today())
        where id = r.id;
        n := n + 1;
      end if;
    end if;
    m := (m + interval '1 month')::date;
  end loop;
  return n;
end $$;

grant execute on function ak_confirm_period(text), ak_set_quarter_tax(text, bigint, text), ak_period_ensure(text) to authenticated;
revoke execute on function ak_close_due_periods() from public, anon, authenticated;
revoke execute on function ak_confirm_period(text), ak_set_quarter_tax(text, bigint, text), ak_period_ensure(text) from anon;

-- каждый день в 00:10 по Ташкенту (19:10 UTC)
select cron.schedule('ak-close-periods', '10 19 * * *', $$ select ak_close_due_periods() $$);
