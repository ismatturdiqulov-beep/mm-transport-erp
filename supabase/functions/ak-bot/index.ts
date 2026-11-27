// Блок «Ангрен Каолин» — Telegram-бот (этап 5, 2026-11-26).
//
// Решения владельца:
//   * отдельный бот; группа «Перевозки» (там есть Зафар) — бот ТОЛЬКО читает и молчит;
//     группа «Расчёты» (Исмат и Сарвар) — весь вывод бота;
//   * сообщения в свободной форме: бот только ПРЕДЛАГАЕТ запись (ak_inbox); в учёт она
//     попадает после подтверждения Исмата — кнопкой здесь или на сайте;
//   * кошелёк не указан — спросить кнопками (утренние напоминания и закрытие через 3 дня —
//     режим cron, часть 3).
//
// Входы:
//   * Telegram webhook (заголовок X-Telegram-Bot-Api-Secret-Token = AK_BOT_WEBHOOK_SECRET);
//   * сайт (Authorization: Bearer <сессия владельца>), { action: 'apply'|'reject'|'wallet'|'setup', ... };
//   * расписание (x-cron-secret), { mode } — часть 3.

import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2';
import Anthropic from 'npm:@anthropic-ai/sdk';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BOT_TOKEN = Deno.env.get('AK_TELEGRAM_BOT_TOKEN')!;
const WH_SECRET = Deno.env.get('AK_BOT_WEBHOOK_SECRET')!;
const CRON_SECRET = Deno.env.get('CRON_SECRET');
const anthropic = new Anthropic({ apiKey: Deno.env.get('AK_ANTHROPIC_API_KEY') });
const MODEL = 'claude-opus-5-5';

const db = createClient(SUPABASE_URL, SERVICE_KEY);
// клиент с причиной для журнала изменений (триггер ak_audit читает x-ak-reason)
const dbAs = (reason: string): SupabaseClient => createClient(SUPABASE_URL, SERVICE_KEY, {
  global: { headers: { 'x-ak-reason': encodeURIComponent(reason.slice(0, 400)) } },
});

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

// ---------- Telegram ----------
// Тестовый режим (решение владельца 2026-11-26): пока Исмат не разрешит работать по-
// настоящему, каждое сообщение бота начинается с пометки «ТЕСТ». Переключатель —
// ak_settings 'bot'.test_mode, меняет владелец на сайте.
const TEST_BANNER = '🧪 <b>ТЕСТ — реальные остатки ещё не введены</b>\n\n';
let testModeCache: { v: boolean; at: number } | null = null;
async function testMode(): Promise<boolean> {
  if (testModeCache && Date.now() - testModeCache.at < 30000) return testModeCache.v;
  const { data } = await db.from('ak_settings').select('value').eq('key', 'bot').maybeSingle();
  const v = data?.value?.test_mode !== false;   // по умолчанию — тест
  testModeCache = { v, at: Date.now() };
  return v;
}
// «Сухая» проверка (режим test_cmd): ответы бота собираются сюда, в Telegram ничего не уходит.
let DRY: any[] | null = null;
async function tg(method: string, payload: Record<string, unknown>) {
  if (DRY && ['sendMessage', 'editMessageText', 'setMyCommands'].includes(method)) {
    DRY.push({ method, text: payload.text, buttons: (payload.reply_markup as any)?.inline_keyboard?.flat().map((b: any) => b.text) });
    return { ok: true, result: { message_id: 0 } };
  }
  if ((method === 'sendMessage' || method === 'editMessageText') && typeof payload.text === 'string' && await testMode()) {
    const html = payload.parse_mode === 'HTML';
    payload = { ...payload, parse_mode: 'HTML', text: TEST_BANNER + (html ? payload.text : esc(payload.text)) };
  }
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) console.error('tg', method, j.description);
  return j;
}
async function tgFile(fileId: string): Promise<Uint8Array | null> {
  const f = await tg('getFile', { file_id: fileId });
  if (!f.ok) return null;
  const r = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${f.result.file_path}`);
  return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
}
const b64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const esc = (s: unknown) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));

// ---------- общие ----------
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tashkent' });
const CYR = 'АВЕКМНОРСТУХ', LAT = 'ABEKMHOPCTYX';
const normPlate = (p: string) => String(p || '').toUpperCase().replace(/[\s\-.]/g, '').replace(/[АВЕКМНОРСТУХ]/g, (c) => LAT[CYR.indexOf(c)]);
const money = (minor: number, cur: string) => {
  const neg = minor < 0, a = Math.abs(Math.round(minor));
  const w = String(Math.floor(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const f = a % 100 ? ',' + String(a % 100).padStart(2, '0') : '';
  return `${neg ? '−' : ''}${w}${f} ${cur === 'USD' ? '$' : 'сум'}`;
};
const dmy = (iso: string | null) => iso ? iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(0, 4) : '';
const toMinor = (x: number | null | undefined) => (x == null || !isFinite(Number(x))) ? null : Math.round(Number(x) * 100);
const PARTNER = { ismat: 'Исмат', sarvar: 'Сарвар' } as Record<string, string>;
const WALLETS: Record<string, string> = { rs: 'Р/С', cash_uzs_ismat: 'Касса сум (Исмат)', cash_uzs_sarvar: 'Касса сум (Сарвар)', cash_usd_ismat: 'Касса $ (Исмат)', cash_usd_sarvar: 'Касса $ (Сарвар)' };
const WCODE: Record<string, string> = { rs: 'rs', ui: 'cash_uzs_ismat', us: 'cash_uzs_sarvar', di: 'cash_usd_ismat', ds: 'cash_usd_sarvar', me: 'personal' };
const WCODE_BACK = Object.fromEntries(Object.entries(WCODE).map(([k, v]) => [v, k]));
const CAT: Record<string, string> = { loaders: 'Грузчики', broker: 'Брокер', notary: 'Нотариус', logist_fee: 'Комиссия логиста', accountant_salary: 'Зарплата бухгалтера', profit_tax: 'Налог на прибыль', other_fixed: 'Прочие постоянные', other: 'Прочее' };

async function chatByRole(role: 'transport' | 'finance') {
  const { data } = await db.from('ak_tg_chats').select('*').eq('role', role).maybeSingle();
  return data;
}
async function partnerOf(tgUserId: number | null | undefined): Promise<string | null> {
  if (!tgUserId) return null;
  const { data } = await db.from('ak_tg_users').select('partner_key').eq('tg_user_id', tgUserId).maybeSingle();
  return data?.partner_key ?? null;
}

// ================= РАЗБОР СООБЩЕНИЙ (Claude) =================
// Необязательные поля просто не входят в required (модель их опускает). Union-типы
// ([t, 'null']) не используем: у API лимит — 16 параметров с union на схему.
const nul = (t: string) => ({ type: t });
const PLATE = { type: 'object', additionalProperties: false, required: ['tractor'],
  properties: { tractor: { type: 'string' }, trailer: nul('string'), carrier_price: nul('number'), price_cur: nul('string'), pay_method: nul('string') } };
const ACTION_FIELDS: Record<string, unknown> = {
  type: { type: 'string', enum: ['loading', 'prices', 'factory_income', 'carrier_payment', 'expense', 'cash_withdrawal', 'exchange', 'handover'] },
  route: nul('string'), loading_date: nul('string'), request_number: nul('string'),
  plates: { type: 'array', items: PLATE },
  factory_price: nul('number'), factory_price_cur: nul('string'), oformlenie_usd: nul('number'),
  carrier_price: nul('number'), carrier_price_cur: nul('string'),
  amount: nul('number'), currency: nul('string'), amount_to: nul('number'),
  wallet: nul('string'), wallet_to: nul('string'), counterparty: nul('string'), category: nul('string'),
  paid_by_partner: nul('string'), plate: nul('string'), op_date: nul('string'),   // не больше 24 необязательных полей на схему (лимит API)
  quote: { type: 'string' }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
};
const SCHEMA = { type: 'object', additionalProperties: false, required: ['actions'], properties: {
  actions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['type', 'quote', 'confidence'], properties: ACTION_FIELDS } } } };

const SYSTEM = `Ты — помощник учёта перевозок компании MM по контракту с заводом ANGREN KAOLIN (каолин из Ангрена).
Читаешь сообщения из двух Telegram-групп и извлекаешь из них ДЕЙСТВИЯ для учёта. Ничего не выдумывай: если поля нет в сообщении и его нельзя однозначно взять из контекста — просто не указывай это поле. Обычная переписка, вопросы, приветствия — пустой список actions.

Группы: «Перевозки» (дата, маршрут, номера машин; для местных — сумма с НДС) и «Расчёты» (цены по рейсу, поступления, расходы, платежи, фото чеков и платёжек).

Словарь: «тушди» (узб.) — поступило; «накд» — наличными; «&» часто означает «$» («1500& пер» = 1500 $ перевозчику); «пер», «перевозчик» — цена перевозчику; «Завод» — цена завода за 1 машину; «Налог» в сообщении о цене рейса (рядом с «Перевозчик / Завод») — это ОФОРМЛЕНИЕ ($ за машину), НЕ налог; «Логист» — комиссия логиста (отдельный расход). «млн» — миллион сум. Числа вида «170 млн» = 170000000.
Международные маршруты: цены обычно в долларах. Местные (керамика): только сумы, с НДС.

Типы действий:
- loading — машины загружаются/загрузились: route, loading_date, plates (номер тягача; прицеп, если указан через «/»; carrier_price + price_cur, если цена указана у номера). Номера бывают столбиком. Если в сообщении о погрузке есть «накд» / «наличными» (у номера или отдельной строкой) — у этих машин pay_method = "cash".
- prices — цены по рейсу (маршрут + дата): factory_price (+factory_price_cur), carrier_price (+carrier_price_cur), oformlenie_usd. Если маршрут/дата не указаны — возьми из ближайшего по смыслу сообщения в контексте (ответ на сообщение, предыдущее сообщение о погрузке). Комиссию логиста давай ОТДЕЛЬНЫМ действием expense с category=logist_fee и теми же route/loading_date.
- factory_income — поступление от завода на расчётный счёт: amount в сумах.
- carrier_payment — оплата перевозчику: plate (номер машины) или counterparty (название фирмы), amount, currency, wallet.
- expense — расход: category (loaders, broker, notary, logist_fee, accountant_salary, profit_tax, other_fixed, other), amount, currency, wallet или paid_by_partner (если сказано, что заплатил лично), counterparty; route/loading_date — если расход относится к рейсу. Слова «Исмат налоги» и налог на прибыль — category=profit_tax.
- cash_withdrawal — снятие наличных с Р/С по чеку: amount (получено наличными), wallet_to.
- exchange — обмен валюты между кассами: wallet (откуда), amount (отдали), wallet_to (куда), amount_to (получили).
- handover — передача наличных между Исматом и Сарваром: wallet, wallet_to, amount.

Кошельки (wallet / wallet_to): rs (расчётный счёт), cash_uzs_ismat, cash_uzs_sarvar, cash_usd_ismat, cash_usd_sarvar. Указывай кошелёк ТОЛЬКО если он ясен из сообщения («с р/с», «перечислением» → rs; «накд»/«наличными» → касса автора сообщения в валюте суммы). Иначе не указывай кошелёк — бот спросит кнопками.
Даты — YYYY-MM-DD; год, если не указан, — ближайший к сегодняшней дате. route — ТОЧНО одно из названий списка маршрутов (или не указывай). currency, *_cur — 'USD' или 'UZS'. Суммы — числа в долларах/сумах (не в центах). quote — фрагмент исходного сообщения, из которого взято действие. confidence — уверенность.`;

async function contextFor(msg: any) {
  const since = new Date(Date.now() - 4 * 86400000).toISOString();
  const [routes, chats, recent, reqs] = await Promise.all([
    db.from('ak_routes').select('name, kind').eq('active', true),
    db.from('ak_tg_chats').select('chat_id, role'),
    db.from('ak_tg_messages').select('chat_id, message_id, tg_user_id, sent_at, text, reply_to_message_id').gte('sent_at', since).order('sent_at', { ascending: false }).limit(40),
    db.from('ak_requests').select('id, number, route_id, loading_date, trucks_ordered, price_minor, price_cur, oformlenie_minor, status').gte('loading_date', new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10)).neq('status', 'cancelled'),
  ]);
  const roleOf = Object.fromEntries((chats.data || []).map((c: any) => [c.chat_id, c.role === 'transport' ? 'Перевозки' : c.role === 'finance' ? 'Расчёты' : 'другая']));
  const { data: users } = await db.from('ak_tg_users').select('tg_user_id, first_name, partner_key');
  const who = (id: number) => { const u = (users || []).find((x: any) => x.tg_user_id === id); return u ? (u.partner_key ? PARTNER[u.partner_key] : u.first_name) : '?'; };
  const routeName = Object.fromEntries(((await db.from('ak_routes').select('id, name')).data || []).map((r: any) => [r.id, r.name]));
  const replied = msg.reply_to_message_id ? (recent.data || []).find((m: any) => m.chat_id === msg.chat_id && m.message_id === msg.reply_to_message_id) : null;
  const lines = [
    `Сегодня: ${today()}.`,
    `Маршруты: ${(routes.data || []).map((r: any) => `${r.name} (${r.kind === 'local' ? 'местный' : 'международный'})`).join('; ')}.`,
    `Недавние заявки завода: ${(reqs.data || []).map((r: any) => `№${r.number} ${routeName[r.route_id]} ${r.loading_date} машин ${r.trucks_ordered}${r.price_minor != null ? ' цена ' + r.price_minor / 100 + ' ' + r.price_cur : ''}`).join('; ') || 'нет'}.`,
    '', 'Недавние сообщения (старые сверху):',
    ...(recent.data || []).slice().reverse().filter((m: any) => roleOf[m.chat_id] !== 'другая' && (m.message_id !== msg.message_id || m.chat_id !== msg.chat_id))
      .map((m: any) => `[${roleOf[m.chat_id]} · ${m.sent_at.slice(0, 16).replace('T', ' ')} · ${who(m.tg_user_id)}] ${(m.text || '(файл)').slice(0, 400)}`),
    '',
    replied ? `НОВОЕ СООБЩЕНИЕ — ответ на: «${(replied.text || '').slice(0, 300)}»` : 'НОВОЕ СООБЩЕНИЕ:',
    `[${roleOf[msg.chat_id]} · ${msg.sent_at.slice(0, 16).replace('T', ' ')} · автор: ${who(msg.tg_user_id)}] ${msg.text || '(без текста)'}`,
    msg.file_id ? 'К сообщению приложен файл (чек / платёжка) — извлеки из него сумму, дату, плательщика.' : '',
  ];
  return lines.join('\n');
}

async function parseMessage(msg: any): Promise<any[]> {
  const content: any[] = [];
  if (msg.file_id) {
    const bytes = await tgFile(msg.file_id);
    if (bytes && bytes.length < 15_000_000) {
      if (msg.mime === 'application/pdf') content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64(bytes) } });
      else content.push({ type: 'image', source: { type: 'base64', media_type: msg.mime && msg.mime.startsWith('image/') ? msg.mime : 'image/jpeg', data: b64(bytes) } });
    }
  }
  content.push({ type: 'text', text: (await contextFor(msg)) + '\n\nВызови инструмент record_actions ровно один раз (пустой список, если записывать нечего).' });
  // Результат — через инструмент record_actions. Строгую схему (json_schema / strict) не
  // используем: на такой схеме подготовка ответа занимала больше 2 минут (замерено
  // 2026-11-26), обычный запрос — меньше секунды. Поля проверяем сами (validAction).
  // Резервная модель при отказе — server-side fallback.
  const resp: any = await (anthropic.beta.messages.create as any)({
    model: MODEL,
    max_tokens: 8000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low' },
    tool_choice: { type: 'auto' },
    tools: [{ name: 'record_actions', description: 'Записать действия, извлечённые из сообщения (может быть пустой список).', input_schema: SCHEMA }],
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content }],
  }, { timeout: 90000, maxRetries: 1 });
  if (resp.stop_reason === 'refusal') throw new Error('модель отказалась разбирать сообщение');
  if (resp.stop_reason === 'max_tokens') throw new Error('ответ модели обрезан');
  const call = (resp.content || []).find((b: any) => b.type === 'tool_use' && b.name === 'record_actions');
  if (!call) return [];
  const list = Array.isArray(call.input?.actions) ? call.input.actions : [];
  return list.filter(validAction);
}

// Проверка полей ответа модели (схема не строгая — проверяем сами).
const TYPES = ['loading', 'prices', 'factory_income', 'carrier_payment', 'expense', 'cash_withdrawal', 'exchange', 'handover'];
const WALLET_IDS = ['rs', 'cash_uzs_ismat', 'cash_uzs_sarvar', 'cash_usd_ismat', 'cash_usd_sarvar'];
function validAction(a: any): boolean {
  if (!a || !TYPES.includes(a.type)) return false;
  const num = (k: string) => a[k] == null || (typeof a[k] === 'number' && isFinite(a[k]) && a[k] >= 0);
  if (!['factory_price', 'carrier_price', 'oformlenie_usd', 'amount', 'amount_to'].every(num)) return false;
  for (const k of ['currency', 'factory_price_cur', 'carrier_price_cur']) if (a[k] != null && !['USD', 'UZS'].includes(a[k])) a[k] = null;
  for (const k of ['wallet', 'wallet_to']) if (a[k] != null && !WALLET_IDS.includes(a[k])) a[k] = null;
  if (a.paid_by_partner != null && !['ismat', 'sarvar'].includes(a.paid_by_partner)) a.paid_by_partner = null;
  for (const k of ['loading_date', 'op_date']) if (a[k] != null && !/^\d{4}-\d{2}-\d{2}$/.test(a[k])) a[k] = null;
  if (a.plates != null && !Array.isArray(a.plates)) a.plates = [];
  a.plates = (a.plates || []).filter((p: any) => p && typeof p.tractor === 'string' && normPlate(p.tractor).length >= 3);
  if (a.type === 'loading' && !a.plates.length) return false;
  if (['factory_income', 'carrier_payment', 'expense', 'cash_withdrawal', 'exchange', 'handover'].includes(a.type) && !(a.amount > 0)) return false;
  if (!['high', 'medium', 'low'].includes(a.confidence)) a.confidence = 'medium';
  if (typeof a.quote !== 'string') a.quote = '';
  return true;
}

// ---------- описание предложения ----------
const amt = (a: any, k = 'amount', c = 'currency') => a[k] == null ? '?' : money(toMinor(a[k])!, a[c] || 'UZS');
function describe(a: any): string {
  const rd = [a.route, a.loading_date ? dmy(a.loading_date) : null, a.request_number ? '№' + a.request_number : null].filter(Boolean).join(' ');
  switch (a.type) {
    case 'loading': return `🚚 Погрузка ${rd}: ${(a.plates || []).length} маш.\n` + (a.plates || []).map((p: any) => `   • ${normPlate(p.tractor)}${p.trailer ? ' / ' + normPlate(p.trailer) : ''}${p.carrier_price != null ? ' — ' + money(toMinor(p.carrier_price)!, p.price_cur || 'USD') : ''}${p.pay_method === 'cash' ? ' (накд)' : ''}`).join('\n');
    case 'prices': return `💲 Цены ${rd}:` + [a.factory_price != null ? `\n   • завод: ${amt(a, 'factory_price', 'factory_price_cur')} за машину` : '', a.carrier_price != null ? `\n   • перевозчик: ${amt(a, 'carrier_price', 'carrier_price_cur')}` : '', a.oformlenie_usd != null ? `\n   • оформление: ${money(toMinor(a.oformlenie_usd)!, 'USD')} за машину` : ''].join('');
    case 'factory_income': return `🏦 Поступление от завода на Р/С: ${amt(a)}`;
    case 'carrier_payment': return `💸 Оплата перевозчику ${a.plate ? normPlate(a.plate) : esc(a.counterparty || '?')}: ${amt(a)}${a.wallet ? ' из «' + WALLETS[a.wallet] + '»' : ''}`;
    case 'expense': return `🧾 Расход «${CAT[a.category] || 'прочее'}»: ${amt(a)}${a.counterparty ? ' — ' + esc(a.counterparty) : ''}${rd ? ' (рейс ' + rd + ')' : ''}${a.paid_by_partner ? ' — лично ' + PARTNER[a.paid_by_partner] : a.wallet ? ' из «' + WALLETS[a.wallet] + '»' : ''}`;
    case 'cash_withdrawal': return `🏧 Снятие наличных с Р/С: ${amt(a)}${a.wallet_to ? ' → «' + WALLETS[a.wallet_to] + '»' : ''}`;
    case 'exchange': return `💱 Обмен: ${a.wallet ? WALLETS[a.wallet] : '?'} ${amt(a)} → ${a.wallet_to ? WALLETS[a.wallet_to] : '?'} ${a.amount_to != null ? money(toMinor(a.amount_to)!, (a.wallet_to || '').includes('usd') ? 'USD' : 'UZS') : '?'}`;
    case 'handover': return `🤝 Передача наличных: ${a.wallet ? WALLETS[a.wallet] : '?'} → ${a.wallet_to ? WALLETS[a.wallet_to] : '?'}: ${amt(a)}`;
  }
  return JSON.stringify(a);
}
// Какой кошелёк нужен и не указан (для кнопок): 'from' | 'to' | null.
function walletNeed(a: any): 'from' | 'to' | null {
  if (a.type === 'carrier_payment' && !a.wallet) return 'from';
  if (a.type === 'expense' && !a.wallet && !a.paid_by_partner) return 'from';
  if (a.type === 'cash_withdrawal' && !a.wallet_to) return 'to';
  return null;
}
function buttons(item: any) {
  const need = item.status === 'needs_wallet';
  const rows: any[] = [];
  if (need) {
    const cur = item.proposal.currency === 'USD' ? 'usd' : 'uzs';
    const opts = item.proposal.type === 'cash_withdrawal' ? ['ui', 'us'] : cur === 'usd' ? ['di', 'ds'] : ['rs', 'ui', 'us'];
    rows.push(opts.map((c) => ({ text: WALLETS[WCODE[c]], callback_data: `wl:${item.id}:${c}` })));
    if (item.proposal.type === 'expense') rows.push([{ text: `Лично ${item.author_partner ? PARTNER[item.author_partner] : 'автор'} (фин. помощь)`, callback_data: `wl:${item.id}:me` }]);
    rows.push([{ text: '❌ Не записывать', callback_data: `rj:${item.id}` }]);
  } else if (item.proposal?._pick && item.status !== 'applied') {
    // маршрута в списке машин нет — выбор заявки на дату или маршрута (без денег)
    const pk = item.proposal._pick;
    pk.opts.forEach((o: any, i: number) => rows.push([{ text: o.label, callback_data: `pk:${item.id}:${i}` }]));
    if (pk.mode === 'req') rows.push([{ text: '➕ Другой маршрут (новая заявка)', callback_data: `ro:${item.id}` }]);
    rows.push([{ text: '❌ Ошибка', callback_data: `rj:${item.id}` }]);
  } else {
    rows.push(item.proposal?._transport
      ? [{ text: '✅ Верно', callback_data: `ap:${item.id}` }, { text: '❌ Ошибка', callback_data: `rj:${item.id}` }]
      : [{ text: '✅ Записать', callback_data: `ap:${item.id}` }, { text: '❌ Не записывать', callback_data: `rj:${item.id}` }]);
  }
  return { inline_keyboard: rows };
}
function itemText(item: any, footer = '') {
  const a = item.proposal;
  const conf = a.confidence === 'low' ? '\n⚠️ Не уверен — проверьте.' : '';
  const ask = item.status === 'needs_wallet' ? '\n❓ Из какого кошелька?' : '';
  return `📝 <b>Предлагаю записать</b>${item.author_partner ? ' (пишет ' + PARTNER[item.author_partner] + ')' : ''}\n${esc(item.summary)}${conf}${ask}\n<i>«${esc((a.quote || '').slice(0, 200))}»</i>${footer ? '\n\n' + footer : ''}`;
}

// ---------- сверка номеров со справочником (для группы «Перевозки») ----------
function lev(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 9;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
// Точное совпадение или единственная машина, отличающаяся одним символом (опечатка).
function matchPlate(p: string, all: any[], kind: string): { plate: string; veh: any | null; fixedFrom: string | null } {
  const n = normPlate(p);
  const exact = all.find((v) => v.plate_norm === n);
  if (exact) return { plate: n, veh: exact, fixedFrom: null };
  const near = all.filter((v) => v.kind === kind && lev(v.plate_norm, n) === 1);
  if (near.length === 1) return { plate: near[0].plate_norm, veh: near[0], fixedFrom: n };
  return { plate: n, veh: null, fixedFrom: null };
}
// Дополнить предложение погрузки: исправленные номера, свой прицеп, фирма на дату погрузки.
async function enrichLoading(a: any): Promise<string[]> {
  const { data: vs } = await db.from('ak_vehicles').select('id, plate_norm, kind, default_trailer_id').eq('active', true);
  const all = vs || [];
  const byId = Object.fromEntries(all.map((v: any) => [v.id, v]));
  const date = a.loading_date || today();
  const lines: string[] = [];
  let i = 0;
  for (const p of a.plates || []) {
    i++;
    const t = matchPlate(p.tractor, all, 'tractor');
    p.tractor = t.plate;
    let trailerTxt = '';
    if (p.trailer) { const tr = matchPlate(p.trailer, all, 'trailer'); p.trailer = tr.plate; trailerTxt = ' / ' + tr.plate + (tr.fixedFrom ? ` (было ${tr.fixedFrom})` : ''); }
    else if (t.veh?.default_trailer_id && byId[t.veh.default_trailer_id]) trailerTxt = ' / ' + byId[t.veh.default_trailer_id].plate_norm;
    let firm = '❓ нет в справочнике, фирма неизвестна';
    if (t.veh) {
      const cid = await ownerOn(t.veh.id, date);
      if (cid) { const { data: c } = await db.from('ak_carriers').select('name').eq('id', cid).single(); firm = c?.name || firm; }
      else firm = '❓ машина в справочнике, но фирма не указана';
    }
    lines.push(`${i}. ${t.plate}${t.fixedFrom ? ` (исправлено из ${t.fixedFrom})` : ''}${trailerTxt} — ${firm}`);
  }
  return lines;
}
function transportText(item: any, footer = '') {
  const a = item.proposal;
  return `🚚 <b>${esc(a.route || '?')} ${a.loading_date ? dmy(a.loading_date) : ''} — ${(a.plates || []).length} маш.</b>\n${(a._lines || []).map(esc).join('\n')}` +
    `\n\n${footer ? esc(footer) : 'Всё верно? Подтвердить может Исмат или Сарвар.'}`;
}

async function proposeFromMessage(msg: any) {
  let actions: any[] = [];
  try {
    actions = await parseMessage(msg);
    await db.from('ak_tg_messages').update({ parsed_at: new Date().toISOString(), parse_error: null }).eq('id', msg.id);
  } catch (e: any) {
    await db.from('ak_tg_messages').update({ parse_error: String(e?.message || e).slice(0, 500) }).eq('id', msg.id);
    console.error('parse', e);
    return;
  }
  if (!actions.length) return;
  const finance = await chatByRole('finance');
  const transport = await chatByRole('transport');
  const author = await partnerOf(msg.tg_user_id);
  for (const a of actions) {
    // список машин из «Перевозок» — подтверждение там же: только номера и фирмы, без денег
    const inTransport = a.type === 'loading' && transport && msg.chat_id === transport.chat_id;
    if (a.type === 'loading') a._lines = await enrichLoading(a);
    if (inTransport) a._transport = true;
    const status = walletNeed(a) ? 'needs_wallet' : 'pending';
    const target = inTransport ? transport : finance;
    const { data: item, error } = await db.from('ak_inbox').insert({
      source_chat_id: msg.chat_id, source_message_id: msg.message_id, author_tg_user_id: msg.tg_user_id, author_partner: author,
      kind: a.type, summary: describe(a), proposal: a, status, last_asked_at: status === 'needs_wallet' ? new Date().toISOString() : null,
      wallet_asks: status === 'needs_wallet' ? 1 : 0, tg_chat_id: target?.chat_id ?? null,
    }).select().single();
    if (error) { console.error('inbox', error); continue; }
    if (target) {
      const sent = await tg('sendMessage', { chat_id: target.chat_id, text: inTransport ? transportText(item) : itemText(item), parse_mode: 'HTML',
        reply_markup: buttons(item), disable_web_page_preview: true, ...(inTransport ? { reply_to_message_id: msg.message_id } : {}) });
      if (sent.ok) await db.from('ak_inbox').update({ tg_message_id: sent.result.message_id }).eq('id', item.id);
    }
  }
}

// ================= ЗАПИСЬ В УЧЁТ =================
async function findRoute(name: string | null) {
  if (!name) return null;
  const { data } = await db.from('ak_routes').select('*');
  const n = name.toLowerCase().replace(/ё/g, 'е');
  return (data || []).find((r: any) => r.name.toLowerCase() === n) || (data || []).find((r: any) => r.name.toLowerCase().startsWith(n.slice(0, 5))) || null;
}
async function findRequest(a: any, d: SupabaseClient, create: boolean) {
  if (a.request_number) {
    const { data } = await d.from('ak_requests').select('*').eq('number', a.request_number).neq('status', 'cancelled').maybeSingle();
    if (data) return data;
  }
  const route = await findRoute(a.route);
  if (!route) throw new Error(`не понял маршрут «${a.route ?? '—'}»`);
  if (!a.loading_date) throw new Error('не указана дата погрузки');
  const { data: ex } = await d.from('ak_requests').select('*').eq('route_id', route.id).eq('loading_date', a.loading_date).neq('status', 'cancelled').order('created_at').limit(1);
  if (ex && ex.length) return ex[0];
  if (!create) throw new Error(`нет заявки ${route.name} на ${dmy(a.loading_date)}`);
  const n = Math.max(a.plates?.length || 0, a.trucks || 0, 1);
  const { data, error } = await d.from('ak_requests').insert({ route_id: route.id, loading_date: a.loading_date, trucks_ordered: n, price_cur: route.kind === 'local' ? 'UZS' : 'USD', bot_pending: true }).select().single();
  if (error) throw error;
  return data;
}
async function vehicleId(plate: string, kind: 'tractor' | 'trailer', d: SupabaseClient) {
  const p = normPlate(plate);
  const { data } = await d.from('ak_vehicles').select('*').eq('plate_norm', p).maybeSingle();
  if (data) return data;
  const { data: v, error } = await d.from('ak_vehicles').insert({ plate: p, kind }).select().single();
  if (error) throw error;
  return v;
}
async function ownerOn(vehicleId: string, date: string) {
  const { data } = await db.from('ak_vehicle_owners').select('carrier_id').eq('vehicle_id', vehicleId).lte('valid_from', date).order('valid_from', { ascending: false }).limit(1);
  return data && data.length ? data[0].carrier_id : null;
}

async function applyAction(a: any, wallet: string | null, author: string | null, d: SupabaseClient): Promise<string> {
  const opDate = a.op_date || today();
  switch (a.type) {
    case 'loading': {
      const r = await findRequest(a, d, true);
      const notes: string[] = [];
      for (const p of a.plates || []) {
        const tractor = await vehicleId(p.tractor, 'tractor', d);
        let { data: lots } = await d.from('ak_trips').select('*').eq('request_id', r.id).neq('status', 'cancelled');
        let lot = (lots || []).find((t: any) => t.tractor_id === tractor.id) || (lots || []).find((t: any) => !t.tractor_id && t.status === 'assigned');
        if (!lot) {
          const active = (lots || []).filter((t: any) => !['cancelled', 'failed'].includes(t.status)).length;
          await d.from('ak_requests').update({ trucks_ordered: active + 1 }).eq('id', r.id);
          ({ data: lots } = await d.from('ak_trips').select('*').eq('request_id', r.id).neq('status', 'cancelled'));
          lot = (lots || []).find((t: any) => !t.tractor_id && t.status === 'assigned');
          if (!lot) throw new Error('не удалось открыть лот');
        }
        const carrierId = await ownerOn(tractor.id, r.loading_date);
        const { data: carrier } = carrierId ? await d.from('ak_carriers').select('*').eq('id', carrierId).single() : { data: null };
        const trailerId = p.trailer ? (await vehicleId(p.trailer, 'trailer', d)).id : tractor.default_trailer_id;
        // всё, что заполнил бот, ждёт одобрения Исмата на сайте (решение владельца)
        const upd: any = { tractor_id: tractor.id, trailer_id: trailerId ?? null, carrier_id: carrierId, bot_pending: true };
        if (carrier) Object.assign(upd, { pay_timing: carrier.pay_timing, pay_method: carrier.pay_method, pay_days: carrier.pay_days });
        if (p.pay_method === 'cash') upd.pay_method = 'cash';
        if (p.carrier_price != null) { upd.price_minor = toMinor(p.carrier_price); upd.price_cur = r.kind === 'local' ? 'UZS' : (p.price_cur || 'USD'); }
        const { error } = await d.from('ak_trips').update(upd).eq('id', lot.id);
        if (error) throw error;
        if (!carrierId) notes.push(`${normPlate(p.tractor)} — новая машина, перевозчик не известен (укажите на сайте)`);
      }
      await d.from('ak_requests').update({ bot_pending: true }).eq('id', r.id);
      return `заявка №${r.number} — на сайте ждёт одобрения Исмата` + (notes.length ? '\n' + notes.join('\n') : '');
    }
    case 'prices': {
      const r = await findRequest(a, d, false);
      const upd: any = { bot_pending: true };
      if (a.factory_price != null) { upd.price_minor = toMinor(a.factory_price); upd.price_cur = r.kind === 'local' ? 'UZS' : (a.factory_price_cur || 'USD'); }
      if (a.oformlenie_usd != null && r.kind === 'international') upd.oformlenie_minor = toMinor(a.oformlenie_usd);
      if (Object.keys(upd).length > 1) { const { error } = await d.from('ak_requests').update(upd).eq('id', r.id); if (error) throw error; }
      let n = 0;
      if (a.carrier_price != null) {
        const { data: lots } = await d.from('ak_trips').select('id, tractor_id').eq('request_id', r.id).not('tractor_id', 'is', null).not('status', 'in', '(cancelled,failed)');
        const only = (a.plates || []).map((p: any) => normPlate(p.tractor));
        for (const t of lots || []) {
          if (only.length) { const { data: v } = await d.from('ak_vehicles').select('plate_norm').eq('id', t.tractor_id).single(); if (!only.includes(v.plate_norm)) continue; }
          const { error } = await d.from('ak_trips').update({ price_minor: toMinor(a.carrier_price), price_cur: r.kind === 'local' ? 'UZS' : (a.carrier_price_cur || 'USD'), bot_pending: true }).eq('id', t.id);
          if (error) throw error; n++;
        }
      }
      return `заявка №${r.number}${n ? `, цена перевозчика в ${n} лот(ах)` : ''}`;
    }
    case 'factory_income': {
      const { error } = await d.rpc('ak_post_movement', { p: { kind: 'factory_income', op_date: opDate, to_wallet: 'rs', amount_in: toMinor(a.amount), counterparty: 'ANGREN KAOLIN', note: a.note } });
      if (error) throw error; return 'поступление записано';
    }
    case 'carrier_payment': {
      let tripId: string | null = null, carrierId: string | null = null;
      if (a.plate) {
        const { data: v } = await d.from('ak_vehicles').select('id').eq('plate_norm', normPlate(a.plate)).maybeSingle();
        if (v) {
          const { data: t } = await d.from('ak_trips').select('id, carrier_id').eq('tractor_id', v.id).not('status', 'in', '(cancelled,failed)').order('created_at', { ascending: false }).limit(1);
          if (t && t.length) { tripId = t[0].id; carrierId = t[0].carrier_id; }
        }
      }
      if (!carrierId && a.counterparty) {
        const { data: c } = await d.from('ak_carriers').select('id').ilike('name', `%${a.counterparty}%`).limit(1);
        if (c && c.length) carrierId = c[0].id;
      }
      if (!carrierId) throw new Error('не нашёл перевозчика / рейс по номеру машины');
      const w = wallet || a.wallet;
      const { error } = await d.rpc('ak_post_movement', { p: { kind: 'carrier_payment', op_date: opDate, from_wallet: w, amount_in: toMinor(a.amount), carrier_id: carrierId, trip_id: tripId, note: a.note } });
      if (error) throw error; return 'оплата записана';
    }
    case 'expense': {
      let reqIds: string[] = [];
      if (a.route || a.request_number) { try { reqIds = [(await findRequest(a, d, false)).id]; } catch (_) { /* без привязки */ } }
      const w = wallet || a.wallet;
      const personal = w === 'personal' ? (author || a.paid_by_partner) : a.paid_by_partner;
      const { error } = await d.rpc('ak_add_expense', { p: {
        exp_date: opDate, category: CAT[a.category] ? a.category : 'other', amount: toMinor(a.amount), currency: a.currency || 'UZS',
        paid_by: personal ? personal : 'wallet', wallet: personal ? null : w, counterparty: a.counterparty, note: a.note, request_ids: reqIds } });
      if (error) throw error; return personal ? `расход записан как фин. помощь (${PARTNER[personal]})` : 'расход записан';
    }
    case 'cash_withdrawal': {
      const { error } = await d.rpc('ak_post_movement', { p: { kind: 'cash_withdrawal', op_date: opDate, from_wallet: 'rs', to_wallet: wallet || a.wallet_to, amount_in: toMinor(a.amount), note: a.note } });
      if (error) throw error; return 'снятие записано';
    }
    case 'exchange': {
      if (!a.wallet || !a.wallet_to) throw new Error('не указаны кассы обмена — внесите на сайте');
      const { error } = await d.rpc('ak_post_movement', { p: { kind: 'transfer', op_date: opDate, from_wallet: a.wallet, to_wallet: a.wallet_to, amount_out: toMinor(a.amount), amount_in: toMinor(a.amount_to), counterparty: a.counterparty, note: a.note } });
      if (error) throw error; return 'обмен записан';
    }
    case 'handover': {
      if (!a.wallet || !a.wallet_to) throw new Error('не указаны кассы — внесите на сайте');
      const { error } = await d.rpc('ak_post_movement', { p: { kind: 'handover', op_date: opDate, from_wallet: a.wallet, to_wallet: a.wallet_to, amount_in: toMinor(a.amount), note: a.note } });
      if (error) throw error; return 'передача записана';
    }
  }
  throw new Error('неизвестный тип');
}

// Список машин без маршрута (решение Исмата 2026-11-26): маршрут берём из заявок завода на дату.
// Одна заявка (или одна со свободными лотами) — привязываем сами; несколько — кнопки заявок;
// нет ни одной — кнопки маршрутов (создаст заявку, ждёт одобрения на сайте).
// Несколько маршрутов в одном списке — весь список на один, лишнее Исмат переносит на сайте.
async function routeOptions() {
  const { data } = await db.from('ak_routes').select('id, name').eq('active', true).order('name');
  return { mode: 'route', opts: (data || []).slice(0, 20).map((r: any) => ({ label: r.name, route: r.name })) };
}
async function resolveLoadingRoute(item: any): Promise<'ok' | 'ask'> {
  const a = item.proposal;
  if (a.request_number || await findRoute(a.route)) return 'ok';
  const date = a.loading_date || today();
  a.loading_date = date;
  const { data: reqs } = await db.from('ak_requests').select('id, number, route_id').eq('loading_date', date).neq('status', 'cancelled').order('created_at');
  const list = reqs || [];
  const { data: routes } = await db.from('ak_routes').select('id, name');
  const rn = Object.fromEntries((routes || []).map((r: any) => [r.id, r.name]));
  const free: Record<string, number> = {};
  if (list.length) {
    const { data: lots } = await db.from('ak_trips').select('request_id').in('request_id', list.map((r: any) => r.id)).eq('status', 'assigned').is('tractor_id', null);
    for (const t of lots || []) free[t.request_id] = (free[t.request_id] || 0) + 1;
  }
  const withFree = list.filter((r: any) => free[r.id] > 0);
  const one = withFree.length === 1 ? withFree[0] : list.length === 1 ? list[0] : null;
  if (one) { a.request_number = one.number; a.route = rn[one.route_id] || a.route; delete a._pick; await db.from('ak_inbox').update({ proposal: a }).eq('id', item.id); return 'ok'; }
  a._pick = list.length
    ? { mode: 'req', opts: list.map((r: any) => ({ label: `${rn[r.route_id] || '?'} ${dmy(date)} — своб. ${free[r.id] || 0} (№${r.number})`, request_number: r.number, route: rn[r.route_id] || null })) }
    : await routeOptions();
  await db.from('ak_inbox').update({ proposal: a, status: 'pending', error: null }).eq('id', item.id);
  await updateMsg({ ...item, proposal: a, status: 'pending' }, list.length
    ? 'Маршрута в сообщении нет — к какой заявке завода привязать машины?'
    : `Маршрута в сообщении нет, и заявок завода на ${dmy(date)} нет — выберите маршрут (заявка создастся и будет ждать одобрения Исмата на сайте).`, true);
  return 'ask';
}
async function pickOption(id: string, idx: string, by: { tg?: number; name: string }) {
  const { data: item } = await db.from('ak_inbox').select('*').eq('id', id).single();
  if (!item || !['pending', 'error'].includes(item.status)) return { ok: false, error: 'уже решено' };
  const a = item.proposal, o = a._pick?.opts?.[Number(idx)];
  if (!o) return { ok: false, error: 'устаревшая кнопка' };
  if (o.request_number) a.request_number = o.request_number;
  if (o.route) a.route = o.route;
  delete a._pick;
  await db.from('ak_inbox').update({ proposal: a }).eq('id', id);
  return applyItem(id, by);
}
async function otherRoute(id: string) {
  const { data: item } = await db.from('ak_inbox').select('*').eq('id', id).single();
  if (!item || !['pending', 'error'].includes(item.status)) return { ok: false, error: 'уже решено' };
  const a = item.proposal;
  a._pick = await routeOptions();
  await db.from('ak_inbox').update({ proposal: a }).eq('id', id);
  await updateMsg({ ...item, proposal: a }, 'Выберите маршрут — создастся новая заявка завода (ждёт одобрения Исмата на сайте).', true);
  return { ok: true };
}

// Подтвердить запись (Исмат: кнопка в Telegram или сайт).
async function applyItem(id: string, by: { tg?: number; user?: string; name: string }) {
  const { data: item } = await db.from('ak_inbox').select('*').eq('id', id).single();
  if (!item) return { ok: false, error: 'не найдено' };
  if (!['pending', 'error'].includes(item.status)) return { ok: false, error: item.status === 'applied' ? 'уже записано' : item.status === 'needs_wallet' ? 'сначала выберите кошелёк' : 'уже решено' };
  if (item.kind === 'loading' && await resolveLoadingRoute(item) === 'ask')
    return { ok: false, ask: true, error: by.user ? 'Маршрута нет — выберите заявку кнопкой в Telegram' : 'Выберите заявку или маршрут' };
  const d = dbAs(`Бот: ${item.summary.split('\n')[0]} · подтвердил ${by.name}`);
  try {
    const res = await applyAction(item.proposal, item.wallet, item.author_partner, d);
    await db.from('ak_inbox').update({ status: 'applied', result: { text: res }, error: null, decided_by_tg: by.tg ?? null, decided_by_user: by.user ?? null, decided_at: new Date().toISOString() }).eq('id', id);
    await updateMsg(item, `✅ Записано (${by.name}): ${res}`);
    return { ok: true, result: res };
  } catch (e: any) {
    const msg = e?.message || String(e);
    await db.from('ak_inbox').update({ status: 'error', error: msg }).eq('id', id);
    await updateMsg({ ...item, status: 'error' }, `⚠️ Не записалось: ${msg}\nИсправьте на сайте («Ждут подтверждения»).`, true);
    return { ok: false, error: msg };
  }
}
async function rejectItem(id: string, by: { tg?: number; user?: string; name: string }) {
  const { data: item } = await db.from('ak_inbox').select('*').eq('id', id).single();
  if (!item || item.status === 'applied') return { ok: false, error: 'уже записано' };
  await db.from('ak_inbox').update({ status: 'rejected', decided_by_tg: by.tg ?? null, decided_by_user: by.user ?? null, decided_at: new Date().toISOString() }).eq('id', id);
  await updateMsg(item, `❌ Не записываем (${by.name})`);
  return { ok: true };
}
async function chooseWallet(id: string, code: string, by: { tg?: number; user?: string; name: string; partner?: string | null }) {
  const wallet = WCODE[code] || code;
  const { data: item } = await db.from('ak_inbox').select('*').eq('id', id).single();
  if (!item || item.status !== 'needs_wallet') return { ok: false, error: 'уже решено' };
  await db.from('ak_inbox').update({ status: 'pending', wallet }).eq('id', id);
  // Исмат выбрал — сразу записываем; Сарвар выбрал — ждём подтверждения Исмата
  if (by.partner === 'ismat' || by.user) return applyItem(id, by);
  const { data: fresh } = await db.from('ak_inbox').select('*').eq('id', id).single();
  await updateMsg(fresh, `Кошелёк: ${wallet === 'personal' ? 'лично (фин. помощь)' : WALLETS[wallet]} (выбрал ${by.name}). Ждёт подтверждения Исмата.`, true);
  return { ok: true };
}
async function updateMsg(item: any, footer: string, keepButtons = false) {
  if (!item.tg_message_id) return;
  const chatId = item.tg_chat_id ?? (await chatByRole('finance'))?.chat_id;
  if (!chatId) return;
  // в «Перевозках» — без денег: ошибки записи там не расписываем (подробно — на сайте)
  const transport = !!item.proposal?._transport;
  const tfooter = transport && footer.startsWith('⚠️') ? '⚠️ Не записалось — подробности на сайте («Ждут подтверждения»).' : footer;
  await tg('editMessageText', { chat_id: chatId, message_id: item.tg_message_id, parse_mode: 'HTML',
    text: transport ? transportText(item, tfooter) : itemText(item, esc(footer)),
    reply_markup: keepButtons ? buttons(item) : { inline_keyboard: [] } });
}

// ================= КОМАНДЫ В ГРУППЕ «РАСЧЁТЫ» =================
// Решение владельца (2026-11-26): «Отчёт», «Заявки» (заводу / перевозчику → 5 последних +
// поиск в свободной форме → PDF с печатью в группу), «Открытые вопросы».
const COMMANDS = [
  { command: 'otchet', description: 'Отчёт: кошельки, долги завода, перевозчикам, оформление' },
  { command: 'zayavki', description: 'Заявки: заводу или перевозчику (PDF)' },
  { command: 'voprosy', description: 'Открытые вопросы' },
];
// Постоянное меню под полем ввода в «Расчётах» (решение владельца): нажатие кнопки
// отправляет её текст — он распознаётся как команда.
const MENU = { keyboard: [[{ text: '📊 Отчёт' }, { text: '📄 Заявки' }, { text: '❓ Вопросы' }]], resize_keyboard: true, is_persistent: true };
function commandOf(text: string): string | null {
  const t = text.trim().toLowerCase().replace(/@\w+$/, '').replace(/ё/g, 'е').replace(/^[^\p{L}\/]+/u, '').trim();
  if (/^\/otchet\b|^отчет$/.test(t)) return 'otchet';
  if (/^\/zayavki\b|^заявки$/.test(t)) return 'zayavki';
  if (/^\/voprosy\b|^(открытые )?вопросы$/.test(t)) return 'voprosy';
  return null;
}

async function cmdReport(chatId: number) {
  const [{ data: wallets }, { data: bal }, { data: s, error }] = await Promise.all([
    db.from('ak_wallets').select('*').eq('active', true).order('sort_order'),
    db.from('ak_wallet_balances').select('*'),
    db.rpc('ak_summary_core', { p_from: null, p_to: null }),
  ]);
  if (error) throw error;
  const { count: open } = await db.from('ak_inbox').select('id', { count: 'exact', head: true }).in('status', ['pending', 'needs_wallet', 'error']);
  const b = (id: string) => (bal || []).find((x: any) => x.wallet_id === id) || {};
  const lines = (wallets || []).map((w: any) => `• ${esc(w.name)}: <b>${money(Number(b(w.id).balance_minor || 0), w.currency)}</b>${Number(b(w.id).in_transit_minor) ? ` (в пути ${money(Number(b(w.id).in_transit_minor), w.currency)})` : ''}`);
  const owe = Number(s.carriers_owe_us_uzs || 0);
  const p = await cashPlan();
  const text = `📊 <b>Отчёт на ${dmy(today())}</b>\n\n<b>Кошельки</b>\n${lines.join('\n')}\n\n` +
    `🏭 Завод должен нам: <b>${money(Number(s.factory_debt_uzs || 0), 'UZS')}</b>\n` +
    `🚚 Мы должны перевозчикам: <b>${money(Number(s.carriers_debt_uzs || 0), 'UZS')}</b>${owe ? `\n↩️ Перевозчики должны нам: ${money(owe, 'UZS')}` : ''}\n` +
    `📑 Должны заводу за оформление: <b>${money(Number(s.oformlenie_debt_usd || 0), 'USD')}</b>\n\n` +
    `⏰ К оплате сегодня и просрочено: ${p.nowCnt ? `<b>${money(p.now, 'UZS')}</b> (${p.nowCnt} рейс.)` : 'нет'}${p.soon ? ` · на неделе ещё ${money(p.soon, 'UZS')}` : ''}\n` +
    gapLines(p) +
    (open ? `\n\n❓ Ждут подтверждения: ${open} — команда /voprosy` : '');
  await tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: MENU });
}

// ---------- заявки ----------
async function cmdRequests(chatId: number) {
  await tg('sendMessage', { chat_id: chatId, text: '📄 Какая заявка нужна?', reply_markup: { inline_keyboard: [[
    { text: '🏭 Заявка заводу', callback_data: 'zl:f' }, { text: '🚚 Заявка перевозчику', callback_data: 'zl:c' }]] } });
}
async function routeNames() { return Object.fromEntries(((await db.from('ak_routes').select('id, name')).data || []).map((r: any) => [r.id, r.name])); }
const reqLabel = (r: any, rn: Record<string, string>) => `№${r.number} · ${rn[r.route_id] || ''} · ${dmy(r.loading_date)}`;
async function lotLabels(trips: any[]) {
  const vIds = [...new Set(trips.flatMap((t) => [t.tractor_id]).filter(Boolean))];
  const cIds = [...new Set(trips.map((t) => t.carrier_id).filter(Boolean))];
  const { data: vs } = vIds.length ? await db.from('ak_vehicles').select('id, plate_norm').in('id', vIds) : { data: [] };
  const { data: cs } = cIds.length ? await db.from('ak_carriers').select('id, name').in('id', cIds) : { data: [] };
  const pv = Object.fromEntries((vs || []).map((v: any) => [v.id, v.plate_norm]));
  const pc = Object.fromEntries((cs || []).map((c: any) => [c.id, c.name]));
  return (t: any) => `№${t.number} · ${pv[t.tractor_id] || ''} · ${(pc[t.carrier_id] || '').slice(0, 22)}`;
}
async function listRequests(chatId: number, kind: 'f' | 'c', rows?: any[], title?: string) {
  const rn = await routeNames();
  let buttons: any[] = [];
  if (kind === 'f') {
    const list = rows || (await db.from('ak_requests').select('*').not('number', 'is', null).neq('status', 'cancelled').order('loading_date', { ascending: false }).order('created_at', { ascending: false }).limit(5)).data || [];
    buttons = list.map((r: any) => [{ text: reqLabel(r, rn), callback_data: `pf:${r.id}` }]);
  } else {
    const list = rows || (await db.from('ak_trips').select('*').not('number', 'is', null).not('status', 'in', '(cancelled,failed)').order('created_at', { ascending: false }).limit(5)).data || [];
    const lbl = await lotLabels(list);
    buttons = list.map((t: any) => [{ text: lbl(t), callback_data: `pc:${t.id}` }]);
  }
  if (!rows) buttons.push([{ text: '🔍 Поиск', callback_data: `zs:${kind}` }]);
  const head = title || (kind === 'f' ? '🏭 Последние заявки заводу:' : '🚚 Последние заявки перевозчикам:');
  await tg('sendMessage', { chat_id: chatId, text: buttons.length ? head : 'Ничего не нашёл.', reply_markup: buttons.length ? { inline_keyboard: buttons } : MENU });
}
const SEARCH_MARK = { f: '🔍 Поиск заявки заводу', c: '🔍 Поиск заявки перевозчику' } as Record<string, string>;
async function askSearch(chatId: number, kind: 'f' | 'c') {
  await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `${SEARCH_MARK[kind]}\nОтветьте на это сообщение: номер машины, дата погрузки, фирма, маршрут или номер заявки — в любой форме.`,
    reply_markup: { force_reply: true, input_field_placeholder: 'например: 10V266 ноябрь' } });
}
// Свободный запрос → фильтры (помогает Claude).
async function searchFilters(q: string): Promise<any> {
  const resp: any = await anthropic.messages.create({
    model: MODEL, max_tokens: 1000, output_config: { effort: 'low' } as any,
    tools: [{ name: 'filters', description: 'Фильтры поиска заявок', input_schema: { type: 'object', additionalProperties: false, properties: {
      plate: { type: 'string', description: 'номер машины или его часть, латиницей без пробелов' },
      date_from: { type: 'string', description: 'YYYY-MM-DD' }, date_to: { type: 'string', description: 'YYYY-MM-DD' },
      carrier: { type: 'string', description: 'название фирмы-перевозчика или его часть' },
      route: { type: 'string', description: 'маршрут (город)' }, number: { type: 'string', description: 'номер заявки, например 6-37 или 1-5-2027' } } } }],
    tool_choice: { type: 'auto' } as any,
    messages: [{ role: 'user', content: `Сегодня ${today()}. Пользователь ищет заявку: «${q}». Вызови инструмент filters с тем, что можно понять из запроса (одна дата — date_from и date_to одинаковые; месяц — его первый и последний день; год, если не указан, — ближайший к сегодняшнему).` }],
  } as any, { timeout: 45000, maxRetries: 1 });
  const call = (resp.content || []).find((b: any) => b.type === 'tool_use');
  return call?.input || {};
}
async function doSearch(chatId: number, kind: 'f' | 'c', q: string) {
  const f = await searchFilters(q);
  const rn = await routeNames();
  const { data: reqs } = await db.from('ak_requests').select('*').not('number', 'is', null).neq('status', 'cancelled').order('loading_date', { ascending: false }).limit(1000);
  const { data: trips } = await db.from('ak_trips').select('*').not('number', 'is', null).not('status', 'in', '(cancelled,failed)').limit(5000);
  const { data: vs } = await db.from('ak_vehicles').select('id, plate_norm');
  const { data: cs } = await db.from('ak_carriers').select('id, name');
  const plateOf = Object.fromEntries((vs || []).map((v: any) => [v.id, v.plate_norm]));
  const carrierOf = Object.fromEntries((cs || []).map((c: any) => [c.id, c.name]));
  const reqOf = Object.fromEntries((reqs || []).map((r: any) => [r.id, r]));
  const plate = f.plate ? normPlate(f.plate) : null;
  const okReq = (r: any) => r && (!f.date_from || r.loading_date >= f.date_from) && (!f.date_to || r.loading_date <= f.date_to)
    && (!f.route || (rn[r.route_id] || '').toLowerCase().includes(String(f.route).toLowerCase().slice(0, 5)))
    && (!f.number || r.number === f.number || (kind === 'f' && String(r.number).includes(f.number)));
  const okTrip = (t: any) => (!plate || (plateOf[t.tractor_id] || '').includes(plate)) && (!f.carrier || (carrierOf[t.carrier_id] || '').toLowerCase().includes(String(f.carrier).toLowerCase()));
  let rows: any[];
  if (kind === 'f') {
    rows = (reqs || []).filter((r: any) => okReq(r) && ((!plate && !f.carrier) || (trips || []).some((t: any) => t.request_id === r.id && okTrip(t))));
  } else {
    rows = (trips || []).filter((t: any) => okTrip(t) && okReq(reqOf[t.request_id]) && (!f.number || t.number === f.number || okReq(reqOf[t.request_id])))
      .sort((a: any, b: any) => (reqOf[a.request_id]?.loading_date || '') < (reqOf[b.request_id]?.loading_date || '') ? 1 : -1);
  }
  const what = [f.plate && `машина ${plate}`, f.carrier && `фирма «${f.carrier}»`, f.route && `маршрут ${f.route}`, f.number && `№${f.number}`,
    f.date_from && (f.date_from === f.date_to ? dmy(f.date_from) : `${dmy(f.date_from)}–${dmy(f.date_to)}`)].filter(Boolean).join(', ') || q;
  await listRequests(chatId, kind, rows.slice(0, 8), `🔍 Найдено по запросу (${what}): ${rows.length}${rows.length > 8 ? ', показаны 8 последних' : ''}`);
}

// ---------- PDF заявок (тот же модуль, что на сайте: ak-docs.js) ----------
import './ak-docs.js';
// @ts-ignore — сборка pdfmake для Node/Deno
import pdfMake from 'npm:pdfmake@0.2.10/build/pdfmake.js';
// @ts-ignore
import pdfFonts from 'npm:pdfmake@0.2.10/build/vfs_fonts.js';
(pdfMake as any).vfs = (pdfFonts as any).pdfMake ? (pdfFonts as any).pdfMake.vfs : pdfFonts;
const AKDocs = (globalThis as any).AKDocs;
const pdfBuffer = (def: any) => new Promise<Uint8Array>((res) => (pdfMake as any).createPdf(def).getBuffer((b: any) => res(new Uint8Array(b))));
async function docBase(date: string) {
  const { data: st } = await db.from('ak_settings').select('key, value').in('key', ['mm', 'factory', 'request_defaults', 'stamp']);
  const S = Object.fromEntries((st || []).map((r: any) => [r.key, r.value]));
  const { data: dirs } = await db.from('ak_directors').select('*').lte('valid_from', date).order('valid_from', { ascending: false });
  const dir = (party: string, pos: string) => (dirs || []).find((d: any) => d.party === party && d.position === pos) || null;
  return { mm: S.mm || {}, factory: S.factory || {}, defaults: S.request_defaults || {},
    dirFactory: { director: dir('factory', 'director'), deputy: dir('factory', 'deputy') }, dirMM: { director: dir('mm', 'director') },
    stamp: S.stamp?.data_url || null };
}
async function sendPdf(chatId: number, bytes: Uint8Array, filename: string, caption: string) {
  if (DRY) { DRY.push({ method: 'sendDocument', filename, caption, bytes: bytes.length, pdf: new TextDecoder().decode(bytes.slice(0, 5)) }); return; }
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  fd.append('caption', (await testMode() ? '🧪 ТЕСТ — реальные остатки ещё не введены\n' : '') + caption);
  fd.append('document', new Blob([bytes], { type: 'application/pdf' }), filename);
  fd.append('reply_markup', JSON.stringify(MENU));   // вернуть меню (после поиска его заменял запрос ответа)
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd });
  const j = await r.json(); if (!j.ok) throw new Error(j.description);
}
const fileSafe = (s: string) => String(s || '').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '_');
async function pdfFactoryReq(chatId: number, reqId: string) {
  const { data: r } = await db.from('ak_requests').select('*').eq('id', reqId).single();
  if (r.price_minor == null) throw new Error('у заявки не вписана цена завода');
  const { data: route } = await db.from('ak_routes').select('*').eq('id', r.route_id).single();
  const { data: lots } = await db.from('ak_trips').select('*').eq('request_id', r.id).not('tractor_id', 'is', null).not('status', 'in', '(cancelled,failed)').order('created_at');
  if (!lots?.length) throw new Error('в заявке нет машин');
  const { data: vs } = await db.from('ak_vehicles').select('id, plate_norm').in('id', lots.flatMap((t: any) => [t.tractor_id, t.trailer_id]).filter(Boolean));
  const pv = Object.fromEntries((vs || []).map((v: any) => [v.id, v.plate_norm]));
  const def = AKDocs.factoryRequest({ ...(await docBase(r.loading_date)), number: r.number, date: r.loading_date, kind: r.kind, route,
    trucks: lots.map((t: any) => ({ tractor: pv[t.tractor_id], trailer: pv[t.trailer_id] })),
    price_uzs_minor: r.price_uzs_minor, price_minor: r.price_minor, price_cur: r.price_cur, fx_rate: r.fx_rate, payment_days: r.payment_days });
  await sendPdf(chatId, await pdfBuffer(def), `Заявка_${fileSafe(r.number)}_${fileSafe(route.name)}_${dmy(r.loading_date)}.pdf`, `🏭 Заявка заводу №${r.number} · ${route.name} · ${dmy(r.loading_date)} · ${lots.length} маш.`);
}
async function pdfCarrierReq(chatId: number, tripId: string) {
  const { data: t } = await db.from('ak_trips').select('*').eq('id', tripId).single();
  if (!t.carrier_id) throw new Error('у лота нет перевозчика');
  if (t.price_minor == null) throw new Error('у лота нет цены перевозчику');
  const { data: r } = await db.from('ak_requests').select('*').eq('id', t.request_id).single();
  const { data: route } = await db.from('ak_routes').select('*').eq('id', r.route_id).single();
  const { data: c } = await db.from('ak_carriers').select('*').eq('id', t.carrier_id).single();
  const { data: vs } = await db.from('ak_vehicles').select('id, plate_norm').in('id', [t.tractor_id, t.trailer_id].filter(Boolean));
  const pv = Object.fromEntries((vs || []).map((v: any) => [v.id, v.plate_norm]));
  const base = await docBase(r.loading_date);
  const carrier = c.is_own ? { name: base.mm.name, contract_no: null, contract_date: null, director_name: base.dirMM.director?.full_name } : c;
  const def = AKDocs.carrierRequest({ ...base, number: t.number, date: r.loading_date, kind: r.kind, route,
    truck: { tractor: pv[t.tractor_id], trailer: pv[t.trailer_id] }, price_uzs_minor: t.price_uzs_minor, pay_days: t.pay_days, pay_method: t.pay_method, carrier });
  await sendPdf(chatId, await pdfBuffer(def), `Заявка_перевозчику_${fileSafe(t.number)}_${fileSafe(c.name)}.pdf`, `🚚 Заявка перевозчику №${t.number} · ${c.name} · ${pv[t.tractor_id]} · ${route.name} ${dmy(r.loading_date)}`);
}

// ---------- открытые вопросы ----------
async function cmdQuestions(chatId: number) {
  const out: string[] = [];
  const { data: inbox } = await db.from('ak_inbox').select('*').in('status', ['pending', 'needs_wallet', 'error']).order('created_at').limit(30);
  if (inbox?.length) {
    out.push(`<b>Предложения бота, не подтверждены: ${inbox.length}</b>`);
    inbox.slice(0, 10).forEach((x: any) => out.push(`• ${esc(x.summary.split('\n')[0])}${x.status === 'needs_wallet' ? ' — нужен кошелёк' : x.status === 'error' ? ' — ошибка: ' + esc(x.error || '') : ''}`));
    if (inbox.length > 10) out.push(`… и ещё ${inbox.length - 10} — на сайте «Ждут подтверждения»`);
  }
  const rn = await routeNames();
  const { data: reqs } = await db.from('ak_requests').select('*').neq('status', 'cancelled').gte('loading_date', new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10));
  const { data: trips } = await db.from('ak_trips').select('id, request_id, tractor_id, carrier_id, price_minor, pay_timing, pay_method, status').in('request_id', (reqs || []).map((r: any) => r.id)).not('status', 'in', '(cancelled,failed)');
  const lotIssues: string[] = [];
  for (const r of reqs || []) {
    const ts = (trips || []).filter((t: any) => t.request_id === r.id);
    const free = ts.filter((t: any) => !t.tractor_id).length;
    const noCarrier = ts.filter((t: any) => t.tractor_id && !t.carrier_id).length;
    const noPrice = ts.filter((t: any) => t.tractor_id && t.price_minor == null).length;
    const miss: string[] = [];
    if (r.price_minor == null) miss.push('нет цены завода');
    if (r.kind === 'international' && r.oformlenie_minor == null) miss.push('нет оформления');
    if (free) miss.push(`свободных лотов ${free}`);
    if (noCarrier) miss.push(`без перевозчика ${noCarrier}`);
    if (noPrice) miss.push(`без цены перевозчику ${noPrice}`);
    if (miss.length) lotIssues.push(`• №${r.number} ${rn[r.route_id] || ''} ${dmy(r.loading_date)}: ${miss.join(', ')}`);
  }
  if (lotIssues.length) out.push('', `<b>Не заполнено по заявкам: ${lotIssues.length}</b>`, ...lotIssues.slice(0, 15));
  const botPend = (reqs || []).filter((r: any) => r.bot_pending);
  if (botPend.length) out.push('', `<b>Из бота, ждут одобрения Исмата на сайте: ${botPend.length}</b>`, ...botPend.slice(0, 15).map((r: any) => `• №${r.number} ${rn[r.route_id] || ''} ${dmy(r.loading_date)}`));
  const { data: transit } = await db.from('ak_movements').select('id, amount_in_minor, cur_in, op_date').eq('status', 'in_transit');
  const { data: revs } = await db.from('ak_movements').select('reverses_id').not('reverses_id', 'is', null);
  const reversed = new Set((revs || []).map((x: any) => x.reverses_id));
  const tr = (transit || []).filter((m: any) => !reversed.has(m.id));
  if (tr.length) out.push('', `<b>Передачи наличных «в пути» (получатель не подтвердил): ${tr.length}</b>`, ...tr.map((m: any) => `• ${dmy(m.op_date)} — ${money(Number(m.amount_in_minor), m.cur_in)}`));
  const { data: periods } = await db.from('ak_periods').select('*').eq('status', 'open');
  const pend = (periods || []).filter((p: any) => today() > p.date_to && (!p.confirmed_ismat_at || !p.confirmed_sarvar_at));
  if (pend.length) out.push('', '<b>Отчёты ждут подтверждения</b>', ...pend.map((p: any) => `• ${p.id.startsWith('M') ? 'месяц' : 'квартал'} ${dmy(p.date_from)}–${dmy(p.date_to)} до ${dmy(p.confirm_due)}: ${[!p.confirmed_ismat_at && 'Исмат', !p.confirmed_sarvar_at && 'Сарвар'].filter(Boolean).join(', ')}`));
  await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: out.length ? `❓ <b>Открытые вопросы</b>\n\n${out.join('\n')}` : '✅ Открытых вопросов нет.', reply_markup: MENU });
}

// ================= РАСПИСАНИЕ: 09:00 и 21:00 =================
const addDays = (iso: string, n: number) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
function addWorkdays(iso: string, n: number) {
  const d = new Date(iso + 'T00:00:00Z'); let left = Number(n || 0);
  while (left > 0) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) left--; }
  return d.toISOString().slice(0, 10);
}

// ---------- кассовый разрыв (как на сайте, payPlan в angren/index.html — держать одинаковым) ----------
// деньги во всех кошельках (USD по курсу ЦБ) + от завода в ближайший месяц (22 раб. дня)
// − перевозчикам в ближайший месяц (включая рейсы, у которых срок ещё не определён).
async function cashPlan() {
  const t = today(), week = addWorkdays(t, 5), month = addWorkdays(t, 22);
  const [{ data: bal }, { data: fx }, { data: lots }, { data: calc }, { data: reqs }, { data: carriers }, { data: rc }, { data: s }] = await Promise.all([
    db.from('ak_wallet_balances').select('*'),
    db.from('ak_fx_rates').select('usd_uzs').lte('rate_date', t).order('rate_date', { ascending: false }).limit(1),
    db.from('ak_trips').select('id, request_id, carrier_id, status, loaded_on, delivered_on, pay_timing, pay_days').not('carrier_id', 'is', null).neq('status', 'failed'),
    db.from('ak_trip_calc_uzs').select('trip_id, debt_minor, debt_uzs'),
    db.from('ak_requests').select('id, status, loading_date, issued_on, payment_days'),
    db.from('ak_carriers').select('id, pay_timing, pay_days'),
    db.from('ak_request_calc').select('request_id, factory_uzs'),
    db.rpc('ak_summary_core', { p_from: null, p_to: null }),
  ]);
  const rate = Number(fx?.[0]?.usd_uzs || 0);
  const cashNow = (bal || []).reduce((a: number, b: any) => a + (b.currency === 'USD' ? Math.round(Number(b.balance_minor || 0) * rate) : Number(b.balance_minor || 0)), 0);
  const R = Object.fromEntries((reqs || []).map((r: any) => [r.id, r]));
  const C = Object.fromEntries((carriers || []).map((c: any) => [c.id, c]));
  const D = Object.fromEntries((calc || []).map((c: any) => [c.trip_id, c]));
  let now = 0, nowCnt = 0, soon = 0, out30 = 0;
  for (const l of lots || []) {
    const r = R[l.request_id] || {};
    if (r.status === 'cancelled') continue;
    const d = D[l.id];
    if (!d || d.debt_minor == null || !(Number(d.debt_minor) > 0)) continue;
    const timing = l.pay_timing || C[l.carrier_id]?.pay_timing || 'after_loading';
    const days = l.pay_days ?? C[l.carrier_id]?.pay_days ?? 0;
    const base = timing === 'advance' ? r.loading_date
      : timing === 'after_loading' ? (['loaded', 'delivered'].includes(l.status) ? (l.loaded_on || r.loading_date) : null)
      : (l.status === 'delivered' ? l.delivered_on : null);
    const due = base ? addWorkdays(base, days) : null;
    const v = Number(d.debt_uzs || 0);
    if (due && due <= t) { now += v; nowCnt++; } else if (due && due <= week) soon += v;
    if (!due || due <= month) out30 += v;
  }
  // поступления от завода: полученное засчитывается в самые старые заявки
  // сначала поступления гасят стартовый долг завода (как на сайте и в ak_partners_core)
  const { data: ofd } = await db.from('ak_opening_balances').select('amount_minor').eq('kind', 'factory_debt').eq('archived', false);
  let received = Math.max(0, Number(s?.factory_received_uzs || 0) - (ofd || []).reduce((a: number, o: any) => a + Number(o.amount_minor || 0), 0)), in30 = 0;
  const FU = Object.fromEntries((rc || []).map((x: any) => [x.request_id, Number(x.factory_uzs || 0)]));
  for (const r of (reqs || []).filter((r: any) => r.status === 'issued').sort((a: any, b: any) => a.loading_date < b.loading_date ? -1 : 1)) {
    const total = FU[r.id] || 0, cover = Math.min(total, received); received -= cover;
    if (total - cover > 0 && addWorkdays(r.issued_on || r.loading_date, r.payment_days || 90) <= month) in30 += total - cover;
  }
  return { cashNow, in30, out30, gap: cashNow + in30 - out30, now, nowCnt, soon };
}
function gapLines(p: any) {
  return `💧 <b>Кассовый разрыв за месяц: ${p.gap < 0 ? '🔴 ' : '🟢 '}${money(p.gap, 'UZS')}</b>\n` +
    `   деньги ${money(p.cashNow, 'UZS')} + от завода ${money(p.in30, 'UZS')} − перевозчикам ${money(p.out30, 'UZS')}` +
    (p.gap < 0 ? '\n   ⚠️ денег на оплаты перевозчикам в ближайший месяц не хватает' : '');
}

// ---------- 09:00: вопрос по машинам вчерашней погрузки ----------
const LOAD_MARK = '🔁 Замена машины в лоте №';
// Одно сообщение на заявку: список машин и под ним строка кнопок на каждую машину.
const LOAD_ANS: Record<string, string> = { loaded: '✅ загрузилась', failed: '❌ не приехала', replaced: '🔁 заменена' };
async function loadingCard(reqId: string, lotsIn?: any[]) {
  const { data: r } = await db.from('ak_requests').select('id, number, route_id, loading_date').eq('id', reqId).single();
  const lots = lotsIn || (await db.from('ak_trips').select('*').eq('request_id', reqId).not('tractor_id', 'is', null).not('load_asked_at', 'is', null).order('created_at')).data || [];
  const rn = await routeNames();
  const lbl = await lotLabels(lots);
  const { data: vs } = await db.from('ak_vehicles').select('id, plate_norm').in('id', lots.map((t: any) => t.tractor_id));
  const pv = Object.fromEntries((vs || []).map((v: any) => [v.id, v.plate_norm]));
  const lines = lots.map((t: any) => `${esc(lbl(t))} — ${t.load_answer ? LOAD_ANS[t.load_answer] + ' (' + esc(t.load_answer_by) + ')' + (t.load_answer === 'replaced' && t.notes?.startsWith('замена') ? '' : t.load_answer === 'replaced' ? ' — ответьте новым номером' : '') : '❔'}`);
  const open = lots.filter((t: any) => !t.load_answer);
  const text = `🌅 <b>${esc(rn[r.route_id] || '')} ${dmy(r.loading_date)} (заявка №${r.number})</b>
${open.length ? 'Загрузились ли машины? Ответить может Исмат или Сарвар.' : 'Все ответы получены.'}

${lines.join('\n')}`;
  const keyboard = open.map((t: any) => [{ text: `✅ ${pv[t.tractor_id] || t.number}`, callback_data: `ld:${t.id}:ok` }, { text: '❌ не приехала', callback_data: `ld:${t.id}:no` }, { text: '🔁 заменена', callback_data: `ld:${t.id}:rp` }]);
  return { text, reply_markup: { inline_keyboard: keyboard } };
}
async function morningLoading(chatId: number, forDate?: string) {
  const y = forDate || addDays(today(), -1);
  const { data: reqs } = await db.from('ak_requests').select('id').eq('loading_date', y).neq('status', 'cancelled');
  let n = 0;
  for (const r of reqs || []) {
    const { data: lots } = await db.from('ak_trips').select('*').eq('request_id', r.id).not('tractor_id', 'is', null).in('status', ['assigned', 'loaded']).is('load_asked_at', null).order('created_at');
    if (!lots?.length) continue;
    if (!DRY) await db.from('ak_trips').update({ load_asked_at: new Date().toISOString() }).in('id', lots.map((t: any) => t.id));
    const card = await loadingCard(r.id, DRY ? lots : undefined);
    await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', ...card });
    n += lots.length;
  }
  return n;
}
async function answerLoading(q: any, tripId: string, ans: string, name: string) {
  const { data: t } = await db.from('ak_trips').select('*').eq('id', tripId).single();
  if (!t) return 'лот не найден';
  if (t.load_answer) return `уже ответил ${t.load_answer_by}`;
  const d = dbAs(`Бот: статус машины по утреннему вопросу · ответил ${name}`);
  let upd: any;
  if (ans === 'ok') upd = { status: 'loaded', load_answer: 'loaded', load_answer_by: name };
  else if (ans === 'no') upd = { status: 'failed', failed_reason: `не приехала (ответ в Telegram: ${name})`, load_answer: 'failed', load_answer_by: name, bot_pending: true };
  else upd = { load_answer: 'replaced', load_answer_by: name };
  const { error } = await d.from('ak_trips').update(upd).eq('id', tripId);
  if (error) return error.message;
  const card = await loadingCard(t.request_id);
  await tg('editMessageText', { chat_id: q.message.chat.id, message_id: q.message.message_id, parse_mode: 'HTML', ...card });
  if (ans === 'rp') {
    await tg('sendMessage', { chat_id: q.message.chat.id, text: `${LOAD_MARK}${t.number}
Ответьте на это сообщение новым номером машины (тягач / прицеп).`, reply_markup: { force_reply: true, input_field_placeholder: 'например: 10V266LB / 107546BA' } });
    return 'ждём новый номер';
  }
  return ans === 'no' ? 'рейс «не состоялся»; Исмат одобрит на сайте' : 'записано';
}
async function replaceTruck(chatId: number, lotNumber: string, text: string, fromName: string) {
  const { data: t } = await db.from('ak_trips').select('*').eq('number', lotNumber).single();
  if (!t) throw new Error(`нет лота №${lotNumber}`);
  const { data: r } = await db.from('ak_requests').select('*').eq('id', t.request_id).single();
  const { data: vs } = await db.from('ak_vehicles').select('id, plate_norm, kind, default_trailer_id').eq('active', true);
  const [a, b] = text.split('/').map((x) => x.trim());
  const m = matchPlate(a, vs || [], 'tractor');
  const d = dbAs(`Бот: замена машины в лоте №${t.number} · сообщил ${fromName}`);
  const tractor = m.veh || await vehicleId(m.plate, 'tractor', d);
  const trailer = b ? (matchPlate(b, vs || [], 'trailer').veh || await vehicleId(b, 'trailer', d)) : null;
  const carrierId = await ownerOn(tractor.id, r.loading_date);
  const { data: c } = carrierId ? await db.from('ak_carriers').select('*').eq('id', carrierId).single() : { data: null };
  const upd: any = { tractor_id: tractor.id, trailer_id: trailer?.id ?? tractor.default_trailer_id ?? null, carrier_id: carrierId,
    status: 'loaded', load_answer: 'replaced', load_answer_by: fromName, bot_pending: true, notes: `замена машины (сообщил ${fromName})` };
  if (c) Object.assign(upd, { pay_timing: c.pay_timing, pay_method: c.pay_method, pay_days: c.pay_days });
  if (carrierId !== t.carrier_id) Object.assign(upd, { price_minor: null, price_cur: null });   // новая фирма — цену уточнить
  const { error } = await d.from('ak_trips').update(upd).eq('id', t.id);
  if (error) throw error;
  await tg('sendMessage', { chat_id: chatId, reply_markup: MENU, text: `✅ Лот №${t.number}: теперь ${m.plate}${m.fixedFrom ? ` (исправлено из ${m.fixedFrom})` : ''} — ${c?.name || '❓ фирма неизвестна'}.` +
    `${carrierId !== t.carrier_id ? '\nПеревозчик сменился — впишите цену на сайте.' : ''}\nИсмат одобрит замену на сайте.` });
}

// Куда слать отчёты и напоминания (решение Исмата 2026-11-26): каждому партнёру — в личку с ботом.
// Кто ещё не нажал «Запустить» в личке — тому в группу «Расчёты» (одно сообщение на группу).
async function partnerTargets(groupId: number): Promise<{ chat_id: number; partners: string[] }[]> {
  const { data: us } = await db.from('ak_tg_users').select('tg_user_id, partner_key').not('partner_key', 'is', null);
  const ids = (us || []).map((u: any) => u.tg_user_id);
  const { data: pcs } = ids.length ? await db.from('ak_tg_chats').select('chat_id').eq('type', 'private').in('chat_id', ids) : { data: [] };
  const priv = new Set((pcs || []).map((c: any) => Number(c.chat_id)));
  const out: { chat_id: number; partners: string[] }[] = [];
  const group: string[] = [];
  for (const u of us || []) {
    if (priv.has(Number(u.tg_user_id))) out.push({ chat_id: Number(u.tg_user_id), partners: [u.partner_key] });
    else group.push(u.partner_key);
  }
  if (group.length || !out.length) out.push({ chat_id: groupId, partners: group.length ? group : ['ismat', 'sarvar'] });
  return out;
}

// ---------- 09:00: кошелёк не указан — напомнить; 3 дня — лично автор ----------
async function morningWallets(groupId: number) {
  const targets = await partnerTargets(groupId);
  const chatFor = (p: string | null) => (targets.find((x) => x.partners.includes(p || 'ismat')) || targets[0]).chat_id;
  const { data: items } = await db.from('ak_inbox').select('*').eq('status', 'needs_wallet');
  let reminded = 0, closed = 0;
  for (const it of items || []) {
    const ageDays = (Date.now() - Date.parse(it.created_at)) / 86400000;
    if (ageDays >= 3 && it.kind === 'expense' && it.author_partner) {
      // решение владельца: 3 дня без ответа — расход как оплаченный лично автором (фин. помощь)
      await db.from('ak_inbox').update({ status: 'pending', wallet: 'personal' }).eq('id', it.id);
      await applyItem(it.id, { name: `автоматически (3 дня без ответа о кошельке)` });
      closed++;
      continue;
    }
    if (it.last_asked_at && Date.now() - Date.parse(it.last_asked_at) < 20 * 3600000) continue;
    // напоминание — автору сообщения в личку (нет автора-партнёра — Исмату); старая карточка в группе гасится
    const chatId = chatFor(it.author_partner);
    if (it.tg_message_id && it.tg_chat_id && Number(it.tg_chat_id) !== chatId)
      await updateMsg(it, 'Напоминание о кошельке отправлено в личку с ботом.');
    const sent = await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', reply_markup: buttons(it),
      text: `⏰ <b>Напоминание</b>: из какого кошелька?\n${itemText(it)}${it.kind === 'expense' ? '\n\nЕсли не ответить — через 3 дня от сообщения расход запишется как оплаченный лично автором.' : ''}` });
    await db.from('ak_inbox').update({ wallet_asks: (it.wallet_asks || 0) + 1, last_asked_at: new Date().toISOString(), ...(sent.ok ? { tg_message_id: sent.result.message_id, tg_chat_id: chatId } : {}) }).eq('id', it.id);
    reminded++;
  }
  return { reminded, closed };
}

// ---------- 09:00: подтверждение месячных и квартальных отчётов ----------
const MONTHS_RU = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
function periodTitle(id: string) {
  if (id[0] === 'M') return `${MONTHS_RU[+id.slice(6, 8) - 1]} ${id.slice(1, 5)}`;
  return `${['I', 'II', 'III', 'IV'][+id.slice(6, 7) - 1]} квартал ${id.slice(1, 5)}`;
}
async function morningPeriods(groupId: number) {
  const targets = await partnerTargets(groupId);
  const t = today();
  // все месяцы / кварталы, закончившиеся и ещё не закрытые
  const ids: string[] = [];
  for (let k = 1; k <= 3; k++) {
    const d = new Date(Date.parse(t.slice(0, 8) + '01T00:00:00Z')); d.setUTCMonth(d.getUTCMonth() - k);
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
    ids.push(`M${y}-${String(m).padStart(2, '0')}`);
    if (m % 3 === 0) ids.push(`Q${y}-${m / 3}`);
  }
  let sent = 0;
  for (const id of ids) {
    const { data: p, error } = await db.rpc('ak_period_ensure', { p_id: id });
    if (error || !p) continue;
    if (p.status === 'closed' || t >= p.lock_from || t <= p.date_to) continue;
    const needConfirm = !p.confirmed_ismat_at || !p.confirmed_sarvar_at;
    const needTax = p.kind === 'quarter' && p.tax_actual_minor == null;
    if (!needConfirm && !needTax) continue;
    // в первый день после конца периода, затем раз в 3 дня, в последние 3 дня до срока — каждый день
    const first = t === addDays(p.date_to, 1);
    const late = t >= addDays(p.confirm_due, -3);
    const due = first || late || !p.last_reminded || t >= addDays(p.last_reminded, 3);
    if (!due || p.last_reminded === t) continue;
    const { data: s } = await db.rpc('ak_summary_core', { p_from: p.date_from, p_to: p.date_to });
    // пустой период (ни заявок, ни расходов, ни потерь) — подтверждать нечего
    if (!Number(s?.requests) && !Number(s?.expenses_fixed_uzs) && !Number(s?.losses_uzs)) continue;
    const half =Math.round(Number(s?.net_profit_uzs || 0) / 2);
    const who = [!p.confirmed_ismat_at && 'Исмат', !p.confirmed_sarvar_at && 'Сарвар'].filter(Boolean).join(', ');
    const text = `🗓 <b>Отчёт: ${periodTitle(id)}</b>\n` +
      `Заявок ${s?.requests ?? 0}, машин ${s?.trucks ?? 0}\nПрибыль по заявкам: ${money(Number(s?.profit_requests_uzs || 0), 'UZS')}\n` +
      `Налог на прибыль: ${money(Number(s?.tax_estimate_uzs || 0), 'UZS')}${p.kind === 'quarter' && p.tax_actual_minor == null ? ' (оценка 15%)' : ''}\n` +
      `<b>Чистая прибыль: ${money(Number(s?.net_profit_uzs || 0), 'UZS')}</b> — по ${money(half, 'UZS')} каждому\n\n` +
      (needConfirm ? `Подтвердить до ${dmy(p.confirm_due)}; ждём: ${who}. Подробный PDF — на сайте («Отчёты и закрытие»).\n` : '') +
      (needTax ? `❗ Исмат, впишите на сайте фактический налог на прибыль от бухгалтерии до ${dmy(p.confirm_due)} (иначе останется оценка 15%).\n` : '') +
      `С ${dmy(p.lock_from)} период закроется сам.`;
    for (const tgt of targets) {
      // кнопка — только тому, кто ещё не подтвердил; кому нечего делать — не пишем
      const mine = tgt.partners.some((x) => !p[`confirmed_${x}_at`]);
      const taxMine = needTax && tgt.partners.includes('ismat');
      if (!mine && !taxMine) continue;
      await tg('sendMessage', { chat_id: tgt.chat_id, parse_mode: 'HTML', text, reply_markup: mine ? { inline_keyboard: [[{ text: '✅ Подтверждаю отчёт', callback_data: `cf:${id}` }]] } : MENU });
    }
    if (!DRY) await db.from('ak_periods').update({ last_reminded: t }).eq('id', id);
    sent++;
  }
  return sent;
}
async function confirmPeriodTg(q: any, id: string, partner: string, name: string) {
  const { data: p } = await db.from('ak_periods').select('*').eq('id', id).single();
  if (!p) return 'период не найден';
  const col = `confirmed_${partner}_at`;
  if (p[col]) return 'вы уже подтвердили';
  await dbAs(`Бот: подтверждение отчёта ${periodTitle(id)} · ${name}`).from('ak_periods').update({ [col]: new Date().toISOString() }).eq('id', id);
  const { data: np } = await db.from('ak_periods').select('*').eq('id', id).single();
  const both = np.confirmed_ismat_at && np.confirmed_sarvar_at;
  await tg('editMessageText', { chat_id: q.message.chat.id, message_id: q.message.message_id, parse_mode: 'HTML',
    text: esc(q.message.text) + `\n\n✅ Подтвердил ${name}` + (both ? '\n🎉 Отчёт подтверждён обоими.' : ''),
    reply_markup: both ? { inline_keyboard: [] } : { inline_keyboard: [[{ text: '✅ Подтверждаю отчёт', callback_data: `cf:${id}` }]] } });
  return 'подтверждено';
}

// ---------- 21:00: ежедневный отчёт ----------
async function eveningReport(groupId: number) {
  const targets = await partnerTargets(groupId);
  const t = today();
  const [{ data: wallets }, { data: bal }, { data: s }] = await Promise.all([
    db.from('ak_wallets').select('*').eq('active', true).order('sort_order'),
    db.from('ak_wallet_balances').select('*'),
    db.rpc('ak_summary_core', { p_from: null, p_to: null }),
  ]);
  const { data: mvs } = await db.from('ak_movements').select('*').eq('op_date', t).neq('kind', 'reversal');
  const KIND: Record<string, string> = { factory_income: 'от завода', carrier_payment: 'перевозчикам', cash_withdrawal: 'снятие наличных', transfer: 'переводы/обмены', handover: 'передачи наличных', oformlenie_payment: 'оформление', expense: 'расходы', partner_withdrawal: 'изъятия партнёров', help_return: 'возврат фин. помощи', income_other: 'прочие поступления' };
  const agg: Record<string, Record<string, number>> = {};
  for (const m of mvs || []) { agg[m.kind] = agg[m.kind] || {}; agg[m.kind][m.cur_in] = (agg[m.kind][m.cur_in] || 0) + Number(m.amount_in_minor); }
  const dayLines = Object.entries(agg).map(([k, v]) => `• ${KIND[k] || k}: ${Object.entries(v).map(([c, x]) => money(x, c)).join(' + ')}`);
  const b = (id: string) => (bal || []).find((x: any) => x.wallet_id === id) || {};
  const wl = (wallets || []).map((w: any) => `• ${esc(w.name)}: ${money(Number(b(w.id).balance_minor || 0), w.currency)}`);
  const p = await cashPlan();   // к оплате сегодня и кассовый разрыв — как на сайте
  const { count: open } = await db.from('ak_inbox').select('id', { count: 'exact', head: true }).in('status', ['pending', 'needs_wallet', 'error']);
  const { count: botPend } = await db.from('ak_requests').select('id', { count: 'exact', head: true }).eq('bot_pending', true).neq('status', 'cancelled');
  const text = `🌙 <b>Итоги дня ${dmy(t)}</b>\n\n<b>Движение денег сегодня</b>\n${dayLines.join('\n') || '• не было'}\n\n<b>Кошельки</b>\n${wl.join('\n')}\n\n` +
    `🏭 Завод должен нам: ${money(Number(s?.factory_debt_uzs || 0), 'UZS')}\n🚚 Мы должны перевозчикам: ${money(Number(s?.carriers_debt_uzs || 0), 'UZS')}\n` +
    `📑 Оформление заводу: ${money(Number(s?.oformlenie_debt_usd || 0), 'USD')}\n` +
    `⏰ К оплате перевозчикам сегодня и просрочено: ${p.nowCnt ? `${money(p.now, 'UZS')} (${p.nowCnt} рейс.)` : 'нет'}${p.soon ? ` · на неделе ещё ${money(p.soon, 'UZS')}` : ''}
` + gapLines(p) +
    ((open || botPend) ? `\n\n❓ Ждут подтверждения: ${open || 0} в боте${botPend ? `, ${botPend} заявок — одобрение на сайте` : ''}. Подробно — кнопка «❓ Вопросы».` : '');
  for (const tgt of targets) await tg('sendMessage', { chat_id: tgt.chat_id, parse_mode: 'HTML', text, reply_markup: MENU });
  return targets.map((x) => x.chat_id === groupId ? 'группа' : x.partners.join(','));
}

// ---------- пробный разбор пересланного сообщения (только показать, не записывать) ----------
async function dryParseForwarded(chatId: number, m: any, saved: any) {
  const o = m.forward_origin || {};
  const origUser = o.sender_user || m.forward_from || null;
  const origDate = new Date(((o.date || m.forward_date || m.date) as number) * 1000).toISOString();
  const authorName = origUser ? [origUser.first_name, origUser.last_name].filter(Boolean).join(' ') : (o.sender_user_name || o.sender_chat?.title || m.forward_sender_name || 'автор скрыт');
  const head = `🔍 <b>Пробный разбор</b> — в учёт НЕ записано\nАвтор: ${esc(authorName)} · ${dmy(origDate.slice(0, 10))} ${origDate.slice(11, 16)} UTC\n\n`;
  if (!/\d/.test(saved.text || '') && !saved.file_id) {
    await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: head + 'В сообщении нет цифр и файла — в группе бот его пропустил бы (не отправляет в ИИ).', reply_markup: MENU });
    return;
  }
  if (!DRY) await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  // как будто сообщение пришло в «Расчёты» в исходный день (для «вчера», «завтра» и т. п.)
  const finance = await chatByRole('finance');
  const fake = { ...saved, id: 0, chat_id: finance?.chat_id ?? 0, message_id: -1, tg_user_id: origUser?.id ?? null, sent_at: origDate, reply_to_message_id: null };
  const actions = await parseMessage(fake);
  if (!actions.length) {
    await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: head + 'Записывать нечего — в группе бот промолчал бы.', reply_markup: MENU });
    return;
  }
  const parts: string[] = [];
  for (const a of actions) {
    if (a.type === 'loading') a._lines = await enrichLoading(a);
    const need = walletNeed(a);
    parts.push(`• ${esc(describe(a))}` +
      (a._lines?.length ? '\n' + a._lines.map((l: string) => '   ' + esc(l)).join('\n') : '') +
      (need ? `\n   ❓ спросил бы кнопками, из какого кошелька` : '') +
      (a.confidence === 'low' ? '\n   ⚠️ не уверен' : '') +
      (a.quote ? `\n   <i>«${esc(String(a.quote).slice(0, 160))}»</i>` : ''));
  }
  await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: (head + `Понял так (${actions.length}):\n` + parts.join('\n\n')).slice(0, 4000), reply_markup: MENU });
}

// ---------- вопросы в личке (решение Исмата 2026-11-26) ----------
// «Сколько перевозок на Ишимбай за ноябрь?» — Claude пишет SELECT, бот выполняет его через
// ak_bot_query (роль ak_reader: только чтение таблиц ak_*, транзакция read-only; миграция 0076).
let schemaCache: string | null = null;
async function akSchema(): Promise<string> {
  if (schemaCache) return schemaCache;
  const { data, error } = await db.rpc('ak_bot_query', { q: `select table_name t, string_agg(column_name || ' ' || data_type, ', ' order by ordinal_position) c
    from information_schema.columns where table_schema = 'public' and table_name like 'ak\\_%' group by 1 order by 1` });
  if (error) throw error;
  schemaCache = (data || []).map((r: any) => `${r.t}(${r.c})`).join('\n');
  return schemaCache;
}
const ASK_SYSTEM = `Ты — помощник учёта блока «Ангрен Каолин» (перевозки каолина с завода ANGREN KAOLIN; партнёры Исмат и Сарвар, прибыль 50/50). Отвечаешь партнёру в личке Telegram на вопросы по данным учёта.
Данные читай инструментом run_sql (PostgreSQL, только SELECT, одна команда, до 200 строк). Не выдумывай цифры — только из запросов. Если вопрос неясен — сделай разумное допущение и назови его.

Как устроены данные:
- ak_requests — заявки завода: number («6-37»), route_id → ak_routes(name, kind: 'local' местный / 'international'), loading_date (дата погрузки), trucks_ordered, price_minor/price_cur (цена завода за машину), oformlenie_minor (оформление, USD), status ('cancelled' — отменена, не считать).
- ak_trips — лоты = машины по заявке: request_id, number (номер заявки перевозчику), tractor_id/trailer_id → ak_vehicles(plate_norm), carrier_id → ak_carriers(name), price_minor/price_cur (цена перевозчику), status: 'assigned' (лот ещё без машины, если tractor_id null), 'loaded', 'delivered', 'failed' (не состоялся), 'cancelled'.
  ПЕРЕВОЗКА (рейс) = лот с tractor_id is not null и status not in ('cancelled','failed'). Дата перевозки = loading_date заявки (или loaded_on лота).
- ak_trip_calc_uzs (trip_id, debt_uzs — долг перевозчику в тийинах) и другие представления *_calc — готовые расчёты.
- ak_movements — движения денег: kind (factory_income от завода, carrier_payment, expense, transfer, cash_withdrawal, handover, oformlenie_payment, partner_withdrawal…), op_date, from_wallet/to_wallet, amount_out_minor/cur_out, amount_in_minor/cur_in, carrier_id, trip_id, request_id, counterparty, note; kind='reversal' (сторно) и движения, на которые ссылается reverses_id другого движения, — отменённые, не считать. ak_wallet_balances — остатки кошельков (ak_wallets.name).
- ak_expenses — расходы; ak_factory_adjustments — корректировки сверки с заводом; ak_periods — месяцы/кварталы и их подтверждение.
- Функция ak_summary_core(from date, to date) → jsonb: requests, trucks, factory_uzs, carriers_uzs, profit_requests_uzs, net_profit_uzs, tax_estimate_uzs, factory_debt_uzs, carriers_debt_uzs, oformlenie_debt_usd, losses_uzs, vat_payable_uzs и др. (null, null — за всё время). Для прибыли и долгов используй её.
- ВСЕ суммы *_minor и *_uzs/*_usd в jsonb — в минимальных единицах (тийины/центы): дели на 100.

Ответ: коротко, по-русски, простым текстом без Markdown и HTML. Числа — с пробелами по три цифры (22 776 991 сум). Если перечисляешь рейсы — номер машины, фирма, дата. Укажи период, за который считал.
Если сообщение — не вопрос, а запись (оплата, расход, цена), ответь, что записи в учёт вносятся через группу «Расчёты», здесь только ответы на вопросы.`;

async function askData(chatId: number, question: string) {
  if (!DRY) await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  // короткая память: последние реплики этой лички за 30 минут (для «а за октябрь?»)
  const msgs: any[] = [];
  if (!DRY) {
    const { data: hist } = await db.from('ak_tg_messages').select('tg_user_id, text, sent_at').eq('chat_id', chatId)
      .gte('sent_at', new Date(Date.now() - 30 * 60000).toISOString()).order('sent_at', { ascending: false }).limit(9);
    for (const h of (hist || []).reverse().slice(0, -1)) {
      if (!h.text) continue;
      const role = h.tg_user_id ? 'user' : 'assistant';
      if (msgs.length && msgs[msgs.length - 1].role === role) msgs[msgs.length - 1].content += '\n' + h.text;
      else msgs.push({ role, content: h.text });
    }
    while (msgs.length && msgs[0].role !== 'user') msgs.shift();
    if (msgs.length && msgs[msgs.length - 1].role === 'user') msgs.pop();
  }
  msgs.push({ role: 'user', content: `Сегодня ${today()}. Вопрос: ${question}` });
  const system = ASK_SYSTEM + '\n\nСхема (таблица(колонка тип, …)):\n' + await akSchema();
  const tools = [{ name: 'run_sql', description: 'Выполнить один SELECT по данным учёта (только чтение). Возвращает JSON-массив строк (до 200).',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'SQL SELECT' } }, required: ['query'] } }];
  let answer = '';
  for (let step = 0; step < 8; step++) {
    const resp: any = await (anthropic.messages.create as any)({ model: MODEL, max_tokens: 4000, system, tools, messages: msgs,
      thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } }, { timeout: 120000, maxRetries: 1 });
    msgs.push({ role: 'assistant', content: resp.content });
    const uses = (resp.content || []).filter((b: any) => b.type === 'tool_use');
    if (resp.stop_reason !== 'tool_use' || !uses.length) {
      answer = (resp.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
      break;
    }
    if (!DRY) await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
    const results = [];
    for (const u of uses) {
      const { data, error } = await db.rpc('ak_bot_query', { q: String(u.input?.query || '') });
      const out = error ? `Ошибка: ${error.message}` : JSON.stringify(data).slice(0, 30000);
      if (DRY) DRY.push({ method: 'sql', text: u.input?.query, result: out.slice(0, 500) });
      results.push({ type: 'tool_result', tool_use_id: u.id, content: out, ...(error ? { is_error: true } : {}) });
    }
    msgs.push({ role: 'user', content: results });
  }
  if (!answer) answer = 'Не получилось найти ответ — попробуйте спросить иначе.';
  const sent = await tg('sendMessage', { chat_id: chatId, text: answer.slice(0, 4000), reply_markup: MENU });
  // ответ бота — в историю лички (для уточняющих вопросов)
  if (!DRY && sent.ok) await db.from('ak_tg_messages').upsert({ chat_id: chatId, message_id: sent.result.message_id, tg_user_id: null,
    sent_at: new Date().toISOString(), text: answer.slice(0, 4000) }, { onConflict: 'chat_id,message_id' });
}

async function sendHelp(chatId: number) {
  await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text:
    '👋 <b>Бот учёта «Ангрен Каолин» на связи.</b>\n\n' +
    'Команды (кнопка «/» у поля ввода или словом):\n' +
    '• /otchet — <b>отчёт</b>: кошельки, долг завода, долги перевозчикам, оформление\n' +
    '• /zayavki — <b>заявки</b>: заводу или перевозчику, PDF с печатью\n' +
    '• /voprosy — <b>открытые вопросы</b>\n\n' +
    'Пишите как обычно: цены по рейсу, поступления, расходы, фото чеков. Я предложу запись с кнопками; записывает Исмат. ' +
    'Список машин в группе «Перевозки» подтверждают Исмат или Сарвар; всё, что записано через меня, Исмат ещё одобряет на сайте.\n\n' +
    'Кнопки меню — под полем ввода 👇', reply_markup: MENU });
}

// Ошибку команды — сообщением в группу, а не молча.
async function runSafe(chatId: number, job: () => Promise<unknown>) {
  try { await job(); }
  catch (e: any) { console.error(e); await tg('sendMessage', { chat_id: chatId, text: `⚠️ Не получилось: ${e?.message || e}`, reply_markup: MENU }); }
}
// Меню команд (кнопка «/» в Telegram) — в группе «Расчёты» и в личке партнёров.
async function ensureCommands(chatId: number) {
  const { data } = await db.from('ak_settings').select('value').eq('key', 'bot').maybeSingle();
  const v = data?.value || {};
  const done: number[] = v.commands_chats || (v.commands_chat ? [v.commands_chat] : []);
  if (done.includes(chatId)) return;
  const r = await tg('setMyCommands', { commands: COMMANDS, scope: { type: 'chat', chat_id: chatId } });
  if (r.ok) await db.from('ak_settings').update({ value: { ...v, commands_chats: [...done, chatId] } }).eq('key', 'bot');
}

// ================= ВХОДЯЩИЕ ОТ TELEGRAM =================
async function handleUpdate(u: any) {
  const m = u.message || u.edited_message || u.channel_post;
  if (u.my_chat_member) {
    const c = u.my_chat_member.chat;
    await db.from('ak_tg_chats').upsert({ chat_id: c.id, title: c.title || c.username || c.first_name, type: c.type, last_seen: new Date().toISOString() });
    return;
  }
  if (u.callback_query) return handleCallback(u.callback_query);
  if (!m) return;
  const chat = m.chat, from = m.from || {};
  await db.from('ak_tg_chats').upsert({ chat_id: chat.id, title: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username, type: chat.type, last_seen: new Date().toISOString() }, { onConflict: 'chat_id', ignoreDuplicates: false });
  if (from.id && !from.is_bot) await db.from('ak_tg_users').upsert({ tg_user_id: from.id, username: from.username, first_name: from.first_name, last_name: from.last_name, last_seen: new Date().toISOString() }, { onConflict: 'tg_user_id' });
  const photo = m.photo ? m.photo[m.photo.length - 1] : null;
  const doc = m.document || null;
  const row = {
    chat_id: chat.id, message_id: m.message_id, tg_user_id: from.id ?? null, sent_at: new Date((m.date || Date.now() / 1000) * 1000).toISOString(),
    text: m.text || m.caption || null, file_id: photo?.file_id || doc?.file_id || null, file_kind: photo ? 'photo' : doc ? 'document' : null,
    file_name: doc?.file_name || null, mime: photo ? 'image/jpeg' : doc?.mime_type || null, reply_to_message_id: m.reply_to_message?.message_id ?? null, raw: m,
  };
  const { data: saved } = await db.from('ak_tg_messages').upsert(row, { onConflict: 'chat_id,message_id' }).select().single();

  const text = (m.text || '').trim();
  // Личка с ботом (решение Исмата 2026-11-26): партнёрам — те же команды, что в «Расчётах»
  // (отчёт, заявки, вопросы, поиск), чтобы не засорять группу. Чужим — только справка с ID.
  // Свободные сообщения в личке в учёт не разбираются — записи только из групп.
  const isPrivate = chat.type === 'private';
  if (isPrivate && !(await partnerOf(from.id))) {
    if (text.startsWith('/start') || text.startsWith('/help')) {
      await tg('sendMessage', { chat_id: chat.id, parse_mode: 'HTML', text: `Здравствуйте! Я бот учёта «Ангрен Каолин».\nЯ читаю группы «Перевозки» и «Расчёты» и предлагаю записи в учёт; подтверждает Исмат.\n\nВаш Telegram ID: <code>${from.id}</code>` });
    }
    return;
  }
  // Пересланное в личку (решение Исмата 2026-11-27): пробный разбор — показать, как бот понял
  // сообщение, БЕЗ записи в учёт и без карточек в группах.
  if (isPrivate && (m.forward_origin || m.forward_date) && saved) {
    EdgeRuntime.waitUntil(runSafe(chat.id, () => dryParseForwarded(chat.id, m, saved)));
    return;
  }
  const { data: c } = isPrivate ? { data: { role: 'finance' } } : await db.from('ak_tg_chats').select('role').eq('chat_id', chat.id).single();
  if (!c?.role || !saved || from.is_bot) return;          // группа ещё не назначена на сайте
  // команды и поиск — в «Расчётах» и в личке партнёра (в «Перевозках» — только списки машин)
  if (c.role === 'finance' && text) {
    EdgeRuntime.waitUntil(ensureCommands(chat.id));
    if (/^\/(start|help)\b/i.test(text)) { EdgeRuntime.waitUntil(runSafe(chat.id, () => sendHelp(chat.id))); return; }
    const cmd = commandOf(text);
    if (cmd) { EdgeRuntime.waitUntil(runSafe(chat.id, () => cmd === 'otchet' ? cmdReport(chat.id) : cmd === 'zayavki' ? cmdRequests(chat.id) : cmdQuestions(chat.id))); return; }
    const rt = m.reply_to_message?.from?.is_bot ? (m.reply_to_message.text || '') : '';
    const kind = rt.includes(SEARCH_MARK.f) ? 'f' : rt.includes(SEARCH_MARK.c) ? 'c' : null;
    if (kind) { EdgeRuntime.waitUntil(runSafe(chat.id, () => doSearch(chat.id, kind, text))); return; }
    const lotMatch = rt.match(/Замена машины в лоте №(\S+)/);
    if (lotMatch) {
      const who = PARTNER[(await partnerOf(from.id)) || ''] || from.first_name || 'кто-то';
      EdgeRuntime.waitUntil(runSafe(chat.id, () => replaceTruck(chat.id, lotMatch[1], text, who))); return;
    }
  }
  if (isPrivate) {
    // свободный вопрос по данным — отвечает Claude (только чтение); записи — только через группу
    if (text) EdgeRuntime.waitUntil(runSafe(chat.id, () => askData(chat.id, text)));
    return;
  }
  // разбираем только то, где есть цифры или файл (болтовню не отправляем в Claude)
  const relevant = /\d/.test(row.text || '') || !!row.file_id;
  if (relevant && !u.edited_message) EdgeRuntime.waitUntil(proposeFromMessage(saved));
}

async function handleCallback(q: any) {
  const [op, id, code] = String(q.data || '').split(':');
  const partner = await partnerOf(q.from?.id);
  const name = partner ? PARTNER[partner] : (q.from?.first_name || 'кто-то');
  const answer = (text: string, alert = false) => tg('answerCallbackQuery', { callback_query_id: q.id, text, show_alert: alert });
  if (!partner) return answer('Вы не отмечены как партнёр — попросите Исмата отметить вас на сайте.', true);
  if (op === 'ap' || op === 'rj') {
    // погрузку (номера машин) подтверждают оба партнёра — как статус машин; остальное — Исмат
    const { data: it } = await db.from('ak_inbox').select('kind').eq('id', id).maybeSingle();
    if (partner !== 'ismat' && it?.kind !== 'loading') return answer('Записи подтверждает Исмат.', true);
    const r: any = op === 'ap' ? await applyItem(id, { tg: q.from.id, name }) : await rejectItem(id, { tg: q.from.id, name });
    return answer(r.ok ? (op === 'ap' ? 'Записано' : 'Не записываем') : (r.error || 'ошибка'), !r.ok && !r.ask);
  }
  if (op === 'pk' || op === 'ro') {
    // выбор заявки / маршрута для списка машин — любой из партнёров
    const r: any = op === 'pk' ? await pickOption(id, code, { tg: q.from.id, name }) : await otherRoute(id);
    return answer(r.ok ? (op === 'pk' ? 'Записано' : '') : (r.error || 'ошибка'), !r.ok && !r.ask);
  }
  if (op === 'wl') {
    const r = await chooseWallet(id, code, { tg: q.from.id, name, partner });
    return answer(r.ok ? 'Кошелёк выбран' : (r.error || 'ошибка'), !r.ok);
  }
  const chatId = q.message?.chat?.id;
  if (op === 'ld') return answer(await answerLoading(q, id, code, name));             // утренний вопрос — любой из партнёров
  if (op === 'cf') return answer(await confirmPeriodTg(q, id, partner, name));        // подтверждение отчёта — каждый за себя
  if (chatId && ['zl', 'zs', 'pf', 'pc'].includes(op)) {
    await answer(op === 'pf' || op === 'pc' ? 'Готовлю PDF…' : '');
    const job = op === 'zl' ? () => listRequests(chatId, id as 'f' | 'c')
      : op === 'zs' ? () => askSearch(chatId, id as 'f' | 'c')
      : op === 'pf' ? () => pdfFactoryReq(chatId, id) : () => pdfCarrierReq(chatId, id);
    EdgeRuntime.waitUntil(runSafe(chatId, job));
    return;
  }
  return answer('');
}

// ================= ВХОД С САЙТА (владелец) =================
async function handleSite(req: Request) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: u } = await db.auth.getUser(token);
  if (!u?.user) return json({ error: 'Нужен вход' }, 401);
  const { data: m } = await db.from('ak_members').select('role, active, display_name').eq('user_id', u.user.id).maybeSingle();
  if (!m?.active || m.role !== 'owner') return json({ error: 'Только владелец' }, 403);
  const body = await req.json().catch(() => ({}));
  const by = { user: u.user.id, name: m.display_name };
  switch (body.action) {
    case 'apply': return json(await applyItem(body.id, by));
    case 'reject': return json(await rejectItem(body.id, by));
    case 'wallet': return json(await chooseWallet(body.id, body.wallet, by));
    case 'setup': {
      // привязать вебхук к этой функции (секрет — в заголовке, Telegram пришлёт его обратно)
      const url = `${SUPABASE_URL}/functions/v1/ak-bot`;
      const r = await tg('setWebhook', { url, secret_token: WH_SECRET, allowed_updates: ['message', 'edited_message', 'callback_query', 'my_chat_member'], drop_pending_updates: false });
      const me = await tg('getMe', {});
      const info = await tg('getWebhookInfo', {});
      return json({ ok: r.ok, bot: me.result?.username, webhook: info.result?.url, pending: info.result?.pending_update_count, last_error: info.result?.last_error_message || null });
    }
    case 'test': {
      const finance = await chatByRole('finance');
      if (!finance) return json({ ok: false, error: 'Группа «Расчёты» не назначена' });
      const r = await tg('sendMessage', { chat_id: finance.chat_id, text: '✅ Бот «Ангрен Каолин» на связи. Здесь будут предложения записей, вопросы и отчёты.' });
      return json({ ok: r.ok, error: r.description });
    }
  }
  return json({ error: 'неизвестное действие' }, 400);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    if (req.headers.get('x-telegram-bot-api-secret-token') === WH_SECRET) {
      const u = await req.json();
      await handleUpdate(u);
      return json({ ok: true });
    }
    if (CRON_SECRET && req.headers.get('x-cron-secret') === CRON_SECRET) {
      const mode = new URL(req.url).searchParams.get('mode');
      if (mode === 'setup') {
        const r = await tg('setWebhook', { url: `${SUPABASE_URL}/functions/v1/ak-bot`, secret_token: WH_SECRET, allowed_updates: ['message', 'edited_message', 'callback_query', 'my_chat_member'] });
        const me = await tg('getMe', {});
        const info = await tg('getWebhookInfo', {});
        return json({ ok: r.ok, bot: me.result?.username, can_read_all_group_messages: me.result?.can_read_all_group_messages, webhook: info.result?.url, pending: info.result?.pending_update_count, last_error: info.result?.last_error_message || null });
      }
      if (mode === 'ping_claude') {
        // диагностика: простой запрос, затем со схемой, с замером времени
        const out: Record<string, unknown> = {};
        let t = Date.now();
        try {
          const r: any = await anthropic.messages.create({ model: MODEL, max_tokens: 200, output_config: { effort: 'low' } as any, messages: [{ role: 'user', content: 'Ответь одним словом: да' }] } as any, { timeout: 60000, maxRetries: 0 });
          out.plain = { ms: Date.now() - t, stop: r.stop_reason, text: (r.content || []).find((b: any) => b.type === 'text')?.text };
        } catch (e: any) { out.plain = { ms: Date.now() - t, error: e?.message || String(e) }; }
        t = Date.now();
        try {
          const r: any = await (anthropic.beta.messages.create as any)({ model: MODEL, max_tokens: 2000, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
            output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } }, messages: [{ role: 'user', content: 'Сообщение: «170 млн тушди». Сегодня 2026-11-26.' }] }, { timeout: 120000, maxRetries: 0 });
          out.schema = { ms: Date.now() - t, stop: r.stop_reason, text: (r.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').slice(0, 400) };
        } catch (e: any) { out.schema = { ms: Date.now() - t, error: e?.message || String(e) }; }
        return json(out);
      }
      if (mode === 'morning' || mode === 'evening') {
        const finance = await chatByRole('finance');
        if (!finance) return json({ ok: false, error: 'группа «Расчёты» не назначена' });
        const res: Record<string, unknown> = {};
        const safe = async (k: string, f: () => Promise<unknown>) => { try { res[k] = await f(); } catch (e: any) { console.error(k, e); res[k] = 'ошибка: ' + (e?.message || e); } };
        if (mode === 'morning') {
          // Утренний вопрос «загрузилась / не приехала / заменена» ОТКЛЮЧЁН (решение владельца
          // 2026-11-26): список машин и так подтверждается в «Перевозках», лот с машиной считается
          // погруженным сам; исключения отмечают на сайте. Код оставлен (morningLoading) на случай возврата.
          await safe('wallets', () => morningWallets(finance.chat_id));
          await safe('periods', () => morningPeriods(finance.chat_id));
        } else {
          await safe('report', () => eveningReport(finance.chat_id));
        }
        return json({ ok: true, ...res });
      }
      if (mode === 'announce') {
        // разовое сообщение от имени бота в группу «Расчёты» (по просьбе Исмата), простым текстом
        const b = await req.json().catch(() => ({}));
        const finance = await chatByRole('finance');
        if (!finance || !b.text) return json({ ok: false, error: 'нет группы или текста' });
        const r = await tg('sendMessage', { chat_id: finance.chat_id, text: String(b.text), reply_markup: MENU });
        return json({ ok: !!r.ok, error: r.description || null });
      }
      if (mode === 'hello') {
        const finance = await chatByRole('finance');
        if (!finance) return json({ ok: false, error: 'группа «Расчёты» не назначена' });
        await sendHelp(finance.chat_id);
        return json({ ok: true });
      }
      if (mode === 'test_cmd') {
        // { cmd: 'otchet'|'voprosy'|'list_f'|'list_c'|'search', kind, q, req_id, trip_id }
        const b = await req.json().catch(() => ({}));
        DRY = [];
        try {
          if (b.cmd === 'otchet') await cmdReport(0);
          else if (b.cmd === 'voprosy') await cmdQuestions(0);
          else if (b.cmd === 'zayavki') await cmdRequests(0);
          else if (b.cmd === 'list') await listRequests(0, b.kind);
          else if (b.cmd === 'search') await doSearch(0, b.kind, b.q);
          else if (b.cmd === 'evening') await eveningReport(0);
          else if (b.cmd === 'ask') await askData(0, b.q);
          else if (b.cmd === 'morning_loading') await morningLoading(0, b.date);
          else if (b.cmd === 'morning_periods') await morningPeriods(0);
          else if (b.cmd === 'pdf_f') await pdfFactoryReq(0, b.req_id);
          else if (b.cmd === 'pdf_c') await pdfCarrierReq(0, b.trip_id);
          return json({ ok: true, out: DRY });
        } catch (e: any) { return json({ ok: false, error: e?.message || String(e), out: DRY }); }
        finally { DRY = null; }
      }
      if (mode === 'test_parse') {
        // проверка разбора без записи: { text, role: 'transport'|'finance' }
        const b = await req.json().catch(() => ({}));
        const chat = await chatByRole(b.role === 'transport' ? 'transport' : 'finance');
        const fake = { id: 0, chat_id: chat?.chat_id ?? 0, message_id: -1, tg_user_id: null, sent_at: new Date().toISOString(), text: b.text, file_id: null, reply_to_message_id: null };
        const actions = await parseMessage(fake);
        const cards: string[] = [];
        for (const a of actions) if (a.type === 'loading') { a._lines = await enrichLoading(a); cards.push(transportText({ proposal: a })); }
        return json({ ok: true, actions, summaries: actions.map(describe), cards });
      }
      return json({ ok: true, note: 'расписание — часть 3' });
    }
    return await handleSite(req);
  } catch (e: any) {
    console.error(e);
    return json({ ok: false, error: e?.message || String(e) }, 200);   // Telegram не должен повторять бесконечно
  }
});
