-- MM Transport ERP — миграция 27: валюта ставки по плечу рейса
-- (2026-07-19). Ставка (frakht) на рейс/плечо тоже нужно уметь вводить в валюте
-- (та же просьба волонтёров, что и для оплаты от заказчика в 0026) — та же схема:
-- rate хранит сумму в сумах (для всех расчётов/отчётов как раньше), rate_orig/currency/
-- fx_rate хранят исходный ввод для отображения. rate_final (уточнение ставки при
-- завершении рейса) валюту пока не получает — вне текущего запроса пользователя.
alter table trip_legs add column currency text not null default 'UZS';
alter table trip_legs add column fx_rate numeric;
alter table trip_legs add column rate_orig numeric;
