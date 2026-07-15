-- MM Transport ERP — миграция 15: доверенности и трудовые договоры оформляются на
-- конкретного водителя, у которого в разделе "Водители" уже есть паспортные данные —
-- добавляем ссылку на person вместо повторного ручного ввода (тот же принцип, что
-- уже применён для путёвок: выбор из списка, автозаполнение). Текстовые поля
-- name/passport остаются как снимок на момент выдачи документа (см. обоснование
-- в 0013 для waybills — печатный документ не должен меняться задним числом).
alter table poa
  add column person_id uuid references people(id) on delete set null,
  add column kind       text default 'customs' check (kind in ('customs','asmap','visa'));
comment on column poa.kind is 'customs = представление в таможне/госорганах; asmap = представление в АСМАП/МДП (двуязычный бланк); visa = просто отметка о визе, не печатается системой';

alter table labor
  add column person_id            uuid references people(id) on delete set null,
  add column passport_issued_by   text,
  add column passport_issued_date date,
  add column probation_months     numeric default 3,
  add column plan_revenue         numeric default 1000000;
