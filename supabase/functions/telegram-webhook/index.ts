// MM Transport ERP — Telegram bot webhook (Edge Function)
// Один общий бот на всю платформу (не по одному на компанию — изоляция по company_id,
// как и везде в базе).
//
// Доступ к диалогу с ботом — только у контрагента, имеющего отношение хотя бы к одному
// активному подвижному составу: либо как ответственное лицо (fleet.kontragent_id —
// Арендатор/Собственник), либо как назначенный водитель (fleet.driver_id — Наёмный
// водитель, не отвечает за финансы) — решение пользователя 2026-07-20, уточнено 2026-07-21.
//
// Этап 5 (2026-07-20): приём произвольных сообщений (текст/фото/голос) от контрагента —
// сохраняются в driver_messages со статусом 'new', диспетчер обрабатывает их на сайте
// (не в Telegram — решение пользователя: Telegram только для оповещения/подачи, решение
// диспетчер принимает на сайте, где виден весь контекст). Если за контрагентом закреплено
// больше одной машины — сначала спрашиваем, по какой именно, через inline-кнопки
// (callback_query), чтобы не путать сообщения между несколькими ПС одного человека.

import { createClient } from 'npm:@supabase/supabase-js@2';

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// Разовый секретный код для привязки ЛИЧНОГО Telegram владельца платформы (для
// уведомлений о бэкапах — см. owner_notify, миграция 40) — отдельно от обычной
// привязки контрагентов через telegram_links/link_code. Не хранится в БД, просто
// секрет функции, сравнивается напрямую.
const OWNER_LINK_CODE = Deno.env.get('OWNER_LINK_CODE');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const BTN_BALANCE = '💰 Мой баланс';
const BTN_DOCS = '📋 Мои документы';
const BTN_OPS = '📊 Последние операции';
// Полный доступ (баланс, документы на машину, последние операции) — у Арендаторов
// (type='tenant') и Собственников (type='mm' в базе — под "driver_mm" исторически
// хранится тип, переименованный из "Водитель ММ" в "Собственник" на уровне
// интерфейса 2026-07-21, сама финансовая роль не менялась). Наёмный водитель
// (type='hired_driver', добавлен 2026-07-21) подключается к тому же боту, но видит
// только свои личные документы (права/медсправка/АДР/тахограф) — он не отвечает
// за финансы и не может быть "ответственным лицом" за ПС (fleet.kontragent_id),
// только фактическим водителем (fleet.driver_id) — решение пользователя 2026-07-21.
const tenantKeyboard = {
  keyboard: [[{ text: BTN_BALANCE }, { text: BTN_DOCS }], [{ text: BTN_OPS }]],
  resize_keyboard: true,
};
const driverKeyboard = {
  keyboard: [[{ text: BTN_DOCS }]],
  resize_keyboard: true,
};
function hasFullAccess(kgType: string | null | undefined) {
  return kgType === 'tenant' || kgType === 'mm';
}
function keyboardFor(kgType: string | null | undefined) {
  return hasFullAccess(kgType) ? tenantKeyboard : driverKeyboard;
}

// Админ-меню владельца платформы — запрос по кнопке, а не автоматическая сводка по
// расписанию (решение пользователя 2026-08-10). Работает только с данными ЕГО
// СОБСТВЕННОЙ компании (companies.account_type='admin'), а не компаний-клиентов —
// подтверждено пользователем отдельно.
const BTN_ADMIN_KASSA = '💰 Касса';
const BTN_ADMIN_KONTRAGENTY = '👥 Контрагенты';
const BTN_ADMIN_TIRDOZV = '📋 ТИР/Дозволы';
const BTN_ADMIN_DEADLINES = '⏰ Сроки';
const BTN_ADMIN_DIALOGS = '💬 Диалоги';
const BTN_ADMIN_FLEET = '🚛 ПС';
const adminKeyboard = {
  keyboard: [
    [{ text: BTN_ADMIN_KASSA }, { text: BTN_ADMIN_KONTRAGENTY }],
    [{ text: BTN_ADMIN_TIRDOZV }, { text: BTN_ADMIN_DEADLINES }],
    [{ text: BTN_ADMIN_DIALOGS }, { text: BTN_ADMIN_FLEET }],
  ],
  resize_keyboard: true,
};

async function tg(method: string, payload: any) {
  const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return resp.json();
}

async function sendMessage(chatId: number, text: string, keyboard: any = null) {
  const body: any = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (keyboard) body.reply_markup = keyboard;
  await tg('sendMessage', body);
}

function fmtDate(dateStr: string): string {
  const d = new Date(dateStr);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}
function fmtN(n: number): string {
  return Math.round(n).toLocaleString('ru-RU').replace(/,/g, ' ');
}

// ПС, к которым имеет отношение контрагент — либо как финансово ответственный
// (fleet.kontragent_id: Арендатор/Собственник), либо как фактический водитель
// (fleet.driver_id, через его карточку в people) — Наёмный водитель попадает в бот
// именно вторым путём, решение пользователя 2026-07-21.
async function getKgFleets(kontragentId: string): Promise<{ id: string; label: string }[]> {
  const { data: byKg } = await supabase.from('fleet').select('id, label').eq('kontragent_id', kontragentId).neq('active', false);
  const { data: person } = await supabase.from('people').select('id').eq('kontragent_id', kontragentId).maybeSingle();
  let byDriver: any[] = [];
  if (person) {
    const { data } = await supabase.from('fleet').select('id, label').eq('driver_id', person.id).neq('active', false);
    byDriver = data || [];
  }
  const all = [...(byKg || []), ...byDriver];
  const seen = new Set<string>();
  return all.filter((f: any) => (seen.has(f.id) ? false : (seen.add(f.id), true)));
}

// Тот же расчёт, что и getKontragentBalance() в приложении: баланс по ПС + операции
// без привязки к конкретному ПС (кнопка "+Операция").
async function getBalance(kontragentId: string): Promise<number> {
  const { data: fleets } = await supabase.from('fleet').select('balance').eq('kontragent_id', kontragentId);
  const fleetBal = (fleets || []).reduce((s: number, f: any) => s + Number(f.balance || 0), 0);
  const { data: ops } = await supabase.from('finance').select('type, amount, paid').eq('kontragent_id', kontragentId).is('fleet_id', null);
  const genericCharged = (ops || []).filter((o: any) => o.type === 'charge').reduce((s: number, o: any) => s + Number(o.amount || 0), 0);
  const genericPaid = (ops || []).filter((o: any) => o.type === 'payment' || o.type === 'vacation').reduce((s: number, o: any) => s + Number(o.paid || 0), 0);
  return fleetBal - genericCharged + genericPaid;
}

async function getDocumentsText(kontragentId: string): Promise<string> {
  const { data: fleets } = await supabase.from('fleet').select('id, label').eq('kontragent_id', kontragentId);
  const fleetIds = (fleets || []).map((f: any) => f.id);
  if (!fleetIds.length) return 'За вами не закреплён подвижной состав.';

  const { data: tirs } = await supabase
    .from('tirs')
    .select('num, type, expires, fleet_id')
    .in('fleet_id', fleetIds)
    .not('transferred', 'is', null)
    .is('returned_office', null);
  const { data: dozv } = await supabase
    .from('dozv')
    .select('num, country, expires, epermit, closed, returned_office, fleet_id')
    .in('fleet_id', fleetIds)
    .not('issued', 'is', null);
  const heldDozv = (dozv || []).filter((d: any) => (d.epermit ? !d.closed : !d.returned_office));

  const fleetLabel = (id: string) => (fleets || []).find((f: any) => f.id === id)?.label || '';

  const lines: string[] = [];
  (tirs || []).forEach((t: any) => {
    lines.push(`📋 ТИР № ${t.num} (${t.type}) — ${fleetLabel(t.fleet_id)}, до ${fmtDate(t.expires)}`);
  });
  heldDozv.forEach((d: any) => {
    lines.push(`📄 Дозвол № ${d.num} (${d.country}${d.epermit ? ', Е-ПЕРМИТ' : ''}) — ${fleetLabel(d.fleet_id)}${d.expires ? ', до ' + fmtDate(d.expires) : ''}`);
  });

  return lines.length ? lines.join('\n') : 'На руках сейчас нет ни ТИР, ни Дозволов.';
}

const PERSON_DOC_LABELS: Record<string, string> = {
  passport: 'Паспорт', international_passport: 'Загранпаспорт', driver_license: 'Водительское удостоверение',
  mnp: 'Медсправка', tachograph_card: 'Карта тахографа', adr_cert: 'ADR-сертификат',
};
// Личные документы водителя (не машины) — доступны и арендатору, и наёмному водителю,
// если за контрагентом закреплена карточка в разделе "Водители" (people.kontragent_id).
async function getPersonalDocsText(kontragentId: string): Promise<string> {
  const { data: person } = await supabase.from('people').select('id').eq('kontragent_id', kontragentId).maybeSingle();
  if (!person) return 'Личная карточка водителя не найдена.';
  const { data: docs } = await supabase.from('person_docs').select('doc_type, doc_number, expires').eq('person_id', person.id);
  const lines = (docs || [])
    .filter((d: any) => d.doc_number || d.expires)
    .map((d: any) => `🪪 ${PERSON_DOC_LABELS[d.doc_type] || d.doc_type}: № ${d.doc_number || '—'}${d.expires ? ', до ' + fmtDate(d.expires) : ''}`);
  return lines.length ? lines.join('\n') : 'Личные документы пока не заполнены.';
}

// Последние 10 финансовых операций — только для арендаторов (замена полному Акту
// сверки, который по-прежнему нужно запрашивать у диспетчера лично в PDF).
async function getLastOperationsText(kontragentId: string): Promise<string> {
  const { data: rows } = await supabase
    .from('finance')
    .select('date, type, category, description, amount, paid')
    .eq('kontragent_id', kontragentId)
    .order('date', { ascending: false })
    .limit(10);
  if (!rows || !rows.length) return 'Операций пока нет.';
  return rows.map((r: any) => {
    const isCharge = r.type === 'charge';
    const val = isCharge ? r.amount : r.paid;
    return `${isCharge ? '➖' : '➕'} ${fmtDate(r.date)} — ${r.description || r.category || ''}: ${fmtN(Number(val || 0))} сум`;
  }).join('\n');
}

// Скачивает файл у Telegram (нужен токен бота — поэтому только на сервере) и
// перезаливает в приватное хранилище Supabase, чтобы токен бота никогда не попал
// в браузер диспетчера через прямую ссылку на api.telegram.org.
async function relayTelegramFile(fileId: string, companyId: string): Promise<string | null> {
  const info = await tg('getFile', { file_id: fileId });
  if (!info.ok) return null;
  const filePath = info.result.file_path as string;
  const ext = filePath.includes('.') ? filePath.split('.').pop() : 'bin';
  const fileResp = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`);
  const bytes = new Uint8Array(await fileResp.arrayBuffer());
  const storagePath = `${companyId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from('driver-messages').upload(storagePath, bytes, {
    contentType: fileResp.headers.get('content-type') || undefined,
  });
  if (error) return null;
  return storagePath;
}

async function createDriverMessage(opts: {
  companyId: string; telegramLinkId: string; fleetId: string | null;
  messageText: string | null; photoPath: string | null; voicePath: string | null;
}) {
  const { data, error } = await supabase.from('driver_messages').insert({
    company_id: opts.companyId, telegram_link_id: opts.telegramLinkId, fleet_id: opts.fleetId,
    message_text: opts.messageText, photo_url: opts.photoPath, voice_url: opts.voicePath, status: 'new',
  }).select().single();
  return { data, error };
}

// ============================================================================
// Админ-меню владельца платформы (по запросу, не сводкой) — работает только с
// данными компании самого владельца, companies.account_type='admin'.
// ============================================================================

let _adminCompanyIdCache: string | null = null;
async function getAdminCompanyId(): Promise<string | null> {
  if (_adminCompanyIdCache) return _adminCompanyIdCache;
  const { data } = await supabase.from('companies').select('id').eq('account_type', 'admin').maybeSingle();
  _adminCompanyIdCache = data?.id || null;
  return _adminCompanyIdCache;
}

// Касса: остаток по каждому кошельку = initial_balance + приход − расход, как на
// странице "Касса" в приложении. Переводы между кошельками в базе не хранятся типом
// 'transfer' — приложение пишет их парой строк (expense в источник + income в
// назначение, см. transferBetweenWallets в index.html), поэтому отдельная обработка
// 'transfer' не нужна.
async function getKassaSummaryText(companyId: string): Promise<string> {
  const { data: wallets } = await supabase.from('kassa_wallets').select('id, name, icon, initial_balance')
    .eq('company_id', companyId).neq('active', false);
  if (!wallets || !wallets.length) return 'Кошельки не настроены.';
  const { data: ops } = await supabase.from('kassa').select('wallet, type, amount').eq('company_id', companyId);
  const lines = wallets.map((w: any) => {
    const walletOps = (ops || []).filter((o: any) => o.wallet === w.id);
    const inc = walletOps.filter((o: any) => o.type === 'income' || o.type === 'trip_payment')
      .reduce((s: number, o: any) => s + Number(o.amount || 0), 0);
    const exp = walletOps.filter((o: any) => o.type === 'expense' || o.type === 'payout')
      .reduce((s: number, o: any) => s + Number(o.amount || 0), 0);
    const bal = Number(w.initial_balance || 0) + inc - exp;
    return `${w.icon || '💰'} ${w.name}: <b>${fmtN(bal)} сум</b>`;
  });
  return lines.join('\n');
}

async function findKontragenty(companyId: string, query: string): Promise<{ id: string; name: string }[]> {
  const { data } = await supabase.from('kontragenty').select('id, name').eq('company_id', companyId)
    .ilike('name', `%${query}%`).limit(5);
  return data || [];
}
async function getKontragentSummaryText(kontragentId: string, name: string): Promise<string> {
  const bal = await getBalance(kontragentId);
  const balLabel = bal < 0 ? `Долг: ${fmtN(-bal)} сум` : bal > 0 ? `Переплата: ${fmtN(bal)} сум` : 'Баланс: 0';
  const opsText = await getLastOperationsText(kontragentId);
  return `👤 <b>${name}</b>\n💰 ${balLabel}\n\n📊 Последние операции:\n${opsText}`;
}

// Те же состояния, что tirGetState()/dozGetState() в index.html — здесь мирим
// напрямую с сырыми колонками БД (snake_case), так как у Edge Function нет
// camelCase-слоя маппинга, которым пользуется браузерный код.
function tirState(t: any): string {
  if (t.returned_asmap) return 'asmaf';
  if (t.transferred && t.returned_office) return 'office';
  if (t.transferred && !t.returned_office) return 'issued';
  return 'free';
}
function dozState(d: any): string {
  if (d.epermit && d.used === true) return 'closed';
  if (d.returned_mt) return 'mintrans';
  if (d.issued && d.returned_office) return 'office';
  if (d.issued && !d.returned_office) return 'issued';
  return 'free';
}
function daysDiff(d1: string, d2: string): number {
  return Math.floor((new Date(d1).getTime() - new Date(d2).getTime()) / 86400000);
}

async function getTirDozvSummaryText(companyId: string): Promise<string> {
  const todayStr = new Date().toISOString().slice(0, 10);
  const { data: tirs } = await supabase.from('tirs')
    .select('expires, transferred, returned_office, returned_asmap').eq('company_id', companyId);
  const { data: dozv } = await supabase.from('dozv')
    .select('expires, epermit, used, issued, returned_office, returned_mt').eq('company_id', companyId);

  const tirFree = (tirs || []).filter((t: any) => tirState(t) === 'free').length;
  const tirIssued = (tirs || []).filter((t: any) => tirState(t) === 'issued').length;
  const tirSoon = (tirs || []).filter((t: any) =>
    tirState(t) !== 'asmaf' && t.expires && daysDiff(t.expires, todayStr) <= 10).length;

  const dozFree = (dozv || []).filter((d: any) => dozState(d) === 'free').length;
  const dozIssued = (dozv || []).filter((d: any) => dozState(d) === 'issued').length;
  const dozSoon = (dozv || []).filter((d: any) => {
    const st = dozState(d);
    return st !== 'closed' && st !== 'mintrans' && d.expires && daysDiff(d.expires, todayStr) <= 10;
  }).length;

  return `📋 <b>ТИР:</b>\nСвободно в офисе: ${tirFree}\nНа руках: ${tirIssued}\nСрок истекает ≤10 дн.: ${tirSoon}\n\n`
    + `📄 <b>Дозволы:</b>\nСвободно в офисе: ${dozFree}\nНа руках: ${dozIssued}\nСрок истекает ≤10 дн.: ${dozSoon}`;
}

// "Сроки" в боте — упрощённая версия страницы "Сроки" (топ-10 ближайших/просроченных
// суммарно, а не полный список по каждому из 14 типов документов) — решение
// пользователя 2026-08-10. Источники данных те же, что у getDeadlinesByType() в
// index.html: transport.docs (jsonb) + transport.techpass/contract_end, и
// person_docs (реляционная таблица, а не people.docs — people.docs собирается в
// браузере ИЗ person_docs через DOC_TYPE_REVERSE, см. mapPersonFromDb).
const DEADLINE_LABELS: Record<string, string> = {
  t_lic: 'Лицензия транспорта', t_svid: 'Свидетельство о допущении', t_tech: 'Техосмотр',
  t_dopog: 'ДОПОГ транспорта', t_tacho: 'Сертификат тахографа (машина)', t_osago: 'ОСАГО',
  t_techpass: 'Техпаспорт', t_rent: 'Договор аренды',
};
async function getDeadlinesSummaryText(companyId: string): Promise<string> {
  const todayStr = new Date().toISOString().slice(0, 10);
  type Item = { label: string; name: string; date: string; daysLeft: number };
  const items: Item[] = [];
  const push = (label: string, name: string, date: string | null | undefined) => {
    if (!date) return;
    const daysLeft = daysDiff(date, todayStr);
    // techpass в базе иногда хранит номер документа, а не дату (реальные данные,
    // проверено 2026-08-10) — new Date('AAF 2993271') даёт Invalid Date → NaN,
    // такую запись просто пропускаем, а не шлём "просрочено на NaN дн.".
    if (!Number.isFinite(daysLeft)) return;
    items.push({ label, name, date, daysLeft });
  };

  const { data: transport } = await supabase.from('transport')
    .select('callsign, plate, docs, techpass, owner, contract_end').eq('company_id', companyId).neq('active', false);
  (transport || []).forEach((t: any) => {
    const d = t.docs || {};
    const n = (t.callsign || '') + (t.plate ? ` (${t.plate})` : '');
    push(DEADLINE_LABELS.t_lic, n, d.lic?.to);
    push(DEADLINE_LABELS.t_svid, n, d.svid?.to);
    push(DEADLINE_LABELS.t_tech, n, d.tech?.to);
    push(DEADLINE_LABELS.t_dopog, n, d.dopog?.to);
    push(DEADLINE_LABELS.t_tacho, n, d.tacho?.to);
    (d.osago || []).forEach((o: any) => { if (o.to) push(DEADLINE_LABELS.t_osago, n + (o.country ? ` (${o.country})` : ''), o.to); });
    push(DEADLINE_LABELS.t_techpass, n, t.techpass);
    if (t.owner === 'Аренда') push(DEADLINE_LABELS.t_rent, n, t.contract_end);
  });

  const { data: people } = await supabase.from('people').select('id, name').eq('company_id', companyId).neq('active', false);
  const peopleIds = (people || []).map((p: any) => p.id);
  if (peopleIds.length) {
    const { data: docs } = await supabase.from('person_docs').select('person_id, doc_type, expires').in('person_id', peopleIds);
    (docs || []).forEach((doc: any) => {
      if (!doc.expires) return;
      const personName = (people || []).find((p: any) => p.id === doc.person_id)?.name || '';
      push(PERSON_DOC_LABELS[doc.doc_type] || doc.doc_type, personName, doc.expires);
    });
  }

  items.sort((a, b) => a.daysLeft - b.daysLeft);
  const top = items.slice(0, 10);
  if (!top.length) return 'Ближайших сроков не найдено.';
  return top.map((i) => {
    const mark = i.daysLeft <= 7 ? '🔴' : i.daysLeft <= 30 ? '🟡' : '⚪';
    const daysLabel = i.daysLeft < 0 ? `просрочено на ${-i.daysLeft} дн.` : `через ${i.daysLeft} дн.`;
    return `${mark} ${i.label} — ${i.name}: ${fmtDate(i.date)} (${daysLabel})`;
  }).join('\n');
}

// Диалоги: последние сообщения от контрагентов (не только необработанные — владелец
// просил "какие сообщения приходили", то есть недавнюю активность в целом).
async function getRecentDialogsText(companyId: string): Promise<string> {
  const { data: msgs } = await supabase.from('driver_messages')
    .select('message_text, photo_url, voice_url, status, created_at, telegram_link_id')
    .eq('company_id', companyId).order('created_at', { ascending: false }).limit(5);
  if (!msgs || !msgs.length) return 'Сообщений пока не было.';

  const linkIds = [...new Set(msgs.map((m: any) => m.telegram_link_id).filter(Boolean))];
  const { data: links } = linkIds.length
    ? await supabase.from('telegram_links').select('id, kontragent_id').in('id', linkIds)
    : { data: [] as any[] };
  const kgIds = [...new Set((links || []).map((l: any) => l.kontragent_id))];
  const { data: kgs } = kgIds.length
    ? await supabase.from('kontragenty').select('id, name').in('id', kgIds)
    : { data: [] as any[] };
  const nameFor = (linkId: string) => {
    const link = (links || []).find((l: any) => l.id === linkId);
    return (kgs || []).find((k: any) => k.id === link?.kontragent_id)?.name || 'Неизвестный';
  };

  return msgs.map((m: any) => {
    const who = nameFor(m.telegram_link_id);
    const content = m.message_text || (m.photo_url ? '📷 Фото' : m.voice_url ? '🎤 Голосовое' : '(пусто)');
    const mark = m.status === 'new' ? '🆕 ' : '';
    return `${mark}<b>${who}</b>: ${content}`;
  }).join('\n');
}

async function findFleet(companyId: string, query: string): Promise<{ id: string; label: string }[]> {
  const { data } = await supabase.from('fleet').select('id, label').eq('company_id', companyId)
    .ilike('label', `%${query}%`).limit(5);
  return data || [];
}
async function getFleetCardText(fleetId: string): Promise<string> {
  const { data: f } = await supabase.from('fleet').select('*').eq('id', fleetId).single();
  if (!f) return 'ПС не найдено.';
  const [{ data: kg }, { data: truck }, { data: trailer }, { data: driver }] = await Promise.all([
    f.kontragent_id ? supabase.from('kontragenty').select('name').eq('id', f.kontragent_id).single() : Promise.resolve({ data: null }),
    f.truck_id ? supabase.from('transport').select('callsign, plate').eq('id', f.truck_id).single() : Promise.resolve({ data: null }),
    f.trailer_id ? supabase.from('transport').select('callsign, plate').eq('id', f.trailer_id).single() : Promise.resolve({ data: null }),
    f.driver_id ? supabase.from('people').select('name').eq('id', f.driver_id).single() : Promise.resolve({ data: null }),
  ]);
  const lines = [
    `🚛 <b>${f.label}</b>`,
    `Контрагент: ${(kg as any)?.name || '—'}`,
    `Тягач: ${truck ? `${(truck as any).callsign} (${(truck as any).plate || '—'})` : '—'}`,
    trailer ? `Прицеп: ${(trailer as any).callsign} (${(trailer as any).plate || '—'})` : null,
    `Водитель: ${(driver as any)?.name || '—'}`,
    `План: ${f.plan > 0 ? fmtN(f.plan) + ' сум' : '—'}`,
    `Баланс: ${fmtN(f.balance || 0)} сум`,
  ].filter(Boolean);
  return lines.join('\n');
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('ok');

  let update: any;
  try {
    update = await req.json();
  } catch {
    return new Response('ok');
  }

  // --- Нажатие inline-кнопки выбора машины ---
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId: number = cq.message.chat.id;
    const m = /^docveh:([0-9a-f-]+):([0-9a-f-]+)$/.exec(cq.data || '');
    if (m) {
      const [, msgId, fleetId] = m;
      const { data: fleet } = await supabase.from('fleet').select('label').eq('id', fleetId).single();
      await supabase.from('driver_messages').update({ fleet_id: fleetId }).eq('id', msgId);
      await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Принято' });
      await sendMessage(chatId, `✅ Сообщение принято по машине ${fleet?.label || ''} и передано диспетчеру.`);
    } else {
      await tg('answerCallbackQuery', { callback_query_id: cq.id });
    }
    return new Response('ok');
  }

  const message = update.message;
  if (!message) return new Response('ok');

  const chatId: number = message.chat.id;
  const username: string | null = message.from?.username ?? null;
  const text: string = (message.text || message.caption || '').trim();

  // --- Владелец платформы (уже привязан через /admin_link) — админ-меню по
  // запросу вместо сводки. Проверяем раньше обычной привязки контрагента: чат
  // владельца никогда не встретится в telegram_links, но так явнее по смыслу.
  const { data: ownerRow } = await supabase
    .from('owner_notify')
    .select('id, pending_query')
    .eq('chat_id', chatId)
    .maybeSingle();

  if (ownerRow) {
    const adminCompanyId = await getAdminCompanyId();
    if (!adminCompanyId) {
      await sendMessage(chatId, 'Не удалось определить компанию владельца (account_type=admin). Обратитесь к разработчику.', adminKeyboard);
      return new Response('ok');
    }

    if (ownerRow.pending_query === 'kontragent' && text) {
      await supabase.from('owner_notify').update({ pending_query: null }).eq('id', ownerRow.id);
      const matches = await findKontragenty(adminCompanyId, text);
      if (!matches.length) {
        await sendMessage(chatId, `Контрагент по запросу «${text}» не найден.`, adminKeyboard);
      } else if (matches.length > 1) {
        await sendMessage(chatId, `Найдено несколько совпадений, уточните запрос:\n${matches.map((k) => `• ${k.name}`).join('\n')}`, adminKeyboard);
      } else {
        await sendMessage(chatId, await getKontragentSummaryText(matches[0].id, matches[0].name), adminKeyboard);
      }
      return new Response('ok');
    }
    if (ownerRow.pending_query === 'fleet' && text) {
      await supabase.from('owner_notify').update({ pending_query: null }).eq('id', ownerRow.id);
      const matches = await findFleet(adminCompanyId, text);
      if (!matches.length) {
        await sendMessage(chatId, `ПС по запросу «${text}» не найдено.`, adminKeyboard);
      } else if (matches.length > 1) {
        await sendMessage(chatId, `Найдено несколько совпадений, уточните запрос:\n${matches.map((f) => `• ${f.label}`).join('\n')}`, adminKeyboard);
      } else {
        await sendMessage(chatId, await getFleetCardText(matches[0].id), adminKeyboard);
      }
      return new Response('ok');
    }

    if (text === BTN_ADMIN_KASSA) {
      await sendMessage(chatId, await getKassaSummaryText(adminCompanyId), adminKeyboard);
      return new Response('ok');
    }
    if (text === BTN_ADMIN_KONTRAGENTY) {
      await supabase.from('owner_notify').update({ pending_query: 'kontragent' }).eq('id', ownerRow.id);
      await sendMessage(chatId, 'Введите имя контрагента (можно часть имени):', adminKeyboard);
      return new Response('ok');
    }
    if (text === BTN_ADMIN_TIRDOZV) {
      await sendMessage(chatId, await getTirDozvSummaryText(adminCompanyId), adminKeyboard);
      return new Response('ok');
    }
    if (text === BTN_ADMIN_DEADLINES) {
      await sendMessage(chatId, await getDeadlinesSummaryText(adminCompanyId), adminKeyboard);
      return new Response('ok');
    }
    if (text === BTN_ADMIN_DIALOGS) {
      await sendMessage(chatId, await getRecentDialogsText(adminCompanyId), adminKeyboard);
      return new Response('ok');
    }
    if (text === BTN_ADMIN_FLEET) {
      await supabase.from('owner_notify').update({ pending_query: 'fleet' }).eq('id', ownerRow.id);
      await sendMessage(chatId, 'Введите позывной/метку ПС (можно часть):', adminKeyboard);
      return new Response('ok');
    }

    await sendMessage(chatId, 'Выберите, что посмотреть:', adminKeyboard);
    return new Response('ok');
  }

  // Уже привязан?
  const { data: existingLink } = await supabase
    .from('telegram_links')
    .select('id, kontragent_id, company_id, kontragenty(name, type)')
    .eq('telegram_user_id', chatId)
    .eq('active', true)
    .maybeSingle();

  if (existingLink) {
    const kgId = (existingLink as any).kontragent_id;
    const companyId = (existingLink as any).company_id;
    const linkId = (existingLink as any).id;
    const kgType = (existingLink as any).kontragenty?.type;
    const isFullAccess = hasFullAccess(kgType);
    const kb = keyboardFor(kgType);

    if (text === BTN_BALANCE || (message.text && /баланс/i.test(text))) {
      if (!isFullAccess) {
        await sendMessage(chatId, 'Финансовая информация доступна только арендаторам и собственникам. Если у вас вопрос по балансу — обратитесь к диспетчеру лично.', kb);
        return new Response('ok');
      }
      const bal = await getBalance(kgId);
      const label = bal < 0 ? `Долг: ${fmtN(-bal)} сум` : bal > 0 ? `Переплата: ${fmtN(bal)} сум` : 'Баланс: 0';
      await sendMessage(chatId, `💰 <b>${label}</b>`, kb);
      return new Response('ok');
    }
    if (text === BTN_OPS || (message.text && /операци/i.test(text))) {
      if (!isFullAccess) {
        await sendMessage(chatId, 'Акт сверки через бот доступен только арендаторам и собственникам. Для полного акта сверки обратитесь к диспетчеру лично.', kb);
        return new Response('ok');
      }
      const opsText = await getLastOperationsText(kgId);
      await sendMessage(chatId, `📊 <b>Последние операции:</b>\n${opsText}`, kb);
      return new Response('ok');
    }
    if (text === BTN_DOCS || (message.text && /документ/i.test(text))) {
      const personalText = await getPersonalDocsText(kgId);
      const docsText = isFullAccess
        ? `🚚 <b>Документы на машину:</b>\n${await getDocumentsText(kgId)}\n\n🪪 <b>Личные документы:</b>\n${personalText}`
        : `🪪 <b>Личные документы:</b>\n${personalText}`;
      await sendMessage(chatId, docsText, kb);
      return new Response('ok');
    }

    // --- Произвольное сообщение: текст, фото или голос ---
    const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0;
    const hasVoice = !!message.voice;
    if (!hasPhoto && !hasVoice && !text) {
      await sendMessage(chatId, 'Выберите действие ниже.', kb);
      return new Response('ok');
    }

    let photoPath: string | null = null;
    let voicePath: string | null = null;
    if (hasPhoto) {
      const best = message.photo[message.photo.length - 1]; // самое большое разрешение — последнее в массиве
      photoPath = await relayTelegramFile(best.file_id, companyId);
    }
    if (hasVoice) {
      voicePath = await relayTelegramFile(message.voice.file_id, companyId);
    }

    const fleetList = await getKgFleets(kgId);

    if (fleetList.length > 1) {
      // Сохраняем сообщение сразу (fleet_id пока пуст), спрашиваем какая машина
      const { data: dm } = await createDriverMessage({
        companyId, telegramLinkId: linkId, fleetId: null,
        messageText: text || null, photoPath, voicePath,
      });
      if (dm) {
        await tg('sendMessage', {
          chat_id: chatId,
          text: 'По какой машине это сообщение?',
          reply_markup: {
            inline_keyboard: fleetList.map((f: any) => [{ text: f.label, callback_data: `docveh:${dm.id}:${f.id}` }]),
          },
        });
      }
    } else {
      await createDriverMessage({
        companyId, telegramLinkId: linkId, fleetId: fleetList[0]?.id || null,
        messageText: text || null, photoPath, voicePath,
      });
      await sendMessage(chatId, '✅ Сообщение получено и передано диспетчеру.', kb);
    }
    return new Response('ok');
  }

  if (!message.text) return new Response('ok');

  // Привязка ЛИЧНОГО Telegram владельца платформы — команда /admin_link <код>,
  // код разовый, задаётся секретом функции (не виден в коде/git). Если код совпал —
  // запоминаем chat_id в owner_notify, чтобы бэкап-функция знала, кому слать
  // уведомления об успехе/сбое бэкапа (решение пользователя 2026-08-10).
  if (OWNER_LINK_CODE && text === `/admin_link ${OWNER_LINK_CODE}`) {
    await supabase.from('owner_notify').upsert(
      { chat_id: chatId, telegram_username: username, linked_at: new Date().toISOString() },
      { onConflict: 'chat_id' }
    );
    await sendMessage(chatId, '✅ Готово! Этот чат привязан для уведомлений о резервных копиях.');
    return new Response('ok');
  }

  if (text === '/start') {
    await sendMessage(chatId,
      'Здравствуйте! Пришлите, пожалуйста, код привязки, который вам дал диспетчер в приложении MM Transport.');
    return new Response('ok');
  }

  // Пробуем воспринять текст как код привязки
  const code = text.replace(/^\/start\s+/, '');
  const { data: linkRow, error: linkErr } = await supabase
    .from('telegram_links')
    .select('id, kontragent_id, company_id')
    .eq('link_code', code)
    .is('telegram_user_id', null)
    .maybeSingle();

  if (linkErr || !linkRow) {
    await sendMessage(chatId,
      'Код не найден или уже использован. Проверьте код в приложении (Контрагент → Telegram) и пришлите его ещё раз.');
    return new Response('ok');
  }

  // Проверяем: контрагент должен иметь отношение хотя бы к одному активному ПС —
  // либо как ответственное лицо (Арендатор/Собственник), либо как фактический
  // водитель (Наёмный водитель, через fleet.driver_id) — решение пользователя
  // 2026-07-21.
  const fleetRows = await getKgFleets(linkRow.kontragent_id);

  if (!fleetRows || fleetRows.length === 0) {
    await sendMessage(chatId,
      'Этот код привязан к контрагенту, за которым не закреплён ни один подвижной состав. Диалог с ботом доступен только ответственным лицам или назначенным водителям ПС — обратитесь к диспетчеру.');
    return new Response('ok');
  }

  const { data: kg } = await supabase
    .from('kontragenty')
    .select('name, type')
    .eq('id', linkRow.kontragent_id)
    .single();

  await supabase
    .from('telegram_links')
    .update({ telegram_user_id: chatId, telegram_username: username, linked_at: new Date().toISOString() })
    .eq('id', linkRow.id);

  const vehicles = fleetRows.map((f: any) => f.label).join(', ');
  await sendMessage(chatId,
    `Готово! Вы подключены как <b>${kg?.name || ''}</b>.\nЗакреплённый подвижной состав: ${vehicles}`, keyboardFor(kg?.type));
  return new Response('ok');
});
