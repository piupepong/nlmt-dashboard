import http from 'http';
import https from 'https';

const EVENT_URL = process.env.ESPHOME_EVENT_URL || 'https://piupepong.ddnsfree.com/events';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_TABLE = process.env.SUPABASE_TABLE || 'energy_samples';
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '')
    .trim()
    .replace(/^["']|["']$/g, '');
const DEVICE_ID = process.env.DEVICE_ID || 'nlmt-main';
const SAMPLE_INTERVAL_MS = Number(process.env.SAMPLE_INTERVAL_MS || 60000);
const PORT = Number(process.env.PORT || 3000);

const sensorMap = {
    'sensor-cong_suat_pv': 'pv',
    'sensor-cong_suat_tai': 'load',
    'sensor-can_bang_cong_suat': 'bat',
    'sensor-cong_suat_luoi': 'grid',
    'sensor-dien_ap_pv': 'pvVoltage',
    'sensor-dong_pv': 'pvCurrent',
    'sensor-dien_ap_pin_inverter': 'battVoltage',
    'sensor-jk_soc': 'soc',
    'sensor-jk_dong_pin': 'jkCurrent',
    'sensor-jk_cong_suat_pin': 'jkPower',
    'sensor-nhiet_do_inverter': 'invTemp',
    'sensor-tai_phan_tram': 'loadPercent',
    'sensor-tai_bieu_kien': 'apparent',
    'sensor-tan_so_output': 'freq',
    'sensor-jk_nhiet_do_mos': 'tempMos',
    'sensor-jk_lech_ap_cell': 'cellDiff',
    'sensor-dien_ap_output': 'outputVoltage',
    'sensor-dien_ap_luoi': 'gridVoltage',
    'sensor-pin_sac_hom_nay': 'dailyCharge',
    'sensor-pin_xa_hom_nay': 'dailyDischarge',
    'sensor-pv_hom_nay': 'dailyPv',
    'sensor-san_luong_pv_hom_nay': 'dailyPv',
    'sensor.nangluongmattroi_pin_sac_ngay': 'dailyCharge',
    'sensor.nangluongmattroi_pin_xa_ngay': 'dailyDischarge',
    'sensor.nangluongmattroi_pv_ngay': 'dailyPv',
    'sensor-pin_sac_thang': 'monthCharge',
    'sensor-pin_xa_thang': 'monthDischarge',
    'sensor-pv_thang': 'monthPv',
    'sensor-san_luong_pv_thang': 'monthPv',
    'sensor.nangluongmattroi_pin_sac_thang': 'monthCharge',
    'sensor.nangluongmattroi_pin_xa_thang': 'monthDischarge',
    'sensor.nangluongmattroi_pv_thang': 'monthPv'
};

const realData = {
    pv: null, load: null, grid: null, bat: null,
    pvVoltage: null, pvCurrent: null,
    battVoltage: null, soc: null, invTemp: null,
    loadPercent: null, freq: null, apparent: null, gridVoltage: null,
    jkCurrent: null, jkPower: null, tempMos: null, cellDiff: null,
    outputVoltage: null,
    dailyCharge: null, dailyDischarge: null, dailyPv: null,
    monthCharge: null, monthDischarge: null, monthPv: null
};

let lastEventAt = null;
let lastSaveAt = null;
let lastSaveError = null;
let connected = false;
let reconnectTimer = null;
let pendingInitialSave = false;
let saving = false;
let seededFromSupabase = false;
let lastPersistedRow = null;

function httpClientFor(url) {
    return url.protocol === 'https:' ? https : http;
}

function requestText(url, options = {}) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const body = options.body || null;
        const requestOptions = {
            method: options.method || 'GET',
            headers: {
                ...(options.headers || {})
            }
        };
        if (body && !requestOptions.headers['Content-Length']) {
            requestOptions.headers['Content-Length'] = Buffer.byteLength(body);
        }

        const req = httpClientFor(parsedUrl).request(parsedUrl, requestOptions, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                resolve({
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    status: res.statusCode,
                    statusText: res.statusMessage,
                    text
                });
            });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => {
            req.destroy(new Error('HTTP request timeout'));
        });
        if (body) req.write(body);
        req.end();
    });
}

async function requestJson(url, options = {}) {
    const response = await requestText(url, {
        ...options,
        headers: {
            Accept: 'application/json',
            ...(options.headers || {})
        }
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${response.text}`);
    return response.text ? JSON.parse(response.text) : null;
}

function normalizeSensorId(id) {
    return String(id || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/[^a-z0-9]+/g, '_');
}

function resolveSensorKey(id) {
    if (sensorMap[id]) return sensorMap[id];
    const normalized = normalizeSensorId(id);
    if (sensorMap[normalized]) return sensorMap[normalized];
    if (normalized.includes('ngay') || normalized.includes('hom_nay') || normalized.includes('homnay') || normalized.includes('today') || normalized.includes('daily')) {
        if (normalized.includes('sac') || normalized.includes('charge')) return 'dailyCharge';
        if (normalized.includes('xa') || normalized.includes('discharge')) return 'dailyDischarge';
        if (normalized.includes('pv') || normalized.includes('solar')) return 'dailyPv';
    }
    if (normalized.includes('thang') || normalized.includes('month') || normalized.includes('monthly')) {
        if (normalized.includes('sac') || normalized.includes('charge')) return 'monthCharge';
        if (normalized.includes('xa') || normalized.includes('discharge')) return 'monthDischarge';
        if (normalized.includes('pv') || normalized.includes('solar')) return 'monthPv';
    }
    return null;
}

function numberOrNull(value, digits = null) {
    if (!Number.isFinite(value)) return null;
    return digits === null ? value : Number(value.toFixed(digits));
}

function setLatestNumber(rows, key, column) {
    for (const row of rows) {
        const numericValue = row[column] === null || row[column] === undefined ? null : Number(row[column]);
        if (Number.isFinite(numericValue)) {
            realData[key] = numericValue;
            return true;
        }
    }
    return false;
}

function rowNumber(row, column) {
    const numericValue = row && row[column] !== null && row[column] !== undefined ? Number(row[column]) : null;
    return Number.isFinite(numericValue) ? numericValue : null;
}

function localDateParts(timestamp) {
    const date = new Date(timestamp + 7 * 60 * 60 * 1000);
    return {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate()
    };
}

function sameLocalDay(leftTs, rightTs) {
    const left = localDateParts(leftTs);
    const right = localDateParts(rightTs);
    return left.year === right.year && left.month === right.month && left.day === right.day;
}

function sameLocalMonth(leftTs, rightTs) {
    const left = localDateParts(leftTs);
    const right = localDateParts(rightTs);
    return left.year === right.year && left.month === right.month;
}

function latestFiniteRow(rows, column, samePeriod, currentTs) {
    for (const row of rows) {
        const rowTs = row.ts ? new Date(row.ts).getTime() : NaN;
        if (!Number.isFinite(rowTs) || !samePeriod(rowTs, currentTs)) continue;
        const value = rowNumber(row, column);
        if (Number.isFinite(value)) return value;
    }
    return null;
}

function roundedKwh(value) {
    return Number.isFinite(value) ? Number(value.toFixed(3)) : null;
}

function productionBase(row, column) {
    const value = rowNumber(row, column);
    return Number.isFinite(value) ? value : 0;
}

function applyCalculatedProduction(row, previousRow) {
    const currentTs = row.ts ? new Date(row.ts).getTime() : NaN;
    const previousTs = previousRow && previousRow.ts ? new Date(previousRow.ts).getTime() : NaN;
    if (!Number.isFinite(currentTs) || !Number.isFinite(previousTs) || currentTs <= previousTs) return row;

    const hours = Math.min((currentTs - previousTs) / 3600000, 0.25);
    if (hours <= 0) return row;

    const pvW = rowNumber(row, 'pv_w');
    const batteryW = rowNumber(row, 'battery_w');
    const pvDelta = Number.isFinite(pvW) && pvW > 0 ? pvW * hours / 1000 : 0;
    const chargeDelta = Number.isFinite(batteryW) && batteryW > 0 ? batteryW * hours / 1000 : 0;
    const dischargeDelta = Number.isFinite(batteryW) && batteryW < 0 ? Math.abs(batteryW) * hours / 1000 : 0;

    const sameDay = sameLocalDay(previousTs, currentTs);
    const sameMonth = sameLocalMonth(previousTs, currentTs);

    const previousDailyPv = sameDay ? productionBase(previousRow, 'daily_pv_kwh') : 0;
    const previousDailyCharge = sameDay ? productionBase(previousRow, 'daily_charge_kwh') : 0;
    const previousDailyDischarge = sameDay ? productionBase(previousRow, 'daily_discharge_kwh') : 0;
    const previousMonthPv = sameMonth ? productionBase(previousRow, 'month_pv_kwh') : 0;
    const previousMonthCharge = sameMonth ? productionBase(previousRow, 'month_charge_kwh') : 0;
    const previousMonthDischarge = sameMonth ? productionBase(previousRow, 'month_discharge_kwh') : 0;

    if (Number.isFinite(previousDailyPv)) row.daily_pv_kwh = roundedKwh(previousDailyPv + pvDelta);
    if (Number.isFinite(previousDailyCharge)) row.daily_charge_kwh = roundedKwh(previousDailyCharge + chargeDelta);
    if (Number.isFinite(previousDailyDischarge)) row.daily_discharge_kwh = roundedKwh(previousDailyDischarge + dischargeDelta);
    if (Number.isFinite(previousMonthPv)) row.month_pv_kwh = roundedKwh(previousMonthPv + pvDelta);
    if (Number.isFinite(previousMonthCharge)) row.month_charge_kwh = roundedKwh(previousMonthCharge + chargeDelta);
    if (Number.isFinite(previousMonthDischarge)) row.month_discharge_kwh = roundedKwh(previousMonthDischarge + dischargeDelta);

    return row;
}

function omitNullValues(row) {
    return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null && value !== undefined));
}

async function seedLatestFromSupabase() {
    if (seededFromSupabase || !SUPABASE_URL || !SUPABASE_KEY) return false;
    seededFromSupabase = true;

    try {
        const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?` +
            `device_id=eq.${encodeURIComponent(DEVICE_ID)}` +
            '&select=ts,pv_w,load_w,battery_w,grid_w,soc_percent,battery_voltage_v,pv_voltage_v,pv_current_a,jk_current_a,inverter_temp_c,mos_temp_c,output_voltage_v,output_frequency_hz,apparent_va,load_percent,cell_diff_v,daily_charge_kwh,daily_discharge_kwh,daily_pv_kwh,month_charge_kwh,month_discharge_kwh,month_pv_kwh' +
            '&order=ts.desc&limit=500';
        const rows = await requestJson(url, {
            headers: {
                apikey: SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
                Accept: 'application/json'
            }
        });
        if (!rows || !rows.length) return false;
        lastPersistedRow = rows[0];

        setLatestNumber(rows, 'pv', 'pv_w');
        setLatestNumber(rows, 'load', 'load_w');
        setLatestNumber(rows, 'bat', 'battery_w');
        setLatestNumber(rows, 'grid', 'grid_w');
        setLatestNumber(rows, 'soc', 'soc_percent');
        setLatestNumber(rows, 'battVoltage', 'battery_voltage_v');
        setLatestNumber(rows, 'pvVoltage', 'pv_voltage_v');
        setLatestNumber(rows, 'pvCurrent', 'pv_current_a');
        setLatestNumber(rows, 'jkCurrent', 'jk_current_a');
        setLatestNumber(rows, 'invTemp', 'inverter_temp_c');
        setLatestNumber(rows, 'tempMos', 'mos_temp_c');
        setLatestNumber(rows, 'outputVoltage', 'output_voltage_v');
        setLatestNumber(rows, 'freq', 'output_frequency_hz');
        setLatestNumber(rows, 'apparent', 'apparent_va');
        setLatestNumber(rows, 'loadPercent', 'load_percent');
        setLatestNumber(rows, 'cellDiff', 'cell_diff_v');
        const now = Date.now();
        realData.dailyCharge = latestFiniteRow(rows, 'daily_charge_kwh', sameLocalDay, now);
        realData.dailyDischarge = latestFiniteRow(rows, 'daily_discharge_kwh', sameLocalDay, now);
        realData.dailyPv = latestFiniteRow(rows, 'daily_pv_kwh', sameLocalDay, now);
        realData.monthCharge = latestFiniteRow(rows, 'month_charge_kwh', sameLocalMonth, now);
        realData.monthDischarge = latestFiniteRow(rows, 'month_discharge_kwh', sameLocalMonth, now);
        realData.monthPv = latestFiniteRow(rows, 'month_pv_kwh', sameLocalMonth, now);

        if (Number.isFinite(realData.dailyCharge)) lastPersistedRow.daily_charge_kwh = realData.dailyCharge;
        if (Number.isFinite(realData.dailyDischarge)) lastPersistedRow.daily_discharge_kwh = realData.dailyDischarge;
        if (Number.isFinite(realData.dailyPv)) lastPersistedRow.daily_pv_kwh = realData.dailyPv;
        if (Number.isFinite(realData.monthCharge)) lastPersistedRow.month_charge_kwh = realData.monthCharge;
        if (Number.isFinite(realData.monthDischarge)) lastPersistedRow.month_discharge_kwh = realData.monthDischarge;
        if (Number.isFinite(realData.monthPv)) lastPersistedRow.month_pv_kwh = realData.monthPv;

        console.log('Seeded latest Supabase row for unchanged sensors');
        return true;
    } catch (err) {
        lastSaveError = `Seed latest failed: ${err.message}`;
        console.warn(lastSaveError);
        return false;
    }
}

function hasRealtimeData() {
    return ['pv', 'load', 'bat', 'grid', 'soc', 'battVoltage', 'invTemp', 'tempMos'].some(key => Number.isFinite(realData[key]));
}

function createHistorySample() {
    const ts = Math.floor(Date.now() / SAMPLE_INTERVAL_MS) * SAMPLE_INTERVAL_MS;
    return {
        ts,
        pv: Number.isFinite(realData.pv) ? Math.round(realData.pv) : null,
        load: Number.isFinite(realData.load) ? Math.round(realData.load) : null,
        bat: Number.isFinite(realData.bat) ? Math.round(realData.bat) : null,
        grid: Number.isFinite(realData.grid) ? Math.round(realData.grid) : null,
        soc: numberOrNull(realData.soc, 1),
        voltage: numberOrNull(realData.battVoltage, 1),
        invTemp: numberOrNull(realData.invTemp, 1),
        mosTemp: numberOrNull(realData.tempMos, 1)
    };
}

function historySampleToRow(sample) {
    return {
        device_id: DEVICE_ID,
        ts: new Date(sample.ts).toISOString(),
        pv_w: sample.pv,
        load_w: sample.load,
        battery_w: sample.bat,
        grid_w: sample.grid,
        soc_percent: sample.soc,
        battery_voltage_v: sample.voltage,
        pv_voltage_v: numberOrNull(realData.pvVoltage, 1),
        pv_current_a: numberOrNull(realData.pvCurrent, 1),
        jk_current_a: numberOrNull(realData.jkCurrent, 1),
        inverter_temp_c: sample.invTemp,
        mos_temp_c: sample.mosTemp,
        output_voltage_v: numberOrNull(realData.outputVoltage, 1),
        output_frequency_hz: numberOrNull(realData.freq, 1),
        apparent_va: numberOrNull(realData.apparent, 0),
        load_percent: numberOrNull(realData.loadPercent, 0),
        cell_diff_v: numberOrNull(realData.cellDiff, 3),
        daily_charge_kwh: numberOrNull(realData.dailyCharge, 2),
        daily_discharge_kwh: numberOrNull(realData.dailyDischarge, 2),
        daily_pv_kwh: numberOrNull(realData.dailyPv, 2),
        month_charge_kwh: numberOrNull(realData.monthCharge, 2),
        month_discharge_kwh: numberOrNull(realData.monthDischarge, 2),
        month_pv_kwh: numberOrNull(realData.monthPv, 2)
    };
}

async function saveSampleToSupabase() {
    if (saving) return;
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        lastSaveError = 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY';
        return;
    }
    await seedLatestFromSupabase();
    if (!hasRealtimeData()) return;

    saving = true;
    const fullRow = applyCalculatedProduction(historySampleToRow(createHistorySample()), lastPersistedRow);
    const row = omitNullValues(fullRow);
    try {
        const response = await requestText(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?on_conflict=device_id,ts`, {
            method: 'POST',
            headers: {
                apikey: SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json',
                Prefer: 'resolution=merge-duplicates'
            },
            body: JSON.stringify(row)
        });

        if (!response.ok) {
            lastSaveError = response.text;
            console.warn('Supabase save failed:', lastSaveError);
            return;
        }

        lastSaveAt = Date.now();
        lastPersistedRow = {...(lastPersistedRow || {}), ...row};
        lastSaveError = null;
        console.log('Saved sample', row.ts, {pv: row.pv_w, load: row.load_w, bat: row.battery_w, pvKwh: row.daily_pv_kwh});
    } finally {
        saving = false;
    }
}

function scheduleInitialSave() {
    if (pendingInitialSave || lastSaveAt || !hasRealtimeData()) return;
    pendingInitialSave = true;
    setTimeout(async () => {
        pendingInitialSave = false;
        await saveSampleToSupabase();
    }, 2500);
}

function handleSseEvent(type, data) {
    if (type && type !== 'state') return;
    try {
        const event = JSON.parse(data);
        const raw = event.value !== undefined ? event.value : (event.state === 'ON' ? 1 : event.state);
        const key = resolveSensorKey(event.id || event.entity_id);
        if (!key) return;
        const numericValue = parseFloat(raw);
        realData[key] = Number.isFinite(numericValue) ? numericValue : null;
        connected = true;
        lastEventAt = Date.now();
        scheduleInitialSave();
    } catch (err) {
        console.warn('Bad SSE event:', err.message);
    }
}

function parseSseBlock(block) {
    let type = 'message';
    const data = [];
    block.split(/\r?\n/).forEach(line => {
        if (line.startsWith('event:')) type = line.slice(6).trim();
        if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    });
    if (data.length) handleSseEvent(type, data.join('\n'));
}

function scheduleReconnect() {
    connected = false;
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectEvents();
    }, 5000);
}

async function connectEvents() {
    try {
        console.log('Connecting ESPHome SSE:', EVENT_URL);
        await new Promise((resolve, reject) => {
            const parsedUrl = new URL(EVENT_URL);
            const req = httpClientFor(parsedUrl).request(parsedUrl, {
                method: 'GET',
                headers: {Accept: 'text/event-stream'}
            }, res => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`SSE HTTP ${res.statusCode}`));
                    res.resume();
                    return;
                }

                connected = true;
                let buffer = '';
                res.setEncoding('utf8');
                res.on('data', chunk => {
                    buffer += chunk;
                    const blocks = buffer.split(/\r?\n\r?\n/);
                    buffer = blocks.pop() || '';
                    blocks.forEach(parseSseBlock);
                });
                res.on('end', resolve);
                res.on('error', reject);
            });
            req.on('error', reject);
            req.end();
        });
    } catch (err) {
        console.warn('ESPHome SSE disconnected:', err.message);
    } finally {
        scheduleReconnect();
    }
}

http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({
        ok: true,
        connected,
        lastEventAt,
        lastSaveAt,
        lastSaveError,
        deviceId: DEVICE_ID
    }));
}).listen(PORT, () => {
    console.log(`Health server listening on ${PORT}`);
});

connectEvents();
setInterval(saveSampleToSupabase, SAMPLE_INTERVAL_MS);
