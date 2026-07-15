/**
 * Экспорт данных MM Transport из localStorage в JSON.
 *
 * Как использовать:
 * 1. Открыть РЕАЛЬНОЕ работающее приложение (mm_transport_v24 ...html) в браузере —
 *    то есть именно ту вкладку/машину, где лежат настоящие данные компании.
 * 2. Открыть DevTools (F12) → вкладку Console.
 * 3. Вставить содержимое этого файла целиком и нажать Enter.
 * 4. Браузер скачает файл mm_transport_export_<дата>.json — это и есть снапшот данных.
 * 5. Передать этот JSON скрипту scripts/migrate-data.mjs.
 *
 * Скрипт ничего не удаляет и не меняет в localStorage — только читает.
 */
(function () {
  const KEYS = [
    'mm_tir_types', 'mm_doz_prices', 'mm_doz_countries',
    'mm_tirs', 'mm_dozv',
    'mm_kontragenty_v2', 'mm_fleet_v2', 'mm_people_v2', 'mm_transport',
    'mm_waybills', 'mm_poa', 'mm_labor',
    'mm_finance_v2', 'mm_kassa', 'mm_kassa_init', 'mm_kassa_wallets',
    'mm_trips', 'mm_fx_rates', 'mm_trip_counter',
    'mm_maintenance', 'mm_asmaf_reg',
  ];

  const dump = { exportedAt: new Date().toISOString(), data: {} };
  const missing = [];

  KEYS.forEach((k) => {
    const raw = localStorage.getItem(k);
    if (raw === null) { missing.push(k); return; }
    try { dump.data[k] = JSON.parse(raw); }
    catch (e) { console.error('Не удалось распарсить ключ', k, e); dump.data[k] = null; }
  });

  if (missing.length) {
    console.warn('Ключи отсутствуют в localStorage (это нормально, если раздел не использовался):', missing);
  }

  const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = dump.exportedAt.slice(0, 19).replace(/[:T]/g, '-');
  a.href = url;
  a.download = `mm_transport_export_${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  console.log('Экспорт готов, файл скачан:', a.download);
  console.log('Ключей экспортировано:', Object.keys(dump.data).length);
})();
