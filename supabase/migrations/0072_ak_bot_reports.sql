-- Блок «Ангрен Каолин» — миграция 22 (2026-11-26): бот (service role) читает итоги и
-- расчёт партнёров для команды «Отчёт» и отчётов в группу «Расчёты». Браузер к ядру
-- по-прежнему доступа не имеет (только через обёртки с проверкой ak_can_read).
grant execute on function ak_summary_core(date, date), ak_partners_core(date) to service_role;
