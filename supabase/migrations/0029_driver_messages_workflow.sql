-- MM Transport ERP — миграция 29: воркфлоу сообщений от водителей/арендодателей в Telegram-бот
-- (2026-07-20). Диспетчер обрабатывает входящее сообщение одной из трёх кнопок:
-- «Принять» (работа берётся в работу, диспетчер пишет срок выполнения),
-- «Отклонить» (невозможно выполнить, диспетчер пишет причину),
-- «Не по работе» (стандартный ответ — просим написать диспетчеру лично, не засорять бота).
-- Плюс: если за контрагентом закреплено больше одного ПС, бот сначала спрашивает,
-- по какой машине сообщение — fleet_id хранит этот выбор (null, если ПС было одно
-- и уточнение не потребовалось). voice_url — сообщения принимаем и голосом, не только
-- текстом/фото, изначально в схеме этого не было.
alter table driver_messages drop constraint driver_messages_status_check;
alter table driver_messages add constraint driver_messages_status_check
  check (status = any (array['new','accepted','rejected','irrelevant']));

alter table driver_messages add column fleet_id uuid references fleet(id);
alter table driver_messages add column response_text text;
alter table driver_messages add column voice_url text;
