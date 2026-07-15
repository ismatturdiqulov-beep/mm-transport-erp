-- MM Transport ERP — миграция 11: начальный остаток кошелька (KASSA_INIT в приложении)
-- реально влияет на итоговый баланс кассы, но раньше нигде не сохранялся в схеме —
-- жил только в отдельном объекте localStorage. Добавляем колонку в kassa_wallets.
alter table kassa_wallets add column initial_balance numeric not null default 0;
