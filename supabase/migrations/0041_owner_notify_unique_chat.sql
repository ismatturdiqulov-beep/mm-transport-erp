-- MM Transport ERP — миграция 41: уникальность chat_id в owner_notify
-- (2026-08-10). upsert(..., {onConflict:'chat_id'}) в telegram-webhook требует
-- реального unique-ограничения на этом поле, иначе Postgres не поймёт, что
-- считать конфликтом — забыл добавить сразу в 0040.
alter table owner_notify add constraint owner_notify_chat_id_key unique (chat_id);
