-- MM Transport ERP — миграция 12: история начислений/оплат по подписке компаний-клиентов.
--
-- Нужна для панели владельца (admin.html) — "акт сверки" с компанией-подписчиком, тот же
-- принцип, что уже работает внутри самого приложения для контрагентов (finance: type
-- charge/income + баланс). billing.paid_until (0004) остаётся справочной датой "оплачено
-- до", а здесь — реальный постатейный журнал начислений/оплат, из которого можно
-- сформировать акт сверки и увидеть историю, а не только текущий статус.
create table company_billing (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  date       date not null default current_date,
  type       text not null check (type in ('charge','payment')),
  amount     numeric not null check (amount > 0),
  note       text,
  created_at timestamptz not null default now()
);
create index idx_company_billing_company on company_billing(company_id);

alter table company_billing enable row level security;
create policy service_role_all on company_billing for all to service_role using (true) with check (true);
-- Только владелец продукта видит и ведёт биллинг клиентов — это внутренняя бухгалтерия
-- платформы, а не данные самой компании-клиента (в отличие от её business-таблиц).
create policy owner_manage on company_billing for all to authenticated using (is_owner()) with check (is_owner());
