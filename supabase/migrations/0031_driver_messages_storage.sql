-- MM Transport ERP — миграция 31: хранилище для фото/голосовых от водителей через бота
-- (2026-07-20). Приватный bucket — файл-путь всегда начинается с company_id/, поэтому
-- политика ниже даёт доступ на чтение только пользователям той же компании (то же
-- правило изоляции, что и везде: is_owner() тут НЕ используется — это бизнес-данные
-- конкретного арендатора, владельцу платформы они не должны быть видны, см.
-- [[mm-transport-data-privacy-principle]]). Запись делает только сама Edge Function
-- (service_role, минуя RLS), приложению писать сюда не нужно.
insert into storage.buckets (id, name, public)
values ('driver-messages', 'driver-messages', false)
on conflict (id) do nothing;

create policy "company_read_own_driver_messages"
on storage.objects for select
to authenticated
using (
  bucket_id = 'driver-messages'
  and (storage.foldername(name))[1] = current_profile_company_id()::text
);
