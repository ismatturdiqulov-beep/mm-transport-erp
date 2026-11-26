-- Блок «Ангрен Каолин» — миграция 15 (2026-11-26): 0064 пересоздала ak_requests_before
-- через create or replace — это сбрасывает security definer, выставленный в 0055, и
-- изменение выпущенной заявки снова упёрлось бы в запрет записи версий. Возвращаем.
-- (Урок: после create or replace функции с особыми правами — проверять prosecdef.)
alter function ak_requests_before() security definer;
