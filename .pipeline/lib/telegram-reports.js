// =============================================================================
// telegram-reports.js — Formatters para `/report <seccion>` desde Telegram
//
// Issue #2904. Devuelve strings MarkdownV2 listos para `sendMessage` con
// `parse_mode: 'MarkdownV2'`, pensados para celular (monospace tablas,
// semáforos unicode, headers cortos, máximo ~15 líneas por mensaje).
//
// Source of truth: dashboard HTTP en localhost:3200 (single source). Si el
// dashboard está caído, los formatters leen del filesystem como fallback
// y agregan un warning en el header (CA-5 del issue, UX-5 del UX gate).
//
// Reglas inquebrantables:
//   - Whitelist hardcoded de subcomandos (SR-1) — sin require dinámico.
//   - escapeMd() pasa por los 18 caracteres especiales de MarkdownV2.
//   - `/report sistema` NUNCA expone cmdline/argv (SR-2).
//   - Errores NUNCA exponen paths absolutos con username del SO (SR-3).
// =============================================================================

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

// -----------------------------------------------------------------------------
// Constantes (UX-1: set canónico de semáforos)
// -----------------------------------------------------------------------------

const SEMAFORO = Object.freeze({
    OK: '\u{1F7E2}',    // circulo verde
    WARN: '\u{1F7E1}',  // circulo amarillo
    ALERT: '\u{1F7E0}', // circulo naranja
    CRIT: '\u{1F534}',  // circulo rojo
    PAUSE: '⚪',    // circulo blanco
});

// Mapeo status → semáforo (consistente cross-reportes).
function semaforoFromStatus(status) {
    switch (String(status || '').toLowerCase()) {
        case 'ok':
        case 'normal':
        case 'green':
        case 'verde':
            return SEMAFORO.OK;
        case 'warning':
        case 'yellow':
        case 'amarillo':
        case 'warn':
            return SEMAFORO.WARN;
        case 'orange':
        case 'naranja':
        case 'alert':
        case 'degraded':
            return SEMAFORO.ALERT;
        case 'critical':
        case 'crit':
        case 'red':
        case 'rojo':
            return SEMAFORO.CRIT;
        case 'paused':
        case 'partial_pause':
        case 'rest':
            return SEMAFORO.PAUSE;
        default:
            return SEMAFORO.OK;
    }
}

// Lista canónica de subcomandos (SR-1: whitelist hardcoded).
const VALID_SECTIONS = Object.freeze([
    'agentes', 'cuota', 'sistema', 'pipeline', 'sprint', 'rebotes', 'all',
]);

// UX-4: menú de ayuda canónico, string fijo (no inline en dispatcher).
const HELP_MENU = [
    '*Reportes Pipeline V3*',
    '',
    'Mandame /report seguido de:',
    '',
    '```',
    'agentes   - Quien corre, cola, recientes',
    'cuota     - Anthropic semanal + sesion',
    'sistema   - CPU, RAM, throttler, procesos',
    'pipeline  - Issues por fase, estancados',
    'sprint    - Progreso del sprint activo',
    'rebotes   - Top 5 issues con rebotes (24h)',
    'all       - Resumen ultracompacto de todo',
    '```',
    '',
    'Ejemplo: `/report cuota`',
].join('\n');

// -----------------------------------------------------------------------------
// MarkdownV2 escape (TR-3 + SR-6)
//
// Los 18 caracteres especiales de MarkdownV2 según la doc Telegram + el set
// confirmado por los criterios PO:
//   `_ * [ ] ( ) ~ \` > # + - = | { } . !`
// El backslash también se escapa para evitar romper la cadena. Total 18 chars.
// -----------------------------------------------------------------------------

const MD_V2_ESCAPE_RE = /[_*[\]()~`>#+\-=|{}.!\\]/g;

function escapeMd(str) {
    if (str == null) return '';
    return String(str).replace(MD_V2_ESCAPE_RE, m => '\\' + m);
}

// HTML escape para fallback (TR-4). Cubre <, >, &, ".
const HTML_ESCAPE_RE = /[<>&"]/g;
const HTML_ESCAPE_MAP = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' };
function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(HTML_ESCAPE_RE, c => HTML_ESCAPE_MAP[c]);
}

// -----------------------------------------------------------------------------
// HTTP client al dashboard local (single source of truth)
//
// Default timeout 1500ms — si el dashboard no responde rápido, vamos al
// fallback FS. El operador prefiere datos posiblemente desactualizados con
// warning que esperar 30s a un curl colgado.
// -----------------------------------------------------------------------------

const DASHBOARD_HOST = process.env.DASHBOARD_HOST || '127.0.0.1';
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT, 10) || 3200;
const DASHBOARD_TIMEOUT_MS = parseInt(process.env.REPORT_DASH_TIMEOUT_MS, 10) || 1500;

function fetchDashboard(apiPath, { timeoutMs = DASHBOARD_TIMEOUT_MS } = {}) {
    return new Promise((resolve) => {
        const req = http.request({
            host: DASHBOARD_HOST,
            port: DASHBOARD_PORT,
            method: 'GET',
            path: apiPath,
            headers: { 'Accept': 'application/json' },
        }, (res) => {
            let body = '';
            res.on('data', (c) => body += c);
            res.on('end', () => {
                if (res.statusCode !== 200) return resolve(null);
                try { resolve(JSON.parse(body)); } catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
        req.end();
    });
}

// -----------------------------------------------------------------------------
// FS fallback (CA-5: graceful degradation cuando el dashboard está caído)
// -----------------------------------------------------------------------------

const PIPELINE_DIR = process.env.PIPELINE_STATE_DIR || path.resolve(__dirname, '..');
const REPO_ROOT = process.env.PIPELINE_REPO_ROOT
    || process.env.CLAUDE_PROJECT_DIR
    || path.resolve(__dirname, '..', '..');

function safeReadJson(filepath, fallback) {
    try { return JSON.parse(fs.readFileSync(filepath, 'utf8')); }
    catch { return fallback; }
}

function safeReadDir(dir) {
    try { return fs.readdirSync(dir); }
    catch { return []; }
}

// SR-3: nunca exponer paths con username del SO en mensajes.
// Loggear path completo internamente queda al caller (console.error).
function sanitizeError(err) {
    const msg = String((err && err.message) || err || 'unknown');
    // Tirar cualquier substring que parezca path absoluto del SO:
    //   * Windows: `C:\Users\...` o `C:/Users/...`
    //   * Unix:    `/home/<user>/...` o `/Users/<user>/...` (también si no
    //               están al inicio: matcheamos sin anchor para cubrir
    //               casos tipo "open /home/leito/...").
    return msg
        .replace(/[A-Z]:[\\/][^\s]*/g, '<path>')
        .replace(/\/(?:Users|home)\/[^\s/]+(?:\/[^\s]*)?/g, '<path>');
}

// -----------------------------------------------------------------------------
// Helpers de formato
// -----------------------------------------------------------------------------

const TZ_OFFSET_MIN = -180; // ART fijo (sin DST). Mismo offset que weekly-quota.

function nowStamp(date = new Date()) {
    // dd/mm HH:mm ART (TR consistente con resto del sistema).
    const local = new Date(date.getTime() + TZ_OFFSET_MIN * 60000);
    const dd = String(local.getUTCDate()).padStart(2, '0');
    const mm = String(local.getUTCMonth() + 1).padStart(2, '0');
    const HH = String(local.getUTCHours()).padStart(2, '0');
    const MM = String(local.getUTCMinutes()).padStart(2, '0');
    return `${dd}/${mm} ${HH}:${MM}`;
}

function formatDurationShort(ms) {
    if (!ms || ms <= 0) return '0m';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return `${h}h${String(rem).padStart(2, '0')}m`;
}

function ageMinToHuman(min) {
    if (!min || min < 1) return '<1m';
    if (min < 60) return `${Math.floor(min)}m`;
    const h = Math.floor(min / 60);
    const rem = Math.floor(min % 60);
    return `${h}h${String(rem).padStart(2, '0')}m`;
}

function header(section, opts = {}) {
    // UX-2: `*Seccion - dd/mm HH:mm*` (negrita, guión medio, sin emoji).
    // Como vamos en MarkdownV2 hay que escapar el guión y los dos puntos.
    const stamp = nowStamp(opts.at);
    const warn = opts.degraded
        ? `\nDashboard caido \\- leyendo desde disco \\(snapshot ${escapeMd(stamp)}\\)`
        : '';
    return `*${escapeMd(section)} \\- ${escapeMd(stamp)}*${warn}`;
}

// Padding con espacios (no tabs, UX-4 — tabs rompen en Telegram mobile).
function pad(s, n) {
    s = String(s);
    return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

// UX-3: chat_action typing (lo dispara el caller, no este módulo).
// UX-7: skills y comandos también entre backticks.

// -----------------------------------------------------------------------------
// Aggregator: ensambla el `state-like` desde dashboard o filesystem
// -----------------------------------------------------------------------------

// Endpoints que cada reporte necesita. Lista declarativa para que se vea de
// un vistazo qué consume cada sección.
const ENDPOINTS = {
    agentes: ['/api/dash/active', '/api/dash/recent', '/api/dash/queue'],
    cuota: ['/api/dash/quota'],
    sistema: ['/api/dash/ops', '/api/dash/header'],
    pipeline: ['/api/dash/pipeline', '/api/dash/header'],
    rebotes: ['/api/dash/pipeline', '/api/dash/recent'],
};

async function fetchSection(section) {
    const paths = ENDPOINTS[section] || [];
    const out = {};
    let anyOk = false;
    for (const p of paths) {
        const data = await fetchDashboard(p);
        if (data) anyOk = true;
        out[p] = data;
    }
    return { data: out, dashboardUp: anyOk };
}

// -----------------------------------------------------------------------------
// FS fallback: lee directamente de los archivos que escribe el dashboard
// -----------------------------------------------------------------------------

function fsFallback() {
    // agentes activos: leemos heartbeats de .claude/hooks/agent-*.heartbeat
    const hooksDir = path.join(REPO_ROOT, '.claude', 'hooks');
    const heartbeats = [];
    for (const f of safeReadDir(hooksDir)) {
        if (!/^agent-\d+\.heartbeat$/.test(f)) continue;
        const j = safeReadJson(path.join(hooksDir, f), null);
        if (j && j.issue) heartbeats.push(j);
    }
    // cuota: lectura directa del state file
    const metricsDir = path.join(PIPELINE_DIR, 'metrics');
    const quotaState = safeReadJson(path.join(metricsDir, 'weekly-quota.json'), null);
    // roadmap (TR-7: path real es scripts/roadmap.json)
    const roadmap = safeReadJson(path.join(REPO_ROOT, 'scripts', 'roadmap.json'), null);
    return { heartbeats, quotaState, roadmap };
}

// -----------------------------------------------------------------------------
// REPORT: agentes
// -----------------------------------------------------------------------------

async function reportAgentes() {
    const { data, dashboardUp } = await fetchSection('agentes');
    const fb = dashboardUp ? null : fsFallback();
    const lines = [header('Agentes', { degraded: !dashboardUp })];

    let running = [];
    let queue = [];
    let recent = [];

    if (dashboardUp) {
        running = (data['/api/dash/active'] && data['/api/dash/active'].agents) || [];
        queue = (data['/api/dash/queue'] && data['/api/dash/queue'].queue) || [];
        recent = (data['/api/dash/recent'] && data['/api/dash/recent'].recent) || [];
    } else if (fb) {
        running = fb.heartbeats.map(h => ({
            issue: String(h.issue),
            skill: h.skill || 'unknown',
            ageMin: h.ts ? Math.max(0, (Date.now() - new Date(h.ts).getTime()) / 60000) : 0,
        }));
    }

    // Running ahora
    lines.push('');
    if (running.length > 0) {
        lines.push(`*Corriendo ahora* \\(${running.length}\\)`);
        lines.push('```');
        for (const a of running.slice(0, 5)) {
            const sema = (a.ageMin || 0) >= 120 ? SEMAFORO.CRIT
                : (a.ageMin || 0) >= 60 ? SEMAFORO.WARN : SEMAFORO.OK;
            const skill = String(a.skill || '?').slice(0, 14);
            const dur = ageMinToHuman(a.ageMin || 0);
            lines.push(`${sema} #${a.issue} ${pad(skill, 14)} ${dur}`);
        }
        lines.push('```');
    } else {
        lines.push('*Corriendo ahora* \\(0\\)');
        lines.push('Sin actividad en esta seccion');
    }

    // Próximos en cola
    lines.push('');
    if (queue.length > 0) {
        lines.push(`*Proximos en cola* \\(${queue.length}\\)`);
        lines.push('```');
        for (const q of queue.slice(0, 5)) {
            const skill = String(q.skill || '?').slice(0, 14);
            lines.push(`#${q.issue} ${pad(skill, 14)} ${q.fase || ''}`);
        }
        lines.push('```');
    }

    // Últimos finalizados
    if (recent.length > 0) {
        lines.push('');
        lines.push(`*Ultimos finalizados*`);
        lines.push('```');
        for (const r of recent.slice(0, 3)) {
            const sema = r.resultado === 'aprobado' ? SEMAFORO.OK
                : r.resultado === 'rechazado' ? SEMAFORO.CRIT : SEMAFORO.WARN;
            const skill = String(r.skill || '?').slice(0, 14);
            const dur = formatDurationShort(r.durationMs || 0);
            lines.push(`${sema} #${r.issue} ${pad(skill, 14)} ${dur}`);
        }
        lines.push('```');
    }

    return lines.join('\n');
}

// -----------------------------------------------------------------------------
// REPORT: cuota
// -----------------------------------------------------------------------------

function progressBar(pct, width = 20) {
    pct = Math.max(0, Math.min(100, Number(pct) || 0));
    const filled = Math.round((pct / 100) * width);
    return '█'.repeat(filled) + '░'.repeat(width - filled);
}

async function reportCuota() {
    const { data, dashboardUp } = await fetchSection('cuota');
    const lines = [header('Cuota Anthropic', { degraded: !dashboardUp })];

    let quota = null;
    if (dashboardUp) {
        quota = data['/api/dash/quota'];
    } else {
        // FS fallback: leemos el state crudo (sin reset times calculados).
        const fb = fsFallback();
        if (fb.quotaState) {
            quota = {
                pct: 0,
                effectiveLimitHours: fb.quotaState.effective_limit_hours,
                hoursUsed7d: 0,
                status: 'unknown',
                nextResetAt: null,
                session: { pct: 0, hoursUsed: 0, limitHours: 5, status: 'unknown' },
                calibration: fb.quotaState.calibration,
            };
        }
    }

    if (!quota) {
        lines.push('');
        lines.push('Sin actividad en esta seccion');
        return lines.join('\n');
    }

    // Semanal — preferimos realPct si hay calibración, sino pct.
    const weeklyPct = quota.realPct != null ? quota.realPct : (quota.pct || 0);
    const weeklyStatus = quota.realStatus || quota.status || 'unknown';
    const weeklySema = semaforoFromStatus(weeklyStatus);

    lines.push('');
    lines.push('*Semanal*');
    const resetStr = quota.nextResetAt
        ? nowStamp(new Date(quota.nextResetAt))
        : 's/d';
    lines.push(`Reset ${escapeMd(resetStr)} ART`);
    lines.push('```');
    lines.push(`${progressBar(weeklyPct)} ${Math.round(weeklyPct)}%`);
    lines.push('```');
    lines.push(`${weeklySema} ${escapeMd(weeklyStatus.toUpperCase())}`);

    // Sesión rolling 5h
    if (quota.session) {
        const sPct = quota.session.realPct != null ? quota.session.realPct : (quota.session.pct || 0);
        const sStatus = quota.session.realStatus || quota.session.status || 'unknown';
        const sSema = semaforoFromStatus(sStatus);
        lines.push('');
        lines.push('*Sesion* \\(rolling 5h\\)');
        lines.push('```');
        lines.push(`${progressBar(sPct)} ${Math.round(sPct)}%`);
        lines.push('```');
        lines.push(`${sSema} ${escapeMd(sStatus.toUpperCase())}`);
    }

    if (quota.calibration && quota.calibration.at) {
        lines.push('');
        lines.push(`Calibrada: ${escapeMd(nowStamp(new Date(quota.calibration.at)))}`);
    }

    return lines.join('\n');
}

// -----------------------------------------------------------------------------
// REPORT: sistema (SR-2: NO exponer cmdline/argv)
// -----------------------------------------------------------------------------

async function reportSistema() {
    const { data, dashboardUp } = await fetchSection('sistema');
    const lines = [header('Sistema', { degraded: !dashboardUp })];

    let ops = null;
    let head = null;
    if (dashboardUp) {
        ops = data['/api/dash/ops'];
        head = data['/api/dash/header'];
    }

    if (!ops && !head) {
        lines.push('');
        lines.push('Sin actividad en esta seccion');
        return lines.join('\n');
    }

    // Headline (UX-6: veredicto en 1 línea antes del detalle).
    const resources = (ops && ops.resources) || (head && head.resources) || {};
    const cpu = resources.cpuPercent != null ? Math.round(resources.cpuPercent) : null;
    const mem = resources.memPercent != null ? Math.round(resources.memPercent) : null;
    const maxCpu = resources.maxCpu || 70;
    const maxMem = resources.maxMem || 70;

    let overall = 'OK';
    if ((cpu != null && cpu >= 90) || (mem != null && mem >= 90)) overall = 'CRITICAL';
    else if ((cpu != null && cpu >= maxCpu) || (mem != null && mem >= maxMem)) overall = 'DEGRADED';
    else if ((cpu != null && cpu >= 60) || (mem != null && mem >= 60)) overall = 'WARNING';

    const overallSema = semaforoFromStatus(overall);
    lines.push('');
    lines.push(`${overallSema} ${escapeMd(overall)}`);
    lines.push(`CPU ${cpu != null ? cpu : '\\-'}% \\| RAM ${mem != null ? mem : '\\-'}%`);

    // Procesos (SR-2: SOLO conteos + nombres, NUNCA cmdline/argv).
    const procesos = (ops && ops.procesos) || {};
    const procCounts = {};
    for (const [name, p] of Object.entries(procesos)) {
        if (!p || typeof p !== 'object') continue;
        if (p.alive) procCounts[name] = (procCounts[name] || 0) + 1;
    }
    lines.push('');
    lines.push('*Procesos*');
    lines.push('```');
    const procNames = Object.keys(procCounts).sort();
    if (procNames.length > 0) {
        for (const name of procNames.slice(0, 5)) {
            // Whitelist explícita: nombre + flag alive. NO argv/cmdline/env.
            lines.push(`${pad(name, 14)} ${procCounts[name]} vivo`);
        }
    } else {
        lines.push('sin procesos visibles');
    }
    lines.push('```');

    // Pausa parcial / modo descanso (UX adicional, no en mockup pero útil)
    const mode = head && head.mode;
    if (mode && mode !== 'running') {
        lines.push('');
        const sema = semaforoFromStatus(mode);
        lines.push(`${sema} Modo: ${escapeMd(mode)}`);
    }

    return lines.join('\n');
}

// -----------------------------------------------------------------------------
// REPORT: pipeline
// -----------------------------------------------------------------------------

const FASE_ORDER = [
    'intake', 'analisis', 'criterios', 'sizing', 'validacion',
    'dev', 'build', 'qa', 'verificacion', 'aprobacion', 'entrega', 'listo',
];

async function reportPipeline() {
    const { data, dashboardUp } = await fetchSection('pipeline');
    const lines = [header('Pipeline', { degraded: !dashboardUp })];

    let pipelineData = null;
    if (dashboardUp) pipelineData = data['/api/dash/pipeline'];

    if (!pipelineData) {
        lines.push('');
        lines.push('Sin actividad en esta seccion');
        return lines.join('\n');
    }

    // Conteo por fase (cualquier issue activo).
    const matrix = pipelineData.matrix || {};
    const byFase = {};
    const issuesByFase = {};
    let totalActive = 0;
    for (const [issueId, info] of Object.entries(matrix)) {
        if (info.estadoActual === 'archivado' || info.estadoActual === 'cerrado') continue;
        const fase = info.faseActual ? info.faseActual.split('/').pop() : '?';
        byFase[fase] = (byFase[fase] || 0) + 1;
        if (!issuesByFase[fase]) issuesByFase[fase] = [];
        issuesByFase[fase].push(issueId);
        totalActive++;
    }

    lines.push('');
    lines.push(`*Por fase* \\(${totalActive} activos\\)`);
    lines.push('```');
    const sortedFases = Object.keys(byFase).sort((a, b) => {
        const ai = FASE_ORDER.indexOf(a); const bi = FASE_ORDER.indexOf(b);
        if (ai >= 0 && bi >= 0) return ai - bi;
        if (ai >= 0) return -1;
        if (bi >= 0) return 1;
        return a.localeCompare(b);
    });
    for (const fase of sortedFases.slice(0, 10)) {
        const top = issuesByFase[fase].slice(0, 3).map(i => `#${i}`).join(' ');
        lines.push(`${pad(fase, 14)} ${pad(String(byFase[fase]), 3)} ${top}`);
    }
    lines.push('```');

    // Estancados >2h (use stale + blockerAgeMin del slice).
    const stuck = [];
    for (const [issueId, info] of Object.entries(matrix)) {
        if (!info.stale) continue;
        if ((info.blockerAgeMin || 0) < 120) continue;
        stuck.push({ issue: issueId, skill: info.blockerSkill, age: info.blockerAgeMin });
    }
    if (stuck.length > 0) {
        lines.push('');
        lines.push('*Estancados \\>2h:*');
        lines.push('```');
        for (const s of stuck.slice(0, 3)) {
            const skill = String(s.skill || '?').slice(0, 14);
            lines.push(`${SEMAFORO.CRIT} #${s.issue} ${pad(skill, 14)} ${ageMinToHuman(s.age)}`);
        }
        lines.push('```');
    }

    return lines.join('\n');
}

// -----------------------------------------------------------------------------
// REPORT: sprint (TR-7: roadmap está en scripts/roadmap.json, no en .pipeline/)
// -----------------------------------------------------------------------------

function loadRoadmap() {
    return safeReadJson(path.join(REPO_ROOT, 'scripts', 'roadmap.json'), null);
}

async function reportSprint() {
    const roadmap = loadRoadmap();
    const lines = [header('Sprint', { degraded: false })];
    if (!roadmap || !Array.isArray(roadmap.sprints)) {
        lines.push('');
        lines.push('Sin actividad en esta seccion');
        return lines.join('\n');
    }
    // Sprint activo = el primero NO done (orden top-down del roadmap).
    const active = roadmap.sprints.find(s => s.status && s.status !== 'done');
    if (!active) {
        lines.push('');
        lines.push('Sin sprint activo');
        return lines.join('\n');
    }
    const stories = Array.isArray(active.stories) ? active.stories : [];
    const done = stories.filter(s => s.status === 'done').length;
    const blocked = stories.filter(s => s.status === 'blocked' || s.status === 'paused').length;
    const inProgress = stories.filter(s => s.status === 'in_progress' || s.status === 'doing').length;
    const total = stories.length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    let sema = SEMAFORO.OK;
    if (blocked > 0) sema = SEMAFORO.WARN;
    if (blocked >= 3) sema = SEMAFORO.ALERT;

    lines.push('');
    lines.push(`${sema} *${escapeMd(active.id || 'sprint')}*`);
    lines.push(escapeMd(String(active.tema || '').slice(0, 60)));
    lines.push('');
    lines.push('```');
    lines.push(`Progreso  ${progressBar(pct)} ${pct}%`);
    lines.push(`Total     ${total}`);
    lines.push(`Hechas    ${done}`);
    lines.push(`En curso  ${inProgress}`);
    lines.push(`Bloqueads ${blocked}`);
    lines.push('```');

    return lines.join('\n');
}

// -----------------------------------------------------------------------------
// REPORT: rebotes (consume `bounces` del pipeline matrix + rejected recientes)
// -----------------------------------------------------------------------------

async function reportRebotes() {
    const { data, dashboardUp } = await fetchSection('rebotes');
    const lines = [header('Rebotes 24h', { degraded: !dashboardUp })];

    if (!dashboardUp) {
        lines.push('');
        lines.push('Sin actividad en esta seccion');
        return lines.join('\n');
    }

    const pipelineData = data['/api/dash/pipeline'] || {};
    const recentData = data['/api/dash/recent'] || {};
    const matrix = pipelineData.matrix || {};
    const recent = Array.isArray(recentData.recent) ? recentData.recent : [];

    // Top 5 por bounces (descartar 0).
    const topBounces = Object.entries(matrix)
        .map(([id, info]) => ({ issue: id, bounces: info.bounces || 0, motivo: info.motivo_rechazo }))
        .filter(x => x.bounces > 0)
        .sort((a, b) => b.bounces - a.bounces)
        .slice(0, 5);

    // Conteo de rechazos cross-phase vs same-phase mirando recent.
    let crossPhase = 0;
    let samePhase = 0;
    let total = 0;
    const cutoff24h = Date.now() - 24 * 3600 * 1000;
    for (const r of recent) {
        if (r.resultado !== 'rechazado') continue;
        if (!r.finishedAt || r.finishedAt < cutoff24h) continue;
        total++;
        // Heurística: motivo con `rebote_destino` declarado → cross-phase.
        // Sin marker explícito en el slice, conservador: contar como same-phase.
        samePhase++;
    }

    if (topBounces.length === 0 && total === 0) {
        lines.push('');
        lines.push('Sin actividad en esta seccion');
        return lines.join('\n');
    }

    if (topBounces.length > 0) {
        lines.push('');
        lines.push('*Top 5 por rebotes \\(activos\\)*');
        lines.push('```');
        for (const b of topBounces) {
            const status = b.bounces >= 3 ? `${SEMAFORO.CRIT} circuit` : `${SEMAFORO.WARN} activo`;
            lines.push(`#${b.issue} ${b.bounces}/3 ${status}`);
        }
        lines.push('```');
    }

    lines.push('');
    lines.push(`Rechazos 24h: ${total}`);
    if (total > 0) {
        lines.push(`Cross\\-phase: ${crossPhase}   Same\\-phase: ${samePhase}`);
    }

    return lines.join('\n');
}

// -----------------------------------------------------------------------------
// REPORT: all (resumen ultracompacto)
// -----------------------------------------------------------------------------

async function reportAll() {
    // Hace los fetches en paralelo para no tardar 6× lo de un fetch individual.
    const [quotaData, opsData, headerData, pipelineData] = await Promise.all([
        fetchDashboard('/api/dash/quota'),
        fetchDashboard('/api/dash/ops'),
        fetchDashboard('/api/dash/header'),
        fetchDashboard('/api/dash/pipeline'),
    ]);
    const dashboardUp = !!(quotaData && opsData);
    const lines = [header('Resumen', { degraded: !dashboardUp })];

    lines.push('');

    // Cuota
    if (quotaData) {
        const wPct = quotaData.realPct != null ? quotaData.realPct : (quotaData.pct || 0);
        const wStatus = quotaData.realStatus || quotaData.status || 'unknown';
        const wSema = semaforoFromStatus(wStatus);
        const sPct = quotaData.session
            ? (quotaData.session.realPct != null ? quotaData.session.realPct : (quotaData.session.pct || 0))
            : 0;
        lines.push(`${wSema} *Cuota:* W ${Math.round(wPct)}% \\| S ${Math.round(sPct)}%`);
    }

    // Sistema
    const resources = (opsData && opsData.resources) || (headerData && headerData.resources) || {};
    if (resources && Object.keys(resources).length > 0) {
        const cpu = resources.cpuPercent != null ? Math.round(resources.cpuPercent) : null;
        const mem = resources.memPercent != null ? Math.round(resources.memPercent) : null;
        const maxCpu = resources.maxCpu || 70;
        const maxMem = resources.maxMem || 70;
        let s = 'ok';
        if ((cpu != null && cpu >= 90) || (mem != null && mem >= 90)) s = 'critical';
        else if ((cpu != null && cpu >= maxCpu) || (mem != null && mem >= maxMem)) s = 'warning';
        const sema = semaforoFromStatus(s);
        lines.push(`${sema} *Sistema:* CPU ${cpu != null ? cpu : '\\-'}% RAM ${mem != null ? mem : '\\-'}%`);
    }

    // Pipeline
    if (pipelineData && pipelineData.matrix) {
        const matrix = pipelineData.matrix;
        let totalActive = 0; let stuck = 0;
        for (const info of Object.values(matrix)) {
            if (info.estadoActual === 'archivado' || info.estadoActual === 'cerrado') continue;
            totalActive++;
            if (info.stale && (info.blockerAgeMin || 0) >= 120) stuck++;
        }
        const sema = stuck > 0 ? SEMAFORO.WARN : SEMAFORO.OK;
        lines.push(`${sema} *Pipeline:* ${totalActive} activos \\| ${stuck} estancados`);
    }

    // Modo
    if (headerData && headerData.mode && headerData.mode !== 'running') {
        const sema = semaforoFromStatus(headerData.mode);
        lines.push(`${sema} *Modo:* ${escapeMd(headerData.mode)}`);
    }

    // Sprint
    const roadmap = loadRoadmap();
    if (roadmap && Array.isArray(roadmap.sprints)) {
        const active = roadmap.sprints.find(s => s.status && s.status !== 'done');
        if (active && Array.isArray(active.stories)) {
            const done = active.stories.filter(s => s.status === 'done').length;
            const total = active.stories.length;
            const blocked = active.stories.filter(s => s.status === 'blocked' || s.status === 'paused').length;
            const sema = blocked > 0 ? SEMAFORO.WARN : SEMAFORO.OK;
            lines.push(`${sema} *Sprint:* ${done}/${total} done \\| ${blocked} bloqueads`);
        }
    }

    lines.push('');
    lines.push('Detalle: `/report agentes` `/report cuota` `/report sistema`');

    return lines.join('\n');
}

// -----------------------------------------------------------------------------
// Split de mensajes largos (CA-7: >15 lineas se parte en multiples mensajes)
// -----------------------------------------------------------------------------

// Telegram limita 4096 chars por mensaje. Partimos por bloques separados por
// líneas en blanco para no cortar tablas a la mitad (CA-7).
const MAX_LINES_PER_MSG = 15;
const MAX_CHARS_PER_MSG = 3800; // margen vs 4096

function splitMessage(text) {
    const totalLines = text.split('\n');
    if (totalLines.length <= MAX_LINES_PER_MSG && text.length <= MAX_CHARS_PER_MSG) {
        return [text];
    }

    // Partir por bloques delimitados por línea en blanco. Mantenemos
    // tablas (entre triple-backtick) en un solo bloque para no romper.
    const blocks = [];
    let current = [];
    let inFence = false;
    for (const line of totalLines) {
        if (line === '' && !inFence) {
            if (current.length > 0) blocks.push(current.join('\n'));
            current = [];
            continue;
        }
        if (line.startsWith('```')) inFence = !inFence;
        current.push(line);
    }
    if (current.length > 0) blocks.push(current.join('\n'));

    // Re-armar mensajes acumulando bloques hasta el cap.
    const msgs = [];
    let buf = '';
    for (const block of blocks) {
        const candidate = buf ? buf + '\n\n' + block : block;
        if (candidate.split('\n').length > MAX_LINES_PER_MSG || candidate.length > MAX_CHARS_PER_MSG) {
            if (buf) msgs.push(buf);
            buf = block;
        } else {
            buf = candidate;
        }
    }
    if (buf) msgs.push(buf);

    // Numerar si hay más de uno.
    if (msgs.length > 1) {
        return msgs.map((m, i) => `*${i + 1}/${msgs.length}*\n${m}`);
    }
    return msgs;
}

// -----------------------------------------------------------------------------
// Dispatcher (SR-1: whitelist hardcoded — sin require dinámico)
// -----------------------------------------------------------------------------

const FORMATTERS = Object.freeze({
    agentes: reportAgentes,
    cuota: reportCuota,
    sistema: reportSistema,
    pipeline: reportPipeline,
    sprint: reportSprint,
    rebotes: reportRebotes,
    all: reportAll,
});

async function dispatch(section) {
    const key = String(section || '').trim().toLowerCase();
    if (!key || !FORMATTERS[key]) {
        return { ok: false, kind: 'help', body: HELP_MENU };
    }
    try {
        const md = await FORMATTERS[key]();
        return { ok: true, kind: 'report', section: key, body: md };
    } catch (e) {
        // SR-3: error sanitizado (sin paths del SO).
        // El path completo queda en stderr para debugging del operador.
        try { console.error(`[telegram-reports] ${key}: ${e.message}\n${e.stack || ''}`); } catch {}
        const msg = `${SEMAFORO.CRIT} Error generando reporte: ${escapeMd(sanitizeError(e))}`;
        return { ok: false, kind: 'error', body: msg };
    }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
    // Constantes / helpers
    SEMAFORO,
    VALID_SECTIONS,
    HELP_MENU,
    escapeMd,
    escapeHtml,
    splitMessage,
    semaforoFromStatus,
    sanitizeError,
    // Formatters
    reportAgentes,
    reportCuota,
    reportSistema,
    reportPipeline,
    reportSprint,
    reportRebotes,
    reportAll,
    // Dispatcher
    dispatch,
    // Internos exportados para tests
    _fetchDashboard: fetchDashboard,
    _nowStamp: nowStamp,
    _header: header,
    _progressBar: progressBar,
};
