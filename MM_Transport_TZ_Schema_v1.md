# MM Transport ERP — ТЗ на облачную БД и Telegram-бота (v1)

Дата: 14.07.2026
Текущая версия системы: v23/v24 (Single HTML, localStorage)
Цель документа: зафиксировать схему БД для перехода на Supabase (Фаза 1-2 плана) с учётом требований будущего Telegram-бота, чтобы делать миграцию один раз, а не переделывать.

---

## 1. Принципы

- Каждая текущая localStorage-таблица (`TIRS`, `DOZV`, `KONTRAGENTY`, `FINANCE`, `KASSA`, `TRIPS`, `PEOPLE`, `FLEET`, `TRANSPORT`, `MAINTENANCE`, `WAYBILLS`, `KASSA_WALLETS` и т.д.) → отдельная таблица Postgres.
- `id` везде `uuid` (замена текущего `genId()`).
- Даты — `date` или `timestamptz`, а не строки.
- Всё, что сейчас "гибкие вложенные объекты" (например `legs[]`, `docs[]`, `expenses[]` внутри `trip`) — выносим в отдельные таблицы со связью по `trip_id`, чтобы можно было фильтровать/агрегировать на уровне БД (сейчас это одна из причин бага `find()` vs `filter()` — на реляционной модели он в принципе невозможен).
- Мультитенантность (Фаза 4) закладываем сразу полем `company_id` в ключевых таблицах, даже если сейчас работает одна компания — это дешевле сделать сейчас, чем мигрировать данные позже.
- RLS (Row Level Security) включаем с первого дня в Supabase, даже до появления логина — так безопаснее и не придётся ничего переделывать в Фазе 2.

---

## 2. Основные сущности (из текущей системы)

### companies (заготовка под SaaS, Фаза 4)
```
id            uuid pk
name          text
created_at    timestamptz default now()
```
Пока одна запись = ваша компания. Все таблицы ниже получают `company_id uuid references companies(id)`.

### kontragenty
```
id             uuid pk
company_id     uuid references companies(id)
name           text not null
short          text
type           text  -- 'tenant' | 'driver_mm' | 'client' | 'service' | 'other'
phone          text
passport       text
pinfl          text
active         boolean default true
contract_num   text
contract_date  date
contract_end   date
note           text
created_at     timestamptz default now()
```

### people (водители)
```
id             uuid pk
company_id     uuid references companies(id)
kontragent_id  uuid references kontragenty(id)
name           text not null
short          text
pinfl          text
birth          date
phone          text
passport       text
address        text
active         boolean default true
note           text
created_at     timestamptz default now()
```

### person_docs (документы водителя — было docs[] внутри people)
```
id           uuid pk
person_id    uuid references people(id)
doc_type     text
doc_number   text
issued       date
expires      date
note         text
```

### fleet (тягач+прицеп+контрагент)
```
id             uuid pk
company_id     uuid references companies(id)
kontragent_id  uuid references kontragenty(id)
truck_id       uuid references transport(id)
trailer_id     uuid references transport(id)
active         boolean default true
created_at     timestamptz default now()
```

### transport (весь транспорт: тягачи, прицепы, легковой)
```
id            uuid pk
company_id    uuid references companies(id)
type          text   -- 'truck' | 'trailer' | 'other'
plate         text
brand         text
model         text
year          int
vin           text
osago_expires date
mileage       numeric
active        boolean default true
note          text
created_at    timestamptz default now()
```

### tirs (ТИР карнеты)
```
id                uuid pk
company_id        uuid references companies(id)
num               text
type              text
received          date
expires           date
person_id         uuid references people(id)
plate             text
transferred       date
returned_office   date
returned_asmap    date
used              boolean
comp              numeric default 0
buy_price         numeric
trip_id           uuid references trips(id)
note              text
created_at        timestamptz default now()
```

### dozv (дозволы)
```
id                uuid pk
company_id        uuid references companies(id)
country           text
kind              text
epermit           boolean
num               text
received          date
expires           date
issued            date
person_id         uuid references people(id)
plate             text
fleet_id          uuid references fleet(id)
returned_office   date
returned_mt       date
used              boolean
comp              numeric default 0
buy_price         numeric
trip_id           uuid references trips(id)
created_at        timestamptz default now()
```

### trips (рейсы)
```
id             uuid pk
company_id     uuid references companies(id)
trip_num       text          -- MM-2026-0001
type           text
status         text          -- 10 текущих статусов
fleet_id       uuid references fleet(id)
truck_id       uuid references transport(id)
trailer_id     uuid references transport(id)
driver_id      uuid references people(id)
load_date      date
unload_date    date
km_start       numeric
km_end         numeric
fuel_start     numeric
fuel_end       numeric
adblue_start   numeric
adblue_end     numeric
advance_paid   numeric default 0
note           text
created_at     timestamptz default now()
```

### trip_legs (плечи рейса — было legs[] внутри trip)
```
id            uuid pk
trip_id       uuid references trips(id)
leg_num       int
from_point    text
to_point      text
client_id     uuid references kontragenty(id)
rate          numeric
rate_final    numeric
cargo         text
load_date     date
unload_date   date
```

### trip_expenses (расходы в рейсе — было expenses[] внутри trip)
```
id            uuid pk
trip_id       uuid references trips(id)
date          date
category      text
amount        numeric
currency      text
fx_rate       numeric
wallet        text
liters        numeric
note          text
source        text default 'manual'   -- 'manual' | 'telegram_bot' (см. раздел бота)
created_at    timestamptz default now()
```

### trip_payments (оплаты от заказчика — было payments[] внутри trip)
```
id            uuid pk
trip_id       uuid references trips(id)
date          date
amount        numeric
method        text
note          text
```

### trip_surcharges (штрафы/доплаты, привязаны к плечу — v24)
```
id            uuid pk
trip_id       uuid references trips(id)
leg_id        uuid references trip_legs(id)
category      text     -- TRIP_SURCHARGE_CATS
amount        numeric
note          text
created_at    timestamptz default now()
```

### finance (начисления/оплаты по контрагентам)
```
id             uuid pk
company_id     uuid references companies(id)
date           date
fleet_id       uuid references fleet(id)
kontragent_id  uuid references kontragenty(id)
person_name    text
type           text   -- 'charge' | 'payment' | 'vacation'
category       text
description    text
amount         numeric default 0
paid           numeric default 0
wallet         text
created_at     timestamptz default now()
```

### kassa (движения по кассе)
```
id            uuid pk
company_id    uuid references companies(id)
wallet        text
type          text   -- 'income' | 'expense' | 'transfer' | 'trip_payment' | 'payout'
date          date
category      text
from_name     text
to_name       text
description   text
amount        numeric
created_at    timestamptz default now()
```

### kassa_wallets (динамические кошельки)
```
id           uuid pk
company_id   uuid references companies(id)
name         text
hidden       boolean default false
sort_order   int
```

### maintenance (ТО и ремонты)
```
id             uuid pk
company_id     uuid references companies(id)
transport_id   uuid references transport(id)
date           date
mileage        numeric
works          jsonb    -- комплекс работ, несколько позиций
cost           numeric
service_kontragent_id uuid references kontragenty(id)
next_planned_km  numeric
note           text
created_at     timestamptz default now()
```

### waybills (путёвки/документооборот)
```
id            uuid pk
company_id    uuid references companies(id)
trip_id       uuid references trips(id)
type          text
issued_date   date
note          text
```

---

## 3. Таблицы под Telegram-бота

### telegram_links (привязка Telegram-аккаунта к контрагенту — универсально, без деления на роли)
```
id                uuid pk
company_id        uuid references companies(id)
kontragent_id     uuid references kontragenty(id) not null   -- единая точка привязки для любой роли
telegram_user_id  bigint not null unique
telegram_username text
link_code         text        -- одноразовый код для /start <код>
linked_at         timestamptz
active            boolean default true
```
**Важное решение (14.07.2026):** привязка всегда идёт через `kontragent_id`, без деления на "это водитель" / "это арендатор". Причина — один и тот же человек часто одновременно и владелец (арендатор), и водитель. Правила уведомлений едины для всех: боту не важно, кто перед ним по типу — он просто проверяет, какие данные реально существуют для этого контрагента:
- есть операции в `finance`/`kassa` на этот `kontragent_id` → шлём финансовые уведомления
- есть записи в `people` с этим `kontragent_id`, а на них — `tirs`/`dozv` → шлём уведомления по документам

Один человек с одним Telegram-аккаунтом получает и то, и другое без отдельной настройки.

Логика привязки: в веб-системе для контрагента генерируется `link_code` → человек пишет боту `/start <код>` → бот сохраняет `telegram_user_id` в `telegram_links`.

### driver_messages (инбокс расходов от водителей)
```
id                uuid pk
company_id        uuid references companies(id)
telegram_link_id  uuid references telegram_links(id)
trip_id           uuid references trips(id)      -- если удалось определить активный рейс, иначе null
message_text      text
photo_url         text          -- ссылка на фото чека (облачное хранилище)
status            text default 'new'   -- 'new' | 'processed'
processed_expense_id uuid references trip_expenses(id)  -- заполняется, когда диспетчер внёс расход
processed_by      text
processed_at      timestamptz
created_at        timestamptz default now()
```

### notification_log (журнал отправленных уведомлений — финансы, документы, сроки)
```
id                uuid pk
company_id        uuid references companies(id)
telegram_link_id  uuid references telegram_links(id)
event_type        text     -- 'finance_charge' | 'finance_payment' | 'doc_issued' | 'doc_returned' | 'doc_expiring'
ref_table         text     -- 'finance' | 'tirs' | 'dozv' | ...
ref_id            uuid
message_text      text
sent_at           timestamptz default now()
delivery_status   text default 'sent'   -- 'sent' | 'failed'
```
Нужен, чтобы: 1) не отправлять дубли уведомлений, 2) иметь историю на случай спора "мне не пришло уведомление".

---

## 4. Логика уведомлений бота (события → триггеры)

Правило универсальное: получатель определяется через `telegram_links.kontragent_id`, а дальше — через `people.kontragent_id` (если у контрагента есть привязанные водители/записи people). Роль человека (владелец/водитель/оба) значения не имеет — если у него есть соответствующие данные, уведомление уйдёт.

| Событие в системе | Таблица-источник | Кому (через kontragent_id) | Текст |
|---|---|---|---|
| Начисление/списание Л/С | `finance`/`kassa` insert | контрагент напрямую (`finance.kontragent_id`) | сумма операции + текущий баланс |
| Выдача ТИР | `tirs.transferred` заполнено | контрагент через `people.kontragent_id` (`tirs.person_id → people.kontragent_id`) | номер ТИР, срок действия |
| Возврат ТИР в офис | `tirs.returned_office` заполнено | тот же путь | подтверждение приёма |
| Выдача дозвола | `dozv.issued` заполнено | тот же путь | номер, страна, срок |
| Возврат дозвола | `dozv.returned_office`/`returned_mt` | тот же путь | подтверждение |
| Скорое истечение документа | ежедневный cron-проверка `tirs.expires`/`dozv.expires`/`person_docs.expires` за N дней (аналог алертов дашборда) | тот же путь | "истекает через 20 дней" |
| Запрос баланса/документов на руках | по команде от пользователя боту | контрагент | баланс (finance) + список ТИР/дозволов по всем people этого kontragent_id, где `used=false` |

Технически: реализуется либо через **database triggers + Edge Function webhook**, либо через **периодический опрос** новых записей (проще в поддержке для не-программиста, но чуть медленнее). Рекомендую начать с простого варианта: Edge Function по cron (раз в 1-2 минуты проверяет новые записи finance/tirs/dozv, отправляет уведомления, помечает как отправленные через `notification_log`).

---

## 5. Что уже решено и не обсуждается заново

- Только свой автопарк, партнёрские/экспедиторские рейсы — не в системе (внешние журналы).
- Расходы от водителя в боте — БЕЗ автопарсинга и БЕЗ диалоговой машины состояний: свободный текст/фото → диспетчер вручную вносит и подтверждает.
- Уведомления — односторонние, бот не принимает решения, только информирует и передаёт расходы диспетчеру.
- **Нет деления получателей по ролям** (водитель/арендатор/владелец) — один и тот же человек часто совмещает роли. Привязка Telegram и все уведомления идут через единый `kontragent_id`; какие именно уведомления получает человек — определяется наличием у него данных (финансы/документы), а не заранее заданной ролью.
- Документы (сканы, фото) хранятся у клиента в облаке (Google Drive/Yandex Disk), в БД — только ссылка.

---

## 6. Порядок работ дальше (Claude Code)

1. Создать Supabase-проект, применить эту схему как первую миграцию (`supabase/migrations/0001_init.sql`).
2. Включить RLS на всех таблицах (пока — политика "разрешено всем service-role", логин появится в Фазе 2).
3. Написать скрипт миграции данных из текущего localStorage JSON (экспорт) → INSERT в Postgres.
4. Переключить фронтенд с `ld()/saveAll()` на Supabase JS client (постепенно, модуль за модулем).
5. Только после того как основной фронт стабильно работает на Supabase — разворачивать Telegram Edge Function бота.

---

*Документ рабочий, дополняется по ходу проектирования.*
