-- Блок «Ангрен Каолин» — миграция 9 (2026-11-26): «свой» прицеп у тягача.
-- При выборе тягача в рейсе прицеп подставляется сам; его можно поменять — тогда
-- новый прицеп становится парой этого тягача (прицепы иногда меняют).
alter table ak_vehicles add column default_trailer_id uuid references ak_vehicles(id);
comment on column ak_vehicles.default_trailer_id is 'Свой прицеп тягача (подставляется в рейс автоматически)';
