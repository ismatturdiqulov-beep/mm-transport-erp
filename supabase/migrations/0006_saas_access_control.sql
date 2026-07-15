-- MM Transport ERP — миграция 6: типы компаний (admin/volunteer/subscriber) и реальное
-- ограничение доступа по статусу подписки.
--
-- Бизнес-модель (зафиксирована с владельцем 2026-07-14):
--  - admin      — сама компания-платформа (владелец), доступ всегда полный.
--  - volunteer  — коллеги, помогающие тестировать бесплатно. НЕ безусловный доступ —
--                 владелец должен уметь их заблокировать так же, как неплательщика,
--                 и позже перевести в 'subscriber', когда тестирование закончится.
--  - subscriber — платный клиент: 10 дней бесплатного демо (subscription_status='trial'),
--                 потом либо оплата (переводим в 'active' вручную), либо блокировка
--                 ('suspended'). Три тарифа — пока просто текст в companies.plan
--                 (структурированная таблица тарифов не нужна, пока тарифы не определены).
--
-- Правило доступа одинаковое для volunteer и subscriber: пускает только
-- subscription_status in ('trial','active'). account_type='admin' — всегда пускает,
-- это не клиент, а сама платформа. role='owner' (см. 0005) всегда видит всё независимо
-- ни от чего — это нужно, чтобы владелец мог зайти и разблокировать/проверить любую
-- компанию, включая заблокированную.

alter table companies
  add column account_type text not null default 'subscriber'
    check (account_type in ('admin','volunteer','subscriber')),
  add column trial_ends_at date default (current_date + 10);
  -- trial_ends_at — только справочная дата для панели владельца ("демо истекает через N дней"),
  -- сама по себе доступ не блокирует — блокировка всегда через subscription_status вручную,
  -- как и было решено для paid_until (0004) — без автоматики по датам, чтобы не отключить
  -- клиента посреди ночи без вашего ведома.

comment on column companies.account_type is 'admin = сама платформа; volunteer = бесплатный тестировщик, блокируется как обычный клиент; subscriber = платный клиент';

-- ============================================================
-- company_access_allowed(): единая проверка "эта компания сейчас может работать в системе".
-- security definer — та же причина, что и у current_profile_company_id()/is_owner() в 0005.
-- ============================================================
create or replace function company_access_allowed(cid uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce(
    (select account_type = 'admin' or subscription_status in ('trial','active')
     from companies where id = cid),
    false
  )
$$;
grant execute on function company_access_allowed(uuid) to authenticated;

-- ============================================================
-- Пересоздаём политики company_scoped на прямых таблицах — добавляем проверку
-- company_access_allowed(). is_owner() по-прежнему обходит всё (иначе владелец не
-- смог бы зайти и посмотреть/разблокировать заблокированную компанию).
-- ============================================================
do $$
declare
  t text;
begin
  for t in
    select unnest(array[
      'kontragenty','people','transport','fleet','trips','tirs','dozv','finance','kassa',
      'kassa_wallets','maintenance','waybills','telegram_links','driver_messages',
      'notification_log','poa','labor'
    ])
  loop
    execute format('drop policy if exists company_scoped on %I', t);
    execute format(
      'create policy company_scoped on %I for all to authenticated using (is_owner() or (company_id = current_profile_company_id() and company_access_allowed(company_id))) with check (is_owner() or (company_id = current_profile_company_id() and company_access_allowed(company_id)))',
      t
    );
  end loop;
end $$;

-- ============================================================
-- То же самое для дочерних таблиц (через родителя).
-- ============================================================
drop policy if exists company_scoped on trip_legs;
create policy company_scoped on trip_legs for all to authenticated
  using (is_owner() or exists (select 1 from trips t where t.id = trip_legs.trip_id and t.company_id = current_profile_company_id() and company_access_allowed(t.company_id)))
  with check (is_owner() or exists (select 1 from trips t where t.id = trip_legs.trip_id and t.company_id = current_profile_company_id() and company_access_allowed(t.company_id)));

drop policy if exists company_scoped on trip_expenses;
create policy company_scoped on trip_expenses for all to authenticated
  using (is_owner() or exists (select 1 from trips t where t.id = trip_expenses.trip_id and t.company_id = current_profile_company_id() and company_access_allowed(t.company_id)))
  with check (is_owner() or exists (select 1 from trips t where t.id = trip_expenses.trip_id and t.company_id = current_profile_company_id() and company_access_allowed(t.company_id)));

drop policy if exists company_scoped on trip_payments;
create policy company_scoped on trip_payments for all to authenticated
  using (is_owner() or exists (select 1 from trips t where t.id = trip_payments.trip_id and t.company_id = current_profile_company_id() and company_access_allowed(t.company_id)))
  with check (is_owner() or exists (select 1 from trips t where t.id = trip_payments.trip_id and t.company_id = current_profile_company_id() and company_access_allowed(t.company_id)));

drop policy if exists company_scoped on trip_surcharges;
create policy company_scoped on trip_surcharges for all to authenticated
  using (is_owner() or exists (select 1 from trips t where t.id = trip_surcharges.trip_id and t.company_id = current_profile_company_id() and company_access_allowed(t.company_id)))
  with check (is_owner() or exists (select 1 from trips t where t.id = trip_surcharges.trip_id and t.company_id = current_profile_company_id() and company_access_allowed(t.company_id)));

drop policy if exists company_scoped on person_docs;
create policy company_scoped on person_docs for all to authenticated
  using (is_owner() or exists (select 1 from people p where p.id = person_docs.person_id and p.company_id = current_profile_company_id() and company_access_allowed(p.company_id)))
  with check (is_owner() or exists (select 1 from people p where p.id = person_docs.person_id and p.company_id = current_profile_company_id() and company_access_allowed(p.company_id)));

-- ============================================================
-- Помечаем существующую (пока единственную) компанию как саму платформу.
-- ============================================================
update companies set account_type = 'admin' where account_type = 'subscriber';
