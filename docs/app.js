// ====================================================================
// Gear Intelligent Scheduling System - Core Engine (app.js)
// ====================================================================

// --- CONFIG ---
// Simulation epoch: 2026-07-13 08:00 UTC+8
// We use "simulation hours" offset from this epoch to avoid timezone issues.
const EPOCH = new Date("2026-07-13T00:00:00+08:00"); // midnight of day 0
const SIM_START_HOUR = 8; // production starts at hour 8 of day 0
const TZ_OFFSET = 8; // UTC+8

const STANDARDS = {
    M1: { label: '輕型 M1', M: 1, Z: 30, b: 20, revenue: 10000, penaltyRate: 0.01 },
    M2: { label: '中型 M2', M: 2, Z: 50, b: 40, revenue: 30000, penaltyRate: 0.015 },
    M3: { label: '巨型 M3', M: 3, Z: 80, b: 60, revenue: 80000, penaltyRate: 0.02 },
};

// 注意：使用者帳號、密碼一律只存在後端資料庫（雜湊儲存），
// 前端不再持有任何帳密資料，登入一律呼叫後端 API 驗證。

let currentUser = null;
let authToken = null;
let state = { orders: [], logs: [] };

// Factory baseline dynamics — the reference values every AI adjustment is compared against.
const BASE_DYNAMICS = {
    setup_hrs: { turn: 2.0, hob: 3.0, grind: 4.0 },
    coefficients: {
        turn_base: 0.8, turn_safety: 1.05,
        hob_base: 1.2,
        grind_base: 2.5, grind_safety: 1.1
    }
};

// 機台即時遙測快照現在存在後端資料庫裡，前端不再寫死這份資料。

let currentDynamics = JSON.parse(JSON.stringify(BASE_DYNAMICS));

// ====================================================================
// UTILITY FUNCTIONS
// ====================================================================

// --- AI Helper (calls our own backend proxy — the Gemini API key never lives in the browser) ---

// TODO: 部署後端到 Render 後，把下面網址換成您自己的 Render 服務網址
// 例如 'https://gear-scheduler-backend.onrender.com'
const DEFAULT_BACKEND_URL = 'https://YOUR-RENDER-APP-NAME.onrender.com';

function getBackendUrl() {
    const url = (localStorage.getItem('backend_url') || DEFAULT_BACKEND_URL).trim();
    return url.replace(/\/+$/, ''); // strip trailing slash
}

// ---- 通用後端 API 呼叫（FastAPI）----
// 所有需要登入的請求都會自動夾帶 Authorization: Bearer <token>。
// 後端絕不會回傳密碼、密碼雜湊、API Key 等內部資料，
// 這裡收到的永遠只會是允許顯示在 UI 上的欄位。
async function apiFetch(path, options = {}) {
    const backendUrl = getBackendUrl();
    if (!backendUrl || backendUrl.includes('YOUR-RENDER-APP-NAME')) {
        throw new Error('尚未設定後端服務網址！請點擊右上角⚙️設定。');
    }

    const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

    // Render 免費方案閒置一段時間後會休眠，首次喚醒可能需要 30~50 秒，提前提示使用者避免誤以為當機
    const wakeupTimer = setTimeout(() => {
        showToast('☁️ 後端服務啟動中（免費方案冷啟動），首次請求約需 30~50 秒，請稍候...', 'info');
    }, 4000);

    let res;
    try {
        res = await fetch(`${backendUrl}${path}`, Object.assign({}, options, { headers }));
    } catch (networkErr) {
        throw new Error(`無法連線到後端服務 (${backendUrl})，請確認網址是否正確、Render 服務是否運作中。`);
    } finally {
        clearTimeout(wakeupTimer);
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        if (res.status === 401) {
            // Token 失效或未登入 — 強制回到登入畫面，避免顯示殘留的舊資料
            handleSessionExpired();
        }
        throw new Error(data.detail || res.statusText || '後端服務回應錯誤');
    }
    return data;
}

function handleSessionExpired() {
    const wasLoggedIn = !!currentUser;
    authToken = null;
    currentUser = null;
    sessionStorage.removeItem('auth_token');
    sessionStorage.removeItem('auth_user');
    if (wasLoggedIn) {
        switchView('view-login');
        showToast('登入狀態已逾時，請重新登入', 'error');
    }
}

// ---- AI 相關（機台遙測動態調整 / 決策報告）----
// 系統提示字串（Prompt）與 Gemini API Key 都只存在後端，前端只送出/收到必要的結構化資料。
async function analyzeTelemetryOnServer() {
    const data = await apiFetch('/api/ai/telemetry-analysis', { method: 'POST' });
    return {
        explanation: data.explanation,
        before: data.before,
        after: data.after,
        timestamp: data.timestamp
    };
}

async function generateReportOnServer(evalJson) {
    const data = await apiFetch('/api/ai/report', {
        method: 'POST',
        body: JSON.stringify({ eval_json: evalJson })
    });
    return data.text;
}

// ====================================================================
// AI TELEMETRY ANALYSIS (auto-triggered by insertion evaluation)
// ====================================================================

// Calls Gemini with the machine telemetry snapshot, updates currentDynamics,
// and returns the adjustment record (base vs. adjusted values + explanation)
// so it can be rendered in the UI and later forwarded to the decision report.
async function runTelemetryAnalysis() {
    // 機台遙測原始資料、系統提示字串、Gemini API Key 全部只存在後端，
    // 前端只負責呼叫並顯示結果。
    const adjustment = await analyzeTelemetryOnServer();

    currentDynamics = {
        setup_hrs: adjustment.after.setup_hrs,
        coefficients: adjustment.after.coefficients
    };

    return adjustment;
}

// Renders the "⚙️ AI 產線係數動態調整對照" panel — a polished HTML table + alert box,
// never raw JSON. Pass `failed=true` to show a graceful fallback state instead.
function renderDynamicsPanel(adjustment, failed = false, errMsg = '') {
    const panel = document.getElementById('ai-dynamics-panel');
    if (!panel) return;

    if (failed) {
        panel.innerHTML = `
            <div class="dynamics-panel-box dynamics-panel-fallback">
                <div class="ai-alert-box alert-warning">
                    <div class="ai-alert-icon">⚠️</div>
                    <div class="ai-alert-content">
                        <div class="ai-alert-title">AI 動態參數更新失敗，已沿用基準係數繼續評估</div>
                        <div class="ai-alert-text">${errMsg || '無法連接 AI 服務，請確認 API Key 設定是否正確。'}</div>
                    </div>
                </div>
            </div>`;
        panel.classList.remove('hidden');
        return;
    }

    if (!adjustment) {
        panel.classList.add('hidden');
        panel.innerHTML = '';
        return;
    }

    const { explanation, before, after } = adjustment;

    // Renders a small "基準 → 最新" delta badge; red = increased (slower), green = decreased (faster)
    const deltaBadge = (baseVal, newVal) => {
        const diff = newVal - baseVal;
        if (Math.abs(diff) < 0.001) return `<span class="delta-badge delta-same">– 無變化</span>`;
        const pct = baseVal !== 0 ? Math.abs(diff / baseVal) * 100 : 0;
        const cls = diff > 0 ? 'delta-up' : 'delta-down';
        const arrow = diff > 0 ? '▲' : '▼';
        return `<span class="delta-badge ${cls}">${arrow} ${pct.toFixed(0)}%</span>`;
    };

    const cellPair = (baseVal, newVal, decimals, unit = '') => `
        <div class="dyn-cell">
            <span class="dyn-base">${baseVal.toFixed(decimals)}${unit}</span>
            <span class="dyn-arrow">→</span>
            <span class="dyn-new">${newVal.toFixed(decimals)}${unit}</span>
        </div>
        ${deltaBadge(baseVal, newVal)}`;

    const rows = [
        { name: '🔧 車床 Turn', setup: 'turn', main: 'turn_base', safe: 'turn_safety' },
        { name: '⚙️ 滾齒 Hob', setup: 'hob', main: 'hob_base', safe: null },
        { name: '🪚 磨齒 Grind', setup: 'grind', main: 'grind_base', safe: 'grind_safety' }
    ];

    const tableRows = rows.map(r => `
        <tr>
            <td class="proc-name">${r.name}</td>
            <td>${cellPair(before.setup_hrs[r.setup], after.setup_hrs[r.setup], 1, 'h')}</td>
            <td>${cellPair(before.coefficients[r.main], after.coefficients[r.main], 2)}</td>
            <td>${r.safe ? cellPair(before.coefficients[r.safe], after.coefficients[r.safe], 2) : '<span class="text-muted">—</span>'}</td>
        </tr>`).join('');

    panel.innerHTML = `
        <div class="dynamics-panel-box">
            <div class="dynamics-panel-header">
                <h4>⚙️ AI 產線係數動態調整對照</h4>
                <span class="dynamics-badge">機台遙測 · 自動套用</span>
            </div>
            <div class="table-responsive">
                <table class="table dynamics-table">
                    <thead>
                        <tr><th>製程</th><th>換線時間（基準 → 最新）</th><th>切削基準係數（基準 → 最新）</th><th>切削安全係數（基準 → 最新）</th></tr>
                    </thead>
                    <tbody>${tableRows}</tbody>
                </table>
            </div>
            <div class="ai-alert-box">
                <div class="ai-alert-icon">🧠</div>
                <div class="ai-alert-content">
                    <div class="ai-alert-title">AI 診斷原因</div>
                    <div class="ai-alert-text">${explanation}</div>
                </div>
            </div>
        </div>`;
    panel.classList.remove('hidden');
}

// ====================================================================
// AI DECISION REPORT — progressive loading + markdown rendering
// ====================================================================

// Paints one step of the progressive loading indicator into the report container.
function renderReportLoading(container, steps, idx) {
    const dots = steps.map((_, i) =>
        `<span class="loading-dot ${i <= idx ? 'active' : ''} ${i === idx ? 'current' : ''}"></span>`
    ).join('');
    container.innerHTML = `
        <div class="ai-loading-box">
            <div class="ai-spinner"></div>
            <div class="ai-loading-text">${steps[idx]}</div>
            <div class="ai-loading-dots">${dots}</div>
            <div class="ai-loading-caption">AI 正在深度分析中，請稍候片刻（步驟 ${idx + 1} / ${steps.length}）</div>
        </div>`;
}

// Minimal inline markdown (bold only — headings/tables are handled line-by-line below).
function inlineMd(text) {
    return text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
}

// Converts the AI's Markdown report into clean HTML: real <table> elements for
// pipe-tables (never a raw JSON dump), styled headings, and paragraphs.
function renderMarkdownReport(markdownText) {
    const lines = markdownText.replace(/\r\n/g, '\n').split('\n');
    let html = '';
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        // Markdown table: a "| ... |" header row followed by a "|---|---|" separator row
        if (/^\s*\|.+\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
            const headerCells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
            const bodyRows = [];
            i += 2;
            while (i < lines.length && /^\s*\|.+\|\s*$/.test(lines[i])) {
                bodyRows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
                i++;
            }
            html += `<div class="ai-table-wrap"><table class="ai-report-table"><thead><tr>` +
                headerCells.map(c => `<th>${inlineMd(c)}</th>`).join('') +
                `</tr></thead><tbody>` +
                bodyRows.map(r => `<tr>${r.map(c => `<td>${inlineMd(c)}</td>`).join('')}</tr>`).join('') +
                `</tbody></table></div>`;
            continue;
        }

        if (/^###\s+/.test(line)) {
            html += `<h4>${inlineMd(line.replace(/^###\s+/, ''))}</h4>`;
        } else if (/^##\s+/.test(line)) {
            html += `<h3 class="ai-report-h3">${inlineMd(line.replace(/^##\s+/, ''))}</h3>`;
        } else if (line.trim() !== '') {
            html += `<p>${inlineMd(line)}</p>`;
        }
        i++;
    }
    return html;
}

// Convert a "simulation hour" (hours since EPOCH midnight) to display string
function simHourToDisplay(simHour) {
    const day = Math.floor(simHour / 24);
    const hour = Math.floor(simHour % 24);
    const d = new Date(EPOCH.getTime() + day * 24 * 3600 * 1000);
    const m = d.getMonth() + 1;
    const dd = d.getDate();
    return `${m}/${dd} ${String(hour).padStart(2, '0')}:00`;
}

// Convert a datetime-local string (local time) to simulation hour
function dateStrToSimHour(str) {
    const d = new Date(str);
    const diffMs = d.getTime() - EPOCH.getTime();
    return diffMs / (3600 * 1000);
}

// Convert simulation hour to a Date object (for display)
function simHourToDate(simHour) {
    return new Date(EPOCH.getTime() + simHour * 3600 * 1000);
}

// Format simulation hours as "X.X 天" + "Y.Y hrs"
function formatDualTime(hours) {
    const days = hours / 20;
    return `<span class="days">${days.toFixed(1)} 天</span><span class="hours">${hours.toFixed(1)} hrs</span>`;
}

function showToast(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => { if (container.contains(toast)) container.removeChild(toast); }, 3200);
}

// ====================================================================
// STATE — 從正式資料庫（後端 API）讀取，不再使用 localStorage
// ====================================================================
// 工單與操作紀錄現在是「正式資料」，儲存在後端資料庫裡，所有裝置、所有人看到的都是同一份。
// 操作紀錄（登入、登出、插單、編輯、刪除）一律由後端在對應的 API 呼叫當下自動寫入，
// 前端不再自行組裝 log 物件或呼叫 localStorage。
async function fetchOrders() {
    state.orders = await apiFetch('/api/orders');
}

async function fetchLogs() {
    state.logs = await apiFetch('/api/logs?limit=100');
}

async function refreshOrdersAndLogs() {
    await Promise.all([fetchOrders(), fetchLogs()]);
}

// 依現有工單編號推算下一個 ORD-xxx 編號（工單本身由後端資料庫管理，這裡只是產生一個新 ID）
function nextOrderId() {
    let maxNum = 100;
    for (const o of state.orders) {
        const m = /^ORD-(\d+)$/.exec(o.id);
        if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
    }
    return `ORD-${maxNum + 1}`;
}

// ====================================================================
// CORE SCHEDULING ENGINE
// ====================================================================

// Physical cutting formulas
function calcHours(M, Z, b, Qty) {
    const c = currentDynamics.coefficients;
    const turn = (c.turn_base * M * Math.sqrt(Z) * b / 300) * Qty * c.turn_safety;
    const hob = (c.hob_base * M * Math.pow(Z, 0.8) * b / 520) * Qty;
    const grind = (c.grind_base * M * Math.sqrt(Z) * b / 1200) * Qty * c.grind_safety;
    return { turn: Math.round(turn * 100) / 100, hob: Math.round(hob * 100) / 100, grind: Math.round(grind * 100) / 100 };
}

// Forward simulation of a given order sequence
function simulateSchedule(orders) {
    // Machine state stores the time the machine becomes completely free (after finishing a job)
    const machines = {
        lathe1: SIM_START_HOUR, lathe2: SIM_START_HOUR,
        hob1: SIM_START_HOUR, hob2: SIM_START_HOUR,
        grind1: SIM_START_HOUR, grind2: SIM_START_HOUR
    };
    
    // Track if it's the first job on the machine to avoid initial setup time
    const isFirstJob = {
        lathe1: true, lathe2: true, hob1: true, hob2: true, grind1: true, grind2: true
    };
    
    // Setup time (changeover time) in hours for each process
    const SETUP_HRS = currentDynamics.setup_hrs;
    const scheduled = [];

    for (const o of orders) {
        const op = { ...o };
        const hrs = calcHours(op.M, op.Z, op.b, op.qty);

        // Helper to assign machine with setup time
        const assignMachine = (m1, m2, step, stepHrs, orderAvailableTime) => {
            const m = machines[m1] <= machines[m2] ? m1 : m2;
            const setupTime = isFirstJob[m] ? 0 : SETUP_HRS[step];
            
            // The job starts when BOTH the machine is ready (setup finished) AND the previous step of the order is done.
            // Setup starts exactly 'setupTime' hours before actualStart.
            const machineSetupEnd = machines[m] + setupTime;
            const actualStart = Math.max(orderAvailableTime, machineSetupEnd);
            const actualEnd = actualStart + stepHrs;
            
            op[`${step}_setup_start`] = actualStart - setupTime;
            op[`${step}_setup_end`] = actualStart;
            op[`${step}_start`] = actualStart;
            op[`${step}_end`] = actualEnd;
            op[`${step}_machine`] = m;
            
            isFirstJob[m] = false;
            machines[m] = actualEnd;
        };

        // 1. Turning - order is available immediately at SIM_START_HOUR
        assignMachine('lathe1', 'lathe2', 'turn', hrs.turn, SIM_START_HOUR);

        // 2. Hobbing - must start after turning ends
        assignMachine('hob1', 'hob2', 'hob', hrs.hob, op.turn_end);

        // 3. Grinding - must start after hobbing ends
        assignMachine('grind1', 'grind2', 'grind', hrs.grind, op.hob_end);

        // Completion time & penalty
        op.completionHour = op.grind_end;
        const lateHours = Math.max(0, op.completionHour - op.deadline);
        const lateDays = lateHours / 24;
        op.penaltyPerDay = op.revenue * op.penaltyRate;
        op.penaltyTotal = lateDays * op.penaltyPerDay;
        op.isLate = lateHours > 0;
        op.lateDays = lateDays;

        scheduled.push(op);
    }
    return { scheduled, machines };
}

// ====================================================================
// INSERTION EVALUATION with Local Search
// ====================================================================
function evaluateInsertion(newOrder) {
    // Baseline: current orders only
    const baseSim = simulateSchedule([...state.orders]);
    const basePenalty = baseSim.scheduled.reduce((s, o) => s + o.penaltyTotal, 0);
    const baseMakespan = baseSim.scheduled.reduce((m, o) => Math.max(m, o.completionHour), 0);

    // EDD sort with new order included
    const allOrders = [...state.orders, newOrder];
    allOrders.sort((a, b) => a.deadline - b.deadline);

    function calcScore(seq) {
        const sim = simulateSchedule(seq);
        let oldPenalty = 0;
        let newOrderResult = null;
        let makespan = 0;
        for (const o of sim.scheduled) {
            if (o.id === newOrder.id) newOrderResult = o;
            else oldPenalty += o.penaltyTotal;
            makespan = Math.max(makespan, o.completionHour);
        }
        const penaltyDiff = oldPenalty - basePenalty;
        const makespanDiff = makespan - baseMakespan;
        const netProfit = newOrderResult.revenue - penaltyDiff - newOrderResult.penaltyTotal;
        return { sim, netProfit, penaltyDiff, newOrderResult, oldPenalty, makespanDiff };
    }

    let bestSeq = [...allOrders];
    let bestResult = calcScore(bestSeq);

    // Local Search: iterative improvement with adjacent swaps
    let improved = true;
    let iter = 0;
    while (improved && iter < 15) {
        improved = false;
        iter++;
        for (let i = 0; i < bestSeq.length - 1; i++) {
            const trySeq = [...bestSeq];
            [trySeq[i], trySeq[i + 1]] = [trySeq[i + 1], trySeq[i]];
            const tryResult = calcScore(trySeq);
            if (tryResult.netProfit > bestResult.netProfit + 0.01) {
                bestResult = tryResult;
                bestSeq = trySeq;
                improved = true;
                break; // restart from beginning
            }
        }
    }

    return { baseSim, bestSim: bestResult.sim, bestSeq, bestScore: bestResult, basePenalty };
}

// 預設工單資料現在由後端資料庫在第一次啟動時建立（見 backend/seed.py），
// 前端不再需要（也看不到）任何寫死的種子資料。

// ====================================================================
// UI RENDERING
// ====================================================================

function switchView(viewId) {
    document.querySelectorAll('.view-container').forEach(v => {
        v.classList.add('hidden');
        v.classList.remove('active');
    });
    const el = document.getElementById(viewId);
    el.classList.remove('hidden');
    el.classList.add('active');
}

async function refreshDashboard() {
    try {
        await refreshOrdersAndLogs();
    } catch (err) {
        showToast(`讀取資料庫失敗：${err.message}`, 'error');
        return;
    }
    const sim = simulateSchedule(state.orders);
    renderMachineCards(sim);
    renderGanttChart('gantt-master-container', sim.scheduled, 30);
    renderOrderTable(sim.scheduled);
    renderLogs();
}

function refreshBackendLogs() {
    // Sync operation logs to backend page
    const lc = document.getElementById('log-container-backend');
    if (lc) {
        if (state.logs.length === 0) {
            lc.innerHTML = '<div class="log-empty">尚無操作紀錄</div>';
        } else {
            lc.innerHTML = state.logs.map(l => `
                <div class="log-item">
                    <span class="log-time">${l.time}</span>
                    <span class="log-user">[${l.user}]</span>
                    <span class="log-action">${l.action}: ${l.details}</span>
                </div>`).join('');
        }
    }
}

// --- Machine Cards ---
function renderMachineCards(sim) {
    const grid = document.getElementById('machine-grid');
    grid.innerHTML = '';
    const labels = {
        lathe1: 'Lathe-01 (車床)', lathe2: 'Lathe-02 (車床)',
        hob1: 'Hobbing-01 (滾齒)', hob2: 'Hobbing-02 (滾齒)',
        grind1: 'Grinding-01 (磨齒)', grind2: 'Grinding-02 (磨齒)'
    };
    for (const [key, name] of Object.entries(labels)) {
        const busy = sim.machines[key] > SIM_START_HOUR;
        const hrs = busy ? Math.round(sim.machines[key] - SIM_START_HOUR) : 0;
        grid.innerHTML += `
            <div class="machine-card">
                <div class="machine-icon ${busy ? 'active' : ''}"></div>
                <div class="machine-info">
                    <h4>${name}</h4>
                    <p>${busy ? `工作中 (已排產至第 ${hrs} 小時)` : '閒置'}</p>
                </div>
            </div>`;
    }
}

// --- Gantt Chart ---
function renderGanttChart(containerId, scheduled, daysScope, highlightId = null, affectedIds = null) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';

    const totalHours = daysScope * 24;
    const SCALE = Math.max(3, Math.floor((container.clientWidth - 110) / Math.min(totalHours, 360)));
    // Use at least 3px per hour

    const canvas = document.createElement('div');
    canvas.className = 'gantt-canvas';
    canvas.style.width = `${totalHours * SCALE + 110}px`;

    // Time axis header
    const headerRow = document.createElement('div');
    headerRow.className = 'gantt-row gantt-header-row';
    const headerLabel = document.createElement('div');
    headerLabel.className = 'gantt-machine-label';
    headerLabel.textContent = '機台';
    headerRow.appendChild(headerLabel);
    const headerTrack = document.createElement('div');
    headerTrack.className = 'gantt-track gantt-time-axis';
    // Add day markers (aligned to midnight)
    // SIM_START_HOUR is 8. The first midnight is hour 24.
    for (let d = 0; d <= daysScope; d++) {
        const midnightHour = Math.floor(SIM_START_HOUR / 24) * 24 + d * 24; // 0, 24, 48...
        const left = (midnightHour - SIM_START_HOUR) * SCALE;
        
        if (left >= 0 && left <= totalHours * SCALE) {
            const marker = document.createElement('div');
            marker.className = 'gantt-day-marker';
            marker.style.left = `${left}px`;
            marker.style.width = `0px`; // Use 0 width and overflow to let border act as the exact tick
            marker.style.borderLeft = '1px dashed #E2E8F0';
            
            const dateObj = new Date(EPOCH.getTime() + d * 24 * 3600 * 1000);
            const label = document.createElement('div');
            label.textContent = `${dateObj.getMonth() + 1}/${dateObj.getDate()}`;
            label.style.marginLeft = '4px';
            label.style.color = 'var(--text-muted)';
            marker.appendChild(label);
            
            headerTrack.appendChild(marker);
        }
    }
    headerRow.appendChild(headerTrack);
    canvas.appendChild(headerRow);

    const machineKeys = ['lathe1', 'lathe2', 'hob1', 'hob2', 'grind1', 'grind2'];
    const machineLabels = ['車床-01', '車床-02', '滾齒-01', '滾齒-02', '磨齒-01', '磨齒-02'];

    machineKeys.forEach((mk, idx) => {
        const row = document.createElement('div');
        row.className = 'gantt-row';

        const lbl = document.createElement('div');
        lbl.className = 'gantt-machine-label';
        lbl.textContent = machineLabels[idx];
        row.appendChild(lbl);

        const track = document.createElement('div');
        track.className = 'gantt-track';

        // Order blocks - each order has 3 stages, each on its own machine
        for (const o of scheduled) {
            const stages = [
                { machine: o.turn_machine, start: o.turn_start, end: o.turn_end, setupStart: o.turn_setup_start, setupEnd: o.turn_setup_end, color: 'bg-blue', name: '車床' },
                { machine: o.hob_machine, start: o.hob_start, end: o.hob_end, setupStart: o.hob_setup_start, setupEnd: o.hob_setup_end, color: 'bg-indigo', name: '滾齒' },
                { machine: o.grind_machine, start: o.grind_start, end: o.grind_end, setupStart: o.grind_setup_start, setupEnd: o.grind_setup_end, color: 'bg-green', name: '磨齒' },
            ];
            for (const st of stages) {
                if (st.machine !== mk) continue;
                
                // Draw Setup Block
                if (st.setupEnd > st.setupStart) {
                    const setupLeft = (st.setupStart - SIM_START_HOUR) * SCALE;
                    const setupWidth = Math.max((st.setupEnd - st.setupStart) * SCALE, 1);
                    const sBlock = document.createElement('div');
                    sBlock.className = 'gantt-block';
                    sBlock.style.left = `${setupLeft}px`;
                    sBlock.style.width = `${setupWidth}px`;
                    sBlock.style.background = 'repeating-linear-gradient(45deg, #e2e8f0, #e2e8f0 5px, #cbd5e1 5px, #cbd5e1 10px)';
                    sBlock.title = `${o.id} [${st.name}換線] ${st.setupEnd - st.setupStart}h`;
                    sBlock.style.zIndex = '1';
                    track.appendChild(sBlock);
                }

                const left = (st.start - SIM_START_HOUR) * SCALE;
                const width = Math.max((st.end - st.start) * SCALE, 2);

                const block = document.createElement('div');
                block.className = `gantt-block ${st.color}`;

                if (highlightId && o.id === highlightId) {
                    block.className = 'gantt-block bg-orange pulse';
                } else if (affectedIds && affectedIds.has(o.id)) {
                    block.classList.add('border-red');
                }

                block.style.left = `${left}px`;
                block.style.width = `${width}px`;
                block.style.zIndex = '3';
                block.textContent = o.id;
                block.title = `${o.id}\n工序: ${st.color === 'bg-blue' ? '車床' : st.color === 'bg-indigo' ? '滾齒' : '磨齒'}\n起: ${simHourToDisplay(st.start)}\n迄: ${simHourToDisplay(st.end)}`;
                track.appendChild(block);
            }
        }

        row.appendChild(track);
        canvas.appendChild(row);
    });

    container.appendChild(canvas);
}

// --- Order Table ---
function renderOrderTable(scheduled) {
    const tbody = document.getElementById('order-tbody');
    tbody.innerHTML = '';
    const isReadonly = currentUser && currentUser.role === 'Operator';

    // Sort by turn_start
    const sorted = [...scheduled].sort((a, b) => a.turn_start - b.turn_start);

    for (const o of sorted) {
        const hrs = calcHours(o.M, o.Z, o.b, o.qty);
        const totalH = hrs.turn + hrs.hob + hrs.grind;

        const tr = document.createElement('tr');
        tr.style.cursor = isReadonly ? 'default' : 'pointer';
        tr.innerHTML = `
            <td><strong>${o.id}</strong></td>
            <td>${o.type === 'custom' ? '自訂' : o.type}<br><small>M${o.M} Z${o.Z} b${o.b}</small></td>
            <td>${o.qty}</td>
            <td><div class="dual-time">${formatDualTime(totalH)}</div></td>
            <td>${simHourToDisplay(o.deadline)}</td>
            <td>${simHourToDisplay(o.completionHour)}</td>
            <td>${o.isLate
                ? `<span class="text-red">遲交 ${o.lateDays.toFixed(1)}天<br><small>罰 NT$${Math.round(o.penaltyTotal).toLocaleString()}</small></span>`
                : '<span class="text-blue">✓ 準時</span>'
            }</td>
            <td>
                ${isReadonly ? '<small class="text-muted">唯讀</small>' : `
                    <button class="btn btn-sm btn-outline btn-edit" data-id="${o.id}">編輯</button>
                    <button class="btn btn-sm btn-danger btn-del" data-id="${o.id}">🗑</button>
                `}
            </td>`;

        // Click row to edit (except delete button)
        if (!isReadonly) {
            tr.addEventListener('click', (e) => {
                if (e.target.classList.contains('btn-del')) return;
                openEditModal(o.id);
            });
        }

        tbody.appendChild(tr);
    }

    // Delete buttons
    document.querySelectorAll('.btn-del').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = e.target.getAttribute('data-id');
            showCustomModal('確認刪除', `確定要刪除工單 <strong>${id}</strong> 嗎？<br>機台產能將釋放並重新排程。`, async () => {
                try {
                    await apiFetch(`/api/orders/${encodeURIComponent(id)}`, { method: 'DELETE' });
                    await refreshDashboard();
                    showToast(`已刪除工單 ${id}，排程已重新計算`, 'success');
                } catch (err) {
                    showToast(`刪除失敗：${err.message}`, 'error');
                }
            });
        });
    });
}

// --- Logs ---
function renderLogs() {
    const lc = document.getElementById('log-container');
    if (!lc) return;
    if (state.logs.length === 0) {
        lc.innerHTML = '<div class="log-empty">尚無操作紀錄</div>';
        return;
    }
    lc.innerHTML = state.logs.map(l => `
        <div class="log-item">
            <span class="log-time">${l.time}</span>
            <span class="log-user">[${l.user}]</span>
            <span class="log-action">${l.action}: ${l.details}</span>
        </div>`).join('');
}

// ====================================================================
// CUSTOM MODAL
// ====================================================================
let _modalConfirmCb = null;

function showCustomModal(title, bodyHtml, onConfirm) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = bodyHtml;
    document.getElementById('modal-overlay').classList.remove('hidden');
    _modalConfirmCb = onConfirm;
}

function closeModal() {
    document.getElementById('modal-overlay').classList.add('hidden');
    _modalConfirmCb = null;
}

// ====================================================================
// EDIT ORDER MODAL
// ====================================================================
function openEditModal(orderId) {
    const order = state.orders.find(o => o.id === orderId);
    if (!order) return;

    const deadlineDate = simHourToDate(order.deadline);
    const dlStr = deadlineDate.toISOString().slice(0, 16);

    const bodyHtml = `
        <div class="form-group">
            <label>工單編號</label>
            <input type="text" value="${order.id}" disabled>
        </div>
        <div class="form-row">
            <div class="form-group"><label>模數 M</label><input type="number" id="edit-M" value="${order.M}" step="0.1"></div>
            <div class="form-group"><label>齒數 Z</label><input type="number" id="edit-Z" value="${order.Z}"></div>
        </div>
        <div class="form-row">
            <div class="form-group"><label>齒寬 b</label><input type="number" id="edit-b" value="${order.b}"></div>
            <div class="form-group"><label>數量 Qty</label><input type="number" id="edit-qty" value="${order.qty}"></div>
        </div>
        <div class="form-row">
            <div class="form-group"><label>金額 NTD</label><input type="number" id="edit-revenue" value="${order.revenue}"></div>
            <div class="form-group"><label>罰款率/日</label><input type="number" id="edit-penalty" value="${order.penaltyRate}" step="0.001"></div>
        </div>
        <div class="form-group">
            <label>期望交期</label>
            <input type="datetime-local" id="edit-deadline" value="${dlStr}">
        </div>`;

    showCustomModal(`編輯工單 ${order.id}`, bodyHtml, async () => {
        const updated = {
            M: parseFloat(document.getElementById('edit-M').value),
            Z: parseFloat(document.getElementById('edit-Z').value),
            b: parseFloat(document.getElementById('edit-b').value),
            qty: parseInt(document.getElementById('edit-qty').value),
            revenue: parseFloat(document.getElementById('edit-revenue').value),
            penaltyRate: parseFloat(document.getElementById('edit-penalty').value),
            deadline: dateStrToSimHour(document.getElementById('edit-deadline').value)
        };
        try {
            await apiFetch(`/api/orders/${encodeURIComponent(order.id)}`, {
                method: 'PUT',
                body: JSON.stringify(updated)
            });
            await refreshDashboard();
            showToast(`工單 ${order.id} 已更新，排程已重新優化`, 'success');
        } catch (err) {
            showToast(`更新失敗：${err.message}`, 'error');
        }
    });
}

// (新增工單已移除 — 所有新單必須透過插單評估流程寫入)

// ====================================================================
// EVALUATION VIEW
// ====================================================================
let currentEvalContext = null;

function setupEvalView() {
    const dlDefault = simHourToDate(SIM_START_HOUR + 7 * 24);
    document.getElementById('eval-deadline').value = dlDefault.toISOString().slice(0, 16);
    updateEvalCalc();

    // Reset AI panels from any previous evaluation session
    const dynPanel = document.getElementById('ai-dynamics-panel');
    if (dynPanel) { dynPanel.classList.add('hidden'); dynPanel.innerHTML = ''; }
    document.getElementById('ai-decision-container').classList.add('hidden');
    document.getElementById('ai-decision-report').classList.add('hidden');
    document.getElementById('ai-decision-report').innerHTML = '';
    document.getElementById('eval-decision-msg').classList.add('hidden');
}

function updateEvalCalc() {
    const M = parseFloat(document.getElementById('eval-M').value) || 0;
    const Z = parseFloat(document.getElementById('eval-Z').value) || 0;
    const b = parseFloat(document.getElementById('eval-b').value) || 0;
    const qty = parseFloat(document.getElementById('eval-qty').value) || 0;
    const hrs = calcHours(M, Z, b, qty);

    const setDual = (id, h) => {
        document.getElementById(id).innerHTML = `<span class="days">${(h / 20).toFixed(1)}天</span><br><span class="hours">${h.toFixed(1)}h</span>`;
    };
    setDual('time-turn', hrs.turn);
    setDual('time-hob', hrs.hob);
    setDual('time-grind', hrs.grind);

    // Calculate safe deadline (append at the end of the sequence to avoid delaying old orders)
    const newOrderMock = {
        id: 'MOCK', type: '自訂', M, Z, b, qty,
        deadline: 999999, revenue: 0, penaltyRate: 0
    };
    const seq = [...state.orders, newOrderMock];
    const sim = simulateSchedule(seq);
    const mockResult = sim.scheduled.find(o => o.id === 'MOCK');
    
    if (mockResult) {
        // Round up to the nearest minute to prevent datetime-local truncation from making it "late"
        const safeHour = Math.ceil(mockResult.completionHour * 60) / 60;
        const safeDate = simHourToDate(safeHour);
        document.getElementById('safe-deadline-text').textContent = simHourToDisplay(safeHour);
        
        window.applySuggestedDeadline = () => {
            const offset = safeDate.getTimezoneOffset() * 60000;
            const localISOTime = (new Date(safeDate.getTime() - offset)).toISOString().slice(0, 16);
            document.getElementById('eval-deadline').value = localISOTime;
        };
    }
}

async function runEvaluation() {
    const dStr = document.getElementById('eval-deadline').value;
    if (!dStr) return showToast('請選擇期望交期', 'error');

    const btnRunEval = document.getElementById('btn-run-eval');
    const originalBtnText = btnRunEval.textContent;
    btnRunEval.disabled = true;
    btnRunEval.textContent = '🤖 AI 讀取機台遙測，動態校正係數中...';

    // --- Step 1: auto-fetch machine telemetry & let the AI recompute dynamic coefficients ---
    let adjustment = null;
    let telemetryFailed = false;
    let telemetryErrMsg = '';
    try {
        adjustment = await runTelemetryAnalysis();
    } catch (err) {
        telemetryFailed = true;
        telemetryErrMsg = err.message;
        showToast(`⚠ AI 動態參數更新失敗，沿用基準係數繼續評估 (${err.message})`, 'error');
    }
    renderDynamicsPanel(adjustment, telemetryFailed, telemetryErrMsg);

    // --- Step 2: run the insertion simulation using the (possibly just-updated) currentDynamics ---
    const newOrder = {
        id: nextOrderId(),
        type: '自訂',
        M: parseFloat(document.getElementById('eval-M').value),
        Z: parseFloat(document.getElementById('eval-Z').value),
        b: parseFloat(document.getElementById('eval-b').value),
        qty: parseInt(document.getElementById('eval-qty').value),
        revenue: parseFloat(document.getElementById('eval-revenue').value),
        penaltyRate: parseFloat(document.getElementById('eval-penalty-rate').value),
        deadline: dateStrToSimHour(dStr)
    };

    const result = evaluateInsertion(newOrder);
    currentEvalContext = { result, newOrder, telemetryAdjustment: adjustment, telemetryFailed };

    // Update financial report
    const totalAddedPenalty = result.bestScore.penaltyDiff + result.bestScore.newOrderResult.penaltyTotal;
    const realProfit = newOrder.revenue - totalAddedPenalty;

    document.getElementById('rep-revenue').textContent = `NT$ ${newOrder.revenue.toLocaleString()}`;
    document.getElementById('rep-penalty').textContent = `NT$ ${Math.round(totalAddedPenalty).toLocaleString()}`;
    
    const netEl = document.getElementById('rep-net');
    netEl.textContent = `NT$ ${Math.round(realProfit).toLocaleString()}`;

    const msgEl = document.getElementById('eval-decision-msg');
    msgEl.classList.remove('hidden', 'error', 'success');
    
    document.getElementById('ai-decision-container').classList.remove('hidden');
    document.getElementById('ai-decision-report').classList.add('hidden');
    document.getElementById('ai-decision-report').innerHTML = '';
    document.getElementById('btn-ai-decision').textContent = '🤖 產出 AI 決策評估報告';

    const btnApply = document.getElementById('btn-apply-insert');
    const btnForce = document.getElementById('btn-manager-override');
    btnApply.classList.add('hidden');
    btnForce.classList.add('hidden');

    // Find affected old orders
    const affectedIds = new Set();
    for (const o of result.bestSim.scheduled) {
        if (o.id === newOrder.id) continue;
        const baseOrder = result.baseSim.scheduled.find(b => b.id === o.id);
        if (baseOrder && o.penaltyTotal > baseOrder.penaltyTotal + 0.01) {
            affectedIds.add(o.id);
        }
    }

    // Check for any delays: either the new order is late, or it caused old orders to be more late (affectedIds > 0)
    const newOrderLate = result.bestScore.newOrderResult.isLate;
    const causesDelay = newOrderLate || affectedIds.size > 0;

    if (causesDelay) {
        // Calculate safe deadline for recommendation
        const newOrderMock = {
            id: 'MOCK', type: '自訂', M: newOrder.M, Z: newOrder.Z, b: newOrder.b, qty: newOrder.qty,
            deadline: 999999, revenue: 0, penaltyRate: 0
        };
        const safeSim = simulateSchedule([...state.orders, newOrderMock]);
        const mockResult = safeSim.scheduled.find(o => o.id === 'MOCK');
        let safeDisplay = '計算中';
        if (mockResult) {
            const safeHour = Math.ceil(mockResult.completionHour * 60) / 60;
            safeDisplay = simHourToDisplay(safeHour);
        }

        netEl.className = 'value text-red';
        msgEl.classList.add('error');
        msgEl.textContent = `⚠ 評估失敗：此插單將導致交期延誤！` + 
            (newOrderLate ? ` (新單無法如期完工)` : ` (排擠並延誤現有舊單)`) +
            `\n💡 建議安全交期：${safeDisplay}`;
        
        if (currentUser.role === 'Manager') {
            btnForce.classList.remove('hidden');
            msgEl.textContent += '\n您具備主管權限，可強制寫入。';
        } else {
            msgEl.textContent += '\n請重新調整交期，或請主管強制覆核。';
        }
    } else {
        netEl.className = 'value text-blue';
        msgEl.classList.add('success');
        msgEl.textContent = `✓ 評估通過：排程無衝突，不會造成任何單據延遲。`;
        btnApply.classList.remove('hidden');
    }

    // Render dual gantt
    renderGanttChart('gantt-before', result.baseSim.scheduled, 15);
    renderGanttChart('gantt-after', result.bestSim.scheduled, 15, newOrder.id, affectedIds);

    btnRunEval.disabled = false;
    btnRunEval.textContent = originalBtnText;
}

async function applyEvalResult(isOverride) {
    if (!currentEvalContext) return;
    const { result, newOrder } = currentEvalContext;
    const sequence = result.bestSeq.map(o => o.id);

    try {
        await apiFetch('/api/orders/apply-insertion', {
            method: 'POST',
            body: JSON.stringify({
                new_order: {
                    id: newOrder.id, type: newOrder.type, M: newOrder.M, Z: newOrder.Z, b: newOrder.b,
                    qty: newOrder.qty, revenue: newOrder.revenue, penaltyRate: newOrder.penaltyRate,
                    deadline: newOrder.deadline
                },
                sequence,
                is_override: isOverride,
                net_profit: result.bestScore.netProfit
            })
        });
        showToast(`成功寫入工單 ${newOrder.id}`, 'success');
        currentEvalContext = null;
        switchView('view-dashboard');
        await refreshDashboard();
    } catch (err) {
        showToast(`寫入失敗：${err.message}`, 'error');
    }
}

// ====================================================================
// SESSION HANDLING
// ====================================================================
function applyLoggedInUI() {
    document.getElementById('current-user-info').textContent =
        `${currentUser.id} (${currentUser.name} / ${currentUser.role})`;
    if (currentUser.role === 'Operator') {
        document.getElementById('btn-nav-eval').classList.add('hidden');
    } else {
        document.getElementById('btn-nav-eval').classList.remove('hidden');
    }
}

// 重新整理頁面時，嘗試用 sessionStorage 裡的 token 向後端驗證身分是否仍然有效，
// 而不是直接信任前端存的使用者資訊（避免竄改 sessionStorage 冒充身分）。
async function tryRestoreSession() {
    const savedToken = sessionStorage.getItem('auth_token');
    if (!savedToken) {
        switchView('view-login');
        return;
    }
    authToken = savedToken;
    try {
        currentUser = await apiFetch('/api/auth/me');
        sessionStorage.setItem('auth_user', JSON.stringify(currentUser));
        applyLoggedInUI();
        switchView('view-dashboard');
        await refreshDashboard();
    } catch (err) {
        handleSessionExpired();
        switchView('view-login');
    }
}

// ====================================================================
// EVENT LISTENERS
// ====================================================================
document.addEventListener('DOMContentLoaded', () => {
    tryRestoreSession();

    // Login
    document.getElementById('btn-login').addEventListener('click', async () => {
        const empId = document.getElementById('login-emp-id').value.trim();
        const pwd = document.getElementById('login-password').value;
        if (!empId || !pwd) return showToast('請輸入員工編號與密碼', 'error');

        const btn = document.getElementById('btn-login');
        btn.disabled = true;
        try {
            const data = await apiFetch('/api/auth/login', {
                method: 'POST',
                body: JSON.stringify({ emp_id: empId, password: pwd })
            });
            authToken = data.access_token;
            currentUser = data.user; // { id, name, role } — 密碼與雜湊從未回傳給前端
            sessionStorage.setItem('auth_token', authToken);
            sessionStorage.setItem('auth_user', JSON.stringify(currentUser));

            applyLoggedInUI();
            switchView('view-dashboard');
            await refreshDashboard();
        } catch (err) {
            showToast(err.message || '登入失敗', 'error');
        } finally {
            btn.disabled = false;
        }
    });

    // Logout
    document.getElementById('btn-logout').addEventListener('click', async () => {
        try {
            await apiFetch('/api/auth/logout', { method: 'POST' });
        } catch (err) {
            // 即使登出紀錄寫入失敗，仍讓使用者可以離開系統
        }
        handleSessionExpired();
        switchView('view-login');
    });

    // Nav to evaluation
    document.getElementById('btn-nav-eval').addEventListener('click', () => {
        if (currentUser.role === 'Operator') return showToast('領班僅具備唯讀權限', 'error');
        switchView('view-evaluation');
        setupEvalView();
    });

    // Back to dashboard / Cancel Insertion
    const goDashboard = () => {
        currentEvalContext = null;
        switchView('view-dashboard');
        refreshDashboard();
    };
    document.getElementById('btn-back-dashboard').addEventListener('click', goDashboard);
    document.getElementById('btn-cancel-insert').addEventListener('click', goDashboard);

    // Nav to backend management
    const goBackend = () => {
        switchView('view-backend');
        const infoEl = document.getElementById('backend-user-info');
        if (infoEl) infoEl.textContent = `${currentUser.id} (${currentUser.name})`;
        refreshBackendLogs();
    };
    document.getElementById('btn-nav-backend').addEventListener('click', goBackend);
    document.getElementById('btn-back-from-backend').addEventListener('click', () => {
        switchView('view-dashboard');
        refreshDashboard();
    });
    if (document.getElementById('btn-nav-eval-from-backend')) {
        document.getElementById('btn-nav-eval-from-backend').addEventListener('click', () => {
            if (currentUser.role === 'Operator') return showToast('領班僅具備唯讀權限', 'error');
            switchView('view-evaluation');
            setupEvalView();
        });
    }

    // (新增工單按鈕已移除 — 所有新單必須透過插單評估)

    // Auto-calculate logic on input change
    ['eval-M', 'eval-Z', 'eval-b', 'eval-qty'].forEach(id => {
        document.getElementById(id).addEventListener('input', updateEvalCalc);
    });

    document.getElementById('btn-apply-safe-date').addEventListener('click', () => {
        if (window.applySuggestedDeadline) window.applySuggestedDeadline();
    });

    // Run evaluation
    document.getElementById('btn-run-eval').addEventListener('click', runEvaluation);

    // Apply buttons
    document.getElementById('btn-apply-insert').addEventListener('click', () => applyEvalResult(false));
    document.getElementById('btn-manager-override').addEventListener('click', () => applyEvalResult(true));

    // Settings Modal (now configures the backend proxy URL, not an API key)
    const settingsModal = document.getElementById('settings-modal');
    if (document.getElementById('btn-settings')) {
        document.getElementById('btn-settings').addEventListener('click', () => {
            document.getElementById('input-backend-url').value = localStorage.getItem('backend_url') || '';
            settingsModal.classList.remove('hidden');
        });
    }
    if (document.getElementById('btn-close-settings')) {
        document.getElementById('btn-close-settings').addEventListener('click', () => {
            settingsModal.classList.add('hidden');
        });
    }
    if (document.getElementById('btn-save-settings')) {
        document.getElementById('btn-save-settings').addEventListener('click', () => {
            const val = document.getElementById('input-backend-url').value.trim();
            localStorage.setItem('backend_url', val);
            settingsModal.classList.add('hidden');
            showToast('後端服務網址已儲存', 'success');
        });
    }

    // AI Decision Report — auto-includes the telemetry adjustment from the evaluation step,
    // with a progressive step-by-step loading indicator while Gemini writes the report.
    const btnAiDecision = document.getElementById('btn-ai-decision');
    if (btnAiDecision) {
        btnAiDecision.addEventListener('click', async () => {
            if (!currentEvalContext) return;
            const btn = btnAiDecision;
            const resultEl = document.getElementById('ai-decision-report');

            btn.disabled = true;
            btn.textContent = '🤖 AI 決策報告深度編寫中...';
            resultEl.classList.remove('hidden');

            // Progressive loading indicator so the person can see the report is actively being built
            const loadingSteps = [
                '🔍 正在讀取甘特圖排程與產線瓶頸數據...',
                '⚡ AI 正在計算衝突工單與產能偏移量...',
                '⚙️ 結合機台劣化狀態，動態微調生產物理係數...',
                '📈 正在編寫生管調度應變方案與最終決策報告...'
            ];
            let stepIdx = 0;
            renderReportLoading(resultEl, loadingSteps, stepIdx);
            const stepTimer = setInterval(() => {
                stepIdx = Math.min(stepIdx + 1, loadingSteps.length - 1);
                renderReportLoading(resultEl, loadingSteps, stepIdx);
            }, 1800);

            // Build the JSON payload
            const { result, newOrder, telemetryAdjustment, telemetryFailed } = currentEvalContext;
            const b = result.bestScore;
            
            const affectedOrders = [];
            for (const o of result.bestSim.scheduled) {
                if (o.id === newOrder.id) continue;
                const baseOrder = result.baseSim.scheduled.find(base => base.id === o.id);
                if (baseOrder && o.penaltyTotal > baseOrder.penaltyTotal + 0.01) {
                    affectedOrders.push({
                        id: o.id,
                        original_late_days: Math.round(baseOrder.lateDays * 10) / 10,
                        new_late_days: Math.round(o.lateDays * 10) / 10,
                        penalty_increase: Math.round(o.penaltyTotal - baseOrder.penaltyTotal)
                    });
                }
            }
            
            const bottleneckAnalysis = {
                congested_process: affectedOrders.length > 0 ? "混合製程排擠" : "無明顯推擠",
                congested_machine: "受影響機台",
                queue_hours_increase: Math.round(result.bestScore.makespanDiff)
            };

            // Merge the AI telemetry adjustment (from the automated Step 1) into the same payload
            const telemetryPayload = (telemetryAdjustment && !telemetryFailed) ? {
                status: "adjusted",
                explanation: telemetryAdjustment.explanation,
                base_setup_hrs: telemetryAdjustment.before.setup_hrs,
                adjusted_setup_hrs: telemetryAdjustment.after.setup_hrs,
                base_coefficients: telemetryAdjustment.before.coefficients,
                adjusted_coefficients: telemetryAdjustment.after.coefficients
            } : {
                status: "unavailable",
                explanation: "本次評估未能取得 AI 機台遙測動態分析結果，已沿用出廠基準係數進行排程試算。",
                base_setup_hrs: BASE_DYNAMICS.setup_hrs,
                adjusted_setup_hrs: BASE_DYNAMICS.setup_hrs,
                base_coefficients: BASE_DYNAMICS.coefficients,
                adjusted_coefficients: BASE_DYNAMICS.coefficients
            };
            
            const evalJson = {
                new_order: {
                    id: newOrder.id,
                    specs: `M${newOrder.M} Z${newOrder.Z} b${newOrder.b} Qty ${newOrder.qty}`,
                    revenue: newOrder.revenue,
                    deadline_display: simHourToDisplay(newOrder.deadline)
                },
                evaluation_metrics: {
                    original_penalty: Math.round(result.basePenalty),
                    new_total_penalty_after_insert: Math.round(b.oldPenalty + b.newOrderResult.penaltyTotal),
                    penalty_diff_due_to_squeeze: Math.round(b.penaltyDiff),
                    new_order_own_penalty: Math.round(b.newOrderResult.penaltyTotal),
                    net_profit: Math.round(newOrder.revenue - (b.penaltyDiff + b.newOrderResult.penaltyTotal)),
                    makespan_increase_hours: Math.round(b.makespanDiff)
                },
                affected_orders: affectedOrders,
                bottleneck_analysis: bottleneckAnalysis,
                suggested_safe_deadline: document.getElementById('safe-deadline-text').textContent,
                telemetry_adjustment: telemetryPayload
            };

            // 報告的系統提示字串（Prompt）與 Gemini API Key 都只存在後端，
            // 前端只送出結構化的評估數據 JSON。
            try {
                const markdownText = await generateReportOnServer(evalJson);
                clearInterval(stepTimer);
                resultEl.innerHTML = renderMarkdownReport(markdownText);
                btn.textContent = '🤖 重新生成 AI 決策報告';
            } catch (err) {
                clearInterval(stepTimer);
                resultEl.innerHTML = `
                    <div class="ai-alert-box alert-danger">
                        <div class="ai-alert-icon">❌</div>
                        <div class="ai-alert-content">
                            <div class="ai-alert-title">報告生成失敗</div>
                            <div class="ai-alert-text">${err.message}</div>
                        </div>
                    </div>`;
                btn.textContent = '🤖 產出 AI 決策評估報告';
            } finally {
                btn.disabled = false;
            }
        });
    }

    // Modal buttons
    document.getElementById('modal-btn-cancel').addEventListener('click', closeModal);
    document.getElementById('modal-btn-confirm').addEventListener('click', () => {
        if (_modalConfirmCb) _modalConfirmCb();
        closeModal();
    });
});
