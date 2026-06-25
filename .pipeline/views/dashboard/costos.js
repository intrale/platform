'use strict';

// =============================================================================
// costos.js — Ventana "Costos" del Dashboard V3 (issue #3735, padre #3715).
//
// Extracción del bloque "Costos" embebido en el shell del monolito
// `dashboard.js`: la PILL de consumo anómalo del header + el BANNER persistente
// de alerta de consumo anómalo (antes inline entre las líneas ~5018-5099).
//
// ALCANCE (decisión cerrada UX/architect — narrativa-costos-v3.md):
//   - En este split se extrae SOLO el banner + pill embebidos en home. La
//     página standalone `/consumo` (renderConsumoHtml) queda como está; su
//     consolidación con este módulo sale como recomendación abierta (#3779).
//   - Son FRAGMENTOS que se embeben en la home shell → heredan el CSS del
//     dashboard (clases .anomaly-pill / .cost-anomaly-banner ya viven en el
//     <style> de dashboard.js). El módulo NO carga su propio theme: si lo
//     hiciera duplicaría la paleta y rompería el layout del shell.
//
// Contrato de exports (estable, consumido por dashboard.js y reutilizable por
// home.js sin duplicar la request — opción A del riesgo #3 del architect):
//   - renderCostosPill(state, opts?)   → HTML de la pill o '' si no visible.
//   - renderCostosBanner(state, opts?) → HTML del banner o '' si no visible.
//   - renderInert(msg?)                → banner inerte visible (CA-A3).
//
// IDs invariantes preservados (el cliente hace DOM morphing y los necesita
// exactos): `cost-anomaly-banner` (target del scrollIntoView de la pill).
//
// Seguridad (CA-B3 / CA-D1):
//   - Todo dato dinámico (pct, montos, skill names) pasa por escapeHtmlText /
//     escapeHtmlAttr de `lib/escape-html.js` (#3722, ya en main).
//   - Tooltips (title=) en cada acción operativa van por escapeHtmlAttr.
//
// Nota: la validación server-side del snooze (whitelist 1|4|24h, cap máximo)
// vive en `rest-mode-state.snoozeAlert()` y se testea ahí; este módulo solo
// renderiza la UI de los botones.
// =============================================================================

let escapeHtmlText;
let escapeHtmlAttr;
try {
    ({ escapeHtmlText, escapeHtmlAttr } = require('../../lib/escape-html.js'));
} catch (_) {
    // Fallback inline (CA-A3): si el helper compartido no cargó, el módulo
    // sigue escapando en vez de romper o emitir HTML crudo.
    const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    escapeHtmlText = esc;
    escapeHtmlAttr = esc;
}

// Tooltips acordados con Product Owner (CA-C1, tooltips #1..#4 del CA-4.1).
const TOOLTIPS = {
    pill: 'Pico de consumo detectado · click para ver detalle',
    ack: 'Confirma que viste la alerta — la pill y el banner desaparecen',
    snooze1: 'Silencia una hora',
    snooze4: 'Silencia cuatro horas — útil cuando sabés que viene una ráfaga',
    snooze24: 'Cap máximo permitido (24h) — no se puede más',
};

// Renderer de íconos: replica el markup de `ic()` de dashboard.js
// (`<svg class="pl-ic"><use href="#ic-NAME"/></svg>`) para no romper el sprite
// ya inyectado por loadIconSprite() en la página. Inyectable vía opts.ic para
// los tests / reuso.
function defaultIc(name, ariaLabel, extraClass) {
    const cls = 'pl-ic' + (extraClass ? ' ' + extraClass : '');
    const aria = ariaLabel
        ? ` role="img" aria-label="${escapeHtmlAttr(ariaLabel)}"`
        : ' aria-hidden="true"';
    return `<svg class="${cls}"${aria}><use href="#ic-${escapeHtmlAttr(name)}"/></svg>`;
}

// Normaliza el slice costAnomaly del state. Devuelve null si no hay alerta
// visible (la pill/banner no deben renderizarse).
function readAnomaly(state) {
    const ca = (state && state.costAnomaly) || {};
    if (!ca.visible) return null;
    const a = ca.alert || {};
    const ratioOk = a.ratio != null && Number.isFinite(Number(a.ratio));
    return {
        pctStr: ratioOk ? `+${Math.round((Number(a.ratio) - 1) * 100)}%` : '+?%',
        actualUsd: Number(a.actual_usd || 0).toFixed(2),
        baselineUsd: Number(a.baseline_usd || 0).toFixed(2),
        hour: String(a.hour || '').padStart(2, '0'),
        topSkills: Array.isArray(a.top_skills) ? a.top_skills.slice(0, 3) : [],
    };
}

// --- Pill del header -------------------------------------------------------
function renderCostosPill(state, opts) {
    try {
        const a = readAnomaly(state);
        if (!a) return '';
        const ic = (opts && typeof opts.ic === 'function') ? opts.ic : defaultIc;
        // CA-3.3 / R2 — sin handlers `onclick` inline (prerrequisito CSP #3688).
        // El comportamiento se cablea por delegación de eventos sobre el atributo
        // `data-ca-action` (ver renderCostosClientScript()).
        return `<button class="anomaly-pill" `
            + `data-ca-action="scroll-banner" `
            + `title="${escapeHtmlAttr(TOOLTIPS.pill)}" `
            + `aria-label="Consumo anómalo detectado, click para ver detalle">`
            + `${ic('cost-anomaly')}<span>CONSUMO ANÓMALO · ${escapeHtmlText(a.pctStr)}</span></button>`;
    } catch (_) {
        return '';
    }
}

// --- Banner persistente ----------------------------------------------------
function renderCostosBanner(state, opts) {
    try {
        const a = readAnomaly(state);
        if (!a) return '';
        const ic = (opts && typeof opts.ic === 'function') ? opts.ic : defaultIc;
        const nextHH = String((Number(a.hour) + 1) % 24).padStart(2, '0');
        const topHtml = a.topSkills.length === 0
            ? '<span class="ca-empty">sin desglose por skill (snapshot vacío)</span>'
            : a.topSkills.map((s, i) =>
                `<span class="ca-skill">`
                + `<span class="ca-skill-rank">${i + 1}</span>`
                + `<span class="ca-skill-name">${escapeHtmlText(String(s.skill || ''))}</span>`
                + `<span class="ca-skill-cost">$${escapeHtmlText(Number(s.cost_usd || 0).toFixed(2))}</span>`
                + `</span>`).join('');
        return `
  <section id="cost-anomaly-banner" class="cost-anomaly-banner" role="alert" aria-live="assertive" aria-label="Alerta de consumo anómalo">
    <div class="ca-rail" aria-hidden="true"></div>
    <div class="ca-icon" aria-hidden="true">${ic('cost-anomaly', 'Pico de consumo')}</div>
    <div class="ca-body">
      <div class="ca-headline">Pico de consumo detectado — última hora ${escapeHtmlText(a.pctStr)} sobre el promedio histórico</div>
      <div class="ca-detail">$${escapeHtmlText(a.actualUsd)} USD/h consumidos · esperado $${escapeHtmlText(a.baselineUsd)} USD/h · franja ${escapeHtmlText(a.hour)}:00–${escapeHtmlText(nextHH)}:00 (rolling 7d)</div>
      <div class="ca-skills">Top 3 consumidores: ${topHtml}</div>
      <div class="ca-foot">Persistente hasta acuse manual o vuelta a baseline (2 chequeos consecutivos).</div>
    </div>
    <div class="ca-actions">
      <span class="ca-actions-label">ACCIONES</span>
      <button class="ca-btn-ack" data-ca-action="ack" title="${escapeHtmlAttr(TOOLTIPS.ack)}">${ic('health-ok', 'check')}<span>Ya lo vi</span></button>
      <div class="ca-snooze">
        <span class="ca-snooze-icon" aria-hidden="true">${ic('snooze')}</span>
        <span class="ca-snooze-label">Silenciar</span>
        <button class="ca-snooze-btn" data-ca-action="snooze" data-ca-hours="1" title="${escapeHtmlAttr(TOOLTIPS.snooze1)}">1h</button>
        <button class="ca-snooze-btn" data-ca-action="snooze" data-ca-hours="4" title="${escapeHtmlAttr(TOOLTIPS.snooze4)}">4h</button>
        <button class="ca-snooze-btn ca-snooze-max" data-ca-action="snooze" data-ca-hours="24" title="${escapeHtmlAttr(TOOLTIPS.snooze24)}">24h</button>
      </div>
    </div>
  </section>`;
    } catch (e) {
        return renderInert();
    }
}

// --- Fallback inerte visible (CA-A3) --------------------------------------
// Mantiene el id `cost-anomaly-banner` para que el scrollIntoView de la pill
// no apunte a un nodo inexistente.
function renderInert(msg) {
    const detail = msg
        ? escapeHtmlText(msg)
        : 'No se pudo renderizar el detalle de la alerta de consumo.';
    return `
  <section id="cost-anomaly-banner" class="cost-anomaly-banner" role="alert" aria-live="assertive" aria-label="Ventana Costos no disponible">
    <div class="ca-rail" aria-hidden="true"></div>
    <div class="ca-body">
      <div class="ca-headline">Ventana Costos no disponible</div>
      <div class="ca-foot">${detail}</div>
    </div>
  </section>`;
}

// --- Client script: delegación de eventos (CA-3.3 / R2) --------------------
// Reemplaza los `onclick` inline por un único listener delegado a nivel
// documento, CSP-safe (sin `'unsafe-inline'`). Escucha clicks sobre cualquier
// elemento con `data-ca-action` y dispara la acción correspondiente:
//   - scroll-banner → scrollIntoView al banner (antes onclick de la pill).
//   - ack           → costAnomalyAck()    (función global del shell).
//   - snooze        → costAnomalySnooze(data-ca-hours).
//
// Las funciones globales `costAnomalyAck`/`costAnomalySnooze` siguen viviendo en
// el client script del shell (dashboard.js) — acá solo se cablea el binding sin
// duplicar la lógica de fetch. Idempotente vía guard `__costosWired`.
function renderCostosClientScript() {
    return `<script>(function(){
  if (window.__costosWired) return; window.__costosWired = true;
  document.addEventListener('click', function(ev){
    var el = ev.target && ev.target.closest ? ev.target.closest('[data-ca-action]') : null;
    if (!el) return;
    var action = el.getAttribute('data-ca-action');
    if (action === 'scroll-banner') {
      var b = document.getElementById('cost-anomaly-banner');
      if (b && b.scrollIntoView) b.scrollIntoView({behavior:'smooth',block:'start'});
    } else if (action === 'ack') {
      if (typeof costAnomalyAck === 'function') costAnomalyAck();
    } else if (action === 'snooze') {
      var h = Number(el.getAttribute('data-ca-hours'));
      if (typeof costAnomalySnooze === 'function') costAnomalySnooze(h);
    }
  });
})();</script>`;
}

// =============================================================================
// #4194 EP7.1 — Rediseño integral de la pantalla COSTOS (lenguaje MIZPÁ).
//
// Reemplaza el rediseño parcial #3962 (área apilada SVG sólo-Anthropic) por la
// pantalla completa consensuada en el mockup `costos-redesign-v2`:
//   - Banner de misión en clave alarma: desvío vs presupuesto + gastado hoy/mes
//     + presupuesto diario + «🔥 el que más pesa» (CA-4).
//   - Gráfico de consumo diario: barras apiladas de 14 días por los 5
//     proveedores + deterministas, línea de presupuesto, barras sobre el tope
//     marcadas en rojo, proveedores FREE en $0 visibles en la leyenda (CA-3/CA-6).
//   - Proyecciones + nota de mix de proveedores.
//   - Detalle por skill con COLUMNA DE PROVEEDOR por fila (CA-5), nunca truncado.
//   - «Cuota por proveedor»: una tarjeta por cada uno de los 5 proveedores con
//     su modelo de límite propio (CA-2).
//
// HTML/CSS NATIVO scoped a `#costos-redesign` (sin librería de charting →
// cumple REQ-SEC supply-chain A06/A08). Todo dato dinámico pasa por
// escapeHtmlText/escapeHtmlAttr (REQ-SEC XSS A03). El fragmento se inyecta DENTRO
// del shell satélite (top bar + nav 5+«⋯ Más» los provee el shell compartido,
// pantallas hermanas #4189-4193); por eso esta vista NO re-renderiza la chrome.
// =============================================================================

// Orden de apilado FIJO bottom→top, determinístico entre renders. `openai-codex`
// es el provider real de Codex en el activity-log; `deterministic` apila último.
const PROVIDER_STACK_ORDER = ['anthropic', 'openai-codex', 'groq', 'gemini', 'cerebras'];
const CHART_STACK_ORDER = ['anthropic', 'openai-codex', 'groq', 'gemini', 'cerebras', 'deterministic'];

// Identidad por proveedor alineada al mockup MIZPÁ (color + etiqueta + tier +
// si es free tier). Paleta scoped a #costos-redesign vía las clases de segmento.
const PROVIDER_META = {
    'anthropic':     { label: 'Claude',        color: '#34D9E0', tier: 'PLAN MAX', tierCls: 'max',  free: false },
    'openai-codex':  { label: 'Codex',         color: '#A78BFA', tier: 'PAGO',     tierCls: 'pay',  free: false },
    'groq':          { label: 'Groq',          color: '#FB923C', tier: 'FREE',     tierCls: 'free', free: true },
    'gemini':        { label: 'Gemini',        color: '#60A5FA', tier: 'FREE',     tierCls: 'free', free: true },
    'cerebras':      { label: 'Cerebras',      color: '#34D399', tier: 'FREE',     tierCls: 'free', free: true },
    'deterministic': { label: 'Deterministas', color: '#FBBF24', tier: 'DET',      tierCls: 'det',  free: false },
    'unknown':       { label: 'Otros',         color: '#8A93A6', tier: '—',        tierCls: 'det',  free: false },
};

// Clave CSS corta por proveedor (para las clases de segmento .seg-cl, etc.).
const PROVIDER_SEG = {
    'anthropic': 'cl', 'openai-codex': 'cx', 'groq': 'gq',
    'gemini': 'gm', 'cerebras': 'cb', 'deterministic': 'de', 'unknown': 'un',
};

// Íconos por skill (decorativos, aria-hidden). Default genérico para skills no
// mapeados — nunca se truncan, siempre se listan (CA-6).
const SKILL_ICONS = {
    review: '🔍', ux: '🎨', security: '🛡️', po: '📋', qa: '🧪',
    'pipeline-dev': '⚙️', architect: '📐', tester: '🧷', delivery: '🚚',
    linter: '🧹', build: '🔨', planner: '📅', guru: '🔮', doc: '📝',
    'backend-dev': '🧩', 'android-dev': '🤖', 'web-dev': '🌐', historia: '📖',
};

// Normaliza claves de proveedor que llegan con alias del activity-log a la
// clave canónica del catálogo. Defensivo ante variantes (`claude`, `google`…).
function normProvider(p) {
    const s = String(p || '').toLowerCase();
    if (!s) return 'unknown';
    if (s.includes('anthropic') || s.includes('claude')) return 'anthropic';
    if (s.includes('codex') || s.includes('openai')) return 'openai-codex';
    if (s.includes('groq')) return 'groq';
    if (s.includes('gemini') || s.includes('google')) return 'gemini';
    if (s.includes('cerebras')) return 'cerebras';
    if (s.includes('determ')) return 'deterministic';
    return PROVIDER_META[s] ? s : 'unknown';
}

function providerMeta(p) { return PROVIDER_META[normProvider(p)] || PROVIDER_META.unknown; }
function providerColor(p) { return providerMeta(p).color; }
function providerLabel(p) { return providerMeta(p).label; }
function providerSeg(p) { return PROVIDER_SEG[normProvider(p)] || 'un'; }

// Días del mes a partir de un 'YYYY-MM-DD'. Fallback 30 si no es parseable.
function daysInMonthOf(dayStr) {
    const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(dayStr || ''));
    if (!m) return 30;
    const y = Number(m[1]);
    const month = Number(m[2]); // 1-12
    const d = new Date(y, month, 0).getDate();
    return Number.isFinite(d) && d > 0 ? d : 30;
}

// HH:MM (hora local) a partir de un ISO. '' si no es válido.
function hhmm(iso) {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return '';
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function fmtUsd(n) {
    const v = Number(n || 0);
    return '$' + (Number.isFinite(v) ? v.toFixed(2) : '0.00');
}

// Lista de las últimas `n` claves 'YYYY-MM-DD' terminando en `refDay` (inclusive).
// Si `refDay` no es parseable, termina en hoy. Determinístico salvo el "hoy" del
// fallback (que sólo aplica cuando no hay datos).
function lastNDays(refDay, n) {
    let base = Date.parse(String(refDay || '') + 'T00:00:00Z');
    if (!Number.isFinite(base)) base = Date.now();
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
        const d = new Date(base - i * 86400000);
        const pad = (x) => String(x).padStart(2, '0');
        out.push(d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()));
    }
    return out;
}

// --- Derivaciones compartidas ----------------------------------------------
// Serie diaria (14 días) + totales por proveedor + presupuesto diario + días
// sobre presupuesto. Pura sobre el slice, defensiva ante campos faltantes.
function deriveDailySeries(slice) {
    const s = slice || {};
    const rows = Array.isArray(s.dailyByProvider) ? s.dailyByProvider : [];

    // Mapa day → provider → cost (provider normalizado).
    const byDay = new Map();
    const presentDays = [];
    const seenDay = new Set();
    for (const r of rows) {
        const day = String((r && r.day) || '');
        if (!day) continue;
        if (!seenDay.has(day)) { seenDay.add(day); presentDays.push(day); }
        const prov = normProvider(r && r.provider);
        if (!byDay.has(day)) byDay.set(day, {});
        const o = byDay.get(day);
        o[prov] = (o[prov] || 0) + Number((r && r.cost_usd) || 0);
    }
    presentDays.sort((a, b) => a.localeCompare(b));
    const refDay = presentDays.length ? presentDays[presentDays.length - 1] : null;
    const days = lastNDays(refDay, 14);

    // Presupuesto diario = mensual ÷ días del mes (del último día de referencia).
    const monthlyBudget = Number(s.budget && s.budget.monthly_usd) || 0;
    const dailyBudget = monthlyBudget > 0 ? monthlyBudget / daysInMonthOf(refDay || days[days.length - 1]) : 0;

    // Totales por día + máximo apilado.
    let maxTotal = 0;
    let daysOver = 0;
    const series = days.map((day) => {
        const o = byDay.get(day) || {};
        let total = 0;
        for (const p of CHART_STACK_ORDER) total += Number(o[p] || 0);
        if (total > maxTotal) maxTotal = total;
        if (dailyBudget > 0 && total > dailyBudget + 1e-9) daysOver++;
        return { day, byProv: o, total };
    });

    // Totales por proveedor para la leyenda (all-time del snapshot si está;
    // si no, suma de la ventana). Garantiza las 5 entradas aunque sean $0 (CA-6).
    const bp = (s.byProvider && typeof s.byProvider === 'object') ? s.byProvider : {};
    const legendTotals = {};
    for (const p of CHART_STACK_ORDER) legendTotals[p] = 0;
    // Preferimos byProvider all-time; si vacío, caemos a la suma de la serie.
    let hasBp = false;
    for (const [k, v] of Object.entries(bp)) {
        const p = normProvider(k);
        legendTotals[p] = (legendTotals[p] || 0) + Number((v && v.cost_usd) || 0);
        if (Number((v && v.cost_usd) || 0) > 0) hasBp = true;
    }
    if (!hasBp) {
        for (const row of series) {
            for (const [p, c] of Object.entries(row.byProv)) legendTotals[p] = (legendTotals[p] || 0) + Number(c || 0);
        }
    }

    const yMax = Math.max(maxTotal, dailyBudget, 0.01) * 1.15;
    return { series, days, dailyBudget, monthlyBudget, daysOver, maxTotal, yMax, legendTotals, refDay };
}

// Totales por skill ordenados desc, con proveedor dominante + #sesiones. Sólo
// campos públicos (skill, provider, cost, sessions) — sin paths/tokens (CA-3/CA-5).
function deriveSkillTotals(slice) {
    const s = slice || {};
    const bySkill = (s.sessionsBySkill && typeof s.sessionsBySkill === 'object') ? s.sessionsBySkill : {};
    const out = [];
    for (const [skill, list] of Object.entries(bySkill)) {
        if (!Array.isArray(list)) continue;
        let total = 0;
        const byProv = {};
        for (const x of list) {
            const c = Number((x && x.cost_usd) || 0);
            total += c;
            const p = normProvider(x && x.provider);
            byProv[p] = (byProv[p] || 0) + c;
        }
        // Proveedor dominante por costo; si todo $0 (free/determinista), el más
        // frecuente. Empate → el primero del orden de apilado.
        let domProv = 'unknown';
        let best = -1;
        for (const p of CHART_STACK_ORDER) {
            const v = byProv[p];
            if (v != null && v > best) { best = v; domProv = p; }
        }
        if (best <= 0) {
            // Sin costo: usar el provider más usado por frecuencia.
            const freq = {};
            for (const x of list) { const p = normProvider(x && x.provider); freq[p] = (freq[p] || 0) + 1; }
            let fb = -1;
            for (const p of CHART_STACK_ORDER) { if ((freq[p] || 0) > fb) { fb = freq[p] || 0; domProv = p; } }
        }
        out.push({ skill, total, sessions: list.length, provider: domProv });
    }
    out.sort((a, b) => (b.total - a.total) || (b.sessions - a.sessions) || a.skill.localeCompare(b.skill));
    return out;
}

// Métricas del banner de misión (CA-4).
function deriveMission(slice, ds) {
    const s = slice || {};
    const proj = (s.projections && s.projections.tokens) || {};
    const quota = (proj && proj.quota) || {};
    // Gastado hoy = total del último día con datos de la serie.
    let spentToday = 0;
    if (ds && Array.isArray(ds.series) && ds.series.length) {
        // Buscar el día con datos más reciente (la serie es ascendente).
        for (let i = ds.series.length - 1; i >= 0; i--) {
            if (ds.series[i].total > 0) { spentToday = ds.series[i].total; break; }
        }
    }
    const spentMonth = Number.isFinite(Number(proj.month_to_date_usd))
        ? Number(proj.month_to_date_usd)
        : (ds ? ds.series.reduce((a, r) => a + r.total, 0) : 0);
    const dailyBudget = ds ? ds.dailyBudget : 0;
    const monthlyBudget = ds ? ds.monthlyBudget : (Number(s.budget && s.budget.monthly_usd) || 0);

    const ratio = Number.isFinite(Number(quota.ratio)) ? Number(quota.ratio) : null;
    const devPct = ratio != null ? Math.round((ratio - 1) * 100) : null;
    const over = ratio != null ? ratio > 1 : (monthlyBudget > 0 && spentMonth > monthlyBudget);

    // El que más pesa: skill top por costo + su proveedor dominante.
    const skills = deriveSkillTotals(slice);
    const top = skills.length ? skills[0] : null;

    // Mix de proveedores: % de gasto pago (Claude+Codex) sobre total + #sesiones free.
    const bp = (s.byProvider && typeof s.byProvider === 'object') ? s.byProvider : {};
    let paid = 0, totalCost = 0, freeSessions = 0;
    for (const [k, v] of Object.entries(bp)) {
        const p = normProvider(k);
        const c = Number((v && v.cost_usd) || 0);
        totalCost += c;
        if (p === 'anthropic' || p === 'openai-codex') paid += c;
        if (PROVIDER_META[p] && PROVIDER_META[p].free) freeSessions += Number((v && v.sessions) || 0);
    }
    const paidPct = totalCost > 0 ? (paid / totalCost) * 100 : 0;

    return { spentToday, spentMonth, dailyBudget, monthlyBudget, devPct, over, top, paidPct, freeSessions, totalCost };
}

// --- Banner de misión en clave alarma (CA-4) -------------------------------
function renderMissionBanner(slice) {
    try {
        const ds = deriveDailySeries(slice);
        const m = deriveMission(slice, ds);
        const alarm = m.over;
        const devTxt = m.devPct != null ? (m.devPct >= 0 ? '+' : '') + m.devPct + '%' : '—';
        const headline = alarm
            ? 'Estás gastando por encima del presupuesto'
            : 'El consumo está dentro del presupuesto';
        const tag = alarm
            ? '<span class="cz-pill-warn">REVISÁ EL RITMO</span>'
            : '<span class="cz-pill-ok">EN RANGO</span>';
        const desc = alarm
            ? 'El promedio diario proyecta un cierre de mes por encima del tope. Casi todo el gasto se concentra en los proveedores pagos (Claude y Codex); los free tier no suman costo. Ajustá el presupuesto o el mix de proveedores.'
            : 'El ritmo actual proyecta un cierre de mes dentro del tope configurado. Los proveedores free tier (Groq, Gemini, Cerebras) absorben carga a costo cero.';

        const topHtml = m.top
            ? `<div class="cz-oldest-val"><span class="cz-oldest-skill">${escapeHtmlText(m.top.skill)}</span> · ${escapeHtmlText(fmtUsd(m.top.total))}</div>`
              + `<div class="cz-oldest-sub">Corrió en ${escapeHtmlText(providerLabel(m.top.provider))}. ${PROVIDER_META[m.top.provider] && PROVIDER_META[m.top.provider].free ? 'Ya corre en free tier.' : 'Mirá si conviene derivarlo a un proveedor free tier.'}</div>`
            : '<div class="cz-oldest-val">sin datos por skill todavía</div>';

        return `<section class="cz-mission ${alarm ? 'cz-mission-alarm' : 'cz-mission-ok'}" role="${alarm ? 'alert' : 'status'}" aria-label="Estado de presupuesto de costos">
  <div class="cz-alarmtag">
    <div class="cz-alarmtag-k">DESVÍO</div>
    <div class="cz-alarmtag-n">${escapeHtmlText(devTxt)}</div>
    <div class="cz-alarmtag-s">VS PRESUPUESTO</div>
  </div>
  <div class="cz-mtext">
    <div class="cz-mttl">${escapeHtmlText(headline)} ${tag}</div>
    <div class="cz-mdesc">${escapeHtmlText(desc)}</div>
    <div class="cz-wmetrics">
      <div class="cz-wm"><div class="cz-wl">💵 GASTADO HOY</div><div class="cz-wv">${escapeHtmlText(fmtUsd(m.spentToday))}</div><div class="cz-wsx">acumulado del día</div></div>
      <div class="cz-wm"><div class="cz-wl">📅 GASTADO ESTE MES</div><div class="cz-wv">${escapeHtmlText(fmtUsd(m.spentMonth))}</div><div class="cz-wsx">sobre tope de ${escapeHtmlText(fmtUsd(m.monthlyBudget))}</div></div>
      <div class="cz-wm"><div class="cz-wl">🎯 PRESUPUESTO DIARIO</div><div class="cz-wv cz-accent">${escapeHtmlText(fmtUsd(m.dailyBudget))}</div><div class="cz-wsx">${escapeHtmlText(fmtUsd(m.monthlyBudget))} / ${escapeHtmlText(String(daysInMonthOf(ds.refDay || '')))} días</div></div>
    </div>
  </div>
  <div class="cz-mright">
    <div class="cz-oldest">
      <div class="cz-oldest-k">🔥 EL QUE MÁS PESA</div>
      ${topHtml}
    </div>
  </div>
</section>`;
    } catch (e) {
        return `<section class="cz-mission cz-mission-ok"><div class="cz-empty">Resumen de presupuesto no disponible.</div></section>`;
    }
}

// --- Gráfico de consumo diario: barras apiladas 14 días (CA-3 + CA-6) -------
function renderCostosChart(slice) {
    try {
        const ds = deriveDailySeries(slice);
        const { series, dailyBudget, daysOver, yMax, legendTotals } = ds;

        const hasData = series.some((r) => r.total > 0);

        // Eje Y: 4 líneas de grilla + base. Etiquetas en dólares.
        const gridLines = [1, 0.75, 0.5, 0.25, 0].map((f) =>
            `<div class="cz-gl"><span class="cz-gv">${escapeHtmlText(fmtUsd(yMax * f))}</span><span class="cz-gln"></span></div>`
        ).join('');

        // Línea de presupuesto (posición relativa al área de barras).
        const budPct = yMax > 0 ? Math.max(0, Math.min(100, (dailyBudget / yMax) * 100)) : 0;
        const budgetSvg = dailyBudget > 0
            ? `<div class="cz-budget-line" style="bottom:${budPct.toFixed(2)}%"></div>`
              + `<div class="cz-budtag" style="bottom:${budPct.toFixed(2)}%">Presupuesto ${escapeHtmlText(fmtUsd(dailyBudget))}/día</div>`
            : '';

        // Barras apiladas.
        const bars = series.map((row) => {
            const stackPct = yMax > 0 ? Math.max(0, Math.min(100, (row.total / yMax) * 100)) : 0;
            const over = dailyBudget > 0 && row.total > dailyBudget + 1e-9;
            let segs = '';
            if (row.total > 0) {
                for (const p of CHART_STACK_ORDER) {
                    const c = Number(row.byProv[p] || 0);
                    if (c <= 0) continue;
                    const h = (c / row.total) * 100;
                    segs += `<div class="cz-seg cz-seg-${providerSeg(p)}" style="height:${h.toFixed(2)}%" title="${escapeHtmlAttr(providerLabel(p) + ' ' + fmtUsd(c))}"></div>`;
                }
            }
            const dd = row.day.slice(8); // 'DD'
            return `<div class="cz-bar">`
                + `<div class="cz-stack ${over ? 'cz-stack-over' : ''}" style="height:${stackPct.toFixed(2)}%">${segs}</div>`
                + `<div class="cz-bx ${over ? 'cz-bx-hl' : ''}">${escapeHtmlText(dd)}</div>`
                + `</div>`;
        }).join('');

        // Leyenda: las 6 series (5 proveedores + deterministas), FREE en $0
        // visibles y etiquetadas (CA-6).
        const legend = CHART_STACK_ORDER.map((p) => {
            const meta = providerMeta(p);
            const total = Number(legendTotals[p] || 0);
            const freeTag = meta.free ? ' <span class="cz-freetag">FREE</span>' : '';
            return `<div class="cz-lg ${meta.free ? 'cz-lg-free' : ''}">`
                + `<span class="cz-sw" style="background:${meta.color}"></span>`
                + `${escapeHtmlText(meta.label)} <b>${escapeHtmlText(fmtUsd(total))}</b>${freeTag}</div>`;
        }).join('');
        const overSummary = dailyBudget > 0
            ? `<div class="cz-lg cz-lg-summary"><b>${daysOver} de ${series.length} días</b> sobre presupuesto</div>`
            : '';

        const emptyNote = !hasData
            ? `<div class="cz-empty">Sin consumo registrado en los últimos 14 días. Las barras se llenan a medida que terminan agentes (los free tier y deterministas suman $0).</div>`
            : '';

        return `<div class="cz-chart-wrap">
  <div class="cz-chartarea">
    <div class="cz-ygrid">${gridLines}</div>
    <div class="cz-bars">${budgetSvg}${bars}</div>
  </div>
  <div class="cz-legend">${legend}${overSummary}</div>
  ${emptyNote}
</div>`;
    } catch (e) {
        return `<div class="cz-empty">No se pudo renderizar el gráfico de consumo.</div>`;
    }
}

// --- Presupuesto configurable (CA-4) + chip de snooze (CA-5) ----------------
function renderBudgetForm(slice) {
    try {
        const s = slice || {};
        const current = Number(s.budget && s.budget.monthly_usd) || 0;
        const sourceTxt = (s.budget && s.budget.source === 'persisted') ? 'configurado' : 'default';

        // Chip de snooze "Silenciada hasta HH:MM" derivado del estado server-side.
        let snoozeChip = '';
        const until = s.snooze && s.snooze.until;
        const untilHHMM = hhmm(until);
        if (untilHHMM) {
            snoozeChip = `<span class="cz-snooze-chip" title="Alerta de consumo silenciada">`
                + `🔕 Silenciada hasta ${escapeHtmlText(untilHHMM)}</span>`;
        }

        return `<div class="cz-budgetbox">
  <div class="cz-bl">Presupuesto mensual</div>
  <div class="cz-ipt">
    <span class="cz-cur">US$</span>
    <input id="cz-budget-input" class="cz-budget-input" type="number" min="1" step="1"
           value="${escapeHtmlAttr(current > 0 ? String(current) : '')}" placeholder="100" inputmode="decimal" aria-label="Presupuesto mensual en dólares" />
    <span class="cz-per">/ mes</span>
  </div>
  <button id="cz-budget-save" class="cz-savebtn" type="button">Guardar</button>
  ${snoozeChip}
  <div class="cz-hint">Valor actual ${escapeHtmlText(fmtUsd(current))} (${escapeHtmlText(sourceTxt)}). Numérico &gt; 0; se valida en el servidor.</div>
  <div id="cz-budget-status" class="cz-budget-status" role="status" aria-live="polite"></div>
</div>`;
    } catch (e) {
        return `<div class="cz-empty">Formulario de presupuesto no disponible.</div>`;
    }
}

// --- Proyecciones (CA) + nota de mix de proveedores -------------------------
function renderProjectionsCards(slice) {
    try {
        const s = slice || {};
        const proj = (s.projections && s.projections.tokens) || null;
        if (!proj) {
            return `<div class="cz-empty">Sin proyecciones (serie diaria vacía).</div>`;
        }
        const method = proj.method || {};
        const quota = proj.quota || {};
        const ratio = (quota.ratio != null && Number.isFinite(Number(quota.ratio))) ? Number(quota.ratio) : null;
        const devPct = ratio != null ? Math.round((ratio - 1) * 100) : null;
        const over = ratio != null ? ratio > 1 : false;

        const weeklyCard = `<div class="cz-proj">
  <div class="cz-pk">📆 Proyección semanal</div>
  <div class="cz-pv">${escapeHtmlText(fmtUsd(proj.weekly_projection_usd))}</div>
  <div class="cz-pf">${escapeHtmlText(method.weekly || 'promedio diario × 7')}</div>
</div>`;
        const monthlyCard = `<div class="cz-proj">
  <div class="cz-pk">🗓 Cierre de mes (proyectado)</div>
  <div class="cz-pv">${escapeHtmlText(fmtUsd(proj.monthly_forecast_usd != null ? proj.monthly_forecast_usd : proj.monthly_projection_usd))}</div>
  <div class="cz-pf">${escapeHtmlText(method.monthly || 'promedio diario × días del mes')}</div>
</div>`;
        const devCard = `<div class="cz-proj ${over ? 'cz-proj-alert' : ''}">
  ${over ? '<div class="cz-pbadge">⚠ FUERA DE RANGO</div>' : ''}
  <div class="cz-pk ${over ? 'cz-pk-alert' : ''}">${over ? '🚨 ' : ''}Desvío vs presupuesto</div>
  <div class="cz-pv ${over ? 'cz-pv-bad' : 'cz-pv-ok'}">${devPct != null ? escapeHtmlText((devPct >= 0 ? '+' : '') + devPct + '%') : '—'}</div>
  <div class="cz-pf">${escapeHtmlText(method.deviation || '(proyección mensual ÷ presupuesto) − 1')}</div>
</div>`;

        // Nota de mix de proveedores.
        const m = deriveMission(slice, deriveDailySeries(slice));
        const mix = `<div class="cz-mixnote">
  <div class="cz-mk">💡 Mix de proveedores</div>
  <div class="cz-mv"><b>${escapeHtmlText(m.paidPct.toFixed(1))}%</b> del gasto sale de <b>Claude + Codex</b> (pagos). Groq, Gemini y Cerebras absorbieron <b>${escapeHtmlText(String(m.freeSessions))} sesiones</b> a costo cero. Subir su cuota libera presupuesto pago.</div>
</div>`;

        return `<div class="cz-projcards">${weeklyCard}${monthlyCard}${devCard}</div>${mix}`;
    } catch (e) {
        return `<div class="cz-empty">Proyecciones no disponibles.</div>`;
    }
}

// --- Detalle por skill con columna de proveedor (CA-5) ----------------------
// El payload ya viene REDACTADO del aggregator + slice (whitelist). Acá sólo
// escapamos para render. NUNCA se pintan paths/tokens/prompts/issue.
function renderDrillDown(slice) {
    try {
        const skills = deriveSkillTotals(slice);
        if (skills.length === 0) {
            return `<div class="cz-empty">Sin sesiones para el detalle por skill.</div>`;
        }
        const maxCost = skills.reduce((a, x) => Math.max(a, x.total), 0) || 1;

        const rows = skills.map((x, i) => {
            const meta = providerMeta(x.provider);
            const icon = SKILL_ICONS[x.skill] || '🧩';
            const meterPct = x.total > 0 ? Math.max(2, (x.total / maxCost) * 100) : 2;
            const zero = x.total <= 0;
            const chipFree = meta.free ? ' cz-pchip-free' : '';
            return `<div class="cz-srow ${i === 0 && !zero ? 'cz-srow-top' : ''}">`
                + `<div class="cz-sk"><div class="cz-si" aria-hidden="true">${escapeHtmlText(icon)}</div><div class="cz-sn">${escapeHtmlText(x.skill)}</div></div>`
                + `<div class="cz-pchip${chipFree}"><span class="cz-pd" style="background:${meta.color}"></span>${escapeHtmlText(meta.label)}</div>`
                + `<div class="cz-meter ${zero ? 'cz-meter-z' : ''}"><i style="width:${meterPct.toFixed(1)}%;background:${zero ? '' : 'linear-gradient(90deg,#34D9E0,#5A8DEE)'}"></i></div>`
                + `<div class="cz-scost ${zero ? 'cz-scost-zero' : ''}">${escapeHtmlText(fmtUsd(x.total))}</div>`
                + `<div class="cz-sses">${escapeHtmlText(String(x.sessions))} ses.</div>`
                + `</div>`;
        }).join('');

        return `<div class="cz-skilltable">${rows}</div>
  <div class="cz-foot">ℹ️ Se listan <b>todos</b> los skills del período, nunca se truncan ni se resumen con «+X más». El chip muestra el proveedor con el que corrió cada skill. Los <code>$0.00</code> son free tier o deterministas. Detalle saneado: sólo skill, proveedor, costo y sesiones — sin paths, prompts ni tokens.</div>`;
    } catch (e) {
        return `<div class="cz-empty">Detalle por skill no disponible.</div>`;
    }
}

// --- Cuota por proveedor: una tarjeta por cada uno de los 5 (CA-2) ----------
// Modelo de límite declarativo por proveedor. Sólo Anthropic tiene adapter de
// cuota implementado (su % es estimado-real); el resto muestra su modelo de
// límite + uso del activity-log (sesiones/requests del día), marcado "estimado".
function renderProviderQuota(slice) {
    try {
        const s = slice || {};
        const cq = (s.claudeQuota && typeof s.claudeQuota === 'object') ? s.claudeQuota : null;
        const bp = (s.byProvider && typeof s.byProvider === 'object') ? s.byProvider : {};
        const sessionsOf = (key) => {
            for (const [k, v] of Object.entries(bp)) {
                if (normProvider(k) === key) return Number((v && v.sessions) || 0);
            }
            return 0;
        };

        // Barra de métrica: si pct es null mostramos "estimado" sin barra falsa.
        const metric = (label, pct, valTxt, color) => {
            const known = Number.isFinite(Number(pct));
            const w = known ? Math.max(1, Math.min(100, Number(pct))) : 0;
            const val = valTxt != null ? valTxt : (known ? Number(pct).toFixed(1) + '%' : '—');
            return `<div class="cz-pqm">`
                + `<div class="cz-pl">${escapeHtmlText(label)} <b>${escapeHtmlText(val)}</b></div>`
                + `<div class="cz-pqbar"><i style="width:${w.toFixed(1)}%;background:${color}"></i></div>`
                + `</div>`;
        };

        const card = (key, metricsHtml, resetTxt) => {
            const meta = PROVIDER_META[key];
            return `<div class="cz-pq cz-pq-${PROVIDER_SEG[key]}">`
                + `<div class="cz-pqtop"><span class="cz-pd" style="background:${meta.color}"></span>`
                + `<span class="cz-pn">${escapeHtmlText(meta.label)}</span>`
                + `<span class="cz-ptier cz-ptier-${meta.tierCls}">${escapeHtmlText(meta.tier)}</span></div>`
                + metricsHtml
                + `<div class="cz-pqreset">${resetTxt}</div>`
                + `</div>`;
        };

        // CLAUDE — sesión 5h + semanal, estimado real (Anthropic sin API de cuota).
        const claudeMetrics =
            metric('⏱ Sesión 5h', cq ? cq.sessionPct : null, null, 'linear-gradient(90deg,#34D399,#34D9E0)')
            + metric('🔆 Semanal', cq ? cq.weeklyPct : null, null, 'linear-gradient(90deg,#34D399,#FBBF24)');
        const claudeReset = cq && cq.daysToReset != null
            ? `Reset semanal en ${escapeHtmlText(cq.daysToReset.toFixed(1))} días · <span class="cz-est">estimado</span> (Anthropic sin API de cuota)`
            : `Reset semanal dom 21:00 ART · <span class="cz-est">estimado</span> (Anthropic sin API de cuota)`;

        // CODEX — plan pago semanal + uso del día.
        const codexMetrics =
            metric('💳 Plan semanal', null, 'sin API', 'linear-gradient(90deg,#A78BFA,#7c5cff)')
            + metric('📊 Hoy (uso)', null, sessionsOf('openai-codex') + ' ses.', 'linear-gradient(90deg,#A78BFA,#60A5FA)');
        const codexReset = 'Cuota de plan OpenAI · reset semanal · uso real por activity-log';

        // FREE — requests/día (sesiones) + tokens/día estimado.
        const freeCard = (key, color) => {
            const sess = sessionsOf(key);
            const metrics =
                metric('📨 Requests/día', null, sess + ' req', color)
                + metric('🔢 Tokens/día', null, 'estimado', color);
            return card(key, metrics, 'Free tier · límite diario de requests/tokens · reset diario · <span class="cz-est">estimado</span>');
        };

        const cards = [
            card('anthropic', claudeMetrics, claudeReset),
            card('openai-codex', codexMetrics, codexReset),
            freeCard('groq', 'linear-gradient(90deg,#FB923C,#FBBF24)'),
            freeCard('gemini', 'linear-gradient(90deg,#60A5FA,#34D9E0)'),
            freeCard('cerebras', 'linear-gradient(90deg,#34D399,#34D9E0)'),
        ].join('');

        return `<div class="cz-quotanote">Todos los proveedores tienen su techo. <b>Claude</b> (Plan Max) y <b>Codex</b> (pago) son los que tienen costo; <b>Groq, Gemini y Cerebras</b> corren en free tier con límites diarios de requests/tokens. Donde el proveedor no expone API de cuota, el valor es <b>estimado</b> desde el uso del activity-log.</div>
  <div class="cz-pqgrid">${cards}</div>`;
    } catch (e) {
        return `<div class="cz-empty">Cuota por proveedor no disponible.</div>`;
    }
}

// --- Calibración de la estimación de Claude (preservada de #3735) ------------
// Mantiene los IDs invariantes que el client script del shell (satellites.js
// tickQuota) bindea por getElementById: calib-weekly / calib-session /
// calib-session-at / calib-weekly-at / calib-save / calib-clear / calib-status /
// calib-history. Mover el markup acá no rompe el binding (es por ID, no por DOM).
function renderCalibrationTool() {
    return `<details class="cz-calib" id="quota-calib">
  <summary>🎯 Calibrar la estimación de Claude con valores reales de claude.ai/settings/usage</summary>
  <p class="cz-calib-help">Pegá los % que ves y, si querés mejorar la precisión del reset semanal, también el día/hora de cada reset. Cada calibración entra al historial — los factores se promedian con EMA.</p>
  <div class="cz-calib-grid">
    <div><label>% semanal real</label><input id="calib-weekly" type="number" step="0.1" min="0" max="100" placeholder="ej: 22"></div>
    <div><label>% sesión 5h real</label><input id="calib-session" type="number" step="0.1" min="0" max="100" placeholder="ej: 60"></div>
    <div><label>Sesión: día y hora del reset (opcional)</label><input id="calib-session-at" type="datetime-local"></div>
    <div><label>Semanal: día y hora del reset (opcional)</label><input id="calib-weekly-at" type="datetime-local"></div>
  </div>
  <div class="cz-calib-actions">
    <button id="calib-save" class="cz-calib-btn cz-calib-apply" type="button">▶ Aplicar y aprender</button>
    <button id="calib-clear" class="cz-calib-btn" type="button">✕ Borrar calibración</button>
  </div>
  <div id="calib-status" class="cz-calib-status" role="status" aria-live="polite"></div>
  <div id="calib-history"></div>
</details>`;
}

// --- Script cliente del presupuesto: POST + re-render sin recarga completa ---
// Tras un POST 200, re-fetchea el partial de la vista Costos y reemplaza el
// contenido (#costos-redesign) por DOM morphing. CSP-safe (sin onclick inline).
function renderBudgetClientScript() {
    return `<script>(function(){
  if (window.__czBudgetWired) return; window.__czBudgetWired = true;
  function setStatus(msg, ok){
    var el = document.getElementById('cz-budget-status');
    if (el){ el.textContent = msg; el.className = 'cz-budget-status ' + (ok ? 'cz-ok' : 'cz-bad'); }
  }
  document.addEventListener('click', function(ev){
    var btn = ev.target && ev.target.closest ? ev.target.closest('#cz-budget-save') : null;
    if (!btn) return;
    var input = document.getElementById('cz-budget-input');
    var val = input ? Number(input.value) : NaN;
    if (!isFinite(val) || val <= 0){ setStatus('Ingresá un número mayor a 0.', false); return; }
    btn.disabled = true; setStatus('Guardando…', true);
    fetch('/dashboard/costos/budget', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monthlyUsd: val })
    }).then(function(r){ return r.json().then(function(j){ return { status: r.status, body: j }; }); })
      .then(function(res){
        btn.disabled = false;
        if (res.status === 200 && res.body && res.body.applied){
          setStatus('Presupuesto actualizado.', true);
          var host = document.getElementById('costos-redesign');
          if (host){
            fetch('/dashboard/partial?view=costos', { headers: { 'Sec-Fetch-Site': 'same-origin' } })
              .then(function(r){ return r.text(); })
              .then(function(html){
                var tmp = document.createElement('div'); tmp.innerHTML = html;
                var fresh = tmp.querySelector('#costos-redesign');
                if (fresh && host.parentNode){ host.parentNode.replaceChild(fresh, host); }
              }).catch(function(){});
          }
        } else {
          setStatus('Valor rechazado por el servidor.', false);
        }
      }).catch(function(){ btn.disabled = false; setStatus('Error de red.', false); });
  });
})();</script>`;
}

// Header de panel reutilizable (estilo MIZPÁ del mockup) con tooltip
// autodescriptivo opcional (nunca truncar — CA-1).
function panelHeader(icon, title, sub, tip) {
    const tipHtml = tip
        ? `<div class="cz-tipwrap"><div class="cz-tipi" aria-hidden="true">i</div><div class="cz-tip"><div class="cz-th">${escapeHtmlText(icon + ' ' + title)}</div><div class="cz-tb">${escapeHtmlText(tip)}</div></div></div>`
        : '';
    return `<div class="cz-ph">
  <div class="cz-pic">${escapeHtmlText(icon)}</div>
  <div><div class="cz-pt">${escapeHtmlText(title)}</div><div class="cz-psub">${escapeHtmlText(sub)}</div></div>
  ${tipHtml}
</div>`;
}

// --- Composición de la pantalla rediseñada (entry point para el view) -------
// Devuelve el bloque HTML completo del rediseño MIZPÁ. Se inyecta como CONTENIDO
// del shell satélite (la top bar + nav 5+«⋯ Más» las pone el shell compartido).
function renderCostosRedesign(slice) {
    let inner;
    try {
        inner = `${renderMissionBanner(slice)}
  <div class="cz-grid">
    <div class="cz-panel">
      ${panelHeader('📊', 'Consumo diario por proveedor', 'últimos 14 días · US$ por día, apilado por los 5 proveedores + deterministas', 'Cada barra es un día; los colores apilan cuánto gastó cada proveedor. Claude y Codex son pagos; Groq, Gemini y Cerebras corren en free tier (US$ 0). La línea punteada es el presupuesto diario.')}
      ${renderCostosChart(slice)}
      ${renderBudgetForm(slice)}
    </div>
    <div class="cz-panel">
      ${panelHeader('📈', 'Proyecciones', 'a ritmo actual', '')}
      ${renderProjectionsCards(slice)}
    </div>
  </div>
  <div class="cz-panel">
    ${panelHeader('🧩', 'Detalle por skill', 'skill, proveedor que lo corrió, costo y sesiones — sin paths, prompts ni tokens', 'Cuánto consumió cada rol de agente y en qué proveedor corrió. Los $0.00 corren en free tier (Groq/Gemini/Cerebras) o son deterministas.')}
    ${renderDrillDown(slice)}
  </div>
  <div class="cz-panel">
    ${panelHeader('🔌', 'Cuota por proveedor', 'límites y consumo de los 5 proveedores del pipeline — no solo Anthropic', 'Cada proveedor tiene su propio modelo de límite: Claude por sesión 5h + semanal (Plan Max), Codex por plan pago, y los free tier (Groq/Gemini/Cerebras) por requests y tokens diarios. Las cuotas que el proveedor no expone por API se estiman desde el activity-log.')}
    ${renderProviderQuota(slice)}
    ${renderCalibrationTool()}
  </div>`;
    } catch (e) {
        inner = `<div class="cz-empty">Rediseño de Costos no disponible.</div>`;
    }
    return `<div id="costos-redesign" class="cz-root">${costosRedesignStyle()}${inner}${renderBudgetClientScript()}</div>`;
}

function costosRedesignStyle() {
    return `<style>
#costos-redesign.cz-root{
  --cz-bg:#0A0D13; --cz-panel:#11151E; --cz-panel2:#141925;
  --cz-line:rgba(255,255,255,.07); --cz-line2:rgba(255,255,255,.12);
  --cz-txt:#E7ECF3; --cz-mut:#8A93A6; --cz-mut2:#5B6376;
  --cz-cy:#34D9E0; --cz-gr:#34D399; --cz-am:#FBBF24; --cz-rd:#F87171; --cz-or:#FB923C;
  --cz-r:16px;
  color:var(--cz-txt); font-family:'Segoe UI',-apple-system,Roboto,sans-serif; letter-spacing:.1px;
}
#costos-redesign .cz-empty{color:var(--cz-mut);font-size:13px;padding:12px 0}
#costos-redesign code{font-family:'Cascadia Code',Consolas,monospace}
/* MISSION BANNER */
#costos-redesign .cz-mission{display:flex;align-items:center;gap:22px;border-radius:var(--cz-r);padding:18px 24px;margin-bottom:14px;position:relative;overflow:hidden;background:linear-gradient(180deg,var(--cz-panel),var(--cz-panel2))}
#costos-redesign .cz-mission-alarm{background:linear-gradient(110deg,rgba(251,146,60,.15),rgba(248,113,113,.08) 45%,transparent 75%),linear-gradient(180deg,var(--cz-panel),var(--cz-panel2));border:1px solid rgba(251,146,60,.24)}
#costos-redesign .cz-mission-ok{border:1px solid rgba(52,211,153,.22)}
#costos-redesign .cz-alarmtag{display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:104px;padding:12px 14px;border-radius:14px;background:linear-gradient(135deg,rgba(248,113,113,.24),rgba(251,146,60,.14));border:1px solid rgba(248,113,113,.34)}
#costos-redesign .cz-mission-ok .cz-alarmtag{background:linear-gradient(135deg,rgba(52,211,153,.2),rgba(52,217,224,.12));border-color:rgba(52,211,153,.34)}
#costos-redesign .cz-alarmtag-k{font-size:9.5px;font-weight:800;letter-spacing:1px;color:#fca5a5}
#costos-redesign .cz-mission-ok .cz-alarmtag-k{color:#7ee2bd}
#costos-redesign .cz-alarmtag-n{font-size:30px;font-weight:800;color:#fecaca;line-height:1;font-variant-numeric:tabular-nums}
#costos-redesign .cz-mission-ok .cz-alarmtag-n{color:#bbf7e0}
#costos-redesign .cz-alarmtag-s{font-size:9px;font-weight:700;color:#fca5a5;letter-spacing:.6px;margin-top:2px}
#costos-redesign .cz-mission-ok .cz-alarmtag-s{color:#7ee2bd}
#costos-redesign .cz-mtext{flex:1;min-width:0}
#costos-redesign .cz-mttl{font-size:18px;font-weight:800;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
#costos-redesign .cz-pill-warn{font-size:11px;color:#fdba74;background:rgba(251,146,60,.12);border:1px solid rgba(251,146,60,.3);padding:3px 9px;border-radius:20px;font-weight:700}
#costos-redesign .cz-pill-ok{font-size:11px;color:#7ee2bd;background:rgba(52,211,153,.12);border:1px solid rgba(52,211,153,.3);padding:3px 9px;border-radius:20px;font-weight:700}
#costos-redesign .cz-mdesc{font-size:13px;color:var(--cz-mut);margin-top:5px;max-width:620px;line-height:1.45}
#costos-redesign .cz-wmetrics{display:flex;gap:10px;margin-top:12px;flex-wrap:wrap}
#costos-redesign .cz-wm{flex:1;min-width:150px;background:rgba(255,255,255,.035);border:1px solid var(--cz-line);border-radius:11px;padding:9px 12px}
#costos-redesign .cz-wl{font-size:9.5px;font-weight:800;letter-spacing:.6px;color:var(--cz-mut2)}
#costos-redesign .cz-wv{font-size:17px;font-weight:800;margin-top:3px;line-height:1;font-variant-numeric:tabular-nums}
#costos-redesign .cz-wv.cz-accent{color:var(--cz-cy)}
#costos-redesign .cz-wsx{font-size:10px;color:var(--cz-mut2);margin-top:3px}
#costos-redesign .cz-mright{min-width:236px}
#costos-redesign .cz-oldest{background:rgba(251,146,60,.08);border:1px solid rgba(251,146,60,.26);border-radius:12px;padding:11px 13px}
#costos-redesign .cz-mission-ok .cz-oldest{background:rgba(52,211,153,.06);border-color:rgba(52,211,153,.22)}
#costos-redesign .cz-oldest-k{font-size:9.5px;font-weight:800;letter-spacing:.6px;color:#fdba74}
#costos-redesign .cz-mission-ok .cz-oldest-k{color:#7ee2bd}
#costos-redesign .cz-oldest-val{font-size:15px;font-weight:800;margin-top:4px}
#costos-redesign .cz-oldest-skill{color:#c9bcff}
#costos-redesign .cz-oldest-sub{font-size:10.5px;color:var(--cz-mut);margin-top:3px;line-height:1.35}
/* GRID + PANELS */
#costos-redesign .cz-grid{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:14px;margin-bottom:14px}
@media (max-width:1100px){#costos-redesign .cz-grid{grid-template-columns:1fr}}
#costos-redesign .cz-panel{background:linear-gradient(180deg,var(--cz-panel),var(--cz-panel2));border:1px solid var(--cz-line);border-radius:var(--cz-r);padding:18px 20px;margin-bottom:14px}
#costos-redesign .cz-ph{display:flex;align-items:center;gap:9px;margin-bottom:15px}
#costos-redesign .cz-pic{width:26px;height:26px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:13px;background:rgba(52,217,224,.12);border:1px solid rgba(52,217,224,.24)}
#costos-redesign .cz-pt{font-size:12.5px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:var(--cz-txt)}
#costos-redesign .cz-psub{font-size:11px;color:var(--cz-mut2);font-weight:600}
/* TOOLTIP */
#costos-redesign .cz-tipwrap{position:relative;display:inline-flex;margin-left:auto}
#costos-redesign .cz-tipi{width:18px;height:18px;border-radius:50%;border:1px solid var(--cz-line2);display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--cz-mut2);font-weight:800;cursor:help}
#costos-redesign .cz-tip{position:absolute;top:26px;right:-6px;z-index:30;width:250px;background:linear-gradient(180deg,#152028,#0f161d);border:1px solid rgba(52,217,224,.42);border-radius:11px;padding:11px 13px;box-shadow:0 18px 44px rgba(0,0,0,.55);opacity:0;visibility:hidden;transition:opacity .12s}
#costos-redesign .cz-tipwrap:hover .cz-tip,#costos-redesign .cz-tipwrap:focus-within .cz-tip{opacity:1;visibility:visible}
#costos-redesign .cz-th{font-size:11px;font-weight:800;color:#9fe9ee}
#costos-redesign .cz-tb{font-size:10.5px;color:var(--cz-mut);line-height:1.42;margin-top:5px}
/* CHART */
#costos-redesign .cz-chart-wrap{margin-top:4px}
#costos-redesign .cz-chartarea{position:relative;height:230px;margin:6px 4px 2px}
#costos-redesign .cz-ygrid{position:absolute;inset:0 0 26px 0;display:flex;flex-direction:column;justify-content:space-between}
#costos-redesign .cz-gl{display:flex;align-items:center;gap:8px}
#costos-redesign .cz-gv{font-size:9.5px;color:var(--cz-mut2);font-weight:700;width:42px;text-align:right;font-variant-numeric:tabular-nums}
#costos-redesign .cz-gln{flex:1;height:1px;background:var(--cz-line)}
#costos-redesign .cz-bars{position:absolute;left:50px;right:6px;top:0;bottom:26px;display:flex;align-items:flex-end;justify-content:space-between;gap:7px;padding:0 4px}
#costos-redesign .cz-budget-line{position:absolute;left:0;right:0;border-top:2px dashed rgba(52,217,224,.5);z-index:2}
#costos-redesign .cz-budtag{position:absolute;right:2px;font-size:10px;font-weight:800;color:#9fe9ee;background:rgba(52,217,224,.1);border:1px solid rgba(52,217,224,.3);border-radius:7px;padding:2px 8px;transform:translateY(-50%);z-index:3}
#costos-redesign .cz-bar{flex:1;display:flex;flex-direction:column;align-items:center;gap:7px;height:100%;justify-content:flex-end}
#costos-redesign .cz-stack{width:78%;max-width:42px;min-height:2px;display:flex;flex-direction:column-reverse;border-radius:6px 6px 0 0;overflow:hidden;box-shadow:0 -1px 0 rgba(255,255,255,.06) inset}
#costos-redesign .cz-stack-over{outline:1.5px solid rgba(248,113,113,.7);outline-offset:1px}
#costos-redesign .cz-seg{width:100%}
#costos-redesign .cz-seg-cl{background:linear-gradient(180deg,#34D9E0,#2596b8)}
#costos-redesign .cz-seg-cx{background:linear-gradient(180deg,#A78BFA,#7c5cff)}
#costos-redesign .cz-seg-gq{background:linear-gradient(180deg,#FB923C,#d97324)}
#costos-redesign .cz-seg-gm{background:linear-gradient(180deg,#60A5FA,#3b73c4)}
#costos-redesign .cz-seg-cb{background:linear-gradient(180deg,#34D399,#1f9c70)}
#costos-redesign .cz-seg-de{background:linear-gradient(180deg,#FBBF24,#d99a12)}
#costos-redesign .cz-seg-un{background:linear-gradient(180deg,#8A93A6,#5B6376)}
#costos-redesign .cz-bx{font-size:9.5px;color:var(--cz-mut2);font-weight:700}
#costos-redesign .cz-bx-hl{color:#fca5a5}
#costos-redesign .cz-legend{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:14px;padding-top:13px;border-top:1px solid var(--cz-line)}
#costos-redesign .cz-lg{display:flex;align-items:center;gap:7px;font-size:11.5px;font-weight:600;color:var(--cz-mut)}
#costos-redesign .cz-lg b{color:var(--cz-txt);font-weight:800;font-variant-numeric:tabular-nums}
#costos-redesign .cz-lg-free b{color:var(--cz-gr)}
#costos-redesign .cz-lg-summary{margin-left:auto;color:var(--cz-cy)}
#costos-redesign .cz-lg-summary b{color:var(--cz-cy)}
#costos-redesign .cz-sw{width:11px;height:11px;border-radius:4px}
#costos-redesign .cz-freetag{font-size:8.5px;font-weight:800;color:#7ee2bd;background:rgba(52,211,153,.12);border:1px solid rgba(52,211,153,.28);border-radius:6px;padding:1px 5px;letter-spacing:.3px}
/* BUDGET CONTROL */
#costos-redesign .cz-budgetbox{margin-top:15px;padding-top:14px;border-top:1px dashed var(--cz-line2);display:flex;align-items:center;gap:14px;flex-wrap:wrap}
#costos-redesign .cz-bl{font-size:12px;font-weight:700;color:var(--cz-mut)}
#costos-redesign .cz-ipt{display:flex;align-items:center;background:var(--cz-bg);border:1px solid var(--cz-line2);border-radius:10px;padding:9px 13px;gap:6px}
#costos-redesign .cz-cur{font-size:12px;color:var(--cz-mut2);font-weight:700}
#costos-redesign .cz-budget-input{background:none;border:none;outline:none;color:var(--cz-txt);font-size:15px;font-weight:800;width:72px}
#costos-redesign .cz-per{font-size:11px;color:var(--cz-mut2)}
#costos-redesign .cz-savebtn{font-size:12.5px;font-weight:800;color:#06121a;background:linear-gradient(135deg,#34D9E0,#5A8DEE);border:none;border-radius:10px;padding:10px 18px;cursor:pointer}
#costos-redesign .cz-savebtn:disabled{opacity:.6;cursor:default}
#costos-redesign .cz-snooze-chip{background:rgba(91,110,225,.18);color:#c9d2ff;border:1px solid rgba(91,110,225,.4);border-radius:999px;padding:5px 12px;font-size:12px;font-weight:700}
#costos-redesign .cz-hint{font-size:10.5px;color:var(--cz-mut2);max-width:280px;line-height:1.35}
#costos-redesign .cz-budget-status{font-size:12px;width:100%;min-height:14px}
#costos-redesign .cz-ok{color:var(--cz-gr)}
#costos-redesign .cz-bad{color:var(--cz-rd)}
/* PROYECCIONES */
#costos-redesign .cz-projcards{display:flex;flex-direction:column;gap:11px}
#costos-redesign .cz-proj{background:rgba(255,255,255,.025);border:1px solid var(--cz-line);border-radius:13px;padding:13px 15px;position:relative}
#costos-redesign .cz-proj-alert{border-color:rgba(248,113,113,.4);background:linear-gradient(180deg,rgba(248,113,113,.08),rgba(255,255,255,.01))}
#costos-redesign .cz-pk{font-size:9.5px;font-weight:800;letter-spacing:.7px;color:var(--cz-mut2);text-transform:uppercase}
#costos-redesign .cz-pk-alert{color:#fca5a5}
#costos-redesign .cz-pv{font-size:25px;font-weight:800;line-height:1.05;margin-top:6px;font-variant-numeric:tabular-nums}
#costos-redesign .cz-pv-bad{color:var(--cz-rd)}
#costos-redesign .cz-pv-ok{color:var(--cz-gr)}
#costos-redesign .cz-pf{font-size:10.5px;color:var(--cz-mut2);margin-top:5px;line-height:1.3}
#costos-redesign .cz-pbadge{position:absolute;top:13px;right:14px;font-size:10px;font-weight:800;border-radius:8px;padding:3px 9px;color:#fecaca;background:rgba(248,113,113,.18);border:1px solid rgba(248,113,113,.4)}
#costos-redesign .cz-mixnote{margin-top:13px;padding:11px 13px;border-radius:12px;background:rgba(52,211,153,.06);border:1px solid rgba(52,211,153,.2)}
#costos-redesign .cz-mk{font-size:9.5px;font-weight:800;letter-spacing:.6px;color:#7ee2bd;text-transform:uppercase}
#costos-redesign .cz-mv{font-size:11.5px;color:var(--cz-mut);margin-top:5px;line-height:1.4}
#costos-redesign .cz-mv b{color:var(--cz-txt)}
/* DETALLE POR SKILL */
#costos-redesign .cz-skilltable{display:flex;flex-direction:column;gap:5px}
#costos-redesign .cz-srow{display:grid;grid-template-columns:160px 128px 1fr 96px 64px;gap:12px;align-items:center;padding:9px 13px;border-radius:11px;background:rgba(255,255,255,.022);border:1px solid var(--cz-line)}
@media (max-width:760px){#costos-redesign .cz-srow{grid-template-columns:1fr auto auto}#costos-redesign .cz-meter{display:none}}
#costos-redesign .cz-srow-top{border-color:rgba(52,217,224,.22);background:rgba(52,217,224,.04)}
#costos-redesign .cz-sk{display:flex;align-items:center;gap:9px;min-width:0}
#costos-redesign .cz-si{width:24px;height:24px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:12px;flex:none;background:rgba(255,255,255,.05);border:1px solid var(--cz-line2)}
#costos-redesign .cz-sn{font-size:13px;font-weight:700;color:var(--cz-txt);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#costos-redesign .cz-pchip{display:inline-flex;align-items:center;gap:6px;font-size:10.5px;font-weight:700;padding:4px 9px;border-radius:8px;background:rgba(255,255,255,.04);border:1px solid var(--cz-line2);color:var(--cz-mut)}
#costos-redesign .cz-pchip-free{color:#9fe9ee}
#costos-redesign .cz-pd{width:8px;height:8px;border-radius:50%;flex:none}
#costos-redesign .cz-meter{height:8px;border-radius:5px;background:rgba(255,255,255,.06);overflow:hidden}
#costos-redesign .cz-meter i{display:block;height:100%;border-radius:5px}
#costos-redesign .cz-meter-z i{background:rgba(255,255,255,.12)}
#costos-redesign .cz-scost{font-size:14px;font-weight:800;text-align:right;font-variant-numeric:tabular-nums}
#costos-redesign .cz-scost-zero{color:var(--cz-mut2);font-weight:700}
#costos-redesign .cz-sses{font-size:10.5px;color:var(--cz-mut2);text-align:right;font-weight:600}
#costos-redesign .cz-foot{margin-top:13px;padding-top:12px;border-top:1px dashed var(--cz-line2);font-size:11px;color:var(--cz-mut2);line-height:1.4}
#costos-redesign .cz-foot code{background:rgba(255,255,255,.06);padding:1px 5px;border-radius:5px}
/* CUOTA POR PROVEEDOR */
#costos-redesign .cz-quotanote{font-size:11.5px;color:var(--cz-mut);line-height:1.45;margin-bottom:15px}
#costos-redesign .cz-quotanote b{color:var(--cz-txt)}
#costos-redesign .cz-pqgrid{display:grid;grid-template-columns:repeat(5,1fr);gap:11px}
@media (max-width:1100px){#costos-redesign .cz-pqgrid{grid-template-columns:repeat(2,1fr)}}
@media (max-width:560px){#costos-redesign .cz-pqgrid{grid-template-columns:1fr}}
#costos-redesign .cz-pq{background:rgba(255,255,255,.025);border:1px solid var(--cz-line);border-radius:13px;padding:13px 14px;display:flex;flex-direction:column;gap:11px;position:relative;overflow:hidden}
#costos-redesign .cz-pq::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px}
#costos-redesign .cz-pq-cl::before{background:#34D9E0}
#costos-redesign .cz-pq-cx::before{background:#A78BFA}
#costos-redesign .cz-pq-gq::before{background:#FB923C}
#costos-redesign .cz-pq-gm::before{background:#60A5FA}
#costos-redesign .cz-pq-cb::before{background:#34D399}
#costos-redesign .cz-pqtop{display:flex;align-items:center;gap:8px}
#costos-redesign .cz-pqtop .cz-pd{width:11px;height:11px}
#costos-redesign .cz-pn{font-size:13.5px;font-weight:800;color:var(--cz-txt)}
#costos-redesign .cz-ptier{margin-left:auto;font-size:8.5px;font-weight:800;letter-spacing:.5px;padding:3px 7px;border-radius:7px}
#costos-redesign .cz-ptier-pay{color:#fecaca;background:rgba(248,113,113,.13);border:1px solid rgba(248,113,113,.3)}
#costos-redesign .cz-ptier-max{color:#c9bcff;background:rgba(167,139,250,.13);border:1px solid rgba(167,139,250,.32)}
#costos-redesign .cz-ptier-free{color:#7ee2bd;background:rgba(52,211,153,.12);border:1px solid rgba(52,211,153,.3)}
#costos-redesign .cz-ptier-det{color:#fde68a;background:rgba(251,191,36,.12);border:1px solid rgba(251,191,36,.3)}
#costos-redesign .cz-pl{display:flex;align-items:baseline;justify-content:space-between;font-size:10px;font-weight:700;color:var(--cz-mut2);gap:8px}
#costos-redesign .cz-pl b{font-size:13px;font-weight:800;color:var(--cz-txt);font-variant-numeric:tabular-nums}
#costos-redesign .cz-pqbar{height:7px;border-radius:5px;background:rgba(255,255,255,.06);overflow:hidden;margin-top:5px}
#costos-redesign .cz-pqbar i{display:block;height:100%;border-radius:5px}
#costos-redesign .cz-pqreset{font-size:9.5px;color:var(--cz-mut2);line-height:1.35;margin-top:auto}
#costos-redesign .cz-est{color:#fdba74;font-weight:700}
/* CALIBRACIÓN */
#costos-redesign .cz-calib{margin-top:16px;border-top:1px solid var(--cz-line);padding-top:13px}
#costos-redesign .cz-calib>summary{cursor:pointer;font-size:12px;color:var(--cz-mut);user-select:none;font-weight:600}
#costos-redesign .cz-calib-help{font-size:11px;color:var(--cz-mut2);margin:10px 0 8px}
#costos-redesign .cz-calib-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}
@media (max-width:560px){#costos-redesign .cz-calib-grid{grid-template-columns:1fr}}
#costos-redesign .cz-calib-grid label{font-size:11px;color:var(--cz-mut2);display:block;margin-bottom:4px}
#costos-redesign .cz-calib-grid input{width:100%;background:var(--cz-bg);border:1px solid var(--cz-line2);border-radius:8px;padding:7px 10px;color:var(--cz-txt);font-size:13px;font-family:'Cascadia Code',Consolas,monospace}
#costos-redesign .cz-calib-actions{display:flex;gap:8px;flex-wrap:wrap}
#costos-redesign .cz-calib-btn{font-size:12px;font-weight:700;padding:8px 14px;border-radius:9px;cursor:pointer;background:transparent;border:1px solid var(--cz-line2);color:var(--cz-mut)}
#costos-redesign .cz-calib-apply{border-color:var(--cz-cy);color:var(--cz-cy)}
#costos-redesign .cz-calib-status{margin-top:10px;font-size:11px;color:var(--cz-mut2)}
</style>`;
}

module.exports = {
    renderCostosPill,
    renderCostosBanner,
    renderInert,
    renderCostosClientScript,
    TOOLTIPS,
    // #4194 EP7.1 — rediseño integral MIZPÁ de la pantalla Costos
    renderMissionBanner,
    renderCostosChart,
    renderBudgetForm,
    renderProjectionsCards,
    renderDrillDown,
    renderProviderQuota,
    renderCalibrationTool,
    renderBudgetClientScript,
    renderCostosRedesign,
    PROVIDER_STACK_ORDER,
};
