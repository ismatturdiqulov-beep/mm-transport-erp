// MM Transport ERP — Telegram bot webhook (Edge Function)
// Один общий бот на всю платформу (не по одному на компанию — изоляция по company_id,
// как и везде в базе).
//
// Доступ к диалогу с ботом — только у контрагента, закреплённого как "Ответственное лицо"
// хотя бы на одном активном подвижном составе (fleet.kontragent_id), не у любого контрагента —
// решение пользователя 2026-07-20.
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

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const BTN_BALANCE = '💰 Мой баланс';
const BTN_DOCS = '📋 Мои документы';
const BTN_OPS = '📊 Последние операции';
// Полный доступ (баланс, документы на машину, последние операции) — только у
// арендаторов (kontragenty.type = 'tenant', собственник ПС). Наёмные водители
// (type = 'mm' и любой другой тип) подключаются к тому же боту, но видят только
// свои личные документы (права/медсправка/АДР/тахограф) — решение пользователя
// 2026-07-20: финансы и документы на машину наёмному водителю не касаются.
const tenantKeyboard = {
  keyboard: [[{ text: BTN_BALANCE }, { text: BTN_DOCS }], [{ text: BTN_OPS }]],
  resize_keyboard: true,
};
const driverKeyboard = {
  keyboard: [[{ text: BTN_DOCS }]],
  resize_keyboard: true,
};
function keyboardFor(kgType: string | null | undefined) {
  return kgType === 'tenant' ? tenantKeyboard : driverKeyboard;
}

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
    const isTenant = kgType === 'tenant';
    const kb = keyboardFor(kgType);

    if (text === BTN_BALANCE || (message.text && /баланс/i.test(text))) {
      if (!isTenant) {
        await sendMessage(chatId, 'Финансовая информация доступна только арендаторам. Если у вас вопрос по балансу — обратитесь к диспетчеру лично.', kb);
        return new Response('ok');
      }
      const bal = await getBalance(kgId);
      const label = bal < 0 ? `Долг: ${fmtN(-bal)} сум` : bal > 0 ? `Переплата: ${fmtN(bal)} сум` : 'Баланс: 0';
      await sendMessage(chatId, `💰 <b>${label}</b>`, kb);
      return new Response('ok');
    }
    if (text === BTN_OPS || (message.text && /операци/i.test(text))) {
      if (!isTenant) {
        await sendMessage(chatId, 'Акт сверки через бот доступен только арендаторам. Для полного акта сверки обратитесь к диспетчеру лично.', kb);
        return new Response('ok');
      }
      const opsText = await getLastOperationsText(kgId);
      await sendMessage(chatId, `📊 <b>Последние операции:</b>\n${opsText}`, kb);
      return new Response('ok');
    }
    if (text === BTN_DOCS || (message.text && /документ/i.test(text))) {
      const personalText = await getPersonalDocsText(kgId);
      const docsText = isTenant
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

    const { data: fleets } = await supabase.from('fleet').select('id, label').eq('kontragent_id', kgId).neq('active', false);
    const fleetList = fleets || [];

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

  // Проверяем: контрагент должен быть "Ответственное лицо" хотя бы на одном активном ПС
  const { data: fleetRows } = await supabase
    .from('fleet')
    .select('id, label')
    .eq('kontragent_id', linkRow.kontragent_id)
    .neq('active', false);

  if (!fleetRows || fleetRows.length === 0) {
    await sendMessage(chatId,
      'Этот код привязан к контрагенту, за которым не закреплён ни один подвижной состав. Диалог с ботом доступен только ответственным лицам за ПС — обратитесь к диспетчеру.');
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
