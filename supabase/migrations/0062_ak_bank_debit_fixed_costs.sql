-- Блок «Ангрен Каолин» — миграция 12 (2026-11-26):
--   1) «списано банком» — платёж с Р/С без платёжного поручения (абонентская плата и
--      т. п.): комиссия 0,1% + 1 120 не начисляется. Параметр bank_debit в
--      ak_post_movement / ak_add_expense. Остальное в функциях — как в 0056/0054.
--   2) постоянные ежемесячные расходы в настройках (напоминание раз в месяц, оплату
--      подтверждает владелец): абонентская плата банка 220 000 сум, бухгалтер 100 $.

insert into ak_settings (key, value) values ('fixed_costs', '[
  {"key": "bank_subscription", "name": "Абонентская плата банка", "amount": 22000000, "currency": "UZS", "category": "other_fixed", "wallet": "rs", "bank_debit": true},
  {"key": "accountant", "name": "Зарплата бухгалтера", "amount": 10000, "currency": "USD", "category": "accountant_salary", "wallet": "cash_usd_ismat"}
]') on conflict (key) do nothing;

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
        raise exception 'Не сходится: списано % ≠ получено % + потери %', ak_fmt(v_base), ak_fmt(v_in), ak_fmt(v_manual);
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
    elsif v_from_w.kind = 'bank' and not coalesce((p ->> 'bank_debit')::boolean, false) then
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
      raise exception 'Недостаточно денег в кошельке «%»: после операции остаток был бы %', v_from_w.name, ak_fmt(v_bal);
    end if;
  end if;
  return v_id;
end $$;


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
      'losses', coalesce(p -> 'losses', '[]'::jsonb), 'bank_debit', coalesce((p ->> 'bank_debit')::boolean, false)));
  end if;
  insert into ak_expenses (id, exp_date, category, amount_minor, currency, paid_by, counterparty, docs_confirmed, note, movement_id)
  values (v_id, (p ->> 'exp_date')::date, p ->> 'category', (p ->> 'amount')::bigint, p ->> 'currency', p ->> 'paid_by',
    nullif(p ->> 'counterparty', ''), coalesce((p ->> 'docs_confirmed')::boolean, false), nullif(p ->> 'note', ''), v_mv);
  for v_req in select jsonb_array_elements_text(coalesce(p -> 'request_ids', '[]'::jsonb)) loop
    insert into ak_expense_requests (expense_id, request_id) values (v_id, v_req::uuid);
  end loop;
  return v_id;
end $$;
