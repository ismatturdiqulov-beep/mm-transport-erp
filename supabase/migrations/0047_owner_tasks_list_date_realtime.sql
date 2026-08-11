-- MM Transport ERP — миграция 47: дата задачи переносится на уровень пачки/темы
-- (2026-08-11, правка от пользователя после первого живого теста функции —
-- "мы же пишем тему на пачку задачи, там и должно стоять дата", а не у каждого
-- отдельного пункта). Плюс realtime для обеих таблиц — тот же фикс, что уже
-- сделан для driver_messages в 0032: без этого новые задачи с бота появлялись
-- на сайте только после ручного обновления страницы (F5).

alter table owner_task_lists add column date date;
-- Перенос уже накопленных реальных записей (пользователь успел опробовать вживую
-- ДО этой правки) — берём дату первой задачи в пачке, у всех задач одной пачки
-- она и так совпадала (раньше просто дублировалась в каждой строке).
update owner_task_lists l set date = coalesce(
  (select min(t.date) from owner_tasks t where t.list_id = l.id),
  current_date
);
alter table owner_task_lists alter column date set not null;
alter table owner_task_lists alter column date set default current_date;

alter table owner_tasks drop column date;

alter publication supabase_realtime add table owner_task_lists;
alter publication supabase_realtime add table owner_tasks;
