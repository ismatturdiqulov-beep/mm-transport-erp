-- MM Transport ERP — миграция 25: убрать is_owner() обход RLS с операционных данных
-- (2026-07-19). До этой миграции is_owner()=true обходил RLS на ВСЕХ таблицах,
-- включая бизнес-данные каждого арендатора (контрагенты, рейсы, касса, ТИР/Дозволы
-- и т.д.) — это было задумано под будущую admin-панель (admin.html), но на практике
-- означало, что единственный владельческий логин видел вперемешку свои данные,
-- тестовые и волонтёрские прямо в обычном приложении (index.html), т.к. RLS не
-- различает "открыт admin.html" от "открыт index.html" — только роль профиля.
-- По явному требованию пользователя (2026-07-19): чужие бизнес-данные должны быть
-- приватны и недоступны даже владельцу платформы через обычный вход.
--
-- admin.html работает только с companies / profiles / company_billing — там
-- is_owner() обход сохранён (см. миграции 0005/0006), это легитимно нужно для
-- управления подписками и списком пользователей. Здесь обход убирается со всех
-- остальных (операционных) таблиц — теперь единственный путь увидеть чужие данные
-- через RLS закрыт полностью, независимо от роли.

alter policy "company_scoped" on company_settings
  using (company_id = current_profile_company_id())
  with check (company_id = current_profile_company_id());

alter policy "company_scoped" on kontragenty
  using ((company_id = current_profile_company_id()) and company_access_allowed(company_id))
  with check ((company_id = current_profile_company_id()) and company_access_allowed(company_id));

alter policy "company_scoped" on people
  using ((company_id = current_profile_company_id()) and company_access_allowed(company_id))
  with check ((company_id = current_profile_company_id()) and company_access_allowed(company_id));

alter policy "company_scoped" on transport
  using ((company_id = current_profile_company_id()) and company_access_allowed(company_id))
  with check ((company_id = current_profile_company_id()) and company_access_allowed(company_id));

alter policy "company_scoped" on fleet
  using ((company_id = current_profile_company_id()) and company_access_allowed(company_id))
  with check ((company_id = current_profile_company_id()) and company_access_allowed(company_id));

alter policy "company_scoped" on tirs
  using ((company_id = current_profile_company_id()) and company_access_allowed(company_id))
  with check ((company_id = current_profile_company_id()) and company_access_allowed(company_id));

alter policy "company_scoped" on dozv
  using ((company_id = current_profile_company_id()) and company_access_allowed(company_id))
  with check ((company_id = current_profile_company_id()) and company_access_allowed(company_id));

alter policy "company_scoped" on trips
  using ((company_id = current_profile_company_id()) and company_access_allowed(company_id))
  with check ((company_id = current_profile_company_id()) and company_access_allowed(company_id));

alter policy "company_scoped" on finance
  using ((company_id = current_profile_company_id()) and company_access_allowed(company_id))
  with check ((company_id = current_profile_company_id()) and company_access_allowed(company_id));

alter policy "company_scoped" on kassa
  using ((company_id = current_profile_company_id()) and company_access_allowed(company_id))
  with check ((company_id = current_profile_company_id()) and company_access_allowed(company_id));

alter policy "company_scoped" on kassa_wallets
  using ((company_id = current_profile_company_id()) and company_access_allowed(company_id))
  with check ((company_id = current_profile_company_id()) and company_access_allowed(company_id));

alter policy "company_scoped" on maintenance
  using ((company_id = current_profile_company_id()) and company_access_allowed(company_id))
  with check ((company_id = current_profile_company_id()) and company_access_allowed(company_id));

alter policy "company_scoped" on waybills
  using ((company_id = current_profile_company_id()) and company_access_allowed(company_id))
  with check ((company_id = current_profile_company_id()) and company_access_allowed(company_id));

alter policy "company_scoped" on poa
  using ((company_id = current_profile_company_id()) and company_access_allowed(company_id))
  with check ((company_id = current_profile_company_id()) and company_access_allowed(company_id));

alter policy "company_scoped" on labor
  using ((company_id = current_profile_company_id()) and company_access_allowed(company_id))
  with check ((company_id = current_profile_company_id()) and company_access_allowed(company_id));

alter policy "company_scoped" on telegram_links
  using ((company_id = current_profile_company_id()) and company_access_allowed(company_id))
  with check ((company_id = current_profile_company_id()) and company_access_allowed(company_id));

alter policy "company_scoped" on driver_messages
  using ((company_id = current_profile_company_id()) and company_access_allowed(company_id))
  with check ((company_id = current_profile_company_id()) and company_access_allowed(company_id));

alter policy "company_scoped" on notification_log
  using ((company_id = current_profile_company_id()) and company_access_allowed(company_id))
  with check ((company_id = current_profile_company_id()) and company_access_allowed(company_id));

alter policy "company_scoped" on person_docs
  using (exists (select 1 from people p where p.id = person_docs.person_id and p.company_id = current_profile_company_id() and company_access_allowed(p.company_id)))
  with check (exists (select 1 from people p where p.id = person_docs.person_id and p.company_id = current_profile_company_id() and company_access_allowed(p.company_id)));

alter policy "company_scoped" on trip_legs
  using (exists (select 1 from trips t where t.id = trip_legs.trip_id and t.company_id = current_profile_company_id() and company_access_allowed(t.company_id)))
  with check (exists (select 1 from trips t where t.id = trip_legs.trip_id and t.company_id = current_profile_company_id() and company_access_allowed(t.company_id)));

alter policy "company_scoped" on trip_expenses
  using (exists (select 1 from trips t where t.id = trip_expenses.trip_id and t.company_id = current_profile_company_id() and company_access_allowed(t.company_id)))
  with check (exists (select 1 from trips t where t.id = trip_expenses.trip_id and t.company_id = current_profile_company_id() and company_access_allowed(t.company_id)));

alter policy "company_scoped" on trip_payments
  using (exists (select 1 from trips t where t.id = trip_payments.trip_id and t.company_id = current_profile_company_id() and company_access_allowed(t.company_id)))
  with check (exists (select 1 from trips t where t.id = trip_payments.trip_id and t.company_id = current_profile_company_id() and company_access_allowed(t.company_id)));

alter policy "company_scoped" on trip_surcharges
  using (exists (select 1 from trips t where t.id = trip_surcharges.trip_id and t.company_id = current_profile_company_id() and company_access_allowed(t.company_id)))
  with check (exists (select 1 from trips t where t.id = trip_surcharges.trip_id and t.company_id = current_profile_company_id() and company_access_allowed(t.company_id)));
