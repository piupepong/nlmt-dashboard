import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const HA_BASE_URL = process.env.HA_BASE_URL || 'http://192.168.1.76:8123';
const HA_TOKEN = (process.env.HA_TOKEN || '').trim();
const DEVICE_ID = process.env.DEVICE_ID || 'nlmt-main';
const START = process.env.HA_EXPORT_START || '1970-01-01T00:00:00.000Z';
const END = process.env.HA_EXPORT_END || new Date().toISOString();
const OUT_DIR = process.env.HA_EXPORT_DIR || 'exports';

if (!HA_TOKEN) {
    console.error('Missing HA_TOKEN environment variable.');
    process.exit(1);
}

const columns = [
    'device_id',
    'ts',
    'pv_w',
    'load_w',
    'battery_w',
    'grid_w',
    'soc_percent',
    'battery_voltage_v',
    'pv_voltage_v',
    'pv_current_a',
    'jk_current_a',
    'inverter_temp_c',
    'mos_temp_c',
    'output_voltage_v',
    'output_frequency_hz',
    'apparent_va',
    'load_percent',
    'cell_diff_v',
    'daily_charge_kwh',
    'daily_discharge_kwh',
    'daily_pv_kwh',
    'month_charge_kwh',
    'month_discharge_kwh',
    'month_pv_kwh'
];

const keyToColumn = {
    pv: 'pv_w',
    load: 'load_w',
    bat: 'battery_w',
    jkPower: 'battery_w',
    grid: 'grid_w',
    soc: 'soc_percent',
    battVoltage: 'battery_voltage_v',
    pvVoltage: 'pv_voltage_v',
    pvCurrent: 'pv_current_a',
    jkCurrent: 'jk_current_a',
    invTemp: 'inverter_temp_c',
    tempMos: 'mos_temp_c',
    outputVoltage: 'output_voltage_v',
    freq: 'output_frequency_hz',
    apparent: 'apparent_va',
    loadPercent: 'load_percent',
    cellDiff: 'cell_diff_v',
    dailyCharge: 'daily_charge_kwh',
    dailyDischarge: 'daily_discharge_kwh',
    dailyPv: 'daily_pv_kwh',
    monthCharge: 'month_charge_kwh',
    monthDischarge: 'month_discharge_kwh',
    monthPv: 'month_pv_kwh'
};

const exactMap = {
    'sensor.nangluongmattroi_cong_suat_pv': 'pv',
    'sensor.nangluongmattroi_cong_suat_tai': 'load',
    'sensor.nangluongmattroi_can_bang_cong_suat': 'bat',
    'sensor.nangluongmattroi_jk_cong_suat_pin': 'jkPower',
    'sensor.nangluongmattroi_cong_suat_luoi': 'grid',
    'sensor.nangluongmattroi_dien_ap_pv': 'pvVoltage',
    'sensor.nangluongmattroi_dong_pv': 'pvCurrent',
    'sensor.nangluongmattroi_dien_ap_pin_inverter': 'battVoltage',
    'sensor.nangluongmattroi_jk_soc': 'soc',
    'sensor.nangluongmattroi_jk_dong_pin': 'jkCurrent',
    'sensor.nangluongmattroi_nhiet_do_inverter': 'invTemp',
    'sensor.nangluongmattroi_tai_phan_tram': 'loadPercent',
    'sensor.nangluongmattroi_tai_bieu_kien': 'apparent',
    'sensor.nangluongmattroi_tan_so_output': 'freq',
    'sensor.nangluongmattroi_jk_nhiet_do_mos': 'tempMos',
    'sensor.nangluongmattroi_jk_nhiet_do_1': 'tempMos',
    'sensor.nangluongmattroi_jk_nhiet_do_2': 'tempMos',
    'sensor.nangluongmattroi_jk_lech_ap_cell': 'cellDiff',
    'sensor.nangluongmattroi_dien_ap_output': 'outputVoltage',
    'sensor.nangluongmattroi_pin_sac_ngay': 'dailyCharge',
    'sensor.nangluongmattroi_pin_xa_ngay': 'dailyDischarge',
    'sensor.nangluongmattroi_pv_ngay': 'dailyPv',
    'sensor.nangluongmattroi_pin_sac_thang': 'monthCharge',
    'sensor.nangluongmattroi_pin_xa_thang': 'monthDischarge',
    'sensor.nangluongmattroi_pv_thang': 'monthPv'
};

function normalize(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/[^a-z0-9]+/g, '_');
}

function resolveKey(state) {
    if (exactMap[state.entity_id]) return exactMap[state.entity_id];
    const text = normalize(`${state.entity_id} ${state.attributes?.friendly_name || ''}`);
    if (text.includes('cong_suat_pv') || text.includes('pv_power')) return 'pv';
    if (text.includes('cong_suat_tai') || text.includes('load_power')) return 'load';
    if (text.includes('can_bang_cong_suat')) return 'bat';
    if (text.includes('jk_cong_suat_pin')) return 'jkPower';
    if (text.includes('cong_suat_luoi') || text.includes('grid_power')) return 'grid';
    if (text.includes('dien_ap_pv') || text.includes('pv_voltage')) return 'pvVoltage';
    if (text.includes('dong_pv') || text.includes('pv_current')) return 'pvCurrent';
    if (text.includes('dien_ap_pin') || text.includes('battery_voltage')) return 'battVoltage';
    if (text.includes('jk_soc') || text.endsWith('_soc')) return 'soc';
    if (text.includes('jk_dong_pin') || text.includes('battery_current')) return 'jkCurrent';
    if (text.includes('nhiet_do_inverter') || text.includes('inverter_temp')) return 'invTemp';
    if (text.includes('jk_nhiet_do_mos') || text.includes('jk_nhiet_do_1') || text.includes('jk_nhiet_do_2') || text.includes('mos_temp')) return 'tempMos';
    if (text.includes('tai_phan_tram') || text.includes('load_percent')) return 'loadPercent';
    if (text.includes('tai_bieu_kien') || text.includes('apparent')) return 'apparent';
    if (text.includes('tan_so_output') || text.includes('output_frequency')) return 'freq';
    if (text.includes('lech_ap_cell') || text.includes('cell_diff')) return 'cellDiff';
    if (text.includes('dien_ap_output') || text.includes('output_voltage')) return 'outputVoltage';
    if ((text.includes('pin_sac') || text.includes('charge')) && (text.includes('ngay') || text.includes('hom_nay') || text.includes('daily'))) return 'dailyCharge';
    if ((text.includes('pin_xa') || text.includes('discharge')) && (text.includes('ngay') || text.includes('hom_nay') || text.includes('daily'))) return 'dailyDischarge';
    if (text.includes('pv') && (text.includes('ngay') || text.includes('hom_nay') || text.includes('daily'))) return 'dailyPv';
    if ((text.includes('pin_sac') || text.includes('charge')) && (text.includes('thang') || text.includes('month'))) return 'monthCharge';
    if ((text.includes('pin_xa') || text.includes('discharge')) && (text.includes('thang') || text.includes('month'))) return 'monthDischarge';
    if (text.includes('pv') && (text.includes('thang') || text.includes('month'))) return 'monthPv';
    return null;
}

function scoreState(state, key) {
    const unit = String(state.attributes?.unit_of_measurement || '').toLowerCase();
    const id = state.entity_id;
    let score = exactMap[id] === key ? 100 : 0;
    if (id.includes('nangluongmattroi')) score += 20;
    if (['dailyCharge', 'dailyDischarge', 'dailyPv', 'monthCharge', 'monthDischarge', 'monthPv'].includes(key) && unit.includes('kwh')) score += 30;
    if (['pv', 'load', 'bat', 'jkPower', 'grid'].includes(key) && unit === 'w') score += 30;
    if (['soc', 'loadPercent'].includes(key) && unit === '%') score += 20;
    if (['battVoltage', 'pvVoltage', 'outputVoltage'].includes(key) && unit === 'v') score += 20;
    if (['pvCurrent', 'jkCurrent'].includes(key) && unit === 'a') score += 20;
    return score;
}

async function haFetch(url) {
    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${HA_TOKEN}`,
            Accept: 'application/json'
        }
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
    return response.json();
}

function numericState(entry) {
    const value = Number.parseFloat(entry.state);
    return Number.isFinite(value) ? value : null;
}

function normalizeValue(value, sensor) {
    const unit = String(sensor.unit || '').toLowerCase();
    if ((sensor.column === 'inverter_temp_c' || sensor.column === 'mos_temp_c') && unit.includes('f')) {
        return (value - 32) * 5 / 9;
    }
    return value;
}

function minuteMs(timestamp) {
    const date = new Date(timestamp);
    date.setUTCSeconds(0, 0);
    return date.getTime();
}

function emptyRow() {
    return Object.fromEntries(columns.map(column => [column, null]));
}

function csvCell(value) {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows) {
    return [columns, ...rows.map(row => columns.map(column => csvCell(row[column])))].map(row => row.join(',')).join('\n');
}

const states = await haFetch(`${HA_BASE_URL}/api/states`);
const candidates = [];
for (const state of states) {
    if (!state.entity_id?.startsWith('sensor.')) continue;
    const key = resolveKey(state);
    if (!key || !keyToColumn[key]) continue;
    candidates.push({
        entity_id: state.entity_id,
        key,
        column: keyToColumn[key],
        friendly_name: state.attributes?.friendly_name || '',
        unit: state.attributes?.unit_of_measurement || '',
        score: scoreState(state, key)
    });
}

const byKey = new Map();
for (const candidate of candidates) {
    const current = byKey.get(candidate.key);
    if (!current || candidate.score > current.score) byKey.set(candidate.key, candidate);
}

const keyPriority = {
    bat: 100,
    jkPower: 50
};

const byColumn = new Map();
for (const candidate of byKey.values()) {
    const current = byColumn.get(candidate.column);
    const candidatePriority = keyPriority[candidate.key] || 75;
    const currentPriority = current ? (keyPriority[current.key] || 75) : -1;
    if (!current || candidatePriority > currentPriority || (candidatePriority === currentPriority && candidate.score > current.score)) {
        byColumn.set(candidate.column, candidate);
    }
}

const selected = [...byColumn.values()].sort((a, b) => a.key.localeCompare(b.key));
if (!selected.length) throw new Error('No matching dashboard sensors found in Home Assistant states.');

const url = new URL(`${HA_BASE_URL}/api/history/period/${encodeURIComponent(START)}`);
url.searchParams.set('end_time', END);
url.searchParams.set('filter_entity_id', selected.map(item => item.entity_id).join(','));
url.searchParams.set('minimal_response', '');

console.log(`Selected ${selected.length} sensors.`);
console.log(selected.map(item => `${item.key} <= ${item.entity_id} (${item.unit || 'no unit'})`).join('\n'));
console.log(`Fetching Home Assistant history from ${START} to ${END} ...`);

const history = await haFetch(url);
const events = [];

for (const entityHistory of history) {
    for (const entry of entityHistory) {
        const entityId = entry.entity_id || entityHistory[0]?.entity_id;
        const selectedSensor = selected.find(item => item.entity_id === entityId);
        if (!selectedSensor) continue;
        const value = numericState(entry);
        if (value === null) continue;
        const timestamp = new Date(entry.last_changed || entry.last_updated).getTime();
        if (!Number.isFinite(timestamp)) continue;
        events.push({
            ts: timestamp,
            entity_id: entityId,
            key: selectedSensor.key,
            column: selectedSensor.column,
            value: normalizeValue(value, selectedSensor)
        });
    }
}

events.sort((a, b) => a.ts - b.ts);
if (!events.length) throw new Error('No numeric history found for selected sensors.');

const rows = [];
const latest = {};
let eventIndex = 0;
const firstMinute = minuteMs(events[0].ts);
const lastMinute = minuteMs(events[events.length - 1].ts);

for (let cursor = firstMinute; cursor <= lastMinute; cursor += 60000) {
    while (eventIndex < events.length && events[eventIndex].ts < cursor + 60000) {
        const event = events[eventIndex];
        latest[event.column] = Number(event.value.toFixed(3));
        eventIndex += 1;
    }

    const row = emptyRow();
    row.device_id = DEVICE_ID;
    row.ts = new Date(cursor).toISOString();
    for (const [column, value] of Object.entries(latest)) {
        row[column] = value;
    }
    rows.push(row);
}
await mkdir(OUT_DIR, {recursive: true});

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const csvPath = path.join(OUT_DIR, `ha-energy-samples-${stamp}.csv`);
const jsonPath = path.join(OUT_DIR, `ha-energy-samples-${stamp}.json`);
const sensorsPath = path.join(OUT_DIR, `ha-selected-sensors-${stamp}.json`);

await writeFile(csvPath, toCsv(rows), 'utf8');
await writeFile(jsonPath, JSON.stringify(rows, null, 2), 'utf8');
await writeFile(sensorsPath, JSON.stringify(selected, null, 2), 'utf8');

console.log(`Events: ${events.length}`);
console.log(`Rows: ${rows.length}`);
console.log(`CSV: ${csvPath}`);
console.log(`JSON: ${jsonPath}`);
console.log(`Sensors: ${sensorsPath}`);
