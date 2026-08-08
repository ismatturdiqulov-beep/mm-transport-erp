-- MM Transport ERP — миграция 39: "Ожидаемые дозволы" (заметки/задачи)
-- (2026-08-04). Реальный сценарий: для Китайского дозвола сначала нужно
-- получить электронную очередь на въезд, и у пользователя уже скопилось
-- 10-15 таких очередей без самого дозвола. Плюс похожий случай без формальной
-- очереди — машина едет в Турцию, обратно может пойти через Таджикистан,
-- Казахстан или Узбекистан, и заранее не всегда известно, через какую
-- страну — надо просто держать в уме, что дозвол может понадобиться.
--
-- Решение пользователя 2026-08-04: НЕ связывать это с реальной таблицей dozv
-- (та построена вокруг настоящего документа — номер бланка, срок действия,
-- передача/возврат, — у очереди этого всего нет). Это отдельная лёгкая
-- заметка/задача: доводишь до конца вручную, жмёшь "Задача выполнена",
-- запись уходит из активного списка. Никакой автоматической привязки к
-- будущему реальному дозволу нет и не планируется.
create table doz_planned (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id),
  country    text,
  queue_num  text,             -- номер очереди — нужен не всем странам (например Китай), необязательное поле
  date       date,
  fleet_id   uuid references fleet(id) on delete set null,  -- необязательно, если ещё не известно для какой машины
  note       text,
  status     text not null default 'planned' check (status in ('planned','done')),
  created_at timestamptz not null default now()
);
create index idx_doz_planned_company on doz_planned(company_id);

alter table doz_planned enable row level security;
create policy service_role_all on doz_planned for all to service_role using (true) with check (true);
create policy company_scoped on doz_planned for all to authenticated
  using (is_owner() or (company_id = current_profile_company_id() and company_access_allowed(company_id)))
  with check (is_owner() or (company_id = current_profile_company_id() and company_access_allowed(company_id)));
