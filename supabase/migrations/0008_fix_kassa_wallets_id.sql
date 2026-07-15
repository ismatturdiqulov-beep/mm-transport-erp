-- MM Transport ERP — миграция 8: исправление типа kassa_wallets.id.
--
-- В приложении кошельки — это небольшой справочник с человекочитаемыми id-слагами
-- ('cash','card','bank', либо придуманные пользователем при добавлении своего кошелька),
-- и именно эти слаги хранятся как значение в kassa.wallet / finance.wallet / trip_expenses.wallet
-- по всему приложению (текстовое поле, не формальный внешний ключ). 0001_init.sql ошибочно
-- сделал kassa_wallets.id обычным uuid со случайной генерацией — из-за этого при переносе
-- данных id кошелька менялся на случайный uuid, а везде, где на него ссылались текстом
-- ('cash' и т.п.), значение оставалось прежним — связь бы просто потерялась.
alter table kassa_wallets alter column id drop default;
alter table kassa_wallets alter column id type text;
