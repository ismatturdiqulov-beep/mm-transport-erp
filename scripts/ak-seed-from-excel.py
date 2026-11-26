"""Блок «Ангрен Каолин»: стартовые справочники из Excel 6-й партии → SQL.

    python -I scripts/ak-seed-from-excel.py "Angren_kaolin/<файл>.xlsm" Angren_kaolin/ak_seed.sql Angren_kaolin/ak_seed_rules.json

Сам скрипт данных не содержит (репозиторий публичный): названия фирм и номера для
особых правил лежат в ak_seed_rules.json, результат — реальные ИНН, телефоны,
договоры — пишется в Angren_kaolin/ (всё закрыто в .gitignore).

ak_seed_rules.json:
  skip_carriers  — записи «ДАННЫЕ», которые не перевозчики (не переносятся);
  own_carrier    — название нашей фирмы: её машины помечаются is_own;
  fixed_uzs      — фирмы, у которых цена фиксируется в сумах;
  forced_owner   — {госномер тягача: фирма} — настоящий владелец, когда в Excel
                   рейс записан на другую фирму (например, при оплате наличными).

Остальные правила (согласованы с владельцем 2026-11-26):
  * перевозчики — лист «ДАННЫЕ», B:G; повторы объединяются по ИНН (без ИНН — по
    названию), договор берётся последний по дате, контакты/телефоны склеиваются;
    колонки статусов (H, J, L, R) не переносятся — ими давно не пользуются;
  * маршруты — «ДАННЫЕ», N:P, все (кроме безымянной «Керамика»), «Стерлимак» →
    «Стерлитамак»; *керамика — местные, остальные — международные;
  * машины — из листа «ЗАЯВКИ (ПЕРЕВОЗЧИКИ)»: тягач / прицеп → фирма с даты первого
    рейса у этой фирмы.
Запуск повторно безопасен: всё вставляется через on conflict do nothing / проверку.
"""
import datetime
import json
import re
import sys
import warnings

import openpyxl

warnings.filterwarnings('ignore')

with open(sys.argv[3], encoding='utf-8') as _f:
    _rules = json.load(_f)
SKIP_CARRIERS = set(_rules.get('skip_carriers', []))
OWN_NAME = _rules.get('own_carrier')
FIXED_UZS = set(_rules.get('fixed_uzs', []))
FORCED_OWNER = _rules.get('forced_owner', {})
CYR = str.maketrans('АВЕКМНОРСТУХ', 'ABEKMHOPCTYX')


def norm_plate(p):
    return re.sub(r'[\s\-.]', '', str(p).upper()).translate(CYR)


def clean(v):
    if v is None:
        return None
    s = re.sub(r'\s+', ' ', str(v).replace('\xa0', ' ')).strip()
    return s or None


def phone(v):
    s = clean(v)
    if not s:
        return None
    parts = [re.sub(r'\D', '', x) for x in s.split('/')]
    out = []
    for d in parts:
        if len(d) == 9:
            out.append(f'+998 {d[:2]} {d[2:5]} {d[5:7]} {d[7:]}')
        elif d:
            out.append(d)
    return ' / '.join(out) or None


def q(v):
    if v is None:
        return 'null'
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, (datetime.date, datetime.datetime)):
        return "'" + v.strftime('%Y-%m-%d') + "'"
    return "'" + str(v).replace("'", "''") + "'"


def main(src, dst):
    wb = openpyxl.load_workbook(src, data_only=True)
    data = wb['ДАННЫЕ']
    trips = wb['ЗАЯВКИ (ПЕРЕВОЗЧИКИ)']

    # ---------- перевозчики ----------
    carriers = {}  # key → dict
    order = []
    for r in range(3, data.max_row + 1):
        name = clean(data.cell(r, 2).value)
        if not name or name in SKIP_CARRIERS:
            continue
        inn = clean(data.cell(r, 3).value)
        if inn and not re.fullmatch(r'\d{9}|\d{14}', inn):
            inn = None
        key = inn or name.upper()
        c = carriers.get(key)
        if c is None:
            c = carriers[key] = dict(name=name, inn=inn, phones=[], contacts=[], contract_no=None, contract_date=None)
            order.append(key)
        ph = phone(data.cell(r, 4).value)
        ct = clean(data.cell(r, 5).value)
        for p in (ph.split(' / ') if ph else []):
            if p not in c['phones']:
                c['phones'].append(p)
        if ct and ct not in c['contacts']:
            c['contacts'].append(ct)
        no = clean(data.cell(r, 6).value)
        dt = data.cell(r, 7).value
        if no in ('0', None):
            no = None
        if isinstance(dt, datetime.datetime) and no:
            if c['contract_date'] is None or dt.date() >= c['contract_date']:
                c['contract_no'], c['contract_date'] = no, dt.date()
        elif no and not c['contract_no']:
            c['contract_no'] = no

    # ---------- маршруты (N:P) ----------
    routes = []
    for r in range(3, 19):
        name = clean(data.cell(r, 14).value)
        if not name or name in ('Керамика', 'Маршруты'):
            continue
        if name == 'Стерлимак':
            name = 'Стерлитамак'
        name = name[0].upper() + name[1:]
        cust = clean(data.cell(r, 15).value)
        unload = clean(data.cell(r, 16).value)
        local = 'керамика' in name.lower()
        code = None
        if cust:
            m = re.search(r'\b(\d{8})\b', cust)
            code = m.group(1) if m else None
        routes.append(dict(name=name, kind='local' if local else 'international',
                           customs=None if local else cust, code=None if local else code,
                           unload=unload or (name if local else None)))

    # ---------- машины ----------
    owners = {}   # (plate_norm) → list[(date, carrier_name)]
    kinds = {}
    display = {}
    for r in range(4, trips.max_row + 1):
        plates = clean(trips.cell(r, 5).value)
        carrier = clean(trips.cell(r, 7).value)
        d = trips.cell(r, 4).value
        if not plates or not carrier or not isinstance(d, datetime.datetime):
            continue
        parts = [p.strip() for p in plates.split('/')]
        tractor = parts[0]
        trailer = parts[1] if len(parts) > 1 else None
        for kind, p in (('tractor', tractor), ('trailer', trailer)):
            if not p or len(norm_plate(p)) < 3 or (kind == 'trailer' and len(norm_plate(p)) < 5):
                continue
            n = norm_plate(p)
            owner = FORCED_OWNER.get(norm_plate(tractor), carrier)
            kinds[n] = kind
            display.setdefault(n, n)
            hist = owners.setdefault(n, [])
            if not hist or hist[-1][1] != owner:
                if owner not in [h[1] for h in hist]:
                    hist.append((d.date(), owner))

    name_by_carrier = {c['name']: c for c in carriers.values()}
    lines = ['-- Сгенерировано scripts/ak-seed-from-excel.py — РЕАЛЬНЫЕ ДАННЫЕ, не коммитить.',
             'begin;']
    for key in order:
        c = carriers[key]
        is_own = c['name'] == OWN_NAME
        lines.append(
            'insert into ak_carriers (name, inn, phone, contact_person, contract_no, contract_date, contract_status, '
            'price_fixed_uzs, is_own) select '
            f"{q(c['name'])}, {q(c['inn'])}, {q(' / '.join(c['phones']) or None)}, {q(', '.join(c['contacts']) or None)}, "
            f"{q(c['contract_no'])}, {q(c['contract_date'])}, {q('signed' if c['contract_no'] else 'none')}, "
            f"{q(c['name'] in FIXED_UZS)}, {q(is_own)} "
            f"where not exists (select 1 from ak_carriers where {'inn = ' + q(c['inn']) if c['inn'] else 'upper(name) = ' + q(c['name'].upper())});")
    for rt in routes:
        lines.append(
            'insert into ak_routes (name, kind, unload_address, import_customs_code, import_customs) values '
            f"({q(rt['name'])}, {q(rt['kind'])}, {q(rt['unload'])}, {q(rt['code'])}, {q(rt['customs'])}) "
            'on conflict do nothing;')
    missing = set()
    for n, hist in owners.items():
        lines.append(f"insert into ak_vehicles (kind, plate) values ({q(kinds[n])}, {q(display[n])}) on conflict do nothing;")
        for d, cname in hist:
            if cname not in name_by_carrier:
                missing.add(cname)
                continue
            c = name_by_carrier[cname]
            cond = f"inn = {q(c['inn'])}" if c['inn'] else f"upper(name) = {q(c['name'].upper())}"
            lines.append(
                'insert into ak_vehicle_owners (vehicle_id, carrier_id, valid_from) select v.id, c.id, '
                f"{q(d)} from ak_vehicles v, ak_carriers c where v.plate_norm = {q(n)} and c.{cond} "
                'on conflict do nothing;')
    lines.append('commit;')
    with open(dst, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
    print(f'carriers={len(order)} routes={len(routes)} vehicles={len(owners)} '
          f'owner_links={sum(len(h) for h in owners.values())}')
    if missing:
        print('НЕТ В СПРАВОЧНИКЕ (связи пропущены):', ', '.join(sorted(missing)))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
