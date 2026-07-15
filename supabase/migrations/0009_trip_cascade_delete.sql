-- MM Transport ERP — миграция 9: удаление рейса должно удалять его плечи/расходы/
-- оплаты/штрафы вместе с ним (это настоящие дочерние записи рейса, без него не имеют
-- смысла) — в отличие от tirs/dozv, которые при удалении рейса просто отвязываются
-- (trip_id остаётся у них в схеме без каскада, это делается вручную в JS), потому что
-- ТИР/дозвол — это реальный физический документ, который не должен исчезать.
alter table trip_legs drop constraint trip_legs_trip_id_fkey, add constraint trip_legs_trip_id_fkey foreign key (trip_id) references trips(id) on delete cascade;
alter table trip_expenses drop constraint trip_expenses_trip_id_fkey, add constraint trip_expenses_trip_id_fkey foreign key (trip_id) references trips(id) on delete cascade;
alter table trip_payments drop constraint trip_payments_trip_id_fkey, add constraint trip_payments_trip_id_fkey foreign key (trip_id) references trips(id) on delete cascade;
alter table trip_surcharges drop constraint trip_surcharges_trip_id_fkey, add constraint trip_surcharges_trip_id_fkey foreign key (trip_id) references trips(id) on delete cascade;
