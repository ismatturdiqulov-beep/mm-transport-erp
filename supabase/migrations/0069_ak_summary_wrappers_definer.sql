-- Блок «Ангрен Каолин» — миграция 19 (2026-11-26): обёртки ak_summary / ak_partners
-- вызывают ядро (ak_summary_core / ak_partners_core), которое закрыто от прямого вызова
-- из браузера, — поэтому обёртки выполняются с правами владельца функции. Доступ по-
-- прежнему проверяется внутри (ak_can_read() — по auth.uid() вызывающего). Найдено тестом.
alter function ak_summary(date, date) security definer;
alter function ak_partners(date) security definer;
