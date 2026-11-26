/*
 * Блок «Ангрен Каолин» — документы (PDF A4, одна страница): заявка завода и заявка
 * перевозчику. Описание документа для pdfmake; тот же модуль потом использует бот
 * (этап 5), поэтому здесь нет обращений к странице — только данные на входе.
 *
 * Реальных реквизитов и печати здесь нет (репозиторий публичный): всё приходит из
 * базы (ak_settings, ak_directors, справочники).
 */
(function (root) {
  'use strict';

  // ---------- сумма прописью ----------
  const UNITS_M = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
  const UNITS_F = ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
  const TEENS = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
  const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
  const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];
  const plural = (n, one, few, many) => {
    const a = n % 100, b = n % 10;
    if (a >= 11 && a <= 19) return many;
    if (b === 1) return one;
    if (b >= 2 && b <= 4) return few;
    return many;
  };
  function triad(n, fem) {
    const out = [];
    const h = Math.floor(n / 100), t = Math.floor((n % 100) / 10), u = n % 10;
    if (h) out.push(HUNDREDS[h]);
    if (t === 1) out.push(TEENS[u]);
    else { if (t) out.push(TENS[t]); if (u) out.push((fem ? UNITS_F : UNITS_M)[u]); }
    return out;
  }
  // Целое число прописью (мужской род по умолчанию).
  function numberWords(n, fem = false) {
    n = Math.floor(Math.abs(Number(n)));
    if (n === 0) return 'ноль';
    const groups = [
      [1e12, false, 'триллион', 'триллиона', 'триллионов'],
      [1e9, false, 'миллиард', 'миллиарда', 'миллиардов'],
      [1e6, false, 'миллион', 'миллиона', 'миллионов'],
      [1e3, true, 'тысяча', 'тысячи', 'тысяч'],
    ];
    const words = [];
    let rest = n;
    for (const [base, gFem, one, few, many] of groups) {
      const g = Math.floor(rest / base);
      if (g) { words.push(...triad(g, gFem), plural(g, one, few, many)); rest %= base; }
    }
    if (rest) words.push(...triad(rest, fem));
    return words.join(' ');
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  // «Пять миллионов сто тысяч сум 00 тийин» из суммы в тийинах.
  function sumWords(minor) {
    const m = Math.round(Number(minor));
    const whole = Math.floor(m / 100), frac = String(m % 100).padStart(2, '0');
    return `${cap(numberWords(whole))} сум ${frac} тийин`;
  }
  const sumDigits = (minor) => String(Math.floor(Math.round(Number(minor)) / 100)) + (Math.round(Number(minor)) % 100 ? ',' + String(Math.round(Number(minor)) % 100).padStart(2, '0') : '');
  const money = (minor) => `${sumDigits(minor)} (${sumWords(minor)})`;
  const countText = (n) => `${n} (${numberWords(n)})`;
  const usd = (cents) => (Number(cents) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 }).replace(/\s/g, '');
  const rateText = (r) => String(Number(r)).replace('.', ',');
  const dmy = (iso) => { if (!iso) return ''; const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${d}.${m}.${y}`; };

  // ---------- общий макет ----------
  const LINE = '________________';
  function header(date, annexTo) {
    return {
      columns: [
        { text: dmy(date), bold: true, width: '*', margin: [0, 6, 0, 0] },
        { stack: [{ text: 'Приложение №1', bold: true }, { text: annexTo }], alignment: 'right', width: 'auto' },
      ],
      margin: [0, 0, 0, 2],
    };
  }
  function title(number) {
    return [
      { text: `Заявка № ${number}`, bold: true, fontSize: 14, alignment: 'center' },
      { text: 'на предоставление транспортных услуг', bold: true, alignment: 'center', margin: [0, 0, 0, 8] },
    ];
  }
  function bodyTable(rows) {
    return {
      table: { widths: ['36%', '*'], body: rows.map(([l, v]) => [{ text: l }, Array.isArray(v) ? { stack: v } : { text: v }]) },
      layout: { hLineWidth: () => 0.6, vLineWidth: () => 0.6, hLineColor: () => '#444', vLineColor: () => '#444', paddingTop: () => 1.6, paddingBottom: () => 1.6, paddingLeft: () => 4, paddingRight: () => 4 },
      margin: [0, 5, 0, 6],
    };
  }
  function clauses(executor, customer) {
    return {
      ol: [
        `${executor} обязуется выполнить перевозку в полном объёме, согласно данным, указанным в заявке.`,
        `${customer} обязуется предоставить груз, готовый к перевозке, необходимые документы на него и своевременно оплатить стоимость перевозки.`,
      ],
      margin: [0, 6, 0, 0],
    };
  }
  function special(conditions) {
    return [
      { text: 'Особые условия:', bold: true, margin: [0, 0, 0, 2] },
      { ol: conditions || [], fontSize: 9, margin: [0, 0, 0, 8] },
    ];
  }
  // Подписи: две колонки. stamp — dataURL печати с подписью MM (необязательно),
  // stampSide — 'left' | 'right' (где колонка MM).
  function signatures(left, right, stamp, stampSide) {
    const col = (p, withStamp) => ({
      width: '*',
      stack: [
        { text: p.role, bold: true, alignment: 'center' },
        { text: p.name, bold: true, alignment: 'center', margin: [0, 0, 0, 3] },
        ...(p.requisites || []).map((x) => ({ text: x, fontSize: 9, lineHeight: 1 })),
        ...p.signers.flatMap((s) => [
          { text: s.position, bold: true, margin: [0, 4, 0, 0] },
          { text: `${s.name}${' '.repeat(6)}${LINE}`, bold: true },
        ]),
        // печать с подписью — поверх строки подписи, места не занимает
        ...(withStamp ? [{ image: withStamp, width: 104, margin: [88, -40, 0, -46] }] : []),
      ],
    });
    const cols = [col(left, stampSide === 'left' && stamp), { width: 20, text: '' }, col(right, stampSide === 'right' && stamp)];
    return [{ columns: cols, unbreakable: true }];
  }
  function doc(content) {
    return {
      pageSize: 'A4',
      pageMargins: [28, 16, 34, 22],
      defaultStyle: { fontSize: 10, lineHeight: 1.05 },
      content,
      footer: (page) => ({ text: String(page), alignment: 'center', fontSize: 8, margin: [0, 6, 0, 0] }),
      info: { title: content.__title || 'Заявка' },
    };
  }

  // ---------- заявка завода (Приложение №1 к договору с заводом) ----------
  // ctx: { number, date, kind, route:{name, unload_address, import_customs}, trucks:[{tractor, trailer}],
  //        price_uzs_minor, price_minor, price_cur, fx_rate, payment_days,
  //        factory:{name, contract_no, contract_date, requisites[], payment_terms},
  //        mm:{name, requisites[]}, defaults:{shipper, loading_contact, export_customs, vehicle_spec, cargo, special_conditions[]},
  //        dirFactory:{director:{full_name, name_genitive}, deputy:{full_name}}, dirMM:{director:{full_name, name_genitive}}, stamp }
  function factoryRequest(c) {
    const n = c.trucks.length;
    const local = c.kind === 'local';
    const per = c.price_uzs_minor;
    const total = per * n;
    const terms = (c.factory.payment_terms || '100%, Безналичный расчет в течении 90 рабочих дней с момента подписи заявки.')
      .replace(/\d+\s+рабочих\s+дней/, `${c.payment_days} рабочих дней`);
    const fd = c.dirFactory.director || {}, fdep = c.dirFactory.deputy, md = c.dirMM.director || {};
    const priceCell = [money(per)];
    if (!local && c.price_cur === 'USD') priceCell.push(`(в эквиваленте ${usd(c.price_minor)} $ по курсу ${rateText(c.fx_rate)})`);
    const d = doc([
      header(c.date, `к Договору №${c.factory.contract_no} от ${dmy(c.factory.contract_date)}`),
      ...title(c.number),
      { text: [
        { text: c.mm.name, bold: true }, ' (Исполнитель / ТРАНСПОРТНАЯ КОМПАНИЯ), в лице Директора ', { text: md.name_genitive || LINE, bold: true },
        ', действующего на основании устава и ', { text: c.factory.name, bold: true }, ' (ЗАКАЗЧИК), в лице Директора ', { text: fd.name_genitive || LINE, bold: true },
        ', действующего на основании Устава, заключили настоящую заявку о нижеследующем:',
      ] },
      clauses('Исполнитель / ТРАНСПОРТНАЯ КОМПАНИЯ', 'ЗАКАЗЧИК'),
      bodyTable([
        ['Грузоотправитель:', c.defaults.shipper],
        ['Адрес погрузки, контактное лицо:', c.defaults.loading_contact],
        ['Таможенное оформление экспорта:', c.defaults.export_customs],
        ['Таможенное оформление импорта:', local ? '-' : (c.route.import_customs || '-')],
        ['Адрес выгрузки, контактное лицо:', c.route.unload_address || c.route.name],
        ['Дата и время погрузки:', dmy(c.date)],
        ['Спецификация Т/С', c.defaults.vehicle_spec],
        ['Наименование груза и вес:', c.defaults.cargo],
        ['Количество Т/С:', countText(n)],
        ['Стоимость перевозки на 1 Т/С:', priceCell],
        ['Итоговая сумма:', money(total)],
        ['Форма и сроки оплаты:', terms],
        ['Гос. Номера Т/С:', (() => {
          const lines = c.trucks.map((t) => [t.tractor, t.trailer].filter(Boolean).join(' / '));
          if (lines.length <= 4) return lines;
          const half = Math.ceil(lines.length / 2);
          return [{ columns: [{ stack: lines.slice(0, half) }, { stack: lines.slice(half) }] }];
        })()],
      ]),
      ...special(c.defaults.special_conditions),
      ...signatures(
        { role: 'ЗАКАЗЧИК:', name: c.factory.name, requisites: c.factory.requisites,
          signers: [{ position: 'Директор', name: fd.full_name || '' }, ...(fdep ? [{ position: 'Заместитель директора', name: fdep.full_name }] : [])] },
        { role: 'ИСПОЛНИТЕЛЬ / ТРАНСПОРТНАЯ КОМПАНИЯ:', name: c.mm.name, requisites: c.mm.requisites,
          signers: [{ position: 'Директор', name: md.full_name || '' }] },
        c.stamp, 'right'),
    ]);
    d.info.title = `Заявка ${c.number}`;
    return d;
  }

  // ---------- заявка перевозчику (Приложение №1 к договору с перевозчиком) ----------
  // ctx: { number, date, kind, route, truck:{tractor, trailer}, price_uzs_minor, pay_days, pay_method,
  //        carrier:{name, contract_no, contract_date, director_name}, mm, defaults, dirMM, stamp }
  function carrierRequest(c) {
    const md = c.dirMM.director || {};
    const method = c.pay_method === 'cash' ? 'Наличный расчет' : 'Безналичный расчет';
    const dir = c.carrier.director_name;
    const d = doc([
      header(c.date, c.carrier.contract_no ? `к Договору №${c.carrier.contract_no}${c.carrier.contract_date ? ' от ' + dmy(c.carrier.contract_date) : ''}` : 'к Договору №________ от ________'),
      ...title(c.number),
      { text: [
        { text: c.carrier.name, bold: true }, ' (Исполнитель / ТРАНСПОРТНАЯ КОМПАНИЯ), в лице Директора ', { text: dir || '_______________', bold: true },
        ', действующего на основании ', dir ? 'Устава' : '_____________', ' и ', { text: c.mm.name, bold: true }, ' (ЗАКАЗЧИК), в лице Директора ',
        { text: md.name_genitive || LINE, bold: true }, ', действующего на основании Устава, заключили настоящую заявку о нижеследующем:',
      ] },
      clauses('Исполнитель / ТРАНСПОРТНАЯ КОМПАНИЯ', 'ЗАКАЗЧИК'),
      bodyTable([
        ['Грузоотправитель:', c.defaults.shipper],
        ['Адрес погрузки, контактное лицо:', c.defaults.carrier_loading_address || 'По месту загрузки'],
        ['Таможенное оформление экспорта:', c.defaults.export_customs],
        ['Таможенное оформление импорта:', c.kind === 'local' ? '-' : (c.route.import_customs || '-')],
        ['Адрес выгрузки, контактное лицо:', c.route.unload_address || c.route.name],
        ['Дата и время погрузки:', dmy(c.date)],
        ['Спецификация Т/С', c.defaults.vehicle_spec],
        ['Наименование груза и вес:', c.defaults.cargo],
        ['Количество Т/С:', countText(1)],
        ['Стоимость перевозки на 1 Т/С:', money(c.price_uzs_minor)],
        ['Итоговая сумма:', money(c.price_uzs_minor)],
        ['Форма и сроки оплаты:', `100%, ${method} в течении ${c.pay_days ?? 5} рабочих дней с момента подписи заявки.`],
        ['Гос. Номера Т/С:', [c.truck.tractor, c.truck.trailer].filter(Boolean).join(' / ')],
      ]),
      ...special(c.defaults.special_conditions),
      ...signatures(
        { role: 'ЗАКАЗЧИК:', name: c.mm.name, signers: [{ position: 'Директор', name: md.full_name || '' }] },
        { role: 'ИСПОЛНИТЕЛЬ / ТРАНСПОРТНАЯ КОМПАНИЯ:', name: c.carrier.name, signers: [{ position: 'Директор', name: dir || '____________' }] },
        c.stamp, 'left'),
    ]);
    d.info.title = `Заявка перевозчику ${c.number}`;
    return d;
  }

  // Несколько документов в одном PDF (каждый — с новой страницы).
  function merge(docs) {
    if (docs.length === 1) return docs[0];
    const d = { ...docs[0], content: [] };
    docs.forEach((x, i) => { if (i) d.content.push({ text: '', pageBreak: 'before' }); d.content.push(...x.content); });
    d.footer = undefined;
    return d;
  }

  const api = { numberWords, sumWords, money, countText, factoryRequest, carrierRequest, merge };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AKDocs = api;
})(typeof window !== 'undefined' ? window : globalThis);
