-- MM Transport ERP — миграция 13: полноценные данные путёвки вместо свободного текста.
--
-- До этой миграции waybills.truck/trailer/drv1/drv2 были просто текстовыми полями,
-- вводимыми вручную (позывной/ФИО как строка). Меняем архитектуру создания путёвки:
-- теперь тягач/прицеп/водители выбираются из уже существующих Подвижного состава (fleet),
-- Транспорта и Водителей — по требованию пользователя 2026-07-15 ("должен выбираться из
-- подвижного состава, сразу выставлять данные из ПС, выбор водителя тоже из списка").
--
-- truck/trailer/drv1/drv2 (текстовые) НЕ удаляются — путёвка это документ на момент
-- времени, печатный бланк не должен задним числом меняться, если потом переименуют
-- машину или водителя. Новые *_id колонки — это ссылка для автозаполнения/связи,
-- текстовые остаются как снимок (что действительно было напечатано).
alter table waybills
  add column fleet_id      uuid references fleet(id) on delete set null,
  add column truck_id      uuid references transport(id) on delete set null,
  add column trailer_id    uuid references transport(id) on delete set null,
  add column driver1_id    uuid references people(id) on delete set null,
  add column driver2_id    uuid references people(id) on delete set null,
  add column mileage_start numeric,
  add column dep_time      text,   -- 'HH:MM', не time — печатается как есть, часовой пояс не нужен
  add column prefix        text,   -- префикс, применённый при выдаче номера (снимок настройки на тот момент)
  add column full_num      text;   -- готовый номер с префиксом, напр. 'МНП-013'
