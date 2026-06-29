// =============================================================================
// bloqueados.js — Vista SSR de la ventana "Bloqueados / Necesitan intervención
// humana" del dashboard V3 (`/bloqueados` legacy + `/dashboard?view=bloqueados`).
//
// Issue: #3729 (split de #3715 — extracción de la ventana Bloqueados del
// monolito `dashboard.js:2371-2439` + estilos `.needs-human-*` + handlers
// `needsHuman*`). Lista los issues donde un agente pidió intervención humana
// (`reportHumanBlock(...)`) o que tienen label `needs-human`.
//
// Estructura (patrón de las hermanas matriz.js / kpis.js / ops.js + contrato
// del issue + narrativa UX `narrativa-bloqueados-v3.md`):
//   - renderBloqueadosSsr(state)        → fragmento `<main id="view-content"
//                                          data-slug="bloqueados">` con las filas
//                                          renderizadas server-side (boundary del
//                                          router #3773). Lo embebe el monolito
//                                          legacy y el router cliente.
//   - renderBloqueadosClientScript()    → handlers `needsHumanReactivate`,
//                                          `needsHumanDismiss`,
//                                          `toggleNeedsHumanPanel` portados del
//                                          monolito (window.* para no romper los
//                                          onclick="" del SSR).
//   - renderBloqueados(state)           → documento SSR completo (shell satélite
//                                          + nav V3 + fragmento + script).
//   - slug                              → 'bloqueados' (clave de VIEW_SLUGS).
//
// Seguridad (CA-B3 / CA-D1 + comentario de security del issue):
//   - TODA interpolación dinámica pasa por escapeHtmlText (contexto texto) o
//     escapeHtmlAttr (contexto atributo: title="", aria-label="") de
//     lib/escape-html.js (#3722). NO se reusa el esc() global del monolito.
//   - `b.issue` se coacciona con safeIssueNumber() (Number.isInteger && > 0)
//     antes de interpolarse en href/onclick/aria-label. Si falla, la fila se
//     descarta silenciosamente (con warning server-side).
//
// Accesibilidad (CA-E1..E4): severidad dual-encoded (rail + pill con ícono +
// texto numérico de edad), aria-label en cada acción, prefers-reduced-motion.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

// #3726 — Nav bar V3 unificada (renderNavTabsSsr + loadIconSprite del cache
// compartido del sprite.svg). Misma dependencia que home.js / matriz.js.
const { renderNavTabsSsr, loadIconSprite } = require('./nav-tabs');

// #3953 (EP8-H0) — Wrapper único de fetchJson (CA-2) + framework de modal de
// confirmación con preview (CA-3) que reemplaza confirm() nativo. nhCsrfHeaders
// se centraliza en FETCH_CLIENT_JS (R2).
const { FETCH_CLIENT_JS } = require('./fetch-client.js');
const { CONFIRM_MODAL_JS } = require('./confirm-modal.js');
// #4296 — Accessor compartido del banner de ola (avance %, velocidad %/h, ETA)
// desde la fuente determinística viva /api/dash/ola-eta (no conteos done/total).
const { missionOlaEtaClientScript } = require('../../lib/mission-ola-eta.js');

// #4238 (Ola 7.x) — BLOQUEADOS adopta el marco común de ventanas MIZPÁ. Se
// reutiliza el helper compartido `renderMissionBanner` de la HOME (#4189) — la
// cabecera de ola común (② del marco: tag OLA + título + métricas + bloque
// AVANCE) — en vez de duplicar su markup (CA-5), tal como lo hizo EQUIPO (#4258).
// Degradación defensiva: si el módulo no carga, el slot del banner queda vacío y
// el resto del marco (① marca + ③ nav + ④ contenido propio) sigue intacto.
let homeView = null;
try { homeView = require('./home'); } catch (_) { /* sin cabecera de ola común */ }

// #3722 — Escape HTML server-side unificado (CA-B3). escapeHtmlText para
// contexto nodo-texto, escapeHtmlAttr para contexto atributo. Fallback inline
// (defense-in-depth) por si el require fallara en un checkout transitorio.
let escapeHtmlText, escapeHtmlAttr;
try {
    ({ escapeHtmlText, escapeHtmlAttr } = require('../../lib/escape-html.js'));
} catch {
    escapeHtmlText = (s) => (s == null ? '' : String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])));
    escapeHtmlAttr = (s) => (s == null ? '' : String(s).replace(/[&<>"'`]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c])));
}

const THEME_CSS_PATH = path.join(__dirname, 'theme.css');
function loadTheme() {
    try { return fs.readFileSync(THEME_CSS_PATH, 'utf8'); } catch { return ''; }
}

const slug = 'bloqueados';

// Compat: las hermanas exportan `escapeHtmlSsr`. Delega en el helper compartido.
function escapeHtmlSsr(s) {
    return escapeHtmlText(s);
}

// CA-D1 — coerción numérica estricta de `b.issue` antes de interpolar en
// href/onclick/aria-label. Origen filesystem-controlled (bajo riesgo) pero la
// defensa en profundidad lo exige. Devuelve el entero positivo o null.
function safeIssueNumber(raw) {
    const n = Number(raw);
    return (Number.isInteger(n) && n > 0) ? n : null;
}

// Tres umbrales de severidad por edad (D2 de la narrativa UX):
//   fresh  < 4h   → info
//   warning 4-24h → warning
//   danger ≥ 24h  → danger
function severityOf(ageHours) {
    const h = Number(ageHours);
    if (!Number.isFinite(h)) return 'info';
    if (h >= 24) return 'danger';
    if (h >= 4) return 'warning';
    return 'info';
}

// Edad legible compacta: "47min" / "29h". Reusa la lógica del monolito.
function fmtAge(ageHours) {
    const h = Number(ageHours);
    if (!Number.isFinite(h) || h < 0) return '—';
    if (h < 1) return Math.max(1, Math.round(h * 60)) + 'min';
    return Math.round(h) + 'h';
}

// Tiempo relativo compacto para eventos (formateado server-side desde ISO).
// Sin Date.now() en el módulo: recibe el "ahora" como argumento (testeable).
function relTime(whenIso, nowMs) {
    if (!whenIso) return '';
    const t = Date.parse(whenIso);
    if (!t) return '';
    const min = Math.round((nowMs - t) / 60000);
    if (min < 1) return 'ahora';
    if (min < 60) return min + 'min';
    const hr = Math.round(min / 60);
    if (hr < 24) return hr + 'h';
    return Math.round(hr / 24) + 'd';
}

const REASON_MAX = 280;

// CA-2 — Pretty-print del motivo. Si `reason`/`question` es JSON estructurado
// conocido (`dependency_block`, `rebote_categoria`, rebote estructurado #3167)
// lo traduce a una frase legible en español; si es texto plano lo deja igual
// (recortado a REASON_MAX). IMPORTANTE: este helper NO emite HTML — devuelve
// texto plano que SIEMPRE se escapa aguas abajo con escapeHtmlText. Defensas:
//   - Prototype pollution: se itera con Object.keys() (no incluye `__proto__`),
//     nunca se hace merge ni se accede a `__proto__`/`constructor`.
//   - DoS: el input se recorta a REASON_MAX antes de parsear; los objetos
//     anidados NO se recorren (se colapsan a "[…]"); se acotan las claves.
const PRETTY_MAX_KEYS = 12;
function prettyReason(raw) {
    const s = (raw == null ? '' : String(raw)).slice(0, REASON_MAX);
    const t = s.trim();
    if (t[0] !== '{' && t[0] !== '[') return s;            // texto plano: tal cual
    let obj;
    try { obj = JSON.parse(t); } catch { return s; }        // JSON inválido → crudo recortado
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return s;

    // Formas conocidas (orden de prioridad). Los values se vuelcan como texto;
    // el escape por contexto se aplica en el render, no acá.
    if (obj.dependency_block != null) {
        const dep = String(obj.dependency_block).replace(/[^0-9]/g, '');
        return dep ? ('Bloqueado por dependencia: #' + dep) : s;
    }
    if (obj.rebote_categoria != null) {
        const cat = String(obj.rebote_categoria);
        const motivo = obj.motivo != null ? String(obj.motivo) : '';
        return 'Rebote (' + cat + ')' + (motivo ? ': ' + motivo : '');
    }
    // Rebote estructurado #3167: { motivo_rechazo, rechazado_en_fase, ... }.
    if (obj.motivo_rechazo != null) {
        const fase = obj.rechazado_en_fase != null ? String(obj.rechazado_en_fase) : '';
        return (fase ? ('Rechazado en ' + fase + ': ') : 'Rechazado: ') + String(obj.motivo_rechazo);
    }
    // Genérico: aplanar claves PROPIAS (Object.keys NO devuelve `__proto__`).
    const keys = Object.keys(obj).slice(0, PRETTY_MAX_KEYS);
    if (keys.length === 0) return s;
    const parts = keys.map(k => {
        const v = obj[k];
        const vs = (v != null && typeof v === 'object') ? '[…]' : String(v);
        return k + ': ' + vs;
    });
    return parts.join(' · ').slice(0, REASON_MAX);
}

// CA-1 — sort compuesto severidad×edad. Rank danger>warning>info; tie-break por
// edad descendente (más viejo primero). Copia la lista (no muta el input).
const SEV_RANK = { danger: 3, warning: 2, info: 1 };
function sortBySeverityAge(list) {
    const arr = Array.isArray(list) ? list.slice() : [];
    return arr.sort((a, b) =>
        (SEV_RANK[severityOf(b && b.age_hours)] - SEV_RANK[severityOf(a && a.age_hours)])
        || (Number(b && b.age_hours) || 0) - (Number(a && a.age_hours) || 0));
}

// CA-3 — username público del bot de Telegram. Validado contra el charset que
// Telegram acepta para handles. NUNCA se usa el `bot_token` (secreto). Devuelve
// el username saneado o null.
const TELEGRAM_USERNAME_RE = /^[A-Za-z0-9_]{5,32}$/;
function safeBotUsername(raw) {
    const u = (raw == null ? '' : String(raw)).trim();
    return TELEGRAM_USERNAME_RE.test(u) ? u : null;
}

// CA-3 — deep-link al bot: https://t.me/<user>?start=<payload>. El payload va
// URL-encoded y restringido a [A-Za-z0-9_-]. Devuelve null si no hay username
// válido o el issue no es entero positivo ("cuando aplica").
function telegramDeepLink(issueNum, botUsername) {
    const user = safeBotUsername(botUsername);
    if (!user || !Number.isInteger(issueNum) || issueNum <= 0) return null;
    const payload = ('unblock_' + issueNum).replace(/[^A-Za-z0-9_-]/g, '');
    return 'https://t.me/' + user + '?start=' + encodeURIComponent(payload);
}

// CA-5 — clasificador determinístico de CTA primario sobre `reason`+`question`
// (+`labels` si el caller los provee). Prioridad: Aprobar > Reintentar >
// Responder (default seguro). Nunca lanza con input desconocido.
const CTA_RETRY_RE = /circuit|rebote|reintent|dependency[_\s]block|dependencia|\binfra\b|\bbuild\b|quota|cuota|stale|estancad/i;
const CTA_APPROVE_RE = /aprob|recomendaci|recommendation|go[\/-]no[\/-]go|acceptance|acept|gate de aprob/i;

function isJsonRecoverable(raw) {
    const t = (raw == null ? '' : String(raw)).trim();
    if (t[0] !== '{' && t[0] !== '[') return false;
    let obj;
    try { obj = JSON.parse(t.slice(0, REASON_MAX)); } catch { return false; }
    if (!obj || typeof obj !== 'object') return false;
    return obj.dependency_block != null || obj.rebote_categoria != null
        || obj.motivo_rechazo != null || obj.rebote === true;
}

function classifyCta(b) {
    const reason = (b && b.reason != null) ? String(b.reason) : '';
    const question = (b && b.question != null) ? String(b.question) : '';
    const labels = Array.isArray(b && b.labels) ? b.labels.map(x => String(x).toLowerCase()) : [];
    const txt = reason + ' ' + question;

    if (labels.includes('tipo:recomendacion') || labels.includes('recommendation') || CTA_APPROVE_RE.test(txt)) {
        return { verb: 'Aprobar', kind: 'approve', glyph: '✓', cls: 'v3-bloqueados-cta-approve' };
    }
    if (CTA_RETRY_RE.test(txt) || isJsonRecoverable(reason) || isJsonRecoverable(question)) {
        return { verb: 'Reintentar', kind: 'retry', glyph: '↻', cls: 'v3-bloqueados-cta-retry' };
    }
    return { verb: 'Responder', kind: 'respond', glyph: '✉', cls: 'v3-bloqueados-cta-respond' };
}

// =============================================================================
// #4193 (Ola 7.1) — Rediseño integral MIZPÁ: la pantalla deja de ser un panel
// plano y pasa a ser el CENTRO DE DECISIONES. Cada bloqueo explica POR QUÉ está
// trabado (motivo real, agrupado) y QUÉ decisión espera. Banner de misión en
// clave alarma + acciones de decisión por bloqueo. Toda la infra de seguridad
// (escape por contexto, safeIssueNumber, deep-link Telegram saneado) se preserva.
// =============================================================================

// Catálogo de motivos reales. Cada motivo describe POR QUÉ está trabado y QUÉ
// decisión espera del operador. `rank` ordena los grupos (mayor = más urgente).
// Los textos son literales (no datos externos) → no requieren escape, pero se
// escapan igual aguas abajo por defensa en profundidad.
const MOTIVOS = {
    circuit: {
        key: 'circuit', icon: '🛑', label: 'Circuit breaker',
        decision: 'Revisar el bucle de rebotes y decidir: reactivar con orientación o desestimar.',
        rank: 5,
    },
    dependencias: {
        key: 'dependencias', icon: '🔗', label: 'Esperando dependencias',
        decision: 'Destrabar manualmente (override) o esperar a que cierre la dependencia.',
        rank: 4,
    },
    rebote: {
        key: 'rebote', icon: '↩', label: 'Rebotado por una fase',
        decision: 'Aprobar, reintentar o corregir según el motivo del rechazo.',
        rank: 3,
    },
    definicion: {
        key: 'definicion', icon: '📝', label: 'Esperando definición',
        decision: 'Definir criterios/alcance para que el pipeline pueda avanzar.',
        rank: 2,
    },
    humano: {
        key: 'humano', icon: '🙋', label: 'Intervención humana',
        decision: 'Responder la pregunta del agente para destrabar el flujo.',
        rank: 1,
    },
};

// ¿El reason/question es JSON de dependencia conocido? (reusa el parse acotado).
function isDepJson(raw) {
    const t = (raw == null ? '' : String(raw)).trim();
    if (t[0] !== '{' && t[0] !== '[') return false;
    let obj;
    try { obj = JSON.parse(t.slice(0, REASON_MAX)); } catch { return false; }
    return !!(obj && typeof obj === 'object' && obj.dependency_block != null);
}

// CA-3 (#4193) — clasificador determinístico del MOTIVO REAL de un bloqueo. Mira
// reason+question (texto o JSON estructurado) y labels. Prioridad: circuit >
// dependencias > rebote > definición > humano (default seguro). Nunca lanza.
const MOTIVO_CIRCUIT_RE = /circuit|breaker|circuito|3\s*rebote|máx.*rebote|max.*bounce|needs-human/i;
const MOTIVO_DEP_RE = /dependency[_\s]block|dependencia|depende de|bloqueado por #|esperando.*#\d/i;
const MOTIVO_REBOTE_RE = /rebote|rechaz|motivo_rechazo|reintent|rebound|bounce/i;
const MOTIVO_DEF_RE = /esperando definici|needs-definition|sin criterios|definir alcance|criterios de aceptaci|falta(n)? criterios/i;

function classifyMotivo(b) {
    const reason = (b && b.reason != null) ? String(b.reason) : '';
    const question = (b && b.question != null) ? String(b.question) : '';
    const labels = Array.isArray(b && b.labels) ? b.labels.map(x => String(x).toLowerCase()) : [];
    const txt = reason + ' ' + question;

    // Dependencias: señal más específica primero (JSON dependency_block o texto).
    if (isDepJson(reason) || isDepJson(question) || MOTIVO_DEP_RE.test(txt)) {
        return MOTIVOS.dependencias;
    }
    // Circuit breaker: needs-human por tope de rebotes / circuito explícito.
    if (labels.includes('needs-human') && /circuit|breaker|3\s*rebote|máx.*rebote|max.*bounce/i.test(txt)) {
        return MOTIVOS.circuit;
    }
    if (/circuit|breaker/i.test(txt)) return MOTIVOS.circuit;
    // Rebote estructurado #3167 o texto.
    if (isJsonRecoverable(reason) || isJsonRecoverable(question) || MOTIVO_REBOTE_RE.test(txt)) {
        return MOTIVOS.rebote;
    }
    if (labels.includes('needs-definition') || MOTIVO_DEF_RE.test(txt)) {
        return MOTIVOS.definicion;
    }
    return MOTIVOS.humano;
}

// CA-2 (#4193) — agrupa la lista por motivo real. Devuelve un array de grupos
// `{ motivo, items }` ordenado por rank desc; dentro de cada grupo, las filas se
// ordenan por severidad×edad (sortBySeverityAge). Nunca trunca (CA-5): todos los
// bloqueos quedan en algún grupo.
function groupByMotivo(list) {
    const buckets = new Map();
    (Array.isArray(list) ? list : []).forEach((b) => {
        const m = classifyMotivo(b);
        if (!buckets.has(m.key)) buckets.set(m.key, { motivo: m, items: [] });
        buckets.get(m.key).items.push(b);
    });
    return Array.from(buckets.values())
        .map(g => ({ motivo: g.motivo, items: sortBySeverityAge(g.items) }))
        .sort((a, b) => (b.motivo.rank - a.motivo.rank)
            || (b.items.length - a.items.length));
}

// SLA por defecto: un bloqueo con ≥ SLA_HOURS horas en espera se considera con
// el SLA superado (severidad danger). Alineado con severityOf (≥24h = danger).
const SLA_HOURS = 24;

// CA-2 (#4193) — deriva las métricas del banner de misión desde la lista en vivo
// y los stats ya computados (lib/bloqueados-stats). `rebotesActivos` se deriva
// de la propia lista (motivo circuit/rebote) porque no hay métrica directa
// (verificado: el slice no expone un contador de rebotes). Todo numérico.
function deriveBanner(list, stats, nowMs) {
    const valid = (Array.isArray(list) ? list : []).filter(b => safeIssueNumber(b && b.issue) !== null);
    const count = valid.length;
    let oldest = null;
    valid.forEach((b) => {
        const h = Number(b.age_hours);
        const oh = oldest ? (Number(oldest.age_hours) || 0) : -1;
        if (Number.isFinite(h) && h > oh) oldest = b;
    });
    const rebotesActivos = valid.filter((b) => {
        const k = classifyMotivo(b).key;
        return k === 'rebote' || k === 'circuit';
    }).length;
    const s = stats || {};
    return {
        count,
        oldest,
        oldestSlaBreached: oldest ? (Number(oldest.age_hours) >= SLA_HOURS) : false,
        rebotesActivos,
        avgSla: (s.avgSla != null && s.avgSla !== '') ? String(s.avgSla) : '—',
        resolvedToday: (s.resolvedToday != null) ? String(s.resolvedToday) : '—',
    };
}

// CA-2 (#4193) — banner de misión en clave alarma. Tag rojo grande con el
// contador "N requieren tu decisión", indicador "El que más espera" (issue +
// edad + marca SLA superado) y las tres métricas (SLA promedio · Resueltos hoy ·
// Rebotes activos). Todo dato externo escapado por contexto.
function renderMissionBanner(list, stats, nowMs) {
    const m = deriveBanner(list, stats, nowMs);
    const oldestNum = m.oldest ? safeIssueNumber(m.oldest.issue) : null;
    const oldestAge = m.oldest ? fmtAge(m.oldest.age_hours) : '—';
    const oldestTitle = (m.oldest && m.oldest.title) ? String(m.oldest.title) : '';
    const slaTag = m.oldestSlaBreached
        ? '<span class="blq-sla-breach" title="Tiempo en espera por encima del SLA de desbloqueo">⚠ SLA superado</span>'
        : '';
    const oldestHtml = oldestNum
        ? `<div class="blq-oldest" role="group" aria-label="El bloqueo que más espera">
        <div class="blq-oldest-k">🕰 EL QUE MÁS ESPERA</div>
        <div class="blq-oldest-val"><a href="https://github.com/intrale/platform/issues/${oldestNum}" target="_blank" rel="noopener noreferrer">#${oldestNum}</a> · ${escapeHtmlText(oldestAge)} ${slaTag}</div>
        ${oldestTitle ? `<div class="blq-oldest-sub" title="${escapeHtmlAttr(oldestTitle)}">${escapeHtmlText(oldestTitle)}</div>` : ''}
      </div>`
        : '';

    const metric = (k, v, tip) =>
        `<div class="blq-wm" title="${escapeHtmlAttr(tip)}"><div class="blq-wl">${escapeHtmlText(k)}</div><div class="blq-wv">${escapeHtmlText(String(v))}</div></div>`;

    return `<section class="blq-mission" id="bloqueados-mission" role="status" aria-label="Decisiones humanas pendientes">
    <div class="blq-alarmtag">
      <div class="blq-alarmtag-n">${escapeHtmlText(String(m.count))}</div>
      <div class="blq-alarmtag-s">REQUIEREN TU<br>DECISIÓN</div>
    </div>
    <div class="blq-mtext">
      <div class="blq-mttl">🚨 Centro de decisiones humanas</div>
      <div class="blq-mdesc">Cada bloqueo de abajo explica por qué está trabado y qué decisión espera de vos. Atacá primero el que más viene esperando.</div>
      <div class="blq-wmetrics">
        ${metric('SLA promedio', m.avgSla, 'Tiempo promedio que tarda un bloqueo en destrabarse (lib/bloqueados-stats).')}
        ${metric('Resueltos hoy', m.resolvedToday, 'Bloqueos que se destrabaron en lo que va del día.')}
        ${metric('Rebotes activos', m.rebotesActivos, 'Bloqueos cuyo motivo es un rebote o circuit breaker (derivado de la lista en vivo).')}
      </div>
    </div>
    <div class="blq-mright">${oldestHtml}</div>
  </section>`;
}

// Una fila de issue bloqueado. Devuelve '' (fila descartada) si `b.issue` no
// coacciona a entero positivo (CA-D1). Todo dato externo escapado por contexto.
function renderRowSsr(b, nowMs, ctx) {
    const c = ctx || {};
    const issueNum = safeIssueNumber(b && b.issue);
    if (issueNum === null) {
        try { console.warn(JSON.stringify({ event: 'bloqueados_row_discarded', reason: 'invalid_issue', ts: new Date(nowMs).toISOString() })); } catch { /* logger no debe romper el render */ }
        return '';
    }
    const sev = severityOf(b.age_hours);
    const ageTxt = fmtAge(b.age_hours);
    const titleTxt = (b.title == null) ? '' : String(b.title);
    // CA-2 — el motivo pasa por prettyReason (traduce JSON conocido a texto
    // legible); el resultado SIEMPRE se escapa por contexto en el render.
    const reasonSource = (b.question || b.reason || '').toString();
    const reasonPretty = prettyReason(reasonSource);
    const reasonTxt = reasonPretty.slice(0, REASON_MAX);
    const reasonTrunc = reasonSource.length > REASON_MAX || reasonPretty.length > REASON_MAX;
    const summaryTxt = (b.summary || '').toString();
    const events = Array.isArray(b.recent_events) ? b.recent_events : [];

    const titleHtml = titleTxt
        ? ` — <span class="v3-bloqueados-title" title="${escapeHtmlAttr(titleTxt)}">${escapeHtmlText(titleTxt)}</span>`
        : '';

    const eventsHtml = events.length === 0 ? '' : (
        '<div class="v3-bloqueados-events needs-human-events">'
        + '<div class="v3-bloqueados-events-label needs-human-events-label">💬 Actividad reciente</div>'
        + '<ul class="v3-bloqueados-events-list needs-human-events-list">'
        + events.map(ev => '<li>'
            + `<span class="v3-bloqueados-ev-when nh-ev-when">${escapeHtmlText(relTime(ev && ev.when, nowMs))}</span> `
            + `<span class="v3-bloqueados-ev-author nh-ev-author">${escapeHtmlText((ev && ev.author) || '?')}</span>: `
            + `<span class="v3-bloqueados-ev-text nh-ev-text">${escapeHtmlText((ev && ev.preview) || '')}</span>`
            + '</li>').join('')
        + '</ul></div>'
    );

    const summaryHtml = summaryTxt
        ? `<div class="v3-bloqueados-summary needs-human-summary">📄 ${escapeHtmlText(summaryTxt)}</div>`
        : (b && b.summary_stale
            ? '<div class="v3-bloqueados-summary needs-human-summary needs-human-summary-loading">📄 <em>Cargando resumen funcional…</em></div>'
            : '');

    const skillTxt = (b.skill == null) ? '' : String(b.skill);
    const phaseTxt = (b.phase == null) ? '' : String(b.phase);
    const skillPhase = (b.skill || b.phase)
        ? `<span class="v3-bloqueados-meta"> · ${escapeHtmlText(b.skill || '?')} en ${escapeHtmlText(b.phase || '?')}</span>`
        : '';

    // CA-5 — CTA primario explícito (un solo verbo sólido por fila). CA-3 —
    // deep-link Telegram (sólo si hay bot_username público válido en el ctx).
    const cta = classifyCta(b);
    const tgUrl = telegramDeepLink(issueNum, c.telegramBotUsername);
    const ctaHtml = `<button class="v3-bloqueados-cta ${cta.cls}" onclick="needsHumanCta(${issueNum}, '${cta.kind}')" title="${escapeHtmlAttr(cta.verb + ' #' + issueNum)}" aria-label="${escapeHtmlAttr(cta.verb + ' issue #' + issueNum)}">${cta.glyph} ${escapeHtmlText(cta.verb)}</button>`;
    const tgHtml = tgUrl
        ? `<a class="v3-bloqueados-tg" data-tg="1" href="${escapeHtmlAttr(tgUrl)}" target="_blank" rel="noopener noreferrer" title="${escapeHtmlAttr('Abrir #' + issueNum + ' en Telegram para responder')}" aria-label="${escapeHtmlAttr('Responder #' + issueNum + ' por Telegram')}">✉ Telegram</a>`
        : '';

    return `<div class="v3-bloqueados-row needs-human-row v3-bloqueados-sev-${sev}" id="bloqueados-row-${issueNum}" data-issue="${issueNum}" data-severity="${sev}" data-skill="${escapeHtmlAttr(skillTxt)}" data-phase="${escapeHtmlAttr(phaseTxt)}">
      <span class="v3-bloqueados-rail" aria-hidden="true"></span>
      <div class="v3-bloqueados-row-head needs-human-row-head">
        <div class="v3-bloqueados-row-info needs-human-row-info">
          <a href="https://github.com/intrale/platform/issues/${issueNum}" target="_blank" rel="noopener noreferrer"><b>#${issueNum}</b></a>${titleHtml}${skillPhase}
          <span class="v3-bloqueados-age v3-bloqueados-age-${sev}" title="${escapeHtmlAttr('Bloqueado hace ' + ageTxt + ' · severidad ' + sev)}" aria-label="${escapeHtmlAttr('Bloqueado hace ' + ageTxt)}">⏱ hace ${escapeHtmlText(ageTxt)}</span>
        </div>
        <div class="v3-bloqueados-row-actions needs-human-row-actions">
          ${ctaHtml}
          ${tgHtml}
          <button class="v3-bloqueados-btn nh-btn nh-btn-reactivate" onclick="needsHumanReactivate(${issueNum})" title="${escapeHtmlAttr('Destrabar #' + issueNum + ': override manual — quita el bloqueo (label needs-human) y devuelve el issue a la cola del pipeline')}" aria-label="${escapeHtmlAttr('Destrabar issue #' + issueNum)}">🔓 Destrabar</button>
          <a class="v3-bloqueados-act v3-bloqueados-act-issue" href="https://github.com/intrale/platform/issues/${issueNum}" target="_blank" rel="noopener noreferrer" title="${escapeHtmlAttr('Abrir #' + issueNum + ' en GitHub')}" aria-label="${escapeHtmlAttr('Ver issue #' + issueNum + ' en GitHub')}">🔗 Ver issue ↗</a>
          <a class="v3-bloqueados-act v3-bloqueados-act-logs" href="/historial?q=${issueNum}" target="_blank" rel="noopener noreferrer" title="${escapeHtmlAttr('Ver logs del agente que ejecutó #' + issueNum + ' (timeline del Historial filtrado por el issue)')}" aria-label="${escapeHtmlAttr('Ver logs del agente de #' + issueNum)}">📄 Ver logs</a>
          <button class="v3-bloqueados-btn nh-btn nh-btn-dismiss" onclick="needsHumanDismiss(${issueNum})" title="${escapeHtmlAttr('Desestimar #' + issueNum + ': cierra el issue como no planificado y lo quita del panel')}" aria-label="${escapeHtmlAttr('Desestimar issue #' + issueNum)}">✕ Desestimar</button>
        </div>
      </div>
      ${summaryHtml}
      ${reasonTxt ? `<div class="v3-bloqueados-reason needs-human-reason">❓ ${escapeHtmlText(reasonTxt)}${reasonTrunc ? '…' : ''}</div>` : ''}
      ${eventsHtml}
    </div>`;
}

// CA-1 (#4193) — barra de marca MIZPÁ del shell standalone (marca + tagline
// «Que el Señor vigile» Génesis 31:49 + selector multiproyecto). Hereda las
// clases `.mz-*` definidas en theme.css (compartidas con Equipo/Home) para no
// divergir visualmente. Bloqueados es tab PRIMARIA → sin miga de pan.
function renderMizpaBrandBar() {
    const logoSvg = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">'
        + '<path d="M12 2.5 5 6v5c0 4.6 3 8 7 9.5 4-1.5 7-4.9 7-9.5V6l-7-3.5Z" stroke="#06121a" stroke-width="1.6" fill="rgba(255,255,255,.16)"/>'
        + '<path d="M9.5 12.5 11.3 14.3 14.8 10.4" stroke="#06121a" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return `
    <div class="in-header-brand">
      <div class="mz-logo" aria-hidden="true" title="MIZPÁ · atalaya de agentes (Génesis 31:49)">${logoSvg}</div>
      <div class="mz-id">
        <div class="mz-name">MIZPÁ</div>
        <div class="mz-sub">«Que el Señor vigile» · centro de decisiones</div>
      </div>
      <div class="mz-projsel" role="button" tabindex="0"
           title="Proyecto activo. MIZPÁ es el motor; el proyecto es intercambiable (multiproyecto — selección en evaluación)."
           aria-label="Proyecto activo: Intrale, 1 de 3">
        <span class="mz-proj-avatar" aria-hidden="true">i</span>
        <span class="mz-proj-id">
          <span class="mz-proj-name">Intrale</span>
          <span class="mz-proj-state">PROYECTO ACTIVO</span>
        </span>
        <span class="mz-proj-badge">1 / 3</span>
        <span class="mz-proj-caret" aria-hidden="true">▾</span>
      </div>
    </div>`;
}

// CA-1/CA-2 (#4193) — CSS inline del rediseño MIZPÁ (banner de misión + grupos +
// acciones). Va inline en el fragmento para que funcione TANTO en el standalone
// (carga theme.css) COMO embebido en el monolito (la home no carga theme.css).
// Reusa las variables --in-* del tema; no introduce colores nuevos fuera de los
// tonos de alarma ya usados por las hermanas MIZPÁ.
function bloqueadosRedesignStyle() {
    return `<style>
.blq-mission{display:flex;align-items:center;gap:22px;border-radius:14px;padding:18px 24px;margin-bottom:16px;position:relative;overflow:hidden;
  background:linear-gradient(110deg,rgba(248,113,113,.14),rgba(251,146,60,.07) 45%,transparent 75%),var(--in-bg-2,#11151E);
  border:1px solid rgba(248,113,113,.26)}
.blq-alarmtag{display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:108px;padding:12px 14px;border-radius:14px;
  background:linear-gradient(135deg,rgba(248,113,113,.26),rgba(251,146,60,.14));border:1px solid rgba(248,113,113,.36)}
.blq-alarmtag-n{font-size:34px;font-weight:800;color:#fecaca;line-height:1;font-variant-numeric:tabular-nums}
.blq-alarmtag-s{font-size:9.5px;font-weight:800;color:#fca5a5;letter-spacing:.7px;margin-top:5px;text-align:center;line-height:1.2}
.blq-mtext{flex:1;min-width:0}
.blq-mttl{font-size:18px;font-weight:800;color:var(--in-fg,#e6edf3);display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.blq-mdesc{font-size:13px;color:var(--in-fg-dim,#8A93A6);margin-top:5px;max-width:640px;line-height:1.45}
.blq-wmetrics{display:flex;gap:10px;margin-top:13px;flex-wrap:wrap}
.blq-wm{flex:1;min-width:140px;background:rgba(255,255,255,.035);border:1px solid var(--in-border,rgba(255,255,255,.08));border-radius:11px;padding:9px 12px}
.blq-wl{font-size:9.5px;font-weight:800;letter-spacing:.6px;color:var(--in-fg-soft,#5B6376);text-transform:uppercase}
.blq-wv{font-size:18px;font-weight:800;margin-top:3px;line-height:1;color:var(--in-fg,#e6edf3);font-variant-numeric:tabular-nums}
.blq-mright{min-width:240px}
.blq-oldest{background:rgba(251,146,60,.09);border:1px solid rgba(251,146,60,.28);border-radius:12px;padding:11px 13px}
.blq-oldest-k{font-size:9.5px;font-weight:800;letter-spacing:.6px;color:#fdba74;text-transform:uppercase}
.blq-oldest-val{font-size:15px;font-weight:800;margin-top:5px;color:var(--in-fg,#e6edf3)}
.blq-oldest-val a{color:var(--in-info,#58a6ff);text-decoration:none}
.blq-oldest-val a:hover{text-decoration:underline}
.blq-oldest-sub{font-size:11px;color:var(--in-fg-dim,#8A93A6);margin-top:4px;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.blq-sla-breach{font-size:9.5px;font-weight:800;color:#fecaca;background:rgba(248,113,113,.18);border:1px solid rgba(248,113,113,.4);border-radius:7px;padding:2px 7px;margin-left:6px;letter-spacing:.3px}
@media (max-width:900px){.blq-mission{flex-wrap:wrap}.blq-mright{min-width:0;flex-basis:100%}}
/* GRUPOS POR MOTIVO */
.v3-bloqueados-group{margin-bottom:14px}
.v3-bloqueados-group-head{display:flex;align-items:center;gap:9px;margin:0 0 9px;padding-bottom:7px;border-bottom:1px solid var(--in-border,rgba(255,255,255,.08));flex-wrap:wrap}
.v3-bloqueados-group-ic{font-size:15px}
.v3-bloqueados-group-label{font-size:12.5px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:var(--in-fg,#e6edf3)}
.v3-bloqueados-group-count{font-size:11px;font-weight:800;color:#9fe9ee;background:rgba(52,217,224,.12);border:1px solid rgba(52,217,224,.3);border-radius:999px;padding:1px 9px;font-variant-numeric:tabular-nums}
.v3-bloqueados-group-decision{font-size:11.5px;color:var(--in-fg-dim,#8A93A6);font-style:italic;margin-left:6px}
/* ACCIONES DE DECISIÓN (links) */
.v3-bloqueados-act{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:700;text-decoration:none;
  padding:6px 11px;border-radius:8px;border:1px solid var(--in-border,rgba(255,255,255,.12));color:var(--in-fg-dim,#8A93A6);background:transparent;white-space:nowrap}
.v3-bloqueados-act:hover{color:var(--in-fg,#e6edf3);border-color:var(--in-info,#58a6ff)}
.v3-bloqueados-act:focus-visible{outline:2px solid var(--in-accent,#38bdf8);outline-offset:2px}
.v3-bloqueados-act-issue{color:var(--in-info,#58a6ff)}
</style>`;
}

// CA-2 (#4193) — render de un grupo de motivo: header (ícono + label + contador +
// decisión esperada) seguido de sus filas. Todas las filas viven dentro de
// `#bloqueados-list` (vía el contenedor padre) para que el filtro client-side las
// siga matcheando. El grupo se descarta si todas sus filas se descartaron.
function renderMotivoGroupSsr(group, nowMs, ctx) {
    const g = group || {};
    const motivo = g.motivo || MOTIVOS.humano;
    const rows = (Array.isArray(g.items) ? g.items : [])
        .map(b => renderRowSsr(b, nowMs, ctx)).filter(Boolean).join('');
    if (!rows) return '';
    const n = (Array.isArray(g.items) ? g.items : []).filter(b => safeIssueNumber(b && b.issue) !== null).length;
    return `<section class="v3-bloqueados-group" data-motivo="${escapeHtmlAttr(motivo.key)}">
      <div class="v3-bloqueados-group-head">
        <span class="v3-bloqueados-group-ic" aria-hidden="true">${escapeHtmlText(motivo.icon)}</span>
        <span class="v3-bloqueados-group-label">${escapeHtmlText(motivo.label)}</span>
        <span class="v3-bloqueados-group-count" aria-label="${escapeHtmlAttr(n + ' bloqueos en este motivo')}">${escapeHtmlText(String(n))}</span>
        <span class="v3-bloqueados-group-decision" title="Decisión que espera este grupo">${escapeHtmlText(motivo.decision)}</span>
      </div>
      ${rows}
    </section>`;
}

// Mini-stat del empty-state. Los valores numéricos llegan ya computados desde el
// state (opcionales); si faltan, "—". Todo escapado por defensa en profundidad.
function renderEmptyStatsSsr(stats) {
    const s = stats || {};
    const sla = (s.avgSla != null) ? String(s.avgSla) : '—';
    const resolved = (s.resolvedToday != null) ? String(s.resolvedToday) : '—';
    return '<div class="v3-bloqueados-empty-stats">'
        + `<div class="v3-bloqueados-empty-stat"><span class="v3-bloqueados-empty-stat-value">${escapeHtmlText(sla)}</span><span class="v3-bloqueados-empty-stat-label">SLA promedio</span></div>`
        + `<div class="v3-bloqueados-empty-stat"><span class="v3-bloqueados-empty-stat-value">${escapeHtmlText(resolved)}</span><span class="v3-bloqueados-empty-stat-label">Resueltos hoy</span></div>`
        + '</div>';
}

// CA-4 — chips de stats del header del panel (SLA promedio de desbloqueo +
// resueltos hoy). Valores ya computados por lib/bloqueados-stats.js y pasados
// vía state.bloqueadosStats. Si faltan → "—". Todo escapado por contexto.
function renderHeaderStatsSsr(stats) {
    const s = stats || {};
    const sla = (s.avgSla != null && s.avgSla !== '') ? String(s.avgSla) : '—';
    const resolved = (s.resolvedToday != null) ? String(s.resolvedToday) : '—';
    return '<div class="v3-bloqueados-headstats" role="group" aria-label="Métricas de desbloqueo">'
        + `<div class="v3-bloqueados-headstat"><span class="v3-bloqueados-headstat-glyph" aria-hidden="true">⏱</span><span class="v3-bloqueados-headstat-value">${escapeHtmlText(sla)}</span><span class="v3-bloqueados-headstat-label">SLA promedio</span></div>`
        + `<div class="v3-bloqueados-headstat"><span class="v3-bloqueados-headstat-glyph" aria-hidden="true">✓</span><span class="v3-bloqueados-headstat-value">${escapeHtmlText(resolved)}</span><span class="v3-bloqueados-headstat-label">Resueltos hoy</span></div>`
        + '</div>';
}

// CA-1 — barra de filtros/búsqueda SSR. Las opciones de skill/fase se derivan de
// la lista ya cargada. El filtrado real es client-side (sobre filas escapadas
// server-side); esta función sólo emite el markup de los controles.
function renderFilterBarSsr(list) {
    const skills = Array.from(new Set((list || []).map(b => b && b.skill).filter(Boolean).map(String))).sort();
    const phases = Array.from(new Set((list || []).map(b => b && b.phase).filter(Boolean).map(String))).sort();
    const opt = (v) => `<option value="${escapeHtmlAttr(v)}">${escapeHtmlText(v)}</option>`;
    return '<div class="v3-bloqueados-filterbar" id="bloqueados-filterbar" role="search">'
        + '<input type="text" id="bloqueados-search" class="v3-bloqueados-search" placeholder="Buscar incidente…" aria-label="Buscar incidente" autocomplete="off" oninput="bloqueadosApplyFilters()">'
        + '<select id="bloqueados-filter-sev" class="v3-bloqueados-select" aria-label="Filtrar por severidad" onchange="bloqueadosApplyFilters()">'
        + '<option value="">Toda severidad</option><option value="danger">Crítico (≥24h)</option><option value="warning">Atención (4-24h)</option><option value="info">Reciente (&lt;4h)</option>'
        + '</select>'
        + '<select id="bloqueados-filter-skill" class="v3-bloqueados-select" aria-label="Filtrar por skill" onchange="bloqueadosApplyFilters()">'
        + '<option value="">Todo skill</option>' + skills.map(opt).join('')
        + '</select>'
        + '<select id="bloqueados-filter-phase" class="v3-bloqueados-select" aria-label="Filtrar por fase" onchange="bloqueadosApplyFilters()">'
        + '<option value="">Toda fase</option>' + phases.map(opt).join('')
        + '</select>'
        + '<button type="button" id="bloqueados-filter-clear" class="v3-bloqueados-filter-clear" onclick="bloqueadosClearFilters()">Limpiar</button>'
        + '<span class="v3-bloqueados-filter-count" id="bloqueados-filter-count" aria-live="polite"></span>'
        + '</div>';
}

// Empty-state celebratorio (D5 de la narrativa UX). Reemplaza el string vacío
// del monolito: la ausencia de bloqueos es buen estado, no error.
function renderEmptyStateSsr(state) {
    const stats = state && state.bloqueadosStats;
    return '<section class="v3-bloqueados-empty" id="bloqueados-empty" role="status">'
        + '<div class="v3-bloqueados-empty-icon" aria-hidden="true">✓</div>'
        + '<div class="v3-bloqueados-empty-title">Nada esperando que alguien decida</div>'
        + '<div class="v3-bloqueados-empty-sub">El pipeline fluye sin intervención humana.</div>'
        + renderEmptyStatsSsr(stats)
        + '</section>';
}

/**
 * Fragmento SSR de la ventana Bloqueados. Devuelve `<main id="view-content"
 * data-slug="bloqueados">` con las filas renderizadas server-side. Lo embebe el
 * monolito legacy (en `matrixHTML`) y el router cliente (`?view=bloqueados`).
 *
 * @param {object} state — snapshot del pipeline. Lee `state.bloqueados` (array)
 *                         y `state.bloqueadosStats` (opcional, mini-stats).
 * @param {object} [opts] — { nowMs } para tests deterministas (default Date.now()).
 */
function renderBloqueadosSsr(state, opts) {
    const o = opts || {};
    const nowMs = Number.isFinite(o.nowMs) ? o.nowMs : Date.now();
    const list = Array.isArray(state && state.bloqueados) ? state.bloqueados : [];
    // CA-3 — el username público del bot se pasa por ctx a cada fila. Validado
    // aguas arriba (dashboard.js) pero re-saneado por telegramDeepLink.
    const ctx = { telegramBotUsername: state && state.telegramBotUsername };

    if (list.length === 0) {
        return '<main id="view-content" data-slug="bloqueados" class="v3-bloqueados-view">'
            + renderEmptyStateSsr(state)
            + '</main>';
    }

    // CA-1/CA-2 — orden compuesto severidad×edad + agrupado por motivo real.
    const ordered = sortBySeverityAge(list);
    const groups = groupByMotivo(list);
    const groupsHtml = groups.map(grp => renderMotivoGroupSsr(grp, nowMs, ctx)).filter(Boolean).join('');
    // Si TODAS las filas se descartaron por coerción (input corrupto), caer al
    // empty-state en vez de un panel vacío sin sentido.
    if (!groupsHtml) {
        return '<main id="view-content" data-slug="bloqueados" class="v3-bloqueados-view">'
            + renderEmptyStateSsr(state)
            + '</main>';
    }

    const count = list.filter(b => safeIssueNumber(b && b.issue) !== null).length;
    const badge = count > 99 ? '99+' : String(count);

    return '<main id="view-content" data-slug="bloqueados" class="v3-bloqueados-view">'
        + bloqueadosRedesignStyle()
        + renderMissionBanner(list, state && state.bloqueadosStats, nowMs)
        + '<section class="matrix-section needs-human-panel v3-bloqueados-panel" id="bloqueados-humano" data-section="needs-human">'
        + '<h2 class="needs-human-header v3-bloqueados-header" id="bloqueados-header" onclick="toggleNeedsHumanPanel()" title="Click para colapsar o expandir el panel">'
        + '<span class="needs-human-pulse v3-bloqueados-pulse" aria-hidden="true">🚨</span>'
        + 'Necesitan intervención humana'
        + `<span class="needs-human-badge v3-bloqueados-badge">${escapeHtmlText(badge)}</span>`
        + renderHeaderStatsSsr(state && state.bloqueadosStats)
        + '<span class="needs-human-chevron v3-bloqueados-chevron" aria-hidden="true">▼</span>'
        + '<a class="section-popout v3-bloqueados-popout" href="/dashboard?view=bloqueados" target="_blank" rel="noopener noreferrer" title="Abrir Bloqueados en ventana independiente" aria-label="Abrir Bloqueados en ventana independiente" onclick="event.stopPropagation()">↗</a>'
        + '</h2>'
        + '<div class="needs-human-body v3-bloqueados-body">'
        + renderFilterBarSsr(ordered)
        + '<div class="v3-bloqueados-empty-filtered" id="bloqueados-empty-filtered" role="status" hidden>Sin incidentes que coincidan con los filtros.</div>'
        + '<div class="v3-bloqueados-list" id="bloqueados-list">' + groupsHtml + '</div>'
        + '<div class="v3-bloqueados-hint" id="bloqueados-hint">'
        + 'Desbloquear desde Telegram: <code>/unblock &lt;issue&gt; &lt;orientación&gt;</code> · o quitá el label <code>needs-human</code> en GitHub'
        + '</div>'
        + '</div>'
        + '</section>'
        + '</main>';
}

// Handlers del cliente portados del monolito (dashboard.js:7016-7101) — se
// exponen como window.* para que los onclick="" del SSR sigan funcionando en la
// página standalone (R3 del issue). NO se rediseñan en esta sub.
function renderBloqueadosClientScript() {
    return `
function nhDisableButtons(issueNum){
  document.querySelectorAll('.v3-bloqueados-row button[onclick*="(' + issueNum + ')"]').forEach(function(b){ b.disabled = true; });
}
function toggleNeedsHumanPanel(scrollOnExpand){
  var panel = document.getElementById('bloqueados-humano');
  if(!panel) return;
  var willCollapse = !panel.classList.contains('nh-collapsed');
  panel.classList.toggle('nh-collapsed');
  try { localStorage.setItem('nh-panel-collapsed', willCollapse ? '1' : '0'); } catch(e){}
  if(!willCollapse && scrollOnExpand){ panel.scrollIntoView({behavior:'smooth', block:'start'}); }
}
(function restoreNeedsHumanPanelState(){
  try {
    if(localStorage.getItem('nh-panel-collapsed') === '1'){
      var panel = document.getElementById('bloqueados-humano');
      if(panel) panel.classList.add('nh-collapsed');
    }
  } catch(e){}
})();
async function needsHumanReactivate(issueNum){
  if(!(await inConfirm({ title:'Reactivar issue', message:'Volverá a la cola del pipeline sin orientación adicional.', confirmLabel:'Reactivar', danger:false, preview:[{label:'Issue', value:'#'+issueNum}] }))) return;
  nhDisableButtons(issueNum);
  try {
    var r = await fetch('/api/needs-human/' + issueNum + '/reactivate', { method: 'POST', headers: nhCsrfHeaders() });
    var j = await r.json();
    if(j.ok) location.reload();
    else { alert('Error reactivando: ' + (j.msg || 'desconocido')); location.reload(); }
  } catch(e){ alert('Error reactivando: ' + e.message); location.reload(); }
}
async function needsHumanDismiss(issueNum){
  var reason = prompt('Motivo para desestimar #' + issueNum + ' (opcional):', '');
  if(reason === null) return;
  if(!(await inConfirm({ title:'Desestimar issue', message:'Se quitará del panel y quedará cerrado en GitHub.', confirmLabel:'Desestimar', preview:[{label:'Issue', value:'#'+issueNum},{label:'Motivo', value:(reason||'—')}] }))) return;
  nhDisableButtons(issueNum);
  try {
    var r = await fetch('/api/needs-human/' + issueNum + '/dismiss', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, nhCsrfHeaders()),
      body: JSON.stringify({ reason: reason || '' })
    });
    var j = await r.json();
    if(j.ok){
      if(j.worktree && j.worktree_warning){
        var cleanWt = await inConfirm({ title:'Limpiar worktree', message:'Issue #' + issueNum + ' desestimado. El worktree tiene trabajo en disco. ¿Limpiarlo ahora?', confirmLabel:'Limpiar worktree', cancelLabel:'Conservar', preview:[{label:'Worktree', value:j.worktree}] });
        if(cleanWt){
          try {
            var rw = await fetch('/api/needs-human/' + issueNum + '/dismiss-worktree', { method: 'POST', headers: nhCsrfHeaders() });
            var jw = await rw.json();
            if(!jw.ok) alert('No pude limpiar el worktree: ' + (jw.msg || 'desconocido'));
          } catch(e){ alert('Error limpiando worktree: ' + e.message); }
        }
      }
      location.reload();
    } else { alert('Error desestimando: ' + (j.msg || 'desconocido')); location.reload(); }
  } catch(e){ alert('Error desestimando: ' + e.message); location.reload(); }
}
// CA-5 — CTA primario explícito. 'approve' y 'retry' resumen el incidente a la
// cola (reusan el endpoint /reactivate ya existente + CSRF + modal), variando
// sólo el copy según el verbo. 'respond' abre el flujo de respuesta: deep-link
// Telegram de la fila si está configurado, si no enfoca la guía de /unblock.
async function needsHumanCta(issueNum, kind){
  if(kind === 'respond'){ return needsHumanRespond(issueNum); }
  var copy = (kind === 'approve')
    ? { title:'Aprobar incidente', message:'Se aprueba y vuelve a la cola del pipeline.', confirmLabel:'Aprobar' }
    : { title:'Reintentar incidente', message:'Se reintenta: vuelve a la cola del pipeline.', confirmLabel:'Reintentar' };
  if(!(await inConfirm({ title:copy.title, message:copy.message, confirmLabel:copy.confirmLabel, danger:false, preview:[{label:'Issue', value:'#'+issueNum}] }))) return;
  nhDisableButtons(issueNum);
  try {
    var r = await fetch('/api/needs-human/' + issueNum + '/reactivate', { method: 'POST', headers: nhCsrfHeaders() });
    var j = await r.json();
    if(j.ok) location.reload();
    else { alert('Error: ' + (j.msg || 'desconocido')); location.reload(); }
  } catch(e){ alert('Error: ' + e.message); location.reload(); }
}
// 'respond' no cambia estado server-side: abre Telegram (deep-link de la fila,
// ya escapado/validado server-side) o, si no hay bot configurado, enfoca la guía.
function needsHumanRespond(issueNum){
  var row = document.getElementById('bloqueados-row-' + issueNum);
  var tg = row ? row.querySelector('.v3-bloqueados-tg') : null;
  if(tg){ window.open(tg.href, '_blank', 'noopener,noreferrer'); return; }
  var hint = document.getElementById('bloqueados-hint');
  if(hint){ hint.scrollIntoView({behavior:'smooth', block:'center'}); hint.classList.add('v3-bloqueados-hint-flash'); setTimeout(function(){ hint.classList.remove('v3-bloqueados-hint-flash'); }, 1600); }
}
// CA-1 — filtro/búsqueda client-side. Opera SOLO sobre filas ya renderizadas y
// escapadas server-side: matchea por dataset (severity/skill/phase) y por
// textContent (término de búsqueda). NUNCA reconstruye innerHTML desde el
// término ni refleja el query crudo (el contador y el empty usan textContent).
function bloqueadosApplyFilters(){
  var term = (document.getElementById('bloqueados-search') || {}).value || '';
  term = term.toLowerCase().trim();
  var sev = (document.getElementById('bloqueados-filter-sev') || {}).value || '';
  var skill = (document.getElementById('bloqueados-filter-skill') || {}).value || '';
  var phase = (document.getElementById('bloqueados-filter-phase') || {}).value || '';
  var rows = document.querySelectorAll('#bloqueados-list .v3-bloqueados-row');
  var visible = 0;
  rows.forEach(function(row){
    var ok = true;
    if(sev && row.getAttribute('data-severity') !== sev) ok = false;
    if(ok && skill && row.getAttribute('data-skill') !== skill) ok = false;
    if(ok && phase && row.getAttribute('data-phase') !== phase) ok = false;
    if(ok && term && (row.textContent || '').toLowerCase().indexOf(term) === -1) ok = false;
    row.style.display = ok ? '' : 'none';
    if(ok) visible++;
  });
  // #4193 — ocultar el header de un grupo cuyas filas quedaron todas ocultas.
  document.querySelectorAll('#bloqueados-list .v3-bloqueados-group').forEach(function(grp){
    var anyVisible = false;
    grp.querySelectorAll('.v3-bloqueados-row').forEach(function(r){ if(r.style.display !== 'none') anyVisible = true; });
    grp.style.display = anyVisible ? '' : 'none';
  });
  var empty = document.getElementById('bloqueados-empty-filtered');
  if(empty) empty.hidden = (visible !== 0);
  var counter = document.getElementById('bloqueados-filter-count');
  if(counter) counter.textContent = (visible === rows.length) ? '' : (visible + ' de ' + rows.length);
}
function bloqueadosClearFilters(){
  ['bloqueados-search','bloqueados-filter-sev','bloqueados-filter-skill','bloqueados-filter-phase'].forEach(function(id){
    var el = document.getElementById(id); if(el) el.value = '';
  });
  bloqueadosApplyFilters();
}
// nhCsrfHeaders() lo provee FETCH_CLIENT_JS (#3953) — centralizado para que
// todo POST destructivo adjunte X-CSRF-Token de forma uniforme (R2).
window.toggleNeedsHumanPanel = toggleNeedsHumanPanel;
window.needsHumanReactivate = needsHumanReactivate;
window.needsHumanDismiss = needsHumanDismiss;
window.needsHumanCta = needsHumanCta;
window.needsHumanRespond = needsHumanRespond;
window.bloqueadosApplyFilters = bloqueadosApplyFilters;
window.bloqueadosClearFilters = bloqueadosClearFilters;
`;
}

// Helpers mínimos del header satélite (reloj + pill modo), espejados de
// matriz.js::COMMON_HELPERS para que la página standalone sea autosuficiente.
const COMMON_HELPERS = `
function setText(id, value){ var el=document.getElementById(id); if(el && el.textContent!==String(value)) el.textContent=value; }
async function tickHeader(){
  var d = await fetchJson('/api/dash/header');
  if(!d) return;
  setText('hdr-clock', new Date().toLocaleTimeString('es-AR'));
  var modePill = document.getElementById('hdr-mode');
  if(modePill){
    modePill.classList.remove('in-mode-running','in-mode-paused','in-mode-partial');
    if(d.mode==='paused'){ modePill.classList.add('in-mode-paused'); modePill.textContent='⏸ Pausado'; }
    else if(d.mode==='partial_pause'){ modePill.classList.add('in-mode-partial'); modePill.textContent='⏸ Parcial'; }
    else { modePill.classList.add('in-mode-running'); modePill.textContent='🟢 Running'; }
  }
}
// #4238 — Hidratación de la cabecera de ola común (② del marco). El SSR llega
// neutro (igual que en la HOME); este tick espeja /api/dash/waves a los IDs
// mission-* del helper compartido renderMissionBanner. Defensivo: cualquier dato
// ausente degrada a neutro sin romper el resto de la pantalla. Espeja la lógica
// de _mzMirrorMission de la HOME y tickEquipoMission de EQUIPO (#4258).
async function tickBloqueadosMission(){
  var d = await fetchJson('/api/dash/waves');
  if(!d) return;
  try {
    var wave = d.active_wave;
    if(!wave){
      setText('mission-wave-num', '—');
      setText('mission-wave-name', 'Sin ola activa');
      setText('mission-wave-desc', 'Esperando la planificación de la ola activa.');
      return;
    }
    if(Number.isFinite(wave.number)) setText('mission-wave-num', String(wave.number));
    setText('mission-wave-name', wave.name ? ('Ola ' + wave.number + ' · ' + wave.name) : ('Ola ' + wave.number));
    setText('mission-wave-desc', wave.goal || wave.description || ('Issues de la ola ' + wave.number + ' en curso.'));
    var tag = document.getElementById('mission-wave-tag');
    if(tag) tag.style.display = wave.isLast ? '' : 'none';
    var issues = Array.isArray(wave.issues) ? wave.issues : [];
    var done=0, active=0, blocked=0, queue=0;
    for(var i=0;i<issues.length;i++){
      var s = issues[i] && issues[i].status;
      if(s === 'completed') done++;
      else if(s === 'in-progress') active++;
      else if(s === 'blocked') blocked++;
      else queue++;
    }
    var total = issues.length || 0;
    // #4296 — avance % lo hidrata el accessor compartido (/api/dash/ola-eta);
    // acá sólo leyenda/barras/entregados desde los conteos de la ola.
    setText('mission-leg-done', String(done));
    setText('mission-leg-active', String(active));
    setText('mission-leg-blocked', String(blocked));
    setText('mission-leg-queue', String(queue));
    var w = function(n){ return total>0 ? ((n/total)*100).toFixed(1)+'%' : '0%'; };
    var setW = function(id,n){ var el=document.getElementById(id); if(el) el.style.width = w(n); };
    setW('mission-bar-done', done);
    setW('mission-bar-active', active);
    setW('mission-bar-blocked', blocked);
    setW('mission-bar-queue', queue);
    var dv = document.getElementById('mission-delivered-value');
    if(dv) dv.innerHTML = done + '<span class="mz-wm-u"> / ' + total + '</span>';
    var dsub = document.getElementById('mission-delivered-sub');
    if(dsub) dsub.textContent = Math.max(0, total-done) + ' restantes';
    // #4296 — velocidad (%/h) y ETA los hidrata el accessor compartido desde
    // /api/dash/ola-eta (ritmo determinístico de la ola), no desde openedAt.
  } catch(_) {}
}
tickHeader();
setInterval(function(){ tickHeader().catch(function(){}); }, 5000);
tickBloqueadosMission();
setInterval(function(){ tickBloqueadosMission().catch(function(){}); }, 30000);
${missionOlaEtaClientScript()}
`;

/**
 * Documento SSR completo de la ventana Bloqueados (shell satélite + nav V3 +
 * fragmento + script). Replica el patrón de matriz.js / kpis.js. Lo consume el
 * router cliente (`?view=bloqueados` y `/bloqueados`).
 *
 * @param {object} state — snapshot del pipeline (state.bloqueados).
 * @param {object} [opts] — { nowMs } para tests.
 */
function renderBloqueados(state, opts) {
    const theme = loadTheme();
    const spriteInline = loadIconSprite();
    const navHtml = renderNavTabsSsr(slug);
    const fragment = renderBloqueadosSsr(state, opts);
    // #4238 — Cabecera de ola común (② del marco MIZPÁ): se reutiliza el helper
    // compartido renderMissionBanner de la HOME (CA-5, sin duplicar markup). Se
    // sirve neutro en SSR (igual que la HOME) y lo hidrata tickBloqueadosMission()
    // desde /api/dash/waves (CA-2). Si el módulo no cargó, el slot queda vacío.
    const missionHtml = (homeView && typeof homeView.renderMissionBanner === 'function')
        ? homeView.renderMissionBanner()
        : '';
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Intrale · Bloqueados</title>
<style>${theme}</style>
<style>
.satellite-frame { max-width: 1600px; margin: 0 auto; padding: 0; }
.satellite-body { padding: 22px 28px; display: flex; flex-direction: column; gap: 18px; }
/* #4238 — La cabecera de ola común (② del marco) vive fuera del .satellite-body
   (entre header y nav), así que se alinea con el padding horizontal del cuerpo.
   Misma regla que pageShell de los satélites migrados (EQUIPO #4258). */
.satellite-frame > .mz-mission { margin: 18px 28px 0; }
.in-mode-running { color: var(--in-ok); border-color: var(--in-ok); background: var(--in-ok-soft); }
.in-mode-paused { color: var(--in-bad); border-color: var(--in-bad); background: var(--in-bad-soft); }
.in-mode-partial { color: var(--in-warn); border-color: var(--in-warn); background: var(--in-warn-soft); }
</style>
</head>
<body>
<div aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">${spriteInline}</div>
<div class="satellite-frame">
  <header class="in-header">
    ${renderMizpaBrandBar()}
    <div class="in-header-meta">
      <span class="in-pill" id="hdr-mode">…</span>
      <span class="in-clock" id="hdr-clock">…</span>
    </div>
  </header>
  ${missionHtml}
  ${navHtml}
  <main class="satellite-body">${fragment}</main>
  <footer class="in-footer">
    <span>Refresh manual · acciones state-changing</span>
    <span>Intrale V3 · #3729</span>
  </footer>
</div>
<script>${FETCH_CLIENT_JS}\n${CONFIRM_MODAL_JS}\n${COMMON_HELPERS}\n${renderBloqueadosClientScript()}</script>
</body>
</html>`;
}

module.exports = {
    slug,
    renderBloqueadosSsr,
    renderBloqueadosClientScript,
    renderBloqueados,
    renderRowSsr,
    renderEmptyStateSsr,
    renderHeaderStatsSsr,
    renderFilterBarSsr,
    safeIssueNumber,
    severityOf,
    fmtAge,
    prettyReason,
    sortBySeverityAge,
    classifyCta,
    safeBotUsername,
    telegramDeepLink,
    escapeHtmlSsr,
    loadTheme,
    // #4193 (Ola 7.1) — rediseño integral MIZPÁ (centro de decisiones)
    MOTIVOS,
    classifyMotivo,
    groupByMotivo,
    deriveBanner,
    renderMissionBanner,
    renderMotivoGroupSsr,
    renderMizpaBrandBar,
    bloqueadosRedesignStyle,
};
