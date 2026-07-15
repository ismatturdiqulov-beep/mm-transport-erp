-- MM Transport ERP — миграция 10: kassa.trip_id / kassa.trip_exp_id должны отвязываться
-- (SET NULL), а не блокировать и не каскадно удаляться, когда удаляется рейс или расход
-- рейса. Касса — это факт движения реальных денег; она не должна ни исчезать, ни мешать
-- удалить сам рейс, если по нему уже были операции (а по завершённому рейсу они есть
-- почти всегда — зарплата водителю, возврат аванса и т.д.).
alter table kassa drop constraint kassa_trip_id_fkey,
  add constraint kassa_trip_id_fkey foreign key (trip_id) references trips(id) on delete set null;
alter table kassa drop constraint kassa_trip_exp_id_fkey,
  add constraint kassa_trip_exp_id_fkey foreign key (trip_exp_id) references trip_expenses(id) on delete set null;
