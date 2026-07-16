-- MM Transport ERP — миграция 26: валюта оплаты по рейсу
-- (2026-07-19). Волонтёры просят принимать оплату от заказчиков в разных валютах
-- (в первую очередь USD). trip_expenses уже умеет так (currency/fx_rate/amount_orig,
-- сумма конвертируется в сум при вводе и в таком виде уходит в кассу) — делаем
-- trip_payments по той же схеме для единообразия. Отдельного валютного кошелька
-- не заводим (решение пользователя 2026-07-19) — касса остаётся в сумах.
alter table trip_payments add column currency text not null default 'UZS';
alter table trip_payments add column fx_rate numeric;
alter table trip_payments add column amount_orig numeric;
