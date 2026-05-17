import http from 'node:http';

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

function setNumber(key, value) {
    const numericValue = value === null || value === undefined ? null : Number(value);
    realData[key] = Number.isFinite(numericValue) ? numericValue : null;
}

async function seedLatestFromSupabase() {
    if (seededFromSupabase || !SUPABASE_URL || !SUPABASE_KEY) return false;
    seededFromSupabase = true;

    try {
        const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?` +
            `device_id=eq.${encodeURIComponent(DEVICE_ID)}` +
            '&select=pv_w,load_w,battery_w,grid_w,soc_percent,battery_voltage_v,pv_voltage_v,pv_current_a,jk_current_a,inverter_temp_c,mos_temp_c,output_voltage_v,output_frequency_hz,apparent_va,load_percent,cell_diff_v,daily_charge_kwh,daily_discharge_kwh,daily_pv_kwh,month_charge_kwh,month_discharge_kwh,month_pv_kwh' +
            '&order=ts.desc&limit=1';
        const response = await fetch(url, {
            headers: {
                apikey: SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
                Accept: 'application/json'
            }
        });
        if (!response.ok) throw new Error(await response.text());

        const rows = await response.json();
        const row = rows && rows[0];
        if (!row) return false;

        setNumber('pv', row.pv_w);
        setNumber('load', row.load_w);
        setNumber('bat', row.battery_w);
        setNumber('grid', row.grid_w);
        setNumber('soc', row.soc_percent);
        setNumber('battVoltage', row.battery_voltage_v);
        setNumber('pvVoltage', row.pv_voltage_v);
        setNumber('pvCurrent', row.pv_current_a);
        setNumber('jkCurrent', row.jk_current_a);
        setNumber('invTemp', row.inverter_temp_c);
        setNumber('tempMos', row.mos_temp_c);
        setNumber('outputVoltage', row.output_voltage_v);
        setNumber('freq', row.output_frequency_hz);
        setNumber('apparent', row.apparent_va);
        setNumber('loadPercent', row.load_percent);
        setNumber('cellDiff', row.cell_diff_v);
        setNumber('dailyCharge', row.daily_charge_kwh);
        setNumber('dailyDischarge', row.daily_discharge_kwh);
        setNumber('dailyPv', row.daily_pv_kwh);
        setNumber('monthCharge', row.month_charge_kwh);
        setNumber('monthDischarge', row.month_discharge_kwh);
        setNumber('monthPv', row.month_pv_kwh);

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
    const row = historySampleToRow(createHistorySample());
    try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?on_conflict=device_id,ts`, {
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
            lastSaveError = await response.text();
            console.warn('Supabase save failed:', lastSaveError);
            return;
        }

        lastSaveAt = Date.now();
        lastSaveError = null;
        console.log('Saved sample', row.ts, {pv: row.pv_w, load: row.load_w, bat: row.battery_w});
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
        const response = await fetch(EVENT_URL, {headers: {Accept: 'text/event-stream'}});
        if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`);

        connected = true;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const {done, value} = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, {stream: true});
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() || '';
            blocks.forEach(parseSseBlock);
        }
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
