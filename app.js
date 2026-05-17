// Dashboard only reads Supabase. Armbian worker is responsible for collecting
// ESPHome data and writing samples to the database.
const SUPABASE_CONFIG = window.SUPABASE_CONFIG || {};
const SUPABASE_TABLE = SUPABASE_CONFIG.table || 'energy_samples';
const DEVICE_ID = SUPABASE_CONFIG.deviceId || 'nlmt-main';
const THEME_STORAGE_KEY = 'nlmt-theme-v1';
const THEME_AUTO_STORAGE_KEY = 'nlmt-theme-auto-v1';
let supabaseClient = null;
let supabaseReady = false;
let isLoadingRemoteHistory = false;
let espConnected = false;
let lastEventAt = null;
let lastSupabaseSyncAt = null;
let supabaseStatus = 'disabled';
let supabaseRealtimeChannel = null;
let selectedRangePreset = '24h';

let realData = {
    pv: null, load: null, grid: null, bat: null,
    pvVoltage: null, pvCurrent: null,
    battVoltage: null, soc: null, invTemp: null,
    loadPercent: null, freq: null, apparent: null, gridVoltage: null,
    jkCurrent: null, jkPower: null, tempMos: null, cellDiff: null,
    outputVoltage: null,
    dailyCharge: null, dailyDischarge: null, dailyPv: null,
    monthCharge: null, monthDischarge: null, monthPv: null
};

let estimatedProduction = {
    dailyCharge: null, dailyDischarge: null, dailyPv: null,
    monthCharge: null, monthDischarge: null, monthPv: null
};

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

function valueOrZero(value) {
    return Number.isFinite(value) ? value : 0;
}

function numberOrNull(value, digits = null) {
    if (!Number.isFinite(value)) return null;
    return digits === null ? value : Number(value.toFixed(digits));
}

function formatValue(value, digits = 0) {
    if (!Number.isFinite(value)) return '--';
    return digits > 0 ? value.toFixed(digits) : Math.round(value).toString();
}

function productionValue(key) {
    return Number.isFinite(realData[key]) ? realData[key] : estimatedProduction[key];
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.innerText = value;
}

function setHtml(id, value) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = value;
}

function isNightTime(date = new Date()) {
    const hour = date.getHours();
    return hour >= 18 || hour < 6;
}

function savedThemeChoice() {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === 'dark' || value === 'light' ? value : null;
}

function isThemeAutoEnabled() {
    return localStorage.getItem(THEME_AUTO_STORAGE_KEY) !== 'false';
}

function currentTheme() {
    return isThemeAutoEnabled() ? (isNightTime() ? 'dark' : 'light') : (savedThemeChoice() || 'light');
}

function applyTheme(theme = currentTheme()) {
    document.body.classList.toggle('theme-dark', theme === 'dark');
    document.body.classList.toggle('theme-light', theme !== 'dark');
    document.querySelectorAll('.theme-option').forEach(button => {
        button.classList.toggle('active', button.dataset.themeChoice === theme);
    });
    const auto = document.getElementById('themeAuto');
    if (auto) auto.checked = isThemeAutoEnabled();
    updateChartTheme();
}

function setupThemeControls() {
    document.querySelectorAll('.theme-option').forEach(button => {
        button.addEventListener('click', () => {
            localStorage.setItem(THEME_STORAGE_KEY, button.dataset.themeChoice);
            localStorage.setItem(THEME_AUTO_STORAGE_KEY, 'false');
            applyTheme(button.dataset.themeChoice);
        });
    });

    const auto = document.getElementById('themeAuto');
    if (auto) {
        auto.addEventListener('change', () => {
            localStorage.setItem(THEME_AUTO_STORAGE_KEY, auto.checked ? 'true' : 'false');
            applyTheme(currentTheme());
        });
    }

    applyTheme();
    setInterval(() => {
        if (isThemeAutoEnabled()) applyTheme();
    }, 5 * 60 * 1000);
}

function chartTheme() {
    const dark = document.body.classList.contains('theme-dark');
    return {
        text: dark ? '#bfe8df' : '#476864',
        strong: dark ? '#e8fff8' : '#365f59',
        grid: dark ? 'rgba(177, 231, 222, 0.12)' : 'rgba(36, 74, 69, 0.1)',
        gridSoft: dark ? 'rgba(177, 231, 222, 0.08)' : 'rgba(36, 74, 69, 0.08)',
        tooltipBg: dark ? 'rgba(4, 13, 19, 0.9)' : 'rgba(20, 62, 56, 0.82)'
    };
}

function updateChartTheme() {
    if (typeof Chart === 'undefined') return;
    const theme = chartTheme();
    Chart.defaults.color = theme.text;
    Chart.defaults.borderColor = theme.grid;
    [dailyChart, monthlyChart, livePowerChart, powerMixChart, batteryTrendChart, temperatureChart]
        .filter(Boolean)
        .forEach(chart => {
            if (chart.options.plugins?.legend?.labels) chart.options.plugins.legend.labels.color = theme.strong;
            if (chart.options.plugins?.tooltip) chart.options.plugins.tooltip.backgroundColor = theme.tooltipBg;
            Object.values(chart.options.scales || {}).forEach(scale => {
                if (scale?.ticks) scale.ticks.color = theme.text;
                if (scale?.grid) scale.grid.color = theme.grid;
            });
            chart.update('none');
        });
}

function formatClock(timestamp) {
    if (!timestamp) return '--';
    return new Date(timestamp).toLocaleString('vi-VN', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

function setStatusDot(id, state) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('ok', 'bad', 'neutral');
    if (state) el.classList.add(state);
}

function updateSystemStatus() {
    setStatusDot('espStatusDot', espConnected ? 'ok' : 'bad');
    setText('espStatusText', espConnected ? `Online - ${formatClock(lastEventAt)}` : 'Mất kết nối');

    if (supabaseStatus === 'ok') {
        setStatusDot('supabaseStatusDot', 'ok');
        setText('supabaseStatusText', `Đã đồng bộ - ${formatClock(lastSupabaseSyncAt)}`);
    } else if (supabaseStatus === 'error') {
        setStatusDot('supabaseStatusDot', 'bad');
        setText('supabaseStatusText', 'Lỗi đồng bộ');
    } else if (supabaseStatus === 'loading') {
        setStatusDot('supabaseStatusDot', 'neutral');
        setText('supabaseStatusText', 'Đang tải lịch sử');
    } else {
        setStatusDot('supabaseStatusDot', 'neutral');
        setText('supabaseStatusText', 'Chưa cấu hình');
    }

    const latest = historySamples.length ? historySamples[historySamples.length - 1].ts : null;
    setText('lastSampleText', latest ? formatClock(latest) : '--');
}

function finiteValues(samples, key) {
    return samples.map(sample => sample[key]).filter(Number.isFinite);
}

function maxValue(values) {
    return values.length ? Math.max(...values) : null;
}

function minValue(values) {
    return values.length ? Math.min(...values) : null;
}

function avgValue(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function estimateGridEnergy(samples) {
    if (samples.length < 2) return {offsetKwh: null, surplusKwh: null, netKwh: null};
    let offsetWh = 0;
    let surplusWh = 0;
    for (let i = 0; i < samples.length - 1; i++) {
        const current = samples[i];
        const next = samples[i + 1];
        if (!Number.isFinite(current.grid) || !Number.isFinite(next.ts) || !Number.isFinite(current.ts)) continue;
        const hours = Math.min(Math.max((next.ts - current.ts) / 3600000, 0), 0.25);
        const watts = Math.abs(current.grid);
        if (current.grid > 0) offsetWh += watts * hours;
        if (current.grid < 0) surplusWh += watts * hours;
    }
    const offsetKwh = offsetWh / 1000;
    const surplusKwh = surplusWh / 1000;
    return {
        offsetKwh,
        surplusKwh,
        netKwh: offsetKwh - surplusKwh
    };
}

function updateInsights() {
    const samples = getChartHistory();
    const pvValues = finiteValues(samples, 'pv');
    const loadValues = finiteValues(samples, 'load');
    const socValues = finiteValues(samples, 'soc');
    const tempValues = finiteValues(samples, 'invTemp').concat(finiteValues(samples, 'mosTemp'));
    const pvSum = pvValues.reduce((sum, value) => sum + Math.max(0, value), 0);
    const loadSum = loadValues.reduce((sum, value) => sum + Math.max(0, value), 0);
    const selfUse = pvSum > 0 ? Math.min(100, loadSum / pvSum * 100) : null;
    const gridEnergy = estimateGridEnergy(samples);

    setText('selfUseRate', Number.isFinite(selfUse) ? selfUse.toFixed(0) : '--');
    setText('peakLoad', formatValue(maxValue(loadValues)));
    setText('peakPv', formatValue(maxValue(pvValues)));
    setText('minSoc', formatValue(minValue(socValues)));
    setText('maxTemp', formatValue(maxValue(tempValues), 1));
    setText('gridImportKwh', Number.isFinite(gridEnergy.offsetKwh) ? gridEnergy.offsetKwh.toFixed(2) : '--');
    setText('gridExportKwh', Number.isFinite(gridEnergy.surplusKwh) ? gridEnergy.surplusKwh.toFixed(2) : '--');
    setText('gridOffsetKwh', Number.isFinite(gridEnergy.netKwh) ? gridEnergy.netKwh.toFixed(2) : '--');
    updateAlerts(samples);
}

function makeAlert(text, type = 'ok') {
    return `<div class="alert-item ${type}">${text}</div>`;
}

function updateAlerts(samples = getChartHistory()) {
    const alerts = [];
    const soc = realData.soc;
    const invTemp = realData.invTemp;
    const mosTemp = realData.tempMos;
    const loadPercent = realData.loadPercent;
    const cellDiff = realData.cellDiff;
    const load = realData.load;
    const peakLoad = maxValue(finiteValues(samples, 'load'));
    const avgInvTemp = avgValue(finiteValues(samples, 'invTemp'));

    if (Number.isFinite(soc) && soc <= 20) alerts.push(makeAlert(`SOC thấp: ${soc.toFixed(0)}%`, 'danger'));
    if (Number.isFinite(invTemp) && invTemp >= 60) alerts.push(makeAlert(`Inverter nóng: ${invTemp.toFixed(1)} °C`, 'danger'));
    if (Number.isFinite(mosTemp) && mosTemp >= 60) alerts.push(makeAlert(`MOS nóng: ${mosTemp.toFixed(1)} °C`, 'danger'));
    if (Number.isFinite(loadPercent) && loadPercent >= 85) alerts.push(makeAlert(`Tải cao: ${loadPercent.toFixed(0)}%`, 'warning'));
    if (Number.isFinite(cellDiff) && cellDiff >= 0.08) alerts.push(makeAlert(`Lệch cell cao: ${cellDiff.toFixed(3)} V`, 'warning'));
    if (Number.isFinite(load) && Number.isFinite(peakLoad) && load >= peakLoad * 0.95 && peakLoad > 200) alerts.push(makeAlert('Tải hiện tại gần mức đỉnh trong khoảng đang xem', 'warning'));
    if (Number.isFinite(avgInvTemp) && avgInvTemp >= 50) alerts.push(makeAlert(`Nhiệt inverter trung bình cao: ${avgInvTemp.toFixed(1)} °C`, 'warning'));
    if (!alerts.length) alerts.push(makeAlert('Hệ thống trong ngưỡng theo dõi hiện tại', 'ok'));
    setHtml('alertList', alerts.join(''));
}

function statusBadge(text, state = 'neutral') {
    return `<span class="attention-badge ${state}">${text}</span>`;
}

function statusFromRange(value, warning, danger, reverse = false) {
    if (!Number.isFinite(value)) return {state: 'neutral', text: 'Chờ dữ liệu'};
    if (reverse) {
        if (value <= danger) return {state: 'danger', text: 'Nguy hiểm'};
        if (value <= warning) return {state: 'warning', text: 'Cần chú ý'};
        return {state: 'ok', text: 'Ổn định'};
    }
    if (value >= danger) return {state: 'danger', text: 'Nguy hiểm'};
    if (value >= warning) return {state: 'warning', text: 'Cần chú ý'};
    return {state: 'ok', text: 'Ổn định'};
}

function attentionRow(group, value, status) {
    return `<tr><td>${group}</td><td>${value}</td><td>${statusBadge(status.text, status.state)}</td></tr>`;
}

function updateOperationMonitor() {
    const pv = realData.pv;
    const load = realData.load;
    const soc = realData.soc;
    const invTemp = realData.invTemp;
    const mosTemp = realData.tempMos;
    const loadPercent = realData.loadPercent;
    const cellDiff = realData.cellDiff;
    const outputVoltage = realData.outputVoltage;
    const freq = realData.freq;
    const pvLoadRatio = Number.isFinite(pv) && Number.isFinite(load) && load > 0 ? pv / load * 100 : null;
    const maxTemp = maxValue([invTemp, mosTemp].filter(Number.isFinite));

    const pvStatus = !Number.isFinite(pvLoadRatio)
        ? {state: 'neutral', text: 'Chờ dữ liệu'}
        : pvLoadRatio >= 75 ? {state: 'ok', text: 'PV gánh tải tốt'}
        : pvLoadRatio >= 25 ? {state: 'warning', text: 'PV hỗ trợ một phần'}
        : {state: 'neutral', text: 'PV thấp'};

    const socStatus = statusFromRange(soc, 30, 20, true);
    const tempStatus = statusFromRange(maxTemp, 50, 60);
    const loadStatus = statusFromRange(loadPercent, 75, 90);
    const cellStatus = statusFromRange(cellDiff, 0.04, 0.08);
    const outputOk = Number.isFinite(outputVoltage) && outputVoltage >= 210 && outputVoltage <= 240 && Number.isFinite(freq) && freq >= 49 && freq <= 51;
    const outputStatus = !Number.isFinite(outputVoltage) || !Number.isFinite(freq)
        ? {state: 'neutral', text: 'Chờ dữ liệu'}
        : outputOk ? {state: 'ok', text: 'AC ổn định'}
        : {state: 'warning', text: 'Ngoài dải chuẩn'};

    setHtml('attentionTableBody', [
        attentionRow('PV / Tải', `${formatValue(pv)} W / ${formatValue(load)} W (${formatValue(pvLoadRatio)}%)`, pvStatus),
        attentionRow('Pin', `SOC ${formatValue(soc)}%, lệch cell ${formatValue(cellDiff, 3)} V`, cellStatus.state === 'ok' ? socStatus : cellStatus),
        attentionRow('Inverter', `Tải ${formatValue(loadPercent)}%, nhiệt ${formatValue(maxTemp, 1)} °C`, loadStatus.state === 'ok' ? tempStatus : loadStatus),
        attentionRow('AC Output', `${formatValue(outputVoltage, 1)} V, ${formatValue(freq, 1)} Hz`, outputStatus)
    ].join(''));

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

// ========== 1. CẬP NHẬT THẺ NỔI ==========
function updateFloatingCards() {
    setText('pvPowerFloat', formatValue(realData.pv));
    setText('pvVoltageFloat', formatValue(realData.pvVoltage, 1));
    setText('pvCurrentFloat', formatValue(realData.pvCurrent, 1));
    setText('loadPowerFloat', formatValue(realData.load));
    setText('loadPercentFloat', formatValue(realData.loadPercent));
    setText('pvMetaFloat', Number.isFinite(realData.pv) && realData.pv > 20 ? 'Đang phát' : 'Chờ nắng');
    setText('loadMetaFloat', Number.isFinite(realData.apparent) ? `${formatValue(realData.apparent)} VA` : 'Theo tải');

    let gridPower = valueOrZero(realData.grid);
    let gridSpan = document.getElementById('gridPowerFloat');
    let gridDirSpan = document.getElementById('gridDirectionFloat');
    gridSpan.innerText = Number.isFinite(realData.grid) ? Math.abs(Math.round(gridPower)) : '--';
    if (!Number.isFinite(realData.grid)) {
        gridSpan.style.color = '#fff2cf';
        gridDirSpan.innerHTML = 'Chờ dữ liệu';
    } else if (gridPower > 0) {
        gridSpan.style.color = '#8db5ff';
        gridDirSpan.innerHTML = '⚡ Bù lưới';
    } else if (gridPower < 0) {
        gridSpan.style.color = '#e67e22';
        gridDirSpan.innerHTML = 'Dư lưới';
    } else {
        gridSpan.style.color = '#fff2cf';
        gridDirSpan.innerHTML = '⚡ Độc lập';
    }
    setText('gridMetaFloat', `${formatValue(realData.gridVoltage, 1)} V`);

    let battAbs = Math.abs(valueOrZero(realData.bat));
    setText('battPowerFloat', Number.isFinite(realData.bat) ? Math.round(battAbs) : '--');
    setHtml('battSOCFloat', `SOC ${formatValue(realData.soc)}%`);
    let arrowSpan = document.getElementById('battArrowFloat');
    if (!Number.isFinite(realData.bat)) {
        arrowSpan.innerHTML = 'Chờ dữ liệu';
        arrowSpan.style.color = '#cfe6df';
    } else if (realData.bat > 15) {
        arrowSpan.innerHTML = '⬆️ Sạc';
        arrowSpan.style.color = '#2ecc71';
    } else if (realData.bat < -15) {
        arrowSpan.innerHTML = '⬇️ Xả';
        arrowSpan.style.color = '#e67e22';
    } else {
        arrowSpan.innerHTML = '⚖️ Cân bằng';
        arrowSpan.style.color = '#ccc';
    }
    setText('battMetaFloat', `${formatValue(realData.battVoltage, 1)} V`);

    setText('invTempFloat', formatValue(realData.invTemp, 1));
    setText('invFreqFloat', formatValue(realData.freq, 1));
    setText('invOutputFloat', formatValue(realData.outputVoltage, 1));
    setText('invMetaFloat', Number.isFinite(realData.loadPercent) ? `Tải ${formatValue(realData.loadPercent)}%` : 'Nhiệt độ');
}

function updateOtherUI() {
    setText('socVal', formatValue(realData.soc));
    setText('voltageVal', formatValue(realData.battVoltage, 1));
    setText('currentVal', formatValue(realData.jkCurrent, 1));
    setText('tempMosVal', formatValue(realData.tempMos, 1));
    setHtml('battPowerDetail', formatValue(realData.bat));
    setHtml('lechAp', formatValue(realData.cellDiff, 3));
    setHtml('invPv', formatValue(realData.pv));
    setHtml('invPvV', formatValue(realData.pvVoltage, 1));
    setHtml('invPvA', formatValue(realData.pvCurrent, 1));
    setHtml('invLoad', formatValue(realData.load));
    setHtml('invGrid', formatValue(realData.grid));
    setHtml('loadPercent', formatValue(realData.loadPercent));
    setHtml('invTemp', formatValue(realData.invTemp, 1));
    setHtml('dailyCharge', formatValue(productionValue('dailyCharge'), 2));
    setHtml('dailyDischarge', formatValue(productionValue('dailyDischarge'), 2));
    setHtml('dailyPv', formatValue(productionValue('dailyPv'), 2));
    setHtml('monthCharge', formatValue(productionValue('monthCharge'), 2));
    setHtml('monthDischarge', formatValue(productionValue('monthDischarge'), 2));
    setHtml('monthPv', formatValue(productionValue('monthPv'), 2));
    setHtml('tblPv', `${formatValue(realData.pv)} W`);
    setHtml('tblLoad', `${formatValue(realData.load)} W`);
    setHtml('tblPvV', `${formatValue(realData.pvVoltage, 1)} V`);
    setHtml('tblApparent', `${formatValue(realData.apparent)} VA`);
    setHtml('tblPvA', `${formatValue(realData.pvCurrent, 1)} A`);
    setHtml('tblFreq', `${formatValue(realData.freq, 1)} Hz`);
    setHtml('tblGrid', `${formatValue(realData.grid)} W`);
    setHtml('tblGridV', `${formatValue(realData.gridVoltage, 1)} V`);
    setHtml('tblBattV', `${formatValue(realData.battVoltage, 1)} V`);
    setHtml('tblTempInv', `${formatValue(realData.invTemp, 1)} °C`);
    setHtml('tblSoc', `${formatValue(realData.soc)} %`);
    setHtml('tblBattA', `${formatValue(realData.jkCurrent, 1)} A`);
}

// ========== 2. ANIMATION FLOW ==========
const canvas = document.getElementById('energyFlowCanvas');
let ctx = canvas.getContext('2d');
let width = 900, height = 360;
let nodes = {};  // Khởi tạo rỗng, sẽ gán sau
let particles = [];
let pulse = 0;

function resizeFlow() {
    const container = canvas.parentElement;
    width = container.clientWidth;
    height = window.innerWidth <= 860 ? 520 : 210;
    if (window.innerWidth <= 560) height = 540;
    canvas.width = width;
    canvas.height = height;
    updateNodeCoords();
    repositionCards();
}
window.addEventListener('resize', resizeFlow);

function updateNodeCoords() {
    if (width <= 620) {
        nodes = {
            pv: {x: width * 0.28, y: height * 0.18, label: 'PV', color: '#f5b64a'},
            grid: {x: width * 0.72, y: height * 0.18, label: 'Bù lưới', color: '#8db5ff'},
            inverter: {x: width * 0.5, y: height * 0.46, label: 'Inverter', color: '#ffffff'},
            load: {x: width * 0.28, y: height * 0.78, label: 'Tải', color: '#78dce3'},
            battery: {x: width * 0.72, y: height * 0.78, label: 'Pin', color: '#78c9b5'}
        };
    } else {
        nodes = {
            pv: {x: width * 0.14, y: height * 0.35, label: 'PV', color: '#f5b64a'},
            grid: {x: width * 0.86, y: height * 0.35, label: 'Bù lưới', color: '#8db5ff'},
            load: {x: width * 0.25, y: height * 0.72, label: 'Tải', color: '#78dce3'},
            battery: {x: width * 0.75, y: height * 0.72, label: 'Pin', color: '#78c9b5'},
            inverter: {x: width * 0.5, y: height * 0.45, label: 'Inverter', color: '#ffffff'}
        };
    }
}

function placeCard(id, x, y) {
    const card = document.getElementById(id);
    if (!card) return;
    const cardWidth = card.offsetWidth || (width <= 620 ? 100 : 128);
    const cardHeight = card.offsetHeight || 88;
    const left = Math.max(8, Math.min(width - cardWidth - 8, x - cardWidth / 2));
    const top = Math.max(8, Math.min(height - cardHeight - 8, y - cardHeight / 2));
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
}

function repositionCards() {
    if (!nodes.pv) return;
    placeCard('cardPV', nodes.pv.x, nodes.pv.y);
    placeCard('cardLoad', nodes.load.x, nodes.load.y);
    placeCard('cardGrid', nodes.grid.x, nodes.grid.y);
    placeCard('cardBatt', nodes.battery.x, nodes.battery.y);
    placeCard('cardInverter', nodes.inverter.x, nodes.inverter.y);
}

const flowLinks = [
    {from:'pv', to:'inverter', key:'pv', color:'#f5b64a', liftDesktop:-80, liftMobile:-42},
    {from:'inverter', to:'load', key:'load', color:'#78dce3', liftDesktop:-80, liftMobile:-42},
    {from:'inverter', to:'battery', key:'batCharge', color:'#78c9b5', liftDesktop:70, liftMobile:42},
    {from:'battery', to:'inverter', key:'batDischarge', color:'#78c9b5', liftDesktop:70, liftMobile:42},
    {from:'grid', to:'inverter', key:'gridOffset', color:'#8db5ff', liftDesktop:-24, liftMobile:-42},
    {from:'inverter', to:'grid', key:'gridSurplus', color:'#f5b64a', liftDesktop:-24, liftMobile:-42}
];

function linkLift(link) {
    return width <= 620 ? link.liftMobile : link.liftDesktop;
}

function linkIsActive(key) {
    if (key === 'pv') return realData.pv > 20;
    if (key === 'load') return realData.load > 20;
    if (key === 'batCharge') return realData.bat > 15;
    if (key === 'batDischarge') return realData.bat < -15;
    if (key === 'gridOffset') return realData.grid > 20;
    if (key === 'gridSurplus') return realData.grid < -20;
    return false;
}

function linkPower(key) {
    if (key === 'pv') return Math.abs(realData.pv);
    if (key === 'load') return Math.abs(realData.load);
    if (key === 'batCharge' || key === 'batDischarge') return Math.abs(realData.bat);
    if (key === 'gridOffset' || key === 'gridSurplus') return Math.abs(realData.grid);
    return 0;
}

function pointOnCurve(from, to, lift, t) {
    const cx = (from.x + to.x) / 2;
    const cy = (from.y + to.y) / 2 + lift;
    const x = (1 - t) * (1 - t) * from.x + 2 * (1 - t) * t * cx + t * t * to.x;
    const y = (1 - t) * (1 - t) * from.y + 2 * (1 - t) * t * cy + t * t * to.y;
    return {x, y};
}

function drawCurve(link, active) {
    const from = nodes[link.from], to = nodes[link.to];
    const lift = linkLift(link);
    const cx = (from.x + to.x) / 2;
    const cy = (from.y + to.y) / 2 + lift;
    const gradient = ctx.createLinearGradient(from.x, from.y, to.x, to.y);
    gradient.addColorStop(0, active ? link.color : 'rgba(71, 104, 100, 0.18)');
    gradient.addColorStop(1, active ? 'rgba(255,255,255,0.72)' : 'rgba(255,255,255,0.24)');

    ctx.save();
    ctx.lineCap = 'round';
    ctx.shadowColor = active ? link.color : 'transparent';
    ctx.shadowBlur = active ? 18 : 0;
    ctx.strokeStyle = gradient;
    ctx.lineWidth = active ? Math.min(8, 3 + linkPower(link.key) / 180) : 2;
    ctx.globalAlpha = active ? 0.78 : 0.32;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.quadraticCurveTo(cx, cy, to.x, to.y);
    ctx.stroke();
    ctx.restore();
}

function drawNode(node, active) {
    const radius = active ? 26 + Math.sin(pulse) * 2 : 21;
    const glow = ctx.createRadialGradient(node.x, node.y, 4, node.x, node.y, radius * 2.4);
    glow.addColorStop(0, active ? node.color : 'rgba(255,255,255,0.72)');
    glow.addColorStop(0.38, active ? `${node.color}55` : 'rgba(255,255,255,0.18)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.save();
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius * 2.4, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowColor = active ? node.color : 'rgba(255,255,255,0.5)';
    ctx.shadowBlur = active ? 20 : 8;
    ctx.fillStyle = active ? 'rgba(255,255,255,0.52)' : 'rgba(255,255,255,0.32)';
    ctx.strokeStyle = 'rgba(255,255,255,0.74)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
}

function addFlows() {
    if (!nodes.pv) return;
    flowLinks.forEach(link => {
        if (!linkIsActive(link.key)) return;
        const chance = Math.min(0.55, 0.16 + linkPower(link.key) / 1300);
        if (Math.random() < chance) {
            particles.push({
                ...link,
                t: 0,
                speed: 0.009 + Math.min(0.018, linkPower(link.key) / 45000),
                size: 4 + Math.min(5, linkPower(link.key) / 220)
            });
        }
    });
    if (particles.length > 140) particles = particles.slice(-110);
}
setInterval(addFlows, 350);

function drawFlow() {
    if (!ctx || !nodes.pv) {
        requestAnimationFrame(drawFlow);
        return;
    }
    pulse += 0.035;
    ctx.clearRect(0,0,width,height);

    ctx.save();
    ctx.globalAlpha = 0.28;
    ctx.strokeStyle = 'rgba(255,255,255,0.38)';
    ctx.lineWidth = 1;
    for (let x = 48; x < width; x += 96) {
        ctx.beginPath();
        ctx.moveTo(x, 28);
        ctx.lineTo(x, height - 28);
        ctx.stroke();
    }
    for (let y = 48; y < height; y += 84) {
        ctx.beginPath();
        ctx.moveTo(28, y);
        ctx.lineTo(width - 28, y);
        ctx.stroke();
    }
    ctx.restore();

    flowLinks.forEach(link => drawCurve(link, linkIsActive(link.key)));
    
    for(let i=0;i<particles.length;i++){
        let p=particles[i]; p.t+=p.speed;
        if(p.t>=1){ particles.splice(i,1); i--; continue; }
        let from=nodes[p.from], to=nodes[p.to];
        let pos = pointOnCurve(from, to, linkLift(p), p.t);
        ctx.beginPath(); ctx.arc(pos.x,pos.y,p.size,0,2*Math.PI);
        ctx.shadowColor = 'rgba(245, 182, 74, 0.68)';
        ctx.shadowBlur = 16;
        ctx.fillStyle = p.color;
        ctx.fill();
    }

    Object.entries(nodes).forEach(([key, node]) => {
        const active = flowLinks.some(link => (link.from === key || link.to === key) && linkIsActive(link.key));
        drawNode(node, active);
    });

    ctx.shadowBlur = 0;
    requestAnimationFrame(drawFlow);
}

// Khởi tạo animation
resizeFlow();
drawFlow();

// ========== 3. BIỂU ĐỒ ==========
let dailyChart, monthlyChart, livePowerChart, powerMixChart, batteryTrendChart, temperatureChart;
let lastHistoryAt = 0;
const HISTORY_STORAGE_KEY = 'nlmt-history-v1';
const HISTORY_SAMPLE_INTERVAL = 60 * 1000;
const HISTORY_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_CHART_POINTS = 1200;
let historySamples = loadHistory();
let selectedRange = {from: Date.now() - 24 * 60 * 60 * 1000, to: null};

function initSupabase() {
    if (!SUPABASE_CONFIG.url || !SUPABASE_CONFIG.anonKey || !window.supabase) {
        console.info('Supabase disabled: missing url/anonKey or client library.');
        supabaseStatus = 'disabled';
        updateSystemStatus();
        return;
    }
    supabaseClient = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
    supabaseReady = true;
    supabaseStatus = 'loading';
    updateSystemStatus();
}

function glassChartOptions(extra = {}) {
    const theme = chartTheme();
    return {
        responsive: true,
        maintainAspectRatio: true,
        interaction: {mode: 'index', intersect: false},
        plugins: {
            legend: {
                labels: {
                    boxWidth: 32,
                    useBorderRadius: true,
                    borderRadius: 4,
                    color: theme.strong,
                    font: {weight: 700}
                }
            },
            tooltip: {
                backgroundColor: theme.tooltipBg,
                borderColor: 'rgba(255,255,255,0.5)',
                borderWidth: 1,
                padding: 12,
                titleColor: '#fff7d6',
                bodyColor: '#e9fffb'
            }
        },
        scales: {
            x: {grid: {color: theme.gridSoft}, ticks: {color: theme.text}},
            y: {grid: {color: theme.grid}, ticks: {color: theme.text}}
        },
        ...extra
    };
}

function padTimePart(value) {
    return String(value).padStart(2, '0');
}

function formatDateTimeLocal(timestamp) {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${padTimePart(date.getMonth() + 1)}-${padTimePart(date.getDate())}T${padTimePart(date.getHours())}:${padTimePart(date.getMinutes())}`;
}

function formatTimestampWithLocalOffset(timestamp) {
    const date = new Date(timestamp);
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const absOffset = Math.abs(offsetMinutes);
    return `${date.getFullYear()}-${padTimePart(date.getMonth() + 1)}-${padTimePart(date.getDate())}` +
        `T${padTimePart(date.getHours())}:${padTimePart(date.getMinutes())}:${padTimePart(date.getSeconds())}` +
        `${sign}${padTimePart(Math.floor(absOffset / 60))}:${padTimePart(absOffset % 60)}`;
}

function loadHistory() {
    try {
        const parsed = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) || '[]');
        if (!Array.isArray(parsed)) return [];
        const cutoff = Date.now() - HISTORY_RETENTION_MS;
        return parsed.filter(sample => Number.isFinite(sample.ts) && sample.ts >= cutoff);
    } catch (err) {
        return [];
    }
}

function saveHistory() {
    const cutoff = Date.now() - HISTORY_RETENTION_MS;
    historySamples = historySamples.filter(sample => sample.ts >= cutoff);
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(historySamples));
}

function hasRealtimeData() {
    return ['pv', 'load', 'bat', 'soc', 'battVoltage', 'invTemp', 'tempMos'].some(key => Number.isFinite(realData[key]));
}

function createHistorySample() {
    const ts = Math.floor(Date.now() / HISTORY_SAMPLE_INTERVAL) * HISTORY_SAMPLE_INTERVAL;
    return {
        ts,
        pv: Number.isFinite(realData.pv) ? Math.round(realData.pv) : null,
        load: Number.isFinite(realData.load) ? Math.round(realData.load) : null,
        bat: Number.isFinite(realData.bat) ? Math.round(realData.bat) : null,
        grid: Number.isFinite(realData.grid) ? Math.round(realData.grid) : null,
        soc: Number.isFinite(realData.soc) ? Number(realData.soc.toFixed(1)) : null,
        voltage: Number.isFinite(realData.battVoltage) ? Number(realData.battVoltage.toFixed(1)) : null,
        invTemp: Number.isFinite(realData.invTemp) ? Number(realData.invTemp.toFixed(1)) : null,
        mosTemp: Number.isFinite(realData.tempMos) ? Number(realData.tempMos.toFixed(1)) : null
    };
}

function historySampleToRow(sample) {
    return {
        device_id: DEVICE_ID,
        ts: formatTimestampWithLocalOffset(sample.ts),
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
        daily_charge_kwh: numberOrNull(productionValue('dailyCharge'), 2),
        daily_discharge_kwh: numberOrNull(productionValue('dailyDischarge'), 2),
        daily_pv_kwh: numberOrNull(productionValue('dailyPv'), 2),
        month_charge_kwh: numberOrNull(productionValue('monthCharge'), 2),
        month_discharge_kwh: numberOrNull(productionValue('monthDischarge'), 2),
        month_pv_kwh: numberOrNull(productionValue('monthPv'), 2)
    };
}

function rowToHistorySample(row) {
    return {
        ts: new Date(row.ts).getTime(),
        pv: row.pv_w === null ? null : Number(row.pv_w),
        load: row.load_w === null ? null : Number(row.load_w),
        bat: row.battery_w === null ? null : Number(row.battery_w),
        grid: row.grid_w === null ? null : Number(row.grid_w),
        soc: row.soc_percent === null ? null : Number(row.soc_percent),
        voltage: row.battery_voltage_v === null ? null : Number(row.battery_voltage_v),
        invTemp: row.inverter_temp_c === null ? null : Number(row.inverter_temp_c),
        mosTemp: row.mos_temp_c === null ? null : Number(row.mos_temp_c)
    };
}

function applyRowNumber(key, value) {
    if (value === null || value === undefined) return;
    const numericValue = Number(value);
    if (Number.isFinite(numericValue)) realData[key] = numericValue;
}

function applyRealtimeRow(row) {
    applyRowNumber('pv', row.pv_w);
    applyRowNumber('load', row.load_w);
    applyRowNumber('bat', row.battery_w);
    applyRowNumber('grid', row.grid_w);
    applyRowNumber('soc', row.soc_percent);
    applyRowNumber('battVoltage', row.battery_voltage_v);
    applyRowNumber('pvVoltage', row.pv_voltage_v);
    applyRowNumber('pvCurrent', row.pv_current_a);
    applyRowNumber('jkCurrent', row.jk_current_a);
    applyRowNumber('invTemp', row.inverter_temp_c);
    applyRowNumber('tempMos', row.mos_temp_c);
    applyRowNumber('outputVoltage', row.output_voltage_v);
    applyRowNumber('freq', row.output_frequency_hz);
    applyRowNumber('apparent', row.apparent_va);
    applyRowNumber('loadPercent', row.load_percent);
    applyRowNumber('cellDiff', row.cell_diff_v);
    applyRowNumber('dailyCharge', row.daily_charge_kwh);
    applyRowNumber('dailyDischarge', row.daily_discharge_kwh);
    applyRowNumber('dailyPv', row.daily_pv_kwh);
    applyRowNumber('monthCharge', row.month_charge_kwh);
    applyRowNumber('monthDischarge', row.month_discharge_kwh);
    applyRowNumber('monthPv', row.month_pv_kwh);

    const sample = rowToHistorySample(row);
    if (Number.isFinite(sample.ts)) {
        historySamples = historySamples.filter(item => item.ts !== sample.ts);
        historySamples.push(sample);
        historySamples.sort((a, b) => a.ts - b.ts);
        saveHistory();
        if (selectedRangePreset && selectedRangePreset !== 'custom') {
            const nextRange = rangeFromPreset(selectedRangePreset);
            selectedRange = {from: nextRange.from, to: nextRange.to || null};
            setRangeInputs(selectedRange, nextRange.label);
        }
    }
    applyEstimatedProduction(historySamples);

    espConnected = true;
    lastEventAt = Number.isFinite(sample.ts) ? sample.ts : Date.now();
    lastSupabaseSyncAt = Date.now();
    supabaseStatus = 'ok';

    updateFloatingCards();
    updateOtherUI();
    updateCharts({skipHistoryPush: true});
}

function startOfLocalDay(timestamp = Date.now()) {
    const date = new Date(timestamp);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
}

function startOfLocalMonth(timestamp = Date.now()) {
    const date = new Date(timestamp);
    date.setDate(1);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
}

function latestFinite(rows, column, from = null) {
    for (let i = rows.length - 1; i >= 0; i--) {
        if (Number.isFinite(from) && new Date(rows[i].ts).getTime() < from) continue;
        const value = Number(rows[i][column]);
        if (Number.isFinite(value)) return value;
    }
    return null;
}

function roundKwh(value) {
    return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}

function estimateProductionFromSamples(samples, from, to) {
    const sorted = samples
        .filter(sample => Number.isFinite(sample.ts))
        .sort((a, b) => a.ts - b.ts);
    if (sorted.length < 2) {
        return {charge: null, discharge: null, pv: null};
    }

    let chargeWh = 0;
    let dischargeWh = 0;
    let pvWh = 0;

    for (let i = 0; i < sorted.length - 1; i++) {
        const current = sorted[i];
        const next = sorted[i + 1];
        const segmentStart = Math.max(current.ts, from);
        const segmentEnd = Math.min(next.ts, to);
        if (segmentEnd <= segmentStart) continue;

        const hours = Math.min((segmentEnd - segmentStart) / 3600000, 0.25);
        if (Number.isFinite(current.bat)) {
            if (current.bat > 0) chargeWh += current.bat * hours;
            if (current.bat < 0) dischargeWh += Math.abs(current.bat) * hours;
        }
        if (Number.isFinite(current.pv) && current.pv > 0) {
            pvWh += current.pv * hours;
        }
    }

    return {
        charge: roundKwh(chargeWh / 1000),
        discharge: roundKwh(dischargeWh / 1000),
        pv: roundKwh(pvWh / 1000)
    };
}

function applyEstimatedProduction(samples, rows = []) {
    const now = Date.now();
    const todayStart = startOfLocalDay(now);
    const monthStart = startOfLocalMonth(now);
    const todayTotals = estimateProductionFromSamples(samples, todayStart, now);
    const monthTotals = estimateProductionFromSamples(samples, monthStart, now);

    estimatedProduction = {
        dailyCharge: latestFinite(rows, 'daily_charge_kwh', todayStart) ?? todayTotals.charge,
        dailyDischarge: latestFinite(rows, 'daily_discharge_kwh', todayStart) ?? todayTotals.discharge,
        dailyPv: latestFinite(rows, 'daily_pv_kwh', todayStart) ?? todayTotals.pv,
        monthCharge: latestFinite(rows, 'month_charge_kwh') ?? monthTotals.charge,
        monthDischarge: latestFinite(rows, 'month_discharge_kwh') ?? monthTotals.discharge,
        monthPv: latestFinite(rows, 'month_pv_kwh') ?? monthTotals.pv
    };
}

async function loadHistoryFromSupabase() {
    if (!supabaseReady || !supabaseClient || isLoadingRemoteHistory) return false;
    isLoadingRemoteHistory = true;
    supabaseStatus = 'loading';
    updateSystemStatus();
    try {
        const now = Date.now();
        const from = Number.isFinite(selectedRange.from) ? selectedRange.from : null;
        const to = selectedRange.to || now;
        const pageSize = 1000;
        const rows = [];

        for (let offset = 0; offset < 100000; offset += pageSize) {
            let query = supabaseClient
                .from(SUPABASE_TABLE)
                .select('ts,pv_w,load_w,battery_w,grid_w,soc_percent,battery_voltage_v,inverter_temp_c,mos_temp_c')
                .eq('device_id', DEVICE_ID)
                .lte('ts', new Date(to).toISOString())
                .order('ts', { ascending: true })
                .range(offset, offset + pageSize - 1);
            if (from !== null) query = query.gte('ts', new Date(from).toISOString());

            const { data, error } = await query;
            if (error) throw error;
            rows.push(...data);
            if (data.length < pageSize) break;
        }

        historySamples = rows.map(rowToHistorySample);
        applyHistoryToLineCharts();
        updateInsights();
        supabaseStatus = 'ok';
        lastSupabaseSyncAt = Date.now();
        updateSystemStatus();
        return true;
    } catch (err) {
        supabaseStatus = 'error';
        console.warn('Supabase history load failed:', err.message);
        updateSystemStatus();
        return false;
    } finally {
        isLoadingRemoteHistory = false;
    }
}

async function loadLatestFromSupabase() {
    if (!supabaseReady || !supabaseClient) return false;
    try {
        const { data, error } = await supabaseClient
            .from(SUPABASE_TABLE)
            .select('ts,pv_w,load_w,battery_w,grid_w,soc_percent,battery_voltage_v,pv_voltage_v,pv_current_a,jk_current_a,inverter_temp_c,mos_temp_c,output_voltage_v,output_frequency_hz,apparent_va,load_percent,cell_diff_v,daily_charge_kwh,daily_discharge_kwh,daily_pv_kwh,month_charge_kwh,month_discharge_kwh,month_pv_kwh')
            .eq('device_id', DEVICE_ID)
            .order('ts', { ascending: false })
            .limit(1);
        if (error) throw error;
        if (data && data[0]) applyRealtimeRow(data[0]);
        return true;
    } catch (err) {
        supabaseStatus = 'error';
        console.warn('Supabase latest load failed:', err.message);
        updateSystemStatus();
        return false;
    }
}

function subscribeSupabaseRealtime() {
    if (!supabaseReady || !supabaseClient || supabaseRealtimeChannel) return;
    supabaseRealtimeChannel = supabaseClient
        .channel(`energy_samples:${DEVICE_ID}`)
        .on('postgres_changes', {
            event: '*',
            schema: 'public',
            table: SUPABASE_TABLE,
            filter: `device_id=eq.${DEVICE_ID}`
        }, payload => {
            if (payload.new) applyRealtimeRow(payload.new);
        })
        .subscribe(status => {
            if (status === 'SUBSCRIBED') {
                supabaseStatus = 'ok';
                updateSystemStatus();
            }
        });
}

async function loadProductionFromSupabase() {
    if (!supabaseReady || !supabaseClient) {
        applyEstimatedProduction(historySamples);
        return false;
    }

    try {
        const now = Date.now();
        const from = startOfLocalMonth(now);
        const pageSize = 1000;
        const data = [];

        for (let offset = 0; offset < 50000; offset += pageSize) {
            const { data: page, error } = await supabaseClient
                .from(SUPABASE_TABLE)
                .select('ts,pv_w,battery_w,daily_charge_kwh,daily_discharge_kwh,daily_pv_kwh,month_charge_kwh,month_discharge_kwh,month_pv_kwh')
                .eq('device_id', DEVICE_ID)
                .gte('ts', new Date(from).toISOString())
                .lte('ts', new Date(now).toISOString())
                .order('ts', { ascending: true })
                .range(offset, offset + pageSize - 1);
            if (error) throw error;
            data.push(...page);
            if (page.length < pageSize) break;
        }

        const samples = data.map(row => ({
            ts: new Date(row.ts).getTime(),
            pv: row.pv_w === null ? null : Number(row.pv_w),
            bat: row.battery_w === null ? null : Number(row.battery_w)
        }));
        applyEstimatedProduction(samples, data);
        updateOtherUI();
        updateCharts({skipHistoryPush: true});
        return true;
    } catch (err) {
        console.warn('Supabase production load failed:', err.message);
        applyEstimatedProduction(historySamples);
        updateOtherUI();
        updateCharts({skipHistoryPush: true});
        return false;
    }
}

function pushHistory(force = false) {
    const now = Date.now();
    if (!hasRealtimeData()) return;
    if (!force && now - lastHistoryAt < HISTORY_SAMPLE_INTERVAL) return;
    lastHistoryAt = now;
    const sample = createHistorySample();
    historySamples.push(sample);
    saveHistory();
    applyEstimatedProduction(historySamples);
    updateSystemStatus();
}

function getChartHistory() {
    const now = Date.now();
    const from = Number.isFinite(selectedRange.from) ? selectedRange.from : -Infinity;
    const to = selectedRange.to || now;
    const filtered = historySamples.filter(sample => sample.ts >= from && sample.ts <= to);
    if (filtered.length <= MAX_CHART_POINTS) return filtered;
    const stride = Math.ceil(filtered.length / MAX_CHART_POINTS);
    return filtered.filter((_, index) => index % stride === 0);
}

function formatHistoryLabel(timestamp, spanMs) {
    const date = new Date(timestamp);
    if (spanMs > 36 * 60 * 60 * 1000) {
        return `${padTimePart(date.getDate())}/${padTimePart(date.getMonth() + 1)} ${padTimePart(date.getHours())}:${padTimePart(date.getMinutes())}`;
    }
    return `${padTimePart(date.getHours())}:${padTimePart(date.getMinutes())}`;
}

function applyHistoryToLineCharts() {
    const samples = getChartHistory();
    const to = selectedRange.to || Date.now();
    const firstTs = samples[0]?.ts;
    const span = Number.isFinite(selectedRange.from)
        ? to - selectedRange.from
        : (Number.isFinite(firstTs) ? to - firstTs : 0);
    const labels = samples.map(sample => formatHistoryLabel(sample.ts, span));

    if (livePowerChart) {
        livePowerChart.data.labels = labels;
        livePowerChart.data.datasets[0].data = samples.map(sample => sample.pv);
        livePowerChart.data.datasets[1].data = samples.map(sample => sample.load);
        livePowerChart.data.datasets[2].data = samples.map(sample => sample.bat);
        livePowerChart.data.datasets[3].data = samples.map(sample => sample.grid);
        livePowerChart.update('none');
    }
    if (batteryTrendChart) {
        batteryTrendChart.data.labels = labels;
        batteryTrendChart.data.datasets[0].data = samples.map(sample => sample.soc);
        batteryTrendChart.data.datasets[1].data = samples.map(sample => sample.voltage);
        batteryTrendChart.update('none');
    }
    if (temperatureChart) {
        temperatureChart.data.labels = labels;
        temperatureChart.data.datasets[0].data = samples.map(sample => sample.invTemp);
        temperatureChart.data.datasets[1].data = samples.map(sample => sample.mosTemp);
        temperatureChart.update('none');
    }
    updateSystemStatus();
}

function chartByName(name) {
    return {livePowerChart, batteryTrendChart, temperatureChart, powerMixChart, dailyChart, monthlyChart}[name] || null;
}

function csvCell(value) {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportHistoryCsv() {
    const samples = getChartHistory();
    const header = ['time', 'pv_w', 'load_w', 'battery_w', 'grid_w', 'soc_percent', 'battery_voltage_v', 'inverter_temp_c', 'mos_temp_c'];
    const rows = samples.map(sample => [
        new Date(sample.ts).toISOString(),
        sample.pv,
        sample.load,
        sample.bat,
        sample.grid,
        sample.soc,
        sample.voltage,
        sample.invTemp,
        sample.mosTemp
    ]);
    const csv = [header, ...rows].map(row => row.map(csvCell).join(',')).join('\n');
    const blob = new Blob([csv], {type: 'text/csv;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `nlmt-history-${stamp}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

function endOfLocalDay(timestamp = Date.now()) {
    const date = new Date(timestamp);
    date.setHours(23, 59, 59, 999);
    return date.getTime();
}

function startOfLocalWeek(timestamp = Date.now()) {
    const date = new Date(timestamp);
    const day = date.getDay() || 7;
    date.setDate(date.getDate() - day + 1);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
}

function startOfLocalYear(timestamp = Date.now()) {
    const date = new Date(timestamp);
    date.setMonth(0, 1);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
}

function formatDateInput(timestamp) {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${padTimePart(date.getMonth() + 1)}-${padTimePart(date.getDate())}`;
}

function formatTimeInput(timestamp) {
    const date = new Date(timestamp);
    return `${padTimePart(date.getHours())}:${padTimePart(date.getMinutes())}`;
}

function rangeFromPreset(preset) {
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const day = 24 * hour;
    if (preset === 'today') return {from: startOfLocalDay(now), to: null, label: 'Hôm nay'};
    if (preset === 'yesterday') {
        const yesterday = now - day;
        return {from: startOfLocalDay(yesterday), to: endOfLocalDay(yesterday), label: 'Hôm qua'};
    }
    if (preset === 'week') return {from: startOfLocalWeek(now), to: null, label: 'Tuần này'};
    if (preset === 'month') return {from: startOfLocalMonth(now), to: null, label: 'Tháng này'};
    if (preset === 'year') return {from: startOfLocalYear(now), to: null, label: 'Năm nay'};
    if (preset === '1h') return {from: now - hour, to: now, label: '1 giờ qua'};
    if (preset === '12h') return {from: now - 12 * hour, to: now, label: '12 giờ qua'};
    if (preset === '7d') return {from: now - 7 * day, to: now, label: '7 ngày qua'};
    if (preset === '30d') return {from: now - 30 * day, to: now, label: '30 ngày qua'};
    if (preset === '90d') return {from: now - 90 * day, to: now, label: '90 ngày qua'};
    if (preset === 'all') return {from: null, to: null, label: 'Tất cả dữ liệu'};
    return {from: now - day, to: now, label: '24 giờ qua'};
}

function rangeMatchesPreset(range, preset) {
    const candidate = rangeFromPreset(preset);
    if (preset === 'all') return range.from === null && range.to === null;
    const to = range.to || null;
    const candidateTo = candidate.to || null;
    const tolerance = ['1h', '12h', '24h', '7d', '30d', '90d'].includes(preset) ? 120000 : 60000;
    return Math.abs(range.from - candidate.from) < 60000 &&
        (to === candidateTo || (to !== null && candidateTo !== null && Math.abs(to - candidateTo) < tolerance));
}

function presetForRange(range) {
    const presets = ['today', 'yesterday', 'week', 'month', 'year', '1h', '12h', '24h', '7d', '30d', '90d', 'all'];
    return presets.find(preset => rangeMatchesPreset(range, preset)) || null;
}

function setRangeInputs(range, label = 'Tùy chỉnh') {
    const fromDate = document.getElementById('rangeFromDate');
    const fromTime = document.getElementById('rangeFromTime');
    const toDate = document.getElementById('rangeToDate');
    const toTime = document.getElementById('rangeToTime');
    const summary = document.getElementById('historyRangeSummary');
    const to = range.to || Date.now();
    if (Number.isFinite(range.from)) {
        if (fromDate) fromDate.value = formatDateInput(range.from);
        if (fromTime) fromTime.value = formatTimeInput(range.from);
    } else {
        if (fromDate) fromDate.value = '';
        if (fromTime) fromTime.value = '';
    }
    if (toDate) toDate.value = formatDateInput(to);
    if (toTime) toTime.value = formatTimeInput(to);
    if (summary) summary.innerText = label;
}

function applySelectedRange(range, activePreset = null) {
    selectedRange = {from: range.from, to: range.to || null};
    const presetSelect = document.getElementById('rangePresetSelect');
    const resolvedPreset = activePreset || presetForRange(selectedRange);
    selectedRangePreset = resolvedPreset || 'custom';
    if (presetSelect) presetSelect.value = resolvedPreset || 'custom';
    setRangeInputs(selectedRange, range.label || (resolvedPreset ? rangeFromPreset(resolvedPreset).label : 'Khoảng tùy chỉnh'));
    applyHistoryToLineCharts();
    loadHistoryFromSupabase();
}

function readCustomRange() {
    const fromDate = document.getElementById('rangeFromDate');
    const fromTime = document.getElementById('rangeFromTime');
    const toDate = document.getElementById('rangeToDate');
    const toTime = document.getElementById('rangeToTime');
    const from = fromDate && fromTime && fromDate.value && fromTime.value
        ? new Date(`${fromDate.value}T${fromTime.value}`).getTime()
        : NaN;
    const to = toDate && toTime && toDate.value && toTime.value
        ? new Date(`${toDate.value}T${toTime.value}`).getTime()
        : NaN;
    return {from, to};
}

function setupChartControls() {
    setRangeInputs(selectedRange, '24 giờ qua');

    const presetSelect = document.getElementById('rangePresetSelect');
    if (presetSelect) {
        presetSelect.addEventListener('change', () => {
            const preset = presetSelect.value;
            if (preset === 'custom') {
                selectedRangePreset = 'custom';
                setRangeInputs(selectedRange, 'Khoảng tùy chỉnh');
                return;
            }
            applySelectedRange(rangeFromPreset(preset), preset);
        });
    }

    const applyRange = document.getElementById('applyRange');
    if (applyRange) {
        applyRange.addEventListener('click', () => {
            const range = readCustomRange();
            const summary = document.getElementById('historyRangeSummary');
            if (!Number.isFinite(range.from) || !Number.isFinite(range.to) || range.to <= range.from) {
                if (summary) summary.innerText = 'Khoảng thời gian không hợp lệ';
                return;
            }
            const matchedPreset = presetForRange(range);
            applySelectedRange({from: range.from, to: range.to, label: matchedPreset ? rangeFromPreset(matchedPreset).label : 'Khoảng tùy chỉnh'}, matchedPreset);
        });
    }

    const resetRange = document.getElementById('resetRange');
    if (resetRange) {
        resetRange.addEventListener('click', () => {
            applySelectedRange(rangeFromPreset('24h'), '24h');
        });
    }

    const exportCsv = document.getElementById('exportCsv');
    if (exportCsv) exportCsv.addEventListener('click', exportHistoryCsv);

    document.querySelectorAll('.line-toggle').forEach(button => {
        button.addEventListener('click', () => {
            const chart = chartByName(button.dataset.chart);
            const datasetIndex = Number(button.dataset.dataset);
            if (!chart || !Number.isInteger(datasetIndex)) return;
            const visible = chart.isDatasetVisible(datasetIndex);
            chart.setDatasetVisibility(datasetIndex, !visible);
            button.classList.toggle('active', !visible);
            chart.update();
        });
    });
}

function initCharts() {
    const theme = chartTheme();
    Chart.defaults.color = theme.text;
    Chart.defaults.borderColor = theme.grid;
    Chart.defaults.font.family = "'Segoe UI', 'Poppins', system-ui, sans-serif";

    const ctxDaily = document.getElementById('dailyBarChart').getContext('2d');
    dailyChart = new Chart(ctxDaily, {
        type: 'bar',
        data: { labels: ['Pin sạc', 'Pin xả', 'PV'], datasets: [{ label: 'kWh hôm nay', data: [productionValue('dailyCharge'), productionValue('dailyDischarge'), productionValue('dailyPv')], backgroundColor: ['rgba(120,201,181,0.84)', 'rgba(141,181,255,0.84)', 'rgba(245,182,74,0.84)'], borderColor: 'rgba(255, 255, 255, 0.72)', borderWidth: 1, borderRadius: 10 }] },
        options: glassChartOptions()
    });
    const ctxMonth = document.getElementById('monthlyLineChart').getContext('2d');
    monthlyChart = new Chart(ctxMonth, {
        type: 'bar',
        data: { labels: ['Pin sạc', 'Pin xả', 'PV'], datasets: [{ label: 'kWh tháng này', data: [productionValue('monthCharge'), productionValue('monthDischarge'), productionValue('monthPv')], backgroundColor: ['rgba(120,201,181,0.84)', 'rgba(141,181,255,0.84)', 'rgba(245,182,74,0.84)'], borderColor: 'rgba(255, 255, 255, 0.72)', borderWidth: 1, borderRadius: 10 }] },
        options: glassChartOptions()
    });

    livePowerChart = new Chart(document.getElementById('livePowerChart').getContext('2d'), {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                {label: 'PV W', data: [], borderColor: '#f5b64a', backgroundColor: 'rgba(245,182,74,0.16)', pointRadius: 0, borderWidth: 3, tension: 0.36, spanGaps: true, fill: true},
                {label: 'Tải W', data: [], borderColor: '#38bec7', backgroundColor: 'rgba(120,220,227,0.12)', pointRadius: 0, borderWidth: 3, tension: 0.36, spanGaps: true, fill: true},
                {label: 'Pin W', data: [], borderColor: '#1f7061', backgroundColor: 'rgba(120,201,181,0.14)', pointRadius: 0, borderWidth: 3, tension: 0.36, spanGaps: true, fill: false},
                {label: 'Bù lưới W', data: [], borderColor: '#8db5ff', backgroundColor: 'rgba(141,181,255,0.12)', pointRadius: 0, borderWidth: 3, tension: 0.36, spanGaps: true, fill: false}
            ]
        },
        options: glassChartOptions()
    });

    powerMixChart = new Chart(document.getElementById('powerMixChart').getContext('2d'), {
        type: 'doughnut',
        data: {
            labels: ['PV', 'Tải', 'Pin', 'Bù lưới'],
            datasets: [{
                data: [valueOrZero(realData.pv), valueOrZero(realData.load), Math.abs(valueOrZero(realData.bat)), Math.abs(valueOrZero(realData.grid))],
                backgroundColor: ['#f5b64a', '#78dce3', '#78c9b5', '#8db5ff'],
                borderColor: 'rgba(255,255,255,0.72)',
                borderWidth: 2,
                hoverOffset: 8
            }]
        },
        options: glassChartOptions({cutout: '68%', scales: {}})
    });

    batteryTrendChart = new Chart(document.getElementById('batteryTrendChart').getContext('2d'), {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                {label: 'SOC %', data: [], borderColor: '#1f7061', backgroundColor: 'rgba(120,201,181,0.16)', pointRadius: 0, borderWidth: 3, tension: 0.36, spanGaps: true, yAxisID: 'y'},
                {label: 'Điện áp V', data: [], borderColor: '#8db5ff', backgroundColor: 'rgba(141,181,255,0.12)', pointRadius: 0, borderWidth: 3, tension: 0.36, spanGaps: true, yAxisID: 'y1'}
            ]
        },
        options: glassChartOptions({
            scales: {
                x: {grid: {color: chartTheme().gridSoft}, ticks: {color: chartTheme().text}},
                y: {position: 'left', min: 0, max: 100, grid: {color: chartTheme().grid}, ticks: {color: chartTheme().text}},
                y1: {position: 'right', grid: {drawOnChartArea: false}, ticks: {color: chartTheme().text}}
            }
        })
    });

    temperatureChart = new Chart(document.getElementById('temperatureChart').getContext('2d'), {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                {label: 'Inverter °C', data: [], borderColor: '#f5a623', backgroundColor: 'rgba(245,166,35,0.16)', pointRadius: 0, borderWidth: 3, tension: 0.34, spanGaps: true, fill: true},
                {label: 'MOS °C', data: [], borderColor: '#e76f51', backgroundColor: 'rgba(231,111,81,0.12)', pointRadius: 0, borderWidth: 3, tension: 0.34, spanGaps: true, fill: true}
            ]
        },
        options: glassChartOptions()
    });

    applyHistoryToLineCharts();
    updateOperationMonitor();
    setupChartControls();
    updateChartTheme();
}
function updateCharts(options = {}) {
    if (!options.skipHistoryPush) pushHistory();
    if (dailyChart) {
        dailyChart.data.datasets[0].data = [productionValue('dailyCharge'), productionValue('dailyDischarge'), productionValue('dailyPv')];
        dailyChart.update('none');
    }
    if (monthlyChart) {
        monthlyChart.data.datasets[0].data = [productionValue('monthCharge'), productionValue('monthDischarge'), productionValue('monthPv')];
        monthlyChart.update('none');
    }
    applyHistoryToLineCharts();
    if (powerMixChart) {
        powerMixChart.data.datasets[0].data = [
            valueOrZero(realData.pv),
            valueOrZero(realData.load),
            Math.abs(valueOrZero(realData.bat)),
            Math.abs(valueOrZero(realData.grid))
        ];
        powerMixChart.update('none');
    }
    updateOperationMonitor();
    updateInsights();
    updateSystemStatus();
}

// ========== 4. KẾT NỐI REALTIME QUA SUPABASE ==========
initSupabase();
setupThemeControls();
applyEstimatedProduction(historySamples);
initCharts();
updateFloatingCards();
updateOtherUI();
updateOperationMonitor();
updateInsights();
updateSystemStatus();
loadHistoryFromSupabase();
loadLatestFromSupabase();
loadProductionFromSupabase();
subscribeSupabaseRealtime();
setInterval(() => {
    if (lastEventAt && Date.now() - lastEventAt > 90000) espConnected = false;
    updateSystemStatus();
}, 15000);
setInterval(loadLatestFromSupabase, 60000);
