-- Блок «Ангрен Каолин» — миграция 21 (2026-11-26): Telegram-бот (этап 5).
--
-- Решения владельца:
--   * отдельный бот (@angren_kaolin_uchet_bot), токен — секрет AK_TELEGRAM_BOT_TOKEN;
--   * группа «Перевозки» (там есть и Зафар) — бот ТОЛЬКО читает, ничего не пишет;
--     группа «Расчёты» (только Исмат и Сарвар) — весь вывод бота;
--   * сообщения в свободной форме: бот только ПРЕДЛАГАЕТ запись; в учёт она попадает
--     после подтверждения Исмата (кнопкой в Telegram или на сайте);
--   * кошелёк не указан — спросить кнопками, напоминать каждое утро; 3 дня без ответа —
--     расход записывается как оплаченный лично автором сообщения (фин. помощь).
-- Все таблицы пишет только бот (service role); браузер читает.

create table ak_tg_chats (
  chat_id     bigint primary key,
  title       text,
  type        text,
  role        text check (role in ('transport', 'finance')),   -- назначает владелец на сайте
  last_seen   timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create table ak_tg_users (
  tg_user_id   bigint primary key,
  username     text,
  first_name   text,
  last_name    text,
  partner_key  text check (partner_key in ('ismat', 'sarvar')),   -- кто это из партнёров
  last_seen    timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create table ak_tg_messages (
  id                   bigserial primary key,
  chat_id              bigint not null,
  message_id           bigint not null,
  tg_user_id           bigint,
  sent_at              timestamptz not null,
  text                 text,
  file_id              text,
  file_kind            text check (file_kind in ('photo', 'document')),
  file_name            text,
  mime                 text,
  reply_to_message_id  bigint,
  raw                  jsonb,
  parsed_at            timestamptz,
  parse_error          text,
  created_at           timestamptz not null default now(),
  unique (chat_id, message_id)
);
create index ak_tg_messages_recent on ak_tg_messages (sent_at desc);

-- Предложения бота «ждут подтверждения».
create table ak_inbox (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  source_chat_id    bigint,
  source_message_id bigint,
  author_tg_user_id bigint,
  author_partner    text check (author_partner in ('ismat', 'sarvar')),
  kind              text not null,         -- тип действия (request, trucks, prices, factory_income, …)
  summary           text not null,         -- человеческое описание
  proposal          jsonb not null,        -- разобранные поля
  status            text not null default 'pending'
                    check (status in ('pending', 'needs_wallet', 'applied', 'rejected', 'error')),
  wallet            text,                  -- выбранный кошелёк (или 'personal')
  wallet_asks       integer not null default 0,
  last_asked_at     timestamptz,
  result            jsonb,
  error             text,
  decided_by_tg     bigint,
  decided_by_user   uuid,
  decided_at        timestamptz,
  tg_message_id     bigint                 -- сообщение бота с кнопками в «Расчётах»
);
create index ak_inbox_status on ak_inbox (status, created_at);

do $$
declare t text;
begin
  foreach t in array array['ak_tg_chats', 'ak_tg_users', 'ak_tg_messages', 'ak_inbox'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy ak_read on %I for select to authenticated using (ak_can_read())', t);
    execute format('revoke all on %I from anon', t);
    execute format('revoke insert, update, delete, truncate on %I from authenticated', t);
  end loop;
  execute 'create trigger ak_audit after insert or update or delete on ak_inbox for each row execute function ak_audit()';
  execute 'create trigger ak_audit after insert or update or delete on ak_tg_chats for each row execute function ak_audit(''chat_id'')';
  execute 'create trigger ak_audit after insert or update or delete on ak_tg_users for each row execute function ak_audit(''tg_user_id'')';
end $$;

-- Назначения с сайта (владелец): роль группы, кто из партнёров пишет.
create or replace function ak_tg_set_chat_role(p_chat_id bigint, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not ak_is_owner() then raise exception 'Нет прав'; end if;
  if p_role is not null and p_role not in ('transport', 'finance') then raise exception 'Неверная роль'; end if;
  update ak_tg_chats set role = null where role = p_role and p_role is not null and chat_id <> p_chat_id;   -- у роли одна группа
  update ak_tg_chats set role = p_role where chat_id = p_chat_id;
end $$;
create or replace function ak_tg_set_user_partner(p_tg_user_id bigint, p_partner text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not ak_is_owner() then raise exception 'Нет прав'; end if;
  if p_partner is not null and p_partner not in ('ismat', 'sarvar') then raise exception 'Неверный партнёр'; end if;
  update ak_tg_users set partner_key = null where partner_key = p_partner and p_partner is not null and tg_user_id <> p_tg_user_id;
  update ak_tg_users set partner_key = p_partner where tg_user_id = p_tg_user_id;
end $$;
grant execute on function ak_tg_set_chat_role(bigint, text), ak_tg_set_user_partner(bigint, text) to authenticated;
revoke execute on function ak_tg_set_chat_role(bigint, text), ak_tg_set_user_partner(bigint, text) from anon;

-- Бот (service role) выполняет записи от имени подтвердившего владельца: проверки прав
-- в функциях движения денег (ak_is_owner) пропускают service role. RLS service role и так
-- не касается, а браузер service role не получает никогда.
create or replace function ak_is_owner()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce(auth.role() = 'service_role', false)
      or exists(select 1 from ak_members where user_id = auth.uid() and active and role = 'owner')
$$;
