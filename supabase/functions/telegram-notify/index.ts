// MM Transport ERP — отправка Telegram-уведомления контрагенту (Edge Function)
// Этап 2 плана (2026-07-20): событийные уведомления (передача/возврат документа,
// начисление/списание баланса, обновление данных водителя). Вызывается прямо из
// приложения после соответствующего действия — сама функция ничего не решает про
// ЧТО написать, только КОМУ и КАК доставить, текст собирает вызывающий код.
//
// Авторизация: вызывающий должен быть залогинен (обычный JWT пользователя), функция
// проверяет что контрагент-получатель принадлежит ТОЙ ЖЕ компании, что и вызывающий —
// иначе один тенант мог бы слать сообщения чужим контрагентам.

import { createClient } from 'npm:@supabase/supabase-js@2';

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Вызывается прямо из браузера (fetch с сайта на GitHub Pages) — другой домен,
// чем сама функция (supabase.co), поэтому без CORS-заголовков и обработки
// preflight (OPTIONS) браузер молча блокирует запрос ещё до отправки (баг найден
// пользователем 2026-07-20: уведомления "не приходили", хотя функция работала
// прекрасно при вызове напрямую curl'ом — там же CORS не применяется).
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

async function sendMessage(chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return new Response('Unauthorized: no auth header', { status: 401, headers: corsHeaders });
  const jwt = authHeader.replace(/^Bearer\s+/i, '');

  // Явно передаём JWT в getUser(jwt) — полагаться на то, что global.headers.Authorization
  // подхватится автоматически, оказалось ненадёжно (баг найден пользователем 2026-07-20:
  // стабильный 401 из браузера при рабочем токене; в curl-тестах с тем же паттерном
  // почему-то проходило — судя по всему, версия supabase-js в Deno не всегда форвардит
  // global-заголовок именно в auth-клиент).
  const supabaseUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: userData, error: userErr } = await supabaseUser.auth.getUser(jwt);
  if (userErr || !userData.user) {
    return new Response('Unauthorized: ' + (userErr?.message || 'no user'), { status: 401, headers: corsHeaders });
  }

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('company_id, role')
    .eq('id', userData.user.id)
    .single();
  if (!profile) return new Response('Forbidden', { status: 403, headers: corsHeaders });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response('Bad request', { status: 400, headers: corsHeaders });
  }
  const { kontragentId, message } = body;
  if (!kontragentId || !message) return new Response('Bad request: kontragentId and message required', { status: 400, headers: corsHeaders });

  // Владелец платформы (role='owner') не привязан ни к одной компании — этому
  // эндпойнту он всё равно не нужен (уведомления шлёт сама компания-арендатор),
  // поэтому просто требуем совпадение company_id как у обычного пользователя.
  const { data: kg } = await supabaseAdmin
    .from('kontragenty')
    .select('company_id')
    .eq('id', kontragentId)
    .single();
  if (!kg || kg.company_id !== profile.company_id) {
    return new Response(JSON.stringify({ sent: false, reason: 'forbidden' }), { status: 403, headers: corsHeaders });
  }

  const { data: link } = await supabaseAdmin
    .from('telegram_links')
    .select('telegram_user_id')
    .eq('kontragent_id', kontragentId)
    .eq('active', true)
    .not('telegram_user_id', 'is', null)
    .maybeSingle();

  if (!link) {
    return new Response(JSON.stringify({ sent: false, reason: 'not_linked' }), { status: 200, headers: corsHeaders });
  }

  await sendMessage(link.telegram_user_id, message);
  return new Response(JSON.stringify({ sent: true }), { status: 200, headers: corsHeaders });
});
