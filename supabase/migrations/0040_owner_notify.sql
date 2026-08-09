-- MM Transport ERP — миграция 40: личный Telegram владельца платформы (для
-- уведомлений о бэкапах) (2026-08-10). Это НЕ то же самое, что telegram_links
-- (та таблица привязывает КОНТРАГЕНТОВ конкретной компании к боту) — здесь нужен
-- получатель уровня всей платформы, не привязанный ни к одной company_id/kontragent_id
-- (владелец — не контрагент ни у кого). Отдельная маленькая таблица, доступна
-- только backend-функциям (service_role) — обычные пользователи (authenticated)
-- к ней вообще доступа не имеют, ни через RLS-политику, ни иначе.
create table owner_notify (
  id               uuid primary key default gen_random_uuid(),
  chat_id          bigint not null,
  telegram_username text,
  linked_at        timestamptz not null default now()
);

alter table owner_notify enable row level security;
create policy service_role_all on owner_notify for all to service_role using (true) with check (true);
