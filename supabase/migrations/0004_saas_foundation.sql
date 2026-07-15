-- MM Transport ERP — миграция 4: фундамент под продажу продукта другим компаниям по подписке.
--
-- Пока используется только одной компанией (владельцем), но структура закладывается сразу,
-- чтобы не переделывать позже, когда появятся первые клиенты-компании (см. companies.company_id
-- уже во всех таблицах из 0001 — эта миграция достраивает то, чего не хватало).
--
-- Оплата подписки на старте отслеживается ВРУЧНУЮ владельцем продукта (не автоматический
-- платёжный сервис) — поэтому здесь только статус/дата, без таблиц счетов/платежей.
-- Это легко расширить позже, если подключится Click/Payme и т.п. — уже не блокирует.

-- ============================================================
-- companies: подписка + регистрационные/контактные данные компании-клиента
-- ============================================================
alter table companies
  add column subscription_status text not null default 'trial'
    check (subscription_status in ('trial','active','suspended','cancelled')),
  add column paid_until      date,     -- "оплачено до" — владелец продукта проставляет вручную
  add column plan             text,     -- произвольное название тарифа (пока не структурируем жёстко)
  add column contact_name     text,     -- кто регистрировал компанию / основной контакт
  add column contact_phone    text,
  add column contact_email    text,
  add column admin_note       text;     -- заметки владельца продукта по этому клиенту

-- ============================================================
-- profiles: связывает логин (Supabase Auth) с компанией и ролью внутри неё.
-- Нужна ОДНОВРЕМЕННО для двух вещей:
--  1) разделения доступа между компаниями в Фазе 2 (RLS будет проверять profiles.company_id
--     для текущего залогиненного пользователя — сама проверка ещё не написана, это только
--     таблица-основа под неё);
--  2) панели владельца продукта — список пользователей, их компания и роль.
-- role='owner' — сам владелец продукта, видит все компании, company_id для него NULL.
-- ============================================================
create table profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  company_id uuid references companies(id),
  role       text not null default 'dispatcher'
    check (role in ('owner','company_admin','dispatcher')),
  full_name  text,
  phone      text,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create index idx_profiles_company on profiles(company_id);

alter table profiles enable row level security;
-- Пока (до Фазы 2 — включения полноценного логина в самом приложении) доступ только
-- через service-role, как и остальные таблицы.
create policy service_role_all on profiles for all to service_role using (true) with check (true);
