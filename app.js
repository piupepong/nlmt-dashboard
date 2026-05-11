// === CẤU HÌNH ESPHOME ===
const EVENT_URL = "http://piupepong.ddnsfree.com:82/events";
const SUPABASE_CONFIG = window.SUPABASE_CONFIG || {};
const SUPABASE_TABLE = SUPABASE_CONFIG.table || 'energy_samples';
const DEVICE_ID = SUPABASE_CONFIG.deviceId || 'nlmt-main';
let supabaseClient = null;
let supabaseReady = false;
let isLoadingRemoteHistory = false;
let espConnected = false;
let lastEventAt = null;
let lastSupabaseSyncAt = null;
let supabaseStatus = 'disabled';

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
    'sensor-pin_sac_thang': 'monthCharge',
    'sensor-pin_xa_thang': 'monthDischarge',
    'sensor-pv_thang': 'monthPv',
    'sensor-san_luong_pv_thang': 'monthPv'
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

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.innerText = value;
}

function setHtml(id, value) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = value;
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
    if (samples.length < 2) return {importKwh: null, exportKwh: null, offsetKwh: null};
    let importWh = 0;
    let exportWh = 0;
    for (let i = 0; i < samples.length - 1; i++) {
        const current = samples[i];
        const next = samples[i + 1];
        if (!Number.isFinite(current.grid) || !Number.isFinite(next.ts) || !Number.isFinite(current.ts)) continue;
        const hours = Math.min(Math.max((next.ts - current.ts) / 3600000, 0), 0.25);
        const watts = Math.abs(current.grid);
        if (current.grid < 0) importWh += watts * hours;
        if (current.grid > 0) exportWh += watts * hours;
    }
    const importKwh = importWh / 1000;
    const exportKwh = exportWh / 1000;
    return {
        importKwh,
        exportKwh,
        offsetKwh: exportKwh - importKwh
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
    setText('gridImportKwh', Number.isFinite(gridEnergy.importKwh) ? gridEnergy.importKwh.toFixed(2) : '--');
    setText('gridExportKwh', Number.isFinite(gridEnergy.exportKwh) ? gridEnergy.exportKwh.toFixed(2) : '--');
    setText('gridOffsetKwh', Number.isFinite(gridEnergy.offsetKwh) ? gridEnergy.offsetKwh.toFixed(2) : '--');
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

function resolveSensorKey(id) {
    if (sensorMap[id]) return sensorMap[id];
    const normalized = id.toLowerCase();
    if (normalized.includes('hom_nay') || normalized.includes('today') || normalized.includes('daily')) {
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
        gridSpan.style.color = '#2ecc71';
        gridDirSpan.innerHTML = '📤 Phát lên lưới';
    } else if (gridPower < 0) {
        gridSpan.style.color = '#e67e22';
        gridDirSpan.innerHTML = '📥 Nhập từ lưới';
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
    setHtml('dailyCharge', formatValue(realData.dailyCharge, 2));
    setHtml('dailyDischarge', formatValue(realData.dailyDischarge, 2));
    setHtml('dailyPv', formatValue(realData.dailyPv, 2));
    setHtml('monthCharge', formatValue(realData.monthCharge, 2));
    setHtml('monthDischarge', formatValue(realData.monthDischarge, 2));
    setHtml('monthPv', formatValue(realData.monthPv, 2));
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
    height = window.innerWidth <= 860 ? 520 : 380;
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
            load: {x: width * 0.72, y: height * 0.18, label: 'Tải', color: '#78dce3'},
            inverter: {x: width * 0.5, y: height * 0.46, label: 'Inverter', color: '#ffffff'},
            grid: {x: width * 0.28, y: height * 0.78, label: 'Lưới', color: '#8db5ff'},
            battery: {x: width * 0.72, y: height * 0.78, label: 'Pin', color: '#78c9b5'}
        };
    } else {
        nodes = {
            pv: {x: width * 0.13, y: height * 0.36, label: 'PV', color: '#f5b64a'},
            load: {x: width * 0.87, y: height * 0.36, label: 'Tải', color: '#78dce3'},
            grid: {x: width * 0.22, y: height * 0.78, label: 'Lưới', color: '#8db5ff'},
            battery: {x: width * 0.78, y: height * 0.78, label: 'Pin', color: '#78c9b5'},
            inverter: {x: width * 0.5, y: height * 0.43, label: 'Inverter', color: '#ffffff'}
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
    {from:'grid', to:'inverter', key:'gridIn', color:'#8db5ff', liftDesktop:-24, liftMobile:-42},
    {from:'inverter', to:'grid', key:'gridOut', color:'#f5b64a', liftDesktop:-24, liftMobile:-42}
];

function linkLift(link) {
    return width <= 620 ? link.liftMobile : link.liftDesktop;
}

function linkIsActive(key) {
    if (key === 'pv') return realData.pv > 20;
    if (key === 'load') return realData.load > 20;
    if (key === 'batCharge') return realData.bat > 15;
    if (key === 'batDischarge') return realData.bat < -15;
    if (key === 'gridIn') return realData.grid < -20;
    if (key === 'gridOut') return realData.grid > 20;
    return false;
}

function linkPower(key) {
    if (key === 'pv') return Math.abs(realData.pv);
    if (key === 'load') return Math.abs(realData.load);
    if (key === 'batCharge' || key === 'batDischarge') return Math.abs(realData.bat);
    if (key === 'gridIn' || key === 'gridOut') return Math.abs(realData.grid);
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
                    color: '#365f59',
                    font: {weight: 700}
                }
            },
            tooltip: {
                backgroundColor: 'rgba(20, 62, 56, 0.82)',
                borderColor: 'rgba(255,255,255,0.5)',
                borderWidth: 1,
                padding: 12,
                titleColor: '#fff7d6',
                bodyColor: '#e9fffb'
            }
        },
        scales: {
            x: {grid: {color: 'rgba(36, 74, 69, 0.08)'}, ticks: {color: '#5d7874'}},
            y: {grid: {color: 'rgba(36, 74, 69, 0.1)'}, ticks: {color: '#5d7874'}}
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

async function saveSampleToSupabase(sample) {
    if (!supabaseReady || !supabaseClient) return;
    const { error } = await supabaseClient
        .from(SUPABASE_TABLE)
        .upsert(historySampleToRow(sample), { onConflict: 'device_id,ts', ignoreDuplicates: false });
    if (error) {
        supabaseStatus = 'error';
        console.warn('Supabase save failed:', error.message);
    } else {
        supabaseStatus = 'ok';
        lastSupabaseSyncAt = Date.now();
    }
    updateSystemStatus();
}

async function loadHistoryFromSupabase() {
    if (!supabaseReady || !supabaseClient || isLoadingRemoteHistory) return false;
    isLoadingRemoteHistory = true;
    supabaseStatus = 'loading';
    updateSystemStatus();
    try {
        const now = Date.now();
        const from = selectedRange.from || now - 24 * 60 * 60 * 1000;
        const to = selectedRange.to || now;
        const { data, error } = await supabaseClient
            .from(SUPABASE_TABLE)
            .select('ts,pv_w,load_w,battery_w,grid_w,soc_percent,battery_voltage_v,inverter_temp_c,mos_temp_c')
            .eq('device_id', DEVICE_ID)
            .gte('ts', new Date(from).toISOString())
            .lte('ts', new Date(to).toISOString())
            .order('ts', { ascending: true })
            .limit(10000);
        if (error) throw error;
        historySamples = data.map(rowToHistorySample);
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

function pushHistory(force = false) {
    const now = Date.now();
    if (!hasRealtimeData()) return;
    if (!force && now - lastHistoryAt < HISTORY_SAMPLE_INTERVAL) return;
    lastHistoryAt = now;
    const sample = createHistorySample();
    historySamples.push(sample);
    saveHistory();
    saveSampleToSupabase(sample);
    updateSystemStatus();
}

function getChartHistory() {
    const now = Date.now();
    const from = selectedRange.from || now - 24 * 60 * 60 * 1000;
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
    const span = to - (selectedRange.from || to);
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

function setupChartControls() {
    const rangeFrom = document.getElementById('rangeFrom');
    const rangeTo = document.getElementById('rangeTo');
    if (rangeFrom) rangeFrom.value = formatDateTimeLocal(selectedRange.from);

    document.querySelectorAll('.range-btn').forEach(button => {
        button.addEventListener('click', () => {
            const days = Number(button.dataset.rangeDays);
            selectedRange = {from: Date.now() - days * 24 * 60 * 60 * 1000, to: null};
            document.querySelectorAll('.range-btn').forEach(btn => btn.classList.toggle('active', btn === button));
            if (rangeFrom) rangeFrom.value = formatDateTimeLocal(selectedRange.from);
            if (rangeTo) rangeTo.value = '';
            applyHistoryToLineCharts();
            loadHistoryFromSupabase();
        });
    });

    const applyRange = document.getElementById('applyRange');
    if (applyRange) {
        applyRange.addEventListener('click', () => {
            const from = rangeFrom && rangeFrom.value ? new Date(rangeFrom.value).getTime() : Date.now() - 24 * 60 * 60 * 1000;
            const to = rangeTo && rangeTo.value ? new Date(rangeTo.value).getTime() : null;
            selectedRange = {from, to};
            document.querySelectorAll('.range-btn').forEach(btn => btn.classList.remove('active'));
            applyHistoryToLineCharts();
            loadHistoryFromSupabase();
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
    Chart.defaults.color = '#476864';
    Chart.defaults.borderColor = 'rgba(36, 74, 69, 0.12)';
    Chart.defaults.font.family = "'Segoe UI', 'Poppins', system-ui, sans-serif";

    const ctxDaily = document.getElementById('dailyBarChart').getContext('2d');
    dailyChart = new Chart(ctxDaily, {
        type: 'bar',
        data: { labels: ['Pin sạc', 'Pin xả', 'PV'], datasets: [{ label: 'kWh hôm nay', data: [realData.dailyCharge, realData.dailyDischarge, realData.dailyPv], backgroundColor: ['rgba(120,201,181,0.84)', 'rgba(141,181,255,0.84)', 'rgba(245,182,74,0.84)'], borderColor: 'rgba(255, 255, 255, 0.72)', borderWidth: 1, borderRadius: 10 }] },
        options: glassChartOptions()
    });
    const ctxMonth = document.getElementById('monthlyLineChart').getContext('2d');
    monthlyChart = new Chart(ctxMonth, {
        type: 'bar',
        data: { labels: ['Pin sạc', 'Pin xả', 'PV'], datasets: [{ label: 'kWh tháng này', data: [realData.monthCharge, realData.monthDischarge, realData.monthPv], backgroundColor: ['rgba(120,201,181,0.84)', 'rgba(141,181,255,0.84)', 'rgba(245,182,74,0.84)'], borderColor: 'rgba(255, 255, 255, 0.72)', borderWidth: 1, borderRadius: 10 }] },
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
                {label: 'Lưới W', data: [], borderColor: '#8db5ff', backgroundColor: 'rgba(141,181,255,0.12)', pointRadius: 0, borderWidth: 3, tension: 0.36, spanGaps: true, fill: false}
            ]
        },
        options: glassChartOptions()
    });

    powerMixChart = new Chart(document.getElementById('powerMixChart').getContext('2d'), {
        type: 'doughnut',
        data: {
            labels: ['PV', 'Tải', 'Pin', 'Lưới'],
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
                x: {grid: {color: 'rgba(36, 74, 69, 0.08)'}, ticks: {color: '#5d7874'}},
                y: {position: 'left', min: 0, max: 100, grid: {color: 'rgba(36, 74, 69, 0.1)'}, ticks: {color: '#5d7874'}},
                y1: {position: 'right', grid: {drawOnChartArea: false}, ticks: {color: '#5d7874'}}
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
    setupChartControls();
}
function updateCharts() {
    pushHistory();
    if (dailyChart) {
        dailyChart.data.datasets[0].data = [realData.dailyCharge, realData.dailyDischarge, realData.dailyPv];
        dailyChart.update('none');
    }
    if (monthlyChart) {
        monthlyChart.data.datasets[0].data = [realData.monthCharge, realData.monthDischarge, realData.monthPv];
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
    updateInsights();
    updateSystemStatus();
}

// ========== 4. KẾT NỐI ESPHOME ==========
let evSource;
function connectEvents() {
    if (evSource) evSource.close();
    evSource = new EventSource(EVENT_URL);
    evSource.onopen = () => {
        espConnected = true;
        lastEventAt = Date.now();
        updateSystemStatus();
        console.log("ESPHome connected");
    };
    evSource.onerror = () => {
        espConnected = false;
        updateSystemStatus();
        console.warn("ESPHome connection lost, retry in 3s");
        evSource.close();
        setTimeout(connectEvents, 3000);
    };
    evSource.addEventListener('state', (e) => {
        try{
            let d = JSON.parse(e.data);
            let raw = (d.value !== undefined) ? d.value : (d.state === 'ON' ? 1 : d.state);
            let id = d.id;
            const key = resolveSensorKey(id);
            if (!key) return;
            const numericValue = parseFloat(raw);
            realData[key] = Number.isFinite(numericValue) ? numericValue : null;
            espConnected = true;
            lastEventAt = Date.now();
            
            updateFloatingCards();
            updateOtherUI();
            updateCharts();
        } catch(err){}
    });
}
connectEvents();
initSupabase();
initCharts();
updateFloatingCards();
updateOtherUI();
updateInsights();
updateSystemStatus();
loadHistoryFromSupabase();
setInterval(() => {
    if (lastEventAt && Date.now() - lastEventAt > 90000) espConnected = false;
    updateSystemStatus();
}, 15000);
