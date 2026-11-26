// Блок «Ангрен Каолин» — курс ЦБ Узбекистана (USD → сум) с cbu.uz (2026-11-26).
//
// Два способа вызова:
//   * по расписанию (заголовок x-cron-secret): курс на сегодня + досрочно пропущенные
//     дни за последние 10 дней;
//   * со страницы блока (Authorization: Bearer <сессия участника блока>), тело
//     { date: 'YYYY-MM-DD' } — курс на нужную дату (например, на дату погрузки).
// Курс, введённый вручную (source = 'manual'), никогда не перезаписывается.

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CRON_SECRET = Deno.env.get('CRON_SECRET');
const admin = createClient(SUPABASE_URL, SERVICE_KEY);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const tashkentToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tashkent' });

async function fetchCbu(date: string): Promise<number | null> {
  const r = await fetch(`https://cbu.uz/ru/arkhiv-kursov-valyut/json/USD/${date}/`);
  if (!r.ok) throw new Error(`cbu.uz: HTTP ${r.status}`);
  const arr = await r.json();
  const rate = Number(String(arr?.[0]?.Rate ?? '').replace(',', '.'));
  return rate > 0 ? Math.round(rate * 100) / 100 : null;
}

// Сохранить курс, если на эту дату нет ручного. Возвращает итоговую запись.
async function storeRate(date: string) {
  const { data: existing } = await admin.from('ak_fx_rates').select('*').eq('rate_date', date).maybeSingle();
  if (existing?.source === 'manual') return existing;
  const rate = await fetchCbu(date);
  if (rate === null) return existing ?? null;
  if (existing && Number(existing.usd_uzs) === rate) return existing;
  const { data, error } = await admin.from('ak_fx_rates')
    .upsert({ rate_date: date, usd_uzs: rate, source: 'cbu', fetched_at: new Date().toISOString() })
    .select().single();
  if (error) throw error;
  return data;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    // 1) расписание
    if (CRON_SECRET && req.headers.get('x-cron-secret') === CRON_SECRET) {
      const done: Record<string, unknown> = {};
      const today = new Date(`${tashkentToday()}T00:00:00Z`);
      for (let i = 0; i < 10; i++) {
        const d = new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10);
        const { data: has } = await admin.from('ak_fx_rates').select('rate_date').eq('rate_date', d).maybeSingle();
        if (has && i > 0) continue;
        const row = await storeRate(d);
        done[d] = row?.usd_uzs ?? null;
      }
      return json({ ok: true, done });
    }

    // 2) участник блока со страницы
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: u } = await admin.auth.getUser(token);
    if (!u?.user) return json({ error: 'Нужен вход' }, 401);
    const { data: member } = await admin.from('ak_members').select('role, active').eq('user_id', u.user.id).maybeSingle();
    if (!member?.active) return json({ error: 'Нет доступа к блоку' }, 403);

    const body = await req.json().catch(() => ({}));
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body?.date || '') ? body.date : tashkentToday();
    if (date > tashkentToday()) return json({ error: 'Курс на будущую дату ещё не установлен' }, 400);
    const row = await storeRate(date);
    if (!row) return json({ error: `ЦБ не вернул курс на ${date}` }, 404);
    return json({ ok: true, rate: row });
  } catch (e: any) {
    return json({ error: e?.message || String(e) }, 500);
  }
});
