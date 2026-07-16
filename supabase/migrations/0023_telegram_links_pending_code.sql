-- MM Transport ERP — миграция 23: фундамент для подключения контрагентов к Telegram-боту
-- (2026-07-18). Таблицы telegram_links/driver_messages/notification_log существуют с
-- 0001_init.sql и уже имеют рабочий RLS (0005/0006) — их никто не трогал, просто до
-- сих пор не было ни одной строки. Один реальный пробел в схеме: telegram_user_id был
-- "not null", а сама придуманная схема подключения ("диспетчер генерирует код → отдаёт
-- водителю/арендатору → тот пишет боту /start <код> → бот дозаполняет telegram_user_id")
-- требует создавать строку ДО того, как telegram_user_id вообще известен.
alter table telegram_links alter column telegram_user_id drop not null;

-- Уникальность кода — чтобы бот, получив /start <код>, однозначно находил одну запись
-- (частичный индекс: NULL-ы не участвуют, коллизий между "нет активного кода" не бывает).
create unique index telegram_links_code_uniq on telegram_links(link_code) where link_code is not null;
