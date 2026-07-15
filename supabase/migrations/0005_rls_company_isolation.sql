-- MM Transport ERP — миграция 5: реальное разделение доступа между компаниями (RLS).
--
-- До этой миграции доступ к данным был разрешён только service-role (бэкенду/скриптам) —
-- обычный залогиненный пользователь вообще ничего не мог прочитать. Здесь добавляются
-- политики для роли authenticated (то есть для реальных залогиненных диспетчеров),
-- которые видят только данные СВОЕЙ компании (profiles.company_id), кроме роли 'owner'
-- (владелец продукта) — он видит всё.
--
-- Существующие политики service_role_all не трогаем — они остаются для бэкенд-скриптов.

-- ============================================================
-- Вспомогательные функции. security definer нужен, чтобы функция могла прочитать
-- profiles текущего пользователя в обход RLS самой таблицы profiles (иначе была бы
-- рекурсия: чтобы проверить политику, нужно прочитать profiles, а чтение profiles
-- само под RLS). Это стандартный паттерн Supabase для мультитенантности.
-- ============================================================
create or replace function current_profile_company_id()
returns uuid
language sql stable security definer
set search_path = public
as $$
  select company_id from profiles where id = auth.uid()
$$;

create or replace function is_owner()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists(select 1 from profiles where id = auth.uid() and role = 'owner')
$$;

grant execute on function current_profile_company_id() to authenticated;
grant execute on function is_owner() to authenticated;

-- ============================================================
-- profiles: пользователь видит только свою собственную строку (чтобы приложение могло
-- узнать "кто я, какая у меня компания и роль"). Владелец видит все строки.
-- ============================================================
create policy self_or_owner_read on profiles for select to authenticated
  using (id = auth.uid() or is_owner());

-- ============================================================
-- companies: обычный пользователь видит только СВОЮ компанию (только чтение — менять
-- статус подписки/тариф может только владелец продукта через service-role, не сам
-- клиент). Владелец продукта видит и может менять все компании.
-- ============================================================
create policy self_company_read on companies for select to authenticated
  using (id = current_profile_company_id() or is_owner());
create policy owner_manage on companies for all to authenticated
  using (is_owner()) with check (is_owner());

-- ============================================================
-- Таблицы с прямым полем company_id — одна и та же политика для всех: свои данные
-- полностью (чтение и изменение), либо всё, если ты owner.
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
    execute format(
      'create policy company_scoped on %I for all to authenticated using (is_owner() or company_id = current_profile_company_id()) with check (is_owner() or company_id = current_profile_company_id())',
      t
    );
  end loop;
end $$;

-- ============================================================
-- Дочерние таблицы без своего company_id — доступ определяется через родителя.
-- ============================================================
create policy company_scoped on trip_legs for all to authenticated
  using (is_owner() or exists (select 1 from trips t where t.id = trip_legs.trip_id and t.company_id = current_profile_company_id()))
  with check (is_owner() or exists (select 1 from trips t where t.id = trip_legs.trip_id and t.company_id = current_profile_company_id()));

create policy company_scoped on trip_expenses for all to authenticated
  using (is_owner() or exists (select 1 from trips t where t.id = trip_expenses.trip_id and t.company_id = current_profile_company_id()))
  with check (is_owner() or exists (select 1 from trips t where t.id = trip_expenses.trip_id and t.company_id = current_profile_company_id()));

create policy company_scoped on trip_payments for all to authenticated
  using (is_owner() or exists (select 1 from trips t where t.id = trip_payments.trip_id and t.company_id = current_profile_company_id()))
  with check (is_owner() or exists (select 1 from trips t where t.id = trip_payments.trip_id and t.company_id = current_profile_company_id()));

create policy company_scoped on trip_surcharges for all to authenticated
  using (is_owner() or exists (select 1 from trips t where t.id = trip_surcharges.trip_id and t.company_id = current_profile_company_id()))
  with check (is_owner() or exists (select 1 from trips t where t.id = trip_surcharges.trip_id and t.company_id = current_profile_company_id()));

create policy company_scoped on person_docs for all to authenticated
  using (is_owner() or exists (select 1 from people p where p.id = person_docs.person_id and p.company_id = current_profile_company_id()))
  with check (is_owner() or exists (select 1 from people p where p.id = person_docs.person_id and p.company_id = current_profile_company_id()));
