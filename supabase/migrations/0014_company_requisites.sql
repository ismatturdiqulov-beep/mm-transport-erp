-- MM Transport ERP — миграция 14: реквизиты компании для печатных документов
-- (доверенности, трудовые договоры, а в перспективе — акты сверки и отчёты,
-- где сейчас жёстко зашито "ООО «ММ Транспорт»" в самом JS-коде).
--
-- Раньше это было нормально — систему использовала только одна компания.
-- Теперь, когда цель продавать по подписке другим компаниям (см. 0004),
-- название/адрес/банк/директор должны быть данными самой компании, а не кодом.
--
-- logo_url зарезервирован на будущее (загрузка своего фирменного бланка с
-- логотипом) — пользователь явно попросил заложить фундамент, но пока
-- заполнять/показывать логотип не нужно, только текстовые реквизиты.
alter table companies
  add column address        text,
  add column phone          text,
  add column email          text,
  add column bank_account   text,
  add column bank_name      text,
  add column inn            text,
  add column mfo            text,
  add column oked           text,
  add column director_name  text,
  add column logo_url       text;

-- ============================================================
-- Реквизиты — операционные данные самой компании, поэтому любой сотрудник
-- компании (не только владелец платформы) должен уметь их заполнить/поменять
-- себе в Настройках. Но billing-поля (subscription_status, account_type,
-- paid_until, plan, trial_ends_at, admin_note, contact_*, name) должны
-- остаться доступны на запись только владельцу платформы — это решение уже
-- было явно зафиксировано в 0005 ("компания не может сама себе поменять
-- subscription_status"). RLS работает на уровне строки, а не колонки, поэтому
-- разграничение по конкретным полям делаем триггером.
-- ============================================================
create policy self_company_update_requisites on companies for update to authenticated
  using (id = current_profile_company_id())
  with check (id = current_profile_company_id());

create or replace function protect_billing_fields_from_non_owner()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if not is_owner() then
    if new.name is distinct from old.name
      or new.subscription_status is distinct from old.subscription_status
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

create trigger trg_protect_billing_fields
before update on companies
for each row execute function protect_billing_fields_from_non_owner();
