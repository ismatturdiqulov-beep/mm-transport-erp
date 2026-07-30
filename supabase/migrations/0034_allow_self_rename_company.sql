-- MM Transport ERP — миграция 33: разрешить компании самой менять своё название
-- (2026-07-23). Раньше companies.name было в списке billing-полей, доступных на
-- запись только владельцу платформы (0014) — решение было обосновано тем, что
-- название компании фигурирует в SaaS-админке владельца. На практике это неудобно
-- при онбординге новых реальных клиентов: каждое переименование (например, из
-- "Демо-компания N" в реальное название) требовало владельца платформы вручную
-- через admin.html. Название компании само по себе не билинговое поле (не влияет
-- на account_type/subscription_status/оплату) — оставляем защищёнными только
-- реально чувствительные поля.
create or replace function protect_billing_fields_from_non_owner()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if not is_owner() then
    if new.subscription_status is distinct from old.subscription_status
      or new.account_type is distinct from old.account_type
      or new.paid_until is distinct from old.paid_until
      or new.plan is distinct from old.plan
      or new.trial_ends_at is distinct from old.trial_ends_at
      or new.admin_note is distinct from old.admin_note
      or new.contact_name is distinct from old.contact_name
      or new.contact_phone is distinct from old.contact_phone
      or new.contact_email is distinct from old.contact_email
    then
      raise exception 'Эти поля может менять только владелец платформы';
    end if;
  end if;
  return new;
end;
$$;
