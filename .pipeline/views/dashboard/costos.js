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
// #3962 EP8-H9 — Rediseño de la pantalla Costos: gráfico de área apilada por
// proveedor + línea de presupuesto + banda de anomalía sobre el gráfico,
// presupuesto configurable, proyecciones con método y drill-down por skill.
//
// SVG NATIVO (sin librería de charting → cumple REQ-SEC supply-chain A06/A08).
// Todo dato dinámico pasa por escapeHtmlText/escapeHtmlAttr. El timestamp de
// inicio de la anomalía se valida como ISO finito ANTES de pintar la banda
// (REQ-SEC XSS A03 — degradación segura si el ts no es válido).
// =============================================================================

// Orden de apilado FIJO bottom→top (guía UX §A), determinístico entre renders,
// NO derivado del orden de iteración del Map. `openai-codex` es el provider real
// de Codex en el activity-log.
const PROVIDER_STACK_ORDER = ['anthropic', 'openai-codex', 'groq', 'gemini', 'cerebras'];

// Color identitario por proveedor (familia design-tokens 3.c/3.d). Se usa
// `var(--token, #fallback)` para funcionar aunque design-tokens.css no esté
// cargado en el shell. `unknown` cae al token de warning.
const PROVIDER_COLORS = {
    'anthropic':    'var(--provider-anthropic, #E5946B)',
    'openai-codex': 'var(--provider-openai-codex, #10B981)',
    'groq':         'var(--provider-groq, #FF6B47)',
    'gemini':       'var(--provider-gemini, #8AB4F8)',
    'cerebras':     'var(--provider-cerebras, #FFD166)',
    'unknown':      'var(--provider-unknown, var(--warning, #F0A020))',
};

const PROVIDER_LABELS = {
    'anthropic': 'Claude',
    'openai-codex': 'Codex',
    'groq': 'Groq',
    'gemini': 'Gemini',
    'cerebras': 'Cerebras',
    'unknown': 'Desconocido',
};

function providerColor(p) { return PROVIDER_COLORS[p] || PROVIDER_COLORS.unknown; }
function providerLabel(p) { return PROVIDER_LABELS[p] || p; }

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

// Fecha+hora corta para el pill de la anomalía. '' si no es válido.
function shortDateTime(iso) {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return '';
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function fmtUsd(n) {
    const v = Number(n || 0);
    return '$' + (Number.isFinite(v) ? v.toFixed(2) : '0.00');
}

function fmtDuration(ms) {
    const n = Number(ms || 0);
    if (!Number.isFinite(n) || n <= 0) return '0s';
    const s = Math.round(n / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    const rs = s % 60;
    if (m < 60) return m + 'm ' + rs + 's';
    const h = Math.floor(m / 60);
    return h + 'h ' + (m % 60) + 'm';
}

// --- Gráfico principal: área apilada + línea de presupuesto + banda anomalía --
// (CA-1 + CA-2)
function renderCostosChart(slice) {
    try {
        const s = slice || {};
        const rows = Array.isArray(s.dailyByProvider) ? s.dailyByProvider : [];

        // Días únicos ordenados.
        const daySet = [];
        const seen = new Set();
        for (const r of rows) {
            const day = String(r && r.day || '');
            if (day && !seen.has(day)) { seen.add(day); daySet.push(day); }
        }
        daySet.sort((a, b) => a.localeCompare(b));

        // Proveedores presentes, en orden de apilado fijo; los que no estén en
        // la allowlist van después (orden alfabético), con color `unknown`.
        const presentProviders = new Set(rows.map((r) => String(r && r.provider || 'unknown')));
        const ordered = PROVIDER_STACK_ORDER.filter((p) => presentProviders.has(p));
        const extras = [...presentProviders].filter((p) => !PROVIDER_STACK_ORDER.includes(p)).sort();
        const providers = ordered.concat(extras);

        // Mapa day → provider → cost.
        const byDay = new Map();
        for (const r of rows) {
            const day = String(r && r.day || '');
            const prov = String(r && r.provider || 'unknown');
            if (!day) continue;
            if (!byDay.has(day)) byDay.set(day, {});
            byDay.get(day)[prov] = (byDay.get(day)[prov] || 0) + Number(r && r.cost_usd || 0);
        }

        // Geometría.
        const W = 720, H = 280;
        const padL = 48, padR = 16, padT = 16, padB = 28;
        const innerW = W - padL - padR;
        const innerH = H - padT - padB;

        // Eje X: si hay 1 solo día duplicamos para formar una banda visible.
        const xDays = daySet.length >= 1 ? daySet : [];
        const nPoints = Math.max(xDays.length, 1);
        const xFor = (i) => {
            if (nPoints === 1) return padL + innerW / 2;
            return padL + (innerW * i) / (nPoints - 1);
        };

        // Presupuesto diario equivalente = mensual ÷ días del mes (último día).
        const monthlyBudget = Number(s.budget && s.budget.monthly_usd) || 0;
        const refDay = xDays.length ? xDays[xDays.length - 1] : null;
        const budgetDaily = monthlyBudget > 0 ? monthlyBudget / daysInMonthOf(refDay) : 0;

        // Escala Y: máximo total apilado por día, contemplando la línea de ppto.
        let maxTotal = 0;
        for (const day of xDays) {
            const o = byDay.get(day) || {};
            let sum = 0;
            for (const p of providers) sum += Number(o[p] || 0);
            if (sum > maxTotal) maxTotal = sum;
        }
        const yMax = Math.max(maxTotal, budgetDaily, 0.0001) * 1.12;
        const yFor = (v) => padT + innerH * (1 - (v / yMax));

        // Construir un <path> de área por proveedor (banda apilada). Acumulamos
        // baseline por día.
        const baseline = new Array(nPoints).fill(0);
        let areasSvg = '';
        for (const prov of providers) {
            const topYs = [];
            const botYs = [];
            for (let i = 0; i < nPoints; i++) {
                const day = nPoints === 1 ? (xDays[0] || null) : xDays[i];
                const val = day ? Number((byDay.get(day) || {})[prov] || 0) : 0;
                const y0 = baseline[i];
                const y1 = y0 + val;
                botYs.push(yFor(y0));
                topYs.push(yFor(y1));
                baseline[i] = y1;
            }
            // Path: top edge L→R, luego bottom edge R→L.
            let d = '';
            for (let i = 0; i < nPoints; i++) {
                d += (i === 0 ? 'M' : 'L') + xFor(i).toFixed(1) + ',' + topYs[i].toFixed(1) + ' ';
            }
            for (let i = nPoints - 1; i >= 0; i--) {
                d += 'L' + xFor(i).toFixed(1) + ',' + botYs[i].toFixed(1) + ' ';
            }
            d += 'Z';
            areasSvg += `<path class="cz-area cz-area-${escapeHtmlAttr(prov)}" d="${escapeHtmlAttr(d)}" `
                + `fill="${providerColor(prov)}" fill-opacity="0.85" stroke="none"></path>`;
        }

        // Línea de presupuesto (cyan punteada). Solo si hay presupuesto > 0.
        let budgetSvg = '';
        if (budgetDaily > 0) {
            const by = yFor(budgetDaily).toFixed(1);
            budgetSvg = `<line class="cz-budget-line" x1="${padL}" y1="${by}" x2="${W - padR}" y2="${by}" `
                + `stroke="var(--brand-cyan, #00D6FF)" stroke-width="2" stroke-dasharray="10 6"></line>`
                + `<text class="cz-budget-label" x="${W - padR}" y="${(Number(by) - 5).toFixed(1)}" `
                + `text-anchor="end" fill="var(--brand-cyan, #00D6FF)" font-size="11">Presupuesto ${escapeHtmlText(fmtUsd(budgetDaily))}/día</text>`;
        }

        // Banda de anomalía (CA-2). SOLO si hay anomalía activa Y el ts es ISO
        // finito (REQ-SEC XSS A03 — degradación segura). El rect arranca en la X
        // del día del ts (clamp a los bordes) y se extiende al borde derecho.
        let anomalySvg = '';
        const anomaly = s.anomaly || {};
        const startTs = anomaly.startTs;
        const startMs = Date.parse(startTs);
        if (anomaly.active && Number.isFinite(startMs) && xDays.length > 0) {
            const startDay = new Date(startMs).toISOString().slice(0, 10);
            // Índice del día del ts dentro del eje; clamp.
            let idx = xDays.findIndex((d) => d >= startDay);
            if (idx < 0) idx = nPoints - 1; // ts posterior a toda la serie → borde derecho
            const ax = xFor(idx).toFixed(1);
            const bandW = (W - padR - Number(ax)).toFixed(1);
            const pillLabel = 'inicio anomalía · ' + shortDateTime(startTs);
            anomalySvg = `<rect class="cz-anomaly-band" x="${ax}" y="${padT}" width="${bandW}" height="${innerH}" `
                + `fill="var(--alert-anomaly-bg, rgba(255,107,138,0.14))"></rect>`
                + `<line class="cz-anomaly-line" x1="${ax}" y1="${padT}" x2="${ax}" y2="${padT + innerH}" `
                + `stroke="var(--alert-anomaly, #FF6B8A)" stroke-width="1.5" stroke-dasharray="4 4"></line>`
                + `<text class="cz-anomaly-pill" x="${(Number(ax) + 4).toFixed(1)}" y="${padT + 12}" `
                + `fill="var(--alert-anomaly, #FF6B8A)" font-size="11">${escapeHtmlText(pillLabel)}</text>`;
        }

        // Leyenda con etiqueta de texto (dual-encoding a11y, nunca color-solo).
        const legend = providers.map((p) =>
            `<span class="cz-legend-item">`
            + `<span class="cz-legend-swatch" style="background:${providerColor(p)}"></span>`
            + `<span>${escapeHtmlText(providerLabel(p))}</span></span>`
        ).join('');

        const emptyNote = xDays.length === 0
            ? `<div class="cz-empty">Sin datos de consumo en el activity-log todavía.</div>`
            : '';

        return `<div class="cz-chart-wrap">
  <svg class="cz-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Consumo diario por proveedor con línea de presupuesto">
    ${anomalySvg}
    ${areasSvg}
    ${budgetSvg}
  </svg>
  <div class="cz-legend">${legend}</div>
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

        return `<div class="cz-budget">
  <div class="cz-budget-row">
    <label class="cz-budget-label-text" for="cz-budget-input">Presupuesto mensual</label>
    <div class="cz-budget-input-wrap">
      <span class="cz-budget-prefix">US$</span>
      <input id="cz-budget-input" class="cz-budget-input" type="number" min="1" step="1"
             value="${escapeHtmlAttr(current > 0 ? String(current) : '')}" placeholder="100" inputmode="decimal" />
      <span class="cz-budget-suffix">/ mes</span>
    </div>
    <button id="cz-budget-save" class="cz-budget-save" type="button">Guardar</button>
    ${snoozeChip}
  </div>
  <div class="cz-budget-help">Valor actual: ${escapeHtmlText(fmtUsd(current))} (${escapeHtmlText(sourceTxt)}). Numérico &gt; 0; se valida en el servidor.</div>
  <div id="cz-budget-status" class="cz-budget-status" role="status" aria-live="polite"></div>
</div>`;
    } catch (e) {
        return `<div class="cz-empty">Formulario de presupuesto no disponible.</div>`;
    }
}

// --- Proyecciones con método explicado (CA-6) -------------------------------
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
        const devStatus = quota.status || 'ok';
        const devClass = devStatus === 'over' ? 'cz-bad' : (devStatus === 'warning' ? 'cz-warn' : 'cz-ok');

        const cards = [
            {
                label: 'Proyección semanal',
                value: fmtUsd(proj.weekly_projection_usd),
                method: method.weekly || 'promedio diario × 7',
                cls: '',
            },
            {
                label: 'Cierre de mes (proyectado)',
                value: fmtUsd(proj.monthly_forecast_usd != null ? proj.monthly_forecast_usd : proj.monthly_projection_usd),
                method: method.monthly || 'promedio diario × días del mes',
                cls: '',
            },
            {
                label: 'Desvío vs presupuesto',
                value: devPct != null ? (devPct >= 0 ? '+' : '') + devPct + '%' : '—',
                method: method.deviation || '(proyección mensual ÷ presupuesto) − 1',
                cls: devClass,
            },
        ];

        const html = cards.map((c) =>
            `<div class="cz-proj-card ${c.cls}">
  <div class="cz-proj-label">${escapeHtmlText(c.label)}</div>
  <div class="cz-proj-value">${escapeHtmlText(c.value)}</div>
  <div class="cz-proj-method" title="Método de cálculo">${escapeHtmlText(c.method)}</div>
</div>`
        ).join('');

        return `<div class="cz-proj-grid">${html}</div>`;
    } catch (e) {
        return `<div class="cz-empty">Proyecciones no disponibles.</div>`;
    }
}

// --- Drill-down por skill → sesiones (CA-3) ---------------------------------
// El payload ya viene REDACTADO del aggregator + slice (whitelist de 4 campos).
// Acá solo escapamos para render. NUNCA se pintan paths/tokens/prompts/issue.
function renderDrillDown(slice) {
    try {
        const s = slice || {};
        const bySkill = (s.sessionsBySkill && typeof s.sessionsBySkill === 'object') ? s.sessionsBySkill : {};
        const skills = Object.keys(bySkill);
        if (skills.length === 0) {
            return `<div class="cz-empty">Sin sesiones para el drill-down.</div>`;
        }
        // Orden de skills por costo total desc.
        const totals = skills.map((sk) => {
            const list = Array.isArray(bySkill[sk]) ? bySkill[sk] : [];
            const total = list.reduce((acc, x) => acc + Number(x && x.cost_usd || 0), 0);
            return { skill: sk, total, list };
        }).sort((a, b) => b.total - a.total);

        const rows = totals.map(({ skill, total, list }) => {
            const sessionsHtml = list
                .slice()
                .sort((a, b) => Number(b.cost_usd || 0) - Number(a.cost_usd || 0))
                .map((x) =>
                    `<tr>
  <td>${escapeHtmlText(providerLabel(String(x.provider || 'unknown')))}</td>
  <td class="cz-num">${escapeHtmlText(fmtUsd(x.cost_usd))}</td>
  <td class="cz-num">${escapeHtmlText(fmtDuration(x.duration_ms))}</td>
</tr>`
                ).join('');
            return `<details class="cz-drill-skill">
  <summary><span class="cz-drill-name">${escapeHtmlText(skill)}</span>`
                + `<span class="cz-drill-total">${escapeHtmlText(fmtUsd(total))} · ${list.length} ses.</span></summary>
  <table class="cz-drill-table">
    <thead><tr><th>Proveedor</th><th class="cz-num">Costo</th><th class="cz-num">Duración</th></tr></thead>
    <tbody>${sessionsHtml}</tbody>
  </table>
</details>`;
        }).join('');

        return `<div class="cz-drill">${rows}
  <div class="cz-drill-note">Drill-down saneado: solo skill, proveedor, costo y duración. Sin paths, prompts ni tokens.</div>
</div>`;
    } catch (e) {
        return `<div class="cz-empty">Drill-down no disponible.</div>`;
    }
}

// --- Script cliente del presupuesto: POST + re-render sin recarga completa ---
// Replica el cinturón same-origin del cliente (fetch mismo origen). Tras un POST
// 200, re-fetchea el partial de la vista Costos y reemplaza el contenido (DOM
// morphing) para que la línea de presupuesto y las proyecciones reflejen el
// nuevo valor sin recargar la página (CA-4). CSP-safe (sin onclick inline).
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

// --- Composición de la pantalla rediseñada (entry point para el view) -------
// Devuelve el bloque HTML completo del rediseño (chart + presupuesto +
// proyecciones + drill-down + estilos + script). Pensado para inyectarse arriba
// del contenido legacy de la pantalla Costos (CA-7: aditivo, sin regresión).
function renderCostosRedesign(slice) {
    let inner;
    try {
        inner = `
  <section class="in-section">
    <h2 class="in-section-title"><span class="in-section-title-icon">📈</span>Consumo diario por proveedor</h2>
    ${renderCostosChart(slice)}
    ${renderBudgetForm(slice)}
  </section>
  <section class="in-section">
    <h2 class="in-section-title"><span class="in-section-title-icon">🔮</span>Proyecciones</h2>
    ${renderProjectionsCards(slice)}
  </section>
  <section class="in-section">
    <h2 class="in-section-title"><span class="in-section-title-icon">🔎</span>Detalle por skill</h2>
    ${renderDrillDown(slice)}
  </section>`;
    } catch (e) {
        inner = `<section class="in-section"><div class="cz-empty">Rediseño de Costos no disponible.</div></section>`;
    }
    return `<div id="costos-redesign">${costosRedesignStyle()}${inner}${renderBudgetClientScript()}</div>`;
}

function costosRedesignStyle() {
    return `<style>
#costos-redesign .cz-chart-wrap { background: var(--in-bg-3, #1a1d24); border: 1px solid var(--in-border, #2a2f3a); border-radius: var(--in-radius, 10px); padding: 14px; }
#costos-redesign .cz-chart { width: 100%; height: auto; display: block; }
#costos-redesign .cz-legend { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 10px; font-size: 12px; color: var(--in-fg-dim, #9aa4b2); }
#costos-redesign .cz-legend-item { display: inline-flex; align-items: center; gap: 6px; }
#costos-redesign .cz-legend-swatch { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
#costos-redesign .cz-empty { color: var(--in-fg-dim, #9aa4b2); font-size: 13px; padding: 12px 0; }
#costos-redesign .cz-budget { margin-top: 14px; }
#costos-redesign .cz-budget-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
#costos-redesign .cz-budget-label-text { font-size: 12px; color: var(--in-fg-dim, #9aa4b2); }
#costos-redesign .cz-budget-input-wrap { display: inline-flex; align-items: center; gap: 4px; background: var(--in-bg-2, #11141a); border: 1px solid var(--in-border, #2a2f3a); border-radius: 8px; padding: 4px 8px; }
#costos-redesign .cz-budget-input { width: 90px; background: transparent; border: none; color: var(--in-fg, #e6e9ef); font-family: var(--in-mono, monospace); font-size: 14px; outline: none; }
#costos-redesign .cz-budget-prefix, #costos-redesign .cz-budget-suffix { font-size: 12px; color: var(--in-fg-dim, #9aa4b2); }
#costos-redesign .cz-budget-save { background: var(--brand-blue, #1890FF); color: #fff; border: none; border-radius: 8px; padding: 7px 14px; font-size: 13px; cursor: pointer; min-height: 40px; }
#costos-redesign .cz-budget-save:disabled { opacity: 0.6; cursor: default; }
#costos-redesign .cz-snooze-chip { background: var(--rest-mode, #5b6ee1); color: #fff; border-radius: 999px; padding: 5px 12px; font-size: 12px; }
#costos-redesign .cz-budget-help { font-size: 11px; color: var(--in-fg-dim, #9aa4b2); margin-top: 8px; }
#costos-redesign .cz-budget-status { font-size: 12px; margin-top: 6px; min-height: 16px; }
#costos-redesign .cz-ok { color: var(--success, var(--in-ok, #3ecf8e)); }
#costos-redesign .cz-warn { color: var(--warning, var(--in-warn, #f0a020)); }
#costos-redesign .cz-bad { color: var(--danger, var(--in-bad, #ff5c5c)); }
#costos-redesign .cz-proj-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
#costos-redesign .cz-proj-card { background: var(--in-bg-3, #1a1d24); border: 1px solid var(--in-border, #2a2f3a); border-radius: var(--in-radius, 10px); padding: 14px; display: flex; flex-direction: column; gap: 6px; }
#costos-redesign .cz-proj-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--in-fg-dim, #9aa4b2); }
#costos-redesign .cz-proj-value { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; }
#costos-redesign .cz-proj-card.cz-bad .cz-proj-value { color: var(--danger, #ff5c5c); }
#costos-redesign .cz-proj-card.cz-warn .cz-proj-value { color: var(--warning, #f0a020); }
#costos-redesign .cz-proj-method { font-size: 11px; color: var(--in-fg-dim, #9aa4b2); background: var(--in-bg-2, #11141a); border-radius: 6px; padding: 3px 8px; align-self: flex-start; }
#costos-redesign .cz-drill { display: flex; flex-direction: column; gap: 6px; }
#costos-redesign .cz-drill-skill { background: var(--in-bg-3, #1a1d24); border: 1px solid var(--in-border, #2a2f3a); border-radius: 8px; padding: 8px 12px; }
#costos-redesign .cz-drill-skill > summary { cursor: pointer; display: flex; justify-content: space-between; gap: 12px; font-size: 13px; }
#costos-redesign .cz-drill-name { font-family: var(--in-mono, monospace); }
#costos-redesign .cz-drill-total { color: var(--in-fg-dim, #9aa4b2); }
#costos-redesign .cz-drill-table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 12px; }
#costos-redesign .cz-drill-table th, #costos-redesign .cz-drill-table td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--in-border, #2a2f3a); }
#costos-redesign .cz-drill-table .cz-num { text-align: right; font-variant-numeric: tabular-nums; }
#costos-redesign .cz-drill-note { font-size: 11px; color: var(--in-fg-dim, #9aa4b2); margin-top: 8px; font-style: italic; }
</style>`;
}

module.exports = {
    renderCostosPill,
    renderCostosBanner,
    renderInert,
    renderCostosClientScript,
    TOOLTIPS,
    // #3962 EP8-H9 — rediseño de la pantalla Costos
    renderCostosChart,
    renderBudgetForm,
    renderProjectionsCards,
    renderDrillDown,
    renderBudgetClientScript,
    renderCostosRedesign,
    PROVIDER_STACK_ORDER,
};
