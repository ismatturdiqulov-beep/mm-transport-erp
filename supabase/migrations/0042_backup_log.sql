-- MM Transport ERP — миграция 42: журнал резервного копирования (2026-08-10).
-- Каждый запуск ежедневного бэкапа (успех или ошибка) пишет сюда одну строку —
-- по этому журналу отдельная проверка ("сторож") умеет заметить, что бэкапов не
-- было слишком долго, даже если сама функция бэкапа вообще не смогла запуститься
-- (тогда сторож увидит "последний успех был давно" и всё равно предупредит).
-- Платформенный уровень, не привязан к company_id — доступен только service_role.
create table backup_log (
  id         uuid primary key default gen_random_uuid(),
  run_at     timestamptz not null default now(),
  status     text not null check (status in ('success','error')),
  file_name  text,
  detail     text
);
create index idx_backup_log_run_at on backup_log(run_at desc);

alter table backup_log enable row level security;
create policy service_role_all on backup_log for all to service_role using (true) with check (true);
