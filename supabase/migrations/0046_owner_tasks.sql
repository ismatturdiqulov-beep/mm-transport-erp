-- MM Transport ERP — миграция 46: задачи/чек-листы владельца через Telegram-бота
-- (2026-08-11). Отдельная кнопка "Задачи и заметки" в боте: пачка задач с общей
-- темой, каждая задача — свой статус (open/done), отмечается тапом по кнопке-
-- чекбоксу прямо в сообщении бота (сам Telegram-чек-лист доступен только через
-- Telegram Business API — не подошло, см. обсуждение с пользователем — поэтому
-- имитируем через обычную inline-клавиатуру).
--
-- Обычные бизнес-таблицы компании (не платформенные, как owner_notify/backup_log) —
-- поэтому RLS по стандартному паттерну company_scoped (0006), не service_role-only:
-- сайт должен уметь редактировать/удалять задачи от имени залогиненного владельца
-- напрямую через sbClient, без отдельной Edge Function.

create table owner_task_lists (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id),
  theme      text not null,
  created_at timestamptz not null default now()
);
create index idx_owner_task_lists_company on owner_task_lists(company_id);

create table owner_tasks (
  id            uuid primary key default gen_random_uuid(),
  list_id       uuid not null references owner_task_lists(id) on delete cascade,
  company_id    uuid references companies(id),
  text          text not null,
  date          date not null default current_date,
  comment       text,
  status        text not null default 'open' check (status in ('open','done')),
  assigned_to   uuid references profiles(id), -- задел под роли сотрудников (ещё не построены) — null = сам владелец
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);
create index idx_owner_tasks_list on owner_tasks(list_id);
create index idx_owner_tasks_company on owner_tasks(company_id);

alter table owner_task_lists enable row level security;
alter table owner_tasks enable row level security;

create policy company_scoped on owner_task_lists for all to authenticated
  using (is_owner() or (company_id = current_profile_company_id() and company_access_allowed(company_id)))
  with check (is_owner() or (company_id = current_profile_company_id() and company_access_allowed(company_id)));
create policy company_scoped on owner_tasks for all to authenticated
  using (is_owner() or (company_id = current_profile_company_id() and company_access_allowed(company_id)))
  with check (is_owner() or (company_id = current_profile_company_id() and company_access_allowed(company_id)));

create policy service_role_all on owner_task_lists for all to service_role using (true) with check (true);
create policy service_role_all on owner_tasks for all to service_role using (true) with check (true);

-- Двухшаговый ввод новой пачки задач в боте ("пришлите тему" -> "пришлите задачи")
-- нужен временный "черновик" темы между двумя сообщениями — аналогично pending_query
-- (миграция 44), которая уже хранит, чего сейчас "ждёт" бот от этого чата.
alter table owner_notify add column pending_task_theme text;
