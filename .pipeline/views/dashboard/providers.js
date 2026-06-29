'use strict';

// =============================================================================
// providers.js — Pantalla "Providers" (Multi-Provider) del dashboard del
// pipeline. Rediseño integral MIZPÁ (Ola 7.1, issue #4201).
//
// Hereda el lenguaje visual MIZPÁ de las pantallas hermanas mergeadas
// (#4204 Home, #4206 Costos, #4207 Equipo, #4209 Bloqueados, #4211 Pipeline,
// #4212 Matriz, #4213 Ops): barra de marca (logo atalaya + tagline + selector
// multiproyecto), nav 5 tabs + «⋯ Más» (Providers vive adentro, con miga de
// pan), tooltips y footer redundante.
//
// Cambios clave del rediseño (mockup `providers-redesign-v2`, aprobado por Leo
// 2026-06-25):
//   1. SIN pestañas internas. La vista antigua `/multi-provider`
//      (multi-provider.js) partía la pantalla en solapas «Por agente»,
//      «Catálogo», «Health», «Permission overrides». Acá todo se ve de corrido.
//   2. UNA fila por proveedor: key enmascarada + fingerprint, salud en vivo con
//      barra de carga/cuota, tier (🟦 PLAN MAX · 🟧 PAGO · FREE), catálogo de
//      modelos en línea y kill-switch — todo unificado en una sola línea legible.
//   3. Banner de misión que DIAGNOSTICA la cadena leyendo el estado real de
//      salud (sanos N/5, quién absorbe el fallback y a qué nivel, riesgo). Nada
//      hardcodeado: si Gemini está en `red` el banner lo nombra.
//   4. Franja «Por agente» compacta al pie: la cadena DEFAULT + sólo los agentes
//      que la pisan (los deterministas build/tester/linter/delivery no listan).
//
// SSR 100% server-side: el render se valida con `curl` (CA explícito). El único
// JS de cliente es el reloj, los tooltips nativos y el toggle del kill-switch
// (POST autenticado con CSRF a los endpoints ya existentes de multi-provider).
//
// Seguridad: la key real NUNCA viaja — sólo `entry.masked` + `entry.fingerprint`
// vienen de la fuente única `secrets-rw.listKeys()`. Toda interpolación dinámica
// pasa por escapeHtmlText / escapeHtmlAttr. Sin handlers inline (CSP-friendly).
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');

const { escapeHtmlText, escapeHtmlAttr } = require('../../lib/escape-html.js');
const { renderStatusBadge } = require('./components');
const { renderNavTabsSsr, loadIconSprite } = require('./nav-tabs');

// Fuentes de datos (libs puras — sin req/res). Cada require va con guarda en el
// colector correspondiente: si una lib falla, la pantalla degrada con "sin
// datos" en vez de romper el render completo (CA-A3).
const secrets = require('../../lib/multi-provider/secrets-rw');

// #4246 — Banner de ola común (② del marco MIZPÁ de #4234). Se reutiliza el
// helper compartido `renderMissionBanner()` de la HOME para NO duplicar el markup
// (CA-5): mismo <section class="mz-mission"> con los IDs `mission-*` que hidrata
// tickProvidersMission() desde /api/dash/waves. Defensivo: si home.js no carga,
// el slot queda vacío y la pantalla sigue renderizando (CA-A3).
let homeView = null;
try { homeView = require('./home'); } catch (_) { /* sin banner de ola común */ }

const THEME_CSS_PATH = path.join(__dirname, 'theme.css');
const TOKENS_CSS_PATH = path.join(__dirname, '../../assets/design-tokens.css');
function loadTheme() { try { return fs.readFileSync(THEME_CSS_PATH, 'utf8'); } catch { return ''; } }
function loadDesignTokens() { try { return fs.readFileSync(TOKENS_CSS_PATH, 'utf8'); } catch { return ''; } }

// ───────────────────────── Constantes de dominio ─────────────────────────

// Orden canónico (memoria feedback_multi-provider-default-order: Claude > Codex
// > … > FREE). El set real gestionado hoy es éste — Groq aún no está en
// `agent-models.json`/`secrets-rw`, así que NO se inventa una fila para él
// (honramos lo que está en código; si se agrega, aparece automáticamente).
const PROVIDER_ORDER = Object.freeze(['anthropic', 'openai', 'gemini-google', 'cerebras', 'nvidia-nim']);

// Metadata estable por provider (tier = constante de negocio, no estado de
// salud). `disabledKey` mapea el nombre del provider de health/listKeys al de
// `provider-disabled.VALID_PROVIDERS` (openai → openai-codex). `catalogKey`
// mapea al `model-catalog`.
const PROVIDER_META = Object.freeze({
    anthropic:       { name: 'Claude',     accent: '--provider-anthropic',  tier: 'PLAN MAX', tierKind: 'max',  tierIcon: '🟦', disabledKey: 'anthropic',    catalogKey: 'anthropic' },
    openai:          { name: 'Codex',      accent: '--provider-openai',     tier: 'PAGO',     tierKind: 'paid', tierIcon: '🟧', disabledKey: 'openai-codex', catalogKey: 'openai-codex' },
    'gemini-google': { name: 'Gemini',     accent: '--provider-gemini',     tier: 'FREE',     tierKind: 'free', tierIcon: '🟩', disabledKey: 'gemini-google', catalogKey: 'gemini-google' },
    cerebras:        { name: 'Cerebras',   accent: '--provider-cerebras',   tier: 'FREE',     tierKind: 'free', tierIcon: '🟨', disabledKey: 'cerebras',     catalogKey: 'cerebras' },
    'nvidia-nim':    { name: 'NVIDIA NIM', accent: '--provider-nvidia-nim', tier: 'FREE',     tierKind: 'free', tierIcon: '🟩', disabledKey: 'nvidia-nim',   catalogKey: 'nvidia-nim' },
});

// Estado de salud → severidad del status-badge + etiqueta humana.
const HEALTH_SEVERITY = Object.freeze({ green: 'ok', yellow: 'warn', red: 'bad', unknown: 'info' });
const HEALTH_LABEL = Object.freeze({ green: 'SANO', yellow: 'DEGRADADO', red: 'CAÍDO', unknown: 'SIN DATOS' });

// Traducción legible de los reason_code del health-cron (allowlist; lo demás se
// muestra tal cual, escapado).
const REASON_LABEL = Object.freeze({
    cli_oauth_ok: 'OAuth CLI OK',
    authenticated: 'autenticado',
    timeout: 'timeout de red',
    forbidden: 'FORBIDDEN (403)',
    invalid_credentials: 'credencial inválida',
    quota_exhausted: 'cuota agotada',
    quota_exhausted_real: 'sin cuota usable (medida)',
    no_key_configured: 'sin key configurada',
    unknown_provider: 'provider desconocido',
    cli_unavailable: 'CLI no disponible',
});
function reasonHuman(code) {
    if (!code) return '—';
    return REASON_LABEL[code] || String(code).replace(/_/g, ' ');
}

function accentVar(provider) {
    const m = PROVIDER_META[provider];
    return m ? `var(${m.accent})` : 'var(--provider-unknown)';
}

// ───────────────────────── Colectores de datos (defensivos) ─────────────────────────

function collectKeys() {
    const byProvider = {};
    try {
        const list = secrets.listKeys();
        if (Array.isArray(list)) {
            for (const e of list) { if (e && e.provider) byProvider[e.provider] = e; }
        }
    } catch { /* degradamos a {} */ }
    return byProvider;
}

function collectHealthState() {
    // Estado por provider escrito por el health-cron (cada ~15min). Fuente más
    // rica para el banner de diagnóstico (state green/yellow/red + reason_code).
    const out = { byProvider: {}, green: 0, yellow: 0, red: 0, ts: null };
    try {
        const p = path.join(__dirname, '../../state/multi-provider-health.json');
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        out.ts = raw.ts || null;
        out.green = raw.green_count | 0;
        out.yellow = raw.yellow_count | 0;
        out.red = raw.red_count | 0;
        if (Array.isArray(raw.providers)) {
            for (const pr of raw.providers) { if (pr && pr.provider) out.byProvider[pr.provider] = pr; }
        }
    } catch { /* sin estado de salud todavía */ }
    return out;
}

function collectDispatch() {
    // Carga 24h por provider (dispatches con fallback). Sirve para la barra de
    // carga/cuota y para identificar quién absorbe el fallback.
    const out = { byProvider: {}, total: 0 };
    try {
        const hs = require('../../lib/multi-provider/health-screen.js');
        const payload = hs.buildScreenPayload({});
        out.total = payload.dispatches_total_24h | 0;
        if (Array.isArray(payload.cards)) {
            for (const c of payload.cards) {
                if (c && c.provider) out.byProvider[c.provider] = c.dispatches_24h | 0;
            }
        }
    } catch { /* sin tráfico/logs */ }
    return out;
}

function dispatchFor(dispatch, provider) {
    // 'openai' y 'openai-codex' son el mismo proveedor visual (Codex). Sumamos
    // ambos buckets para no subreportar su carga.
    const d = dispatch.byProvider || {};
    if (provider === 'openai') return (d['openai'] | 0) + (d['openai-codex'] | 0);
    return d[provider] | 0;
}

function collectCatalog() {
    const out = {};
    try {
        const mc = require('../../lib/multi-provider/model-catalog.js');
        const r = mc.listModels();
        if (r && r.catalog) {
            for (const [k, models] of Object.entries(r.catalog)) {
                out[k] = (models || []).map((m) => m.id).filter(Boolean);
            }
        }
    } catch { /* sin catálogo */ }
    return out;
}

function collectAgentConfig() {
    // default_provider + cadenas por skill (para la franja «Por agente» y los
    // modelos default por provider).
    const out = { defaultProvider: 'anthropic', providers: {}, skills: {} };
    try {
        const am = require('../../lib/multi-provider/agent-models-rw.js');
        const cfg = am.readConfig();
        if (cfg && typeof cfg === 'object') {
            out.defaultProvider = cfg.default_provider || 'anthropic';
            out.providers = cfg.providers || {};
            out.skills = cfg.skills || {};
        }
    } catch { /* sin config de agentes */ }
    return out;
}

function collectDisabled() {
    const out = { disabledSet: new Set(), valid: [] };
    try {
        const pd = require('../../lib/provider-disabled.js');
        out.valid = Array.isArray(pd.VALID_PROVIDERS) ? pd.VALID_PROVIDERS.slice() : [];
        const list = pd.listDisabledProviders();
        if (list && Array.isArray(list.disabled)) {
            for (const e of list.disabled) { if (e && e.name) out.disabledSet.add(e.name); }
        }
    } catch { /* sin estado de kill-switch */ }
    return out;
}

// ───────────────────────── Modelo unificado ─────────────────────────

/**
 * Cruza todas las fuentes en un único modelo de la pantalla. Defensivo: cada
 * colector ya degrada a vacío si su fuente falla, así que esto nunca lanza.
 * @returns {{providers: object[], meta: object}}
 */
function buildProvidersModel() {
    const keys = collectKeys();
    const health = collectHealthState();
    const dispatch = collectDispatch();
    const catalog = collectCatalog();
    const agents = collectAgentConfig();
    const disabled = collectDisabled();

    const providers = PROVIDER_ORDER.map((key) => {
        const meta = PROVIDER_META[key];
        const k = keys[key] || {};
        const h = health.byProvider[key] || {};
        const state = (h.state === 'green' || h.state === 'yellow' || h.state === 'red') ? h.state : 'unknown';
        const disp = dispatchFor(dispatch, key);
        const loadPct = dispatch.total > 0 ? Math.round((disp / dispatch.total) * 100) : 0;

        // Modelos: catálogo explícito si existe; si no, el modelo default de
        // agent-models.json (siempre hay al menos uno).
        let models = catalog[meta.catalogKey] || [];
        if (models.length === 0) {
            const pdef = agents.providers[meta.catalogKey] || agents.providers[key] || {};
            if (pdef.model) models = [pdef.model];
        }

        return {
            key,
            disabledKey: meta.disabledKey,
            name: meta.name,
            accent: accentVar(key),
            tier: meta.tier,
            tierKind: meta.tierKind,
            tierIcon: meta.tierIcon,
            masked: k.masked || null,
            fingerprint: k.fingerprint || null,
            keyStatus: k.status || h.key_status || 'absent',
            editable: k.editable !== false,
            reason: k.reason || null,
            authMode: h.auth_mode || (k.editable === false ? 'oauth' : null),
            freeTierNotes: k.free_tier_notes || h.free_tier_notes || null,
            healthState: state,
            healthReason: h.reason_code || null,
            // #4283 — discriminante de cuota real (#4202). Independiente del
            // estado de login: distingue "logueado" de "logueado + con cuota"
            // (CA-5). Shape seguro { adapterStatus, status, pct } — sin secretos.
            quota: (h.quota && typeof h.quota === 'object') ? h.quota : null,
            lastChecked: h.last_checked_at || null,
            loadPct,
            dispatches24h: disp,
            hasTraffic: dispatch.total > 0,
            models,
            disabled: disabled.disabledSet.has(meta.disabledKey),
        };
    });

    // Diagnóstico de la cadena.
    const total = providers.length;
    const degraded = providers.filter((p) => p.healthState === 'yellow' || p.healthState === 'red');
    const healthy = providers.filter((p) => p.healthState === 'green').length;
    // Quién absorbe el fallback: el provider con mayor carga 24h.
    let absorber = null;
    for (const p of providers) {
        if (!absorber || p.loadPct > absorber.loadPct) absorber = p;
    }

    // Agentes que pisan la cadena DEFAULT: skills cuyo provider primario es el
    // default (anthropic) — excluye los deterministas (build/tester/linter/
    // delivery), que no usan la cadena LLM.
    const agentChain = [];
    for (const [skill, def] of Object.entries(agents.skills)) {
        const primary = (def && def.provider) || agents.defaultProvider;
        if (primary === agents.defaultProvider && primary !== 'deterministic') {
            agentChain.push(skill);
        }
    }
    agentChain.sort();

    return {
        providers,
        meta: {
            total,
            healthy,
            degraded,
            absorber,
            defaultProvider: agents.defaultProvider,
            defaultChain: PROVIDER_ORDER.map((k) => PROVIDER_META[k].name),
            agents: agentChain,
            healthTs: health.ts,
            dispatchTotal: dispatch.total,
        },
    };
}

// ───────────────────────── Render SSR ─────────────────────────

function renderTierBadge(p) {
    const cls = 'prov-tier prov-tier-' + p.tierKind;
    const title = p.tierKind === 'max' ? 'Plan MAX (suscripción Claude, sin costo por token)'
        : p.tierKind === 'paid' ? 'Tier pago (consume créditos de la cuenta)'
        : 'Tier gratuito (free tier del proveedor)';
    return `<span class="${cls}" title="${escapeHtmlAttr(title)}">`
        + `<span aria-hidden="true">${p.tierIcon}</span>${escapeHtmlText(p.tier)}</span>`;
}

function renderQuotaBar(p) {
    if (!p.hasTraffic) {
        return `<div class="prov-quota" title="${escapeHtmlAttr('Sin despachos registrados en las últimas 24h')}">`
            + `<div class="prov-quota-track"><div class="prov-quota-fill is-empty" style="width:0%"></div></div>`
            + `<span class="prov-quota-lbl">sin tráfico 24h</span></div>`;
    }
    const lvl = p.loadPct >= 60 ? 'is-high' : p.loadPct >= 30 ? 'is-mid' : 'is-low';
    const tip = `Carga 24h: ${p.dispatches24h} despachos · ${p.loadPct}% del total de la cadena`;
    return `<div class="prov-quota" title="${escapeHtmlAttr(tip)}">`
        + `<div class="prov-quota-track"><div class="prov-quota-fill ${lvl}" style="width:${p.loadPct}%"></div></div>`
        + `<span class="prov-quota-lbl">${p.loadPct}% carga 24h</span></div>`;
}

// #4283 — Chip de cuota real (CA-5). Dimensión INDEPENDIENTE del login: el
// color/texto del chip refleja la cuota medida (#4202), no el OAuth. No
// reutiliza `renderQuotaBar` (esa mide carga de despachos 24h, otra métrica).
// Accesibilidad: el texto del chip es el portador primario de significado; el
// color refuerza (no color-only). Umbral ≥90% lo decide el adapter (status
// 'critical'), una sola fuente de verdad — no se hardcodea acá.
function renderQuotaChip(p) {
    const q = p.quota;
    if (!q || typeof q !== 'object') return '';
    const adapter = q.adapterStatus;
    const status = q.status;
    const pct = (typeof q.pct === 'number' && isFinite(q.pct)) ? q.pct : null;

    let cls; let label; let tip;
    if (adapter === 'ok' && status === 'critical') {
        cls = 'prov-quota-chip is-bad';
        label = 'SIN CUOTA';
        tip = `Cuota real: ${pct == null ? '≥90' : pct}% usado · umbral rojo ≥90% · medición offline #4202`;
    } else if (adapter === 'ok') {
        cls = 'prov-quota-chip is-ok';
        label = 'CON CUOTA';
        tip = `Cuota real: ${pct == null ? '<90' : pct}% usado · umbral rojo ≥90% · medición offline #4202`;
    } else if (adapter === 'unknown' || adapter === 'error') {
        cls = 'prov-quota-chip is-dim';
        label = 'CUOTA S/D';
        tip = 'No se pudo medir la cuota (adapter unknown/error) — salud sigue por login';
    } else {
        // 'no_quota' / 'not_implemented' → el provider no maneja cuota medible.
        return '';
    }
    return `<span class="${cls}" title="${escapeHtmlAttr(tip)}">${escapeHtmlText(label)}</span>`;
}

function renderKeyCell(p) {
    // Anthropic / OAuth-MAX: sin API key rotable por UI.
    if (!p.editable || (p.keyStatus === 'absent' && p.authMode === 'oauth')) {
        return `<div class="prov-key prov-key-oauth" title="${escapeHtmlAttr(p.reason || 'Autenticación vía OAuth del CLI — no hay API key que mostrar')}">`
            + `<span aria-hidden="true">🔒</span> OAuth / MAX · sin API key</div>`;
    }
    if (p.masked) {
        const fp = p.fingerprint
            ? `<span class="prov-fp" title="${escapeHtmlAttr('Fingerprint SHA-256 (16 chars) — detecta cambios sin exponer la key')}">fp ${escapeHtmlText(p.fingerprint)}</span>`
            : '';
        return `<div class="prov-key" title="${escapeHtmlAttr('Preview enmascarado: primeros 6 + últimos 4 caracteres. La key completa nunca viaja por HTTP.')}">`
            + `<span aria-hidden="true">🔑</span><code>${escapeHtmlText(p.masked)}</code>${fp}</div>`;
    }
    return `<div class="prov-key prov-key-absent" title="${escapeHtmlAttr('Sin credencial configurada para este proveedor')}">`
        + `<span aria-hidden="true">∅</span> sin key</div>`;
}

function renderCatalogCell(p) {
    if (!p.models || p.models.length === 0) {
        return `<div class="prov-models prov-models-empty">— sin catálogo —</div>`;
    }
    const chips = p.models.map((m) => `<span class="prov-model">${escapeHtmlText(m)}</span>`).join('<span class="prov-model-sep" aria-hidden="true">·</span>');
    return `<div class="prov-models" title="${escapeHtmlAttr('Modelos disponibles para ' + p.name)}">${chips}</div>`;
}

function renderKillSwitch(p) {
    const on = !p.disabled; // "on" = habilitado (no apagado).
    const cls = 'prov-kill' + (on ? ' is-on' : ' is-off');
    const label = on ? 'ACTIVO' : 'APAGADO';
    const tip = on
        ? `Proveedor activo en la cadena. Click para apagarlo (kill-switch) — deja de recibir despachos.`
        : `Proveedor apagado por kill-switch. Click para reactivarlo en la cadena.`;
    return `<button type="button" class="${cls}" data-action="toggle-kill"`
        + ` data-provider="${escapeHtmlAttr(p.disabledKey)}" data-on="${on ? '1' : '0'}"`
        + ` title="${escapeHtmlAttr(tip)}" aria-pressed="${on ? 'true' : 'false'}"`
        + ` aria-label="${escapeHtmlAttr('Kill-switch de ' + p.name + ': ' + label)}">`
        + `<span class="prov-kill-dot" aria-hidden="true"></span>${label}</button>`;
}

/**
 * Una fila por proveedor (mockup v2). Toda la info — key, salud, tier, catálogo,
 * kill-switch — en una sola línea legible, sin solapas.
 */
function renderProviderRow(p) {
    const sev = HEALTH_SEVERITY[p.healthState] || 'info';
    const healthLabel = HEALTH_LABEL[p.healthState] || 'SIN DATOS';
    const reasonTxt = reasonHuman(p.healthReason);
    return `<article class="prov-row" data-provider="${escapeHtmlAttr(p.key)}" style="--row-accent:${p.accent};">
  <div class="prov-id">
    <span class="prov-dot" aria-hidden="true"></span>
    <div class="prov-id-txt">
      <span class="prov-name">${escapeHtmlText(p.name)}</span>
      ${renderTierBadge(p)}
    </div>
  </div>
  <div class="prov-col prov-col-key">${renderKeyCell(p)}</div>
  <div class="prov-col prov-col-health">
    <div class="prov-health-badges">
      ${renderStatusBadge({ severity: sev, label: healthLabel, title: 'Salud en vivo: ' + healthLabel + ' (' + reasonTxt + ')' })}
      ${renderQuotaChip(p)}
    </div>
    <span class="prov-health-reason" title="${escapeHtmlAttr('Causa reportada por el health-cron')}">${escapeHtmlText(reasonTxt)}</span>
    ${renderQuotaBar(p)}
  </div>
  <div class="prov-col prov-col-models">${renderCatalogCell(p)}</div>
  <div class="prov-col prov-col-kill">${renderKillSwitch(p)}</div>
</article>`;
}

/**
 * Banner de misión: diagnostica la cadena. Lee estado real (no hardcodea).
 */
function renderMissionBanner(meta) {
    const degradedCount = meta.degraded.length;
    const calm = degradedCount === 0;
    const cls = 'prov-mission' + (calm ? ' is-calm' : ' is-degraded');

    let ttl, chip, desc;
    if (calm) {
        ttl = 'La cadena de providers está sana';
        chip = 'TODO OK';
        desc = `Los ${meta.total} proveedores responden. La cadena de fallback puede absorber caídas sin intervención.`;
    } else {
        const names = meta.degraded.map((p) => `${p.name} (${reasonHuman(p.healthReason)})`).join(', ');
        ttl = 'La cadena de providers está degradada';
        chip = degradedCount === 1 ? '1 PROVEEDOR CAÍDO' : `${degradedCount} PROVEEDORES CAÍDOS`;
        desc = `Afectados: ${names}. La cadena sigue operativa por fallback, pero con menos redundancia.`;
    }

    const abs = meta.absorber;
    const absName = abs ? abs.name : '—';
    const absPct = abs ? abs.loadPct : 0;
    const absRisk = absPct >= 50
        ? `concentra >½ del tráfico — punto único de presión`
        : absPct >= 30
        ? `absorbe una porción alta de la cadena`
        : `reparto de carga saludable`;

    const badgeN = calm ? String(meta.healthy) : String(degradedCount);
    const badgeK = calm ? 'SANOS' : 'CAÍDOS';

    return `
<div class="${cls}" id="prov-mission" role="region" aria-label="Diagnóstico de la cadena de proveedores">
  <div class="prov-btag">
    <div class="prov-btag-n">${escapeHtmlText(badgeN)}</div>
    <div class="prov-btag-k">${escapeHtmlText(badgeK)}</div>
    <div class="prov-btag-s">DE ${escapeHtmlText(String(meta.total))} PROVIDERS</div>
  </div>
  <div class="prov-mtext">
    <div class="prov-m-ttl">${escapeHtmlText(ttl)}<span class="prov-m-chip">${escapeHtmlText(chip)}</span></div>
    <div class="prov-m-desc">${escapeHtmlText(desc)}</div>
    <div class="prov-wmetrics">
      <div class="prov-wm">
        <div class="prov-wm-l">🟢 PROVEEDORES SANOS</div>
        <div class="prov-wm-v">${escapeHtmlText(String(meta.healthy))} <span class="u">de ${escapeHtmlText(String(meta.total))}</span></div>
        <div class="prov-wm-s">${calm ? 'cadena completa' : escapeHtmlText(meta.degraded.map((p) => p.name).join(', ') + ' fuera')}</div>
      </div>
      <div class="prov-wm">
        <div class="prov-wm-l">⚖ ABSORBE EL FALLBACK</div>
        <div class="prov-wm-v">${escapeHtmlText(absName)} <span class="u">${escapeHtmlText(String(absPct))}%</span></div>
        <div class="prov-wm-s">${escapeHtmlText(absRisk)}</div>
      </div>
      <div class="prov-wm">
        <div class="prov-wm-l">📦 TRÁFICO 24H</div>
        <div class="prov-wm-v">${escapeHtmlText(String(meta.dispatchTotal))} <span class="u">despachos</span></div>
        <div class="prov-wm-s">base del cálculo de carga por provider</div>
      </div>
    </div>
  </div>
  <div class="prov-mright">
    <div class="prov-reco">
      <div class="prov-reco-l">${calm ? '✓ SIN ACCIÓN PENDIENTE' : '⚠ ACCIÓN SUGERIDA'}</div>
      <div class="prov-reco-t">${calm
          ? 'Monitorear. La cadena tiene redundancia para absorber una caída.'
          : escapeHtmlText('Revisar ' + meta.degraded.map((p) => p.name).join(', ') + ' (terminal Windows / health-run). El resto cubre el fallback.')}</div>
    </div>
  </div>
</div>`;
}

/**
 * Franja «Por agente» al pie: cadena DEFAULT + agentes que la pisan.
 */
function renderAgentStrip(meta) {
    const chainHtml = meta.defaultChain
        .map((n) => `<span class="prov-chain-node">${escapeHtmlText(n)}</span>`)
        .join('<span class="prov-chain-arrow" aria-hidden="true">→</span>');
    const agentsHtml = meta.agents.length
        ? meta.agents.map((a) => `<span class="prov-agent" title="${escapeHtmlAttr(a + ' usa la cadena DEFAULT')}">${escapeHtmlText(a)}</span>`).join('')
        : '<span class="prov-agent-empty">sin agentes sobre la cadena DEFAULT</span>';
    return `
<section class="in-section prov-agents" aria-labelledby="prov-agents-title">
  <h2 id="prov-agents-title" class="in-section-title">
    <span class="in-section-title-icon" aria-hidden="true">🧩</span>Por agente
    <span class="prov-agents-sub">— la cadena DEFAULT y quién la pisa</span>
  </h2>
  <div class="prov-chain" aria-label="Cadena DEFAULT de fallback">${chainHtml}</div>
  <div class="prov-agent-grid">${agentsHtml}</div>
</section>`;
}

function bodyHtml(model) {
    const rows = model.providers.map(renderProviderRow).join('');
    return `
${renderMissionBanner(model.meta)}
<section class="in-section" aria-labelledby="providers-title">
  <h2 id="providers-title" class="in-section-title">
    <span class="in-section-title-icon" aria-hidden="true">🔌</span>Proveedores
    <span class="prov-list-sub">— key, salud, tier, catálogo y kill-switch en una sola fila</span>
  </h2>
  <div class="prov-list" id="providers-list">${rows}</div>
</section>
${renderAgentStrip(model.meta)}`;
}

// ───────────────────────── Barra de marca MIZPÁ (hereda de las hermanas) ─────────────────────────

function renderBrandBar() {
    const logoSvg = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">'
        + '<path d="M12 2.5 5 6v5c0 4.6 3 8 7 9.5 4-1.5 7-4.9 7-9.5V6l-7-3.5Z" stroke="#06121a" stroke-width="1.6" fill="rgba(255,255,255,.16)"/>'
        + '<path d="M9.5 12.5 11.3 14.3 14.8 10.4" stroke="#06121a" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return `
    <div class="in-header-brand">
      <div class="mz-logo" aria-hidden="true" title="MIZPÁ · atalaya de agentes (Génesis 31:49)">${logoSvg}</div>
      <div class="mz-id">
        <div class="mz-name">MIZPÁ</div>
        <div class="mz-sub">«Que el Señor vigile» · atalaya de agentes</div>
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

// ───────────────────────── CSS de la pantalla ─────────────────────────

const PANEL_CSS = `
.satellite-frame { max-width: 1600px; margin: 0 auto; padding: 0; }
.satellite-body { padding: 22px 28px; display: flex; flex-direction: column; gap: 18px; }
.prov-list-sub, .prov-agents-sub { font-size: 12px; font-weight: 500; color: var(--in-fg-dim); margin-left: 8px; }

/* #4246 — Banner de ola común (② del marco MIZPÁ). El markup viene del helper
   compartido homeView.renderMissionBanner() (CA-5: no se duplica markup); el CSS
   .mz-* se replica acá porque no vive en theme.css — misma convención que
   pipeline-redesign.js (#4234) y home.js. El banner vive entre el header y la nav
   (fuera del .satellite-body), así que se alinea al padding horizontal del cuerpo. */
.satellite-frame > .mz-mission { margin: 18px 28px 0; }
.mz-mission { display: flex; align-items: center; gap: 22px; position: relative; overflow: hidden;
    background: linear-gradient(110deg, rgba(52,217,224,.14), rgba(124,92,255,.08) 45%, transparent 75%),
                linear-gradient(180deg, var(--in-bg-2,#11151E), var(--in-bg-3,#141925));
    border: 1px solid rgba(52,217,224,.22); border-radius: 16px; padding: 18px 24px; }
.mz-mission::after { content: "🌊"; position: absolute; right: 18px; top: -14px; font-size: 90px; opacity: .06; }
.mz-wavetag { display: flex; flex-direction: column; align-items: center; justify-content: center; min-width: 92px;
    padding: 10px 14px; border-radius: 14px; flex: none;
    background: linear-gradient(135deg, rgba(52,217,224,.22), rgba(124,92,255,.16)); border: 1px solid rgba(52,217,224,.3); }
.mz-wavetag-k { font-size: 10px; font-weight: 800; letter-spacing: 1.5px; color: #9fe9ee; }
.mz-wavetag-n { font-size: 34px; font-weight: 800; color: #bff3f6; line-height: 1; font-variant-numeric: tabular-nums; }
.mz-mission-text { flex: 1; min-width: 0; }
.mz-mission-ttl { font-size: 19px; font-weight: 800; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mz-mission-badge { font-size: 11px; color: var(--brand-cyan,#34D9E0); background: rgba(52,217,224,.12);
    border: 1px solid rgba(52,217,224,.3); padding: 3px 9px; border-radius: 20px; font-weight: 700; letter-spacing: .3px; }
.mz-mission-desc { font-size: 13px; color: var(--in-fg-dim,#8A93A6); margin-top: 5px; max-width: 620px; line-height: 1.45; }
.mz-mission-metrics { display: flex; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
.mz-wm { flex: 1; min-width: 150px; background: rgba(255,255,255,.035); border: 1px solid var(--in-border,rgba(255,255,255,.07));
    border-radius: 11px; padding: 9px 12px; }
.mz-wm-l { font-size: 9.5px; font-weight: 800; letter-spacing: .7px; color: var(--in-fg-dim,#5B6376); }
.mz-wm-v { font-size: 17px; font-weight: 800; margin-top: 3px; line-height: 1; font-variant-numeric: tabular-nums; }
.mz-wm-u { font-size: 11px; color: var(--in-fg-dim,#5B6376); font-weight: 600; }
.mz-wm-s { font-size: 10px; color: var(--in-fg-dim,#5B6376); margin-top: 3px; }
.mz-mission-prog { min-width: 260px; }
.mz-prog-head { display: flex; align-items: baseline; justify-content: space-between; font-size: 11.5px; color: var(--in-fg-dim,#8A93A6); font-weight: 600; }
.mz-prog-pct { font-size: 26px; font-weight: 800; color: var(--brand-cyan,#34D9E0); font-variant-numeric: tabular-nums; }
.mz-prog-bar { height: 8px; border-radius: 6px; background: rgba(255,255,255,.07); overflow: hidden; display: flex; margin: 9px 0 8px; }
.mz-prog-bar i { height: 100%; transition: width .4s ease; }
.mz-prog-legend { display: flex; gap: 14px; font-size: 11px; color: var(--in-fg-dim,#8A93A6); flex-wrap: wrap; }
.mz-prog-legend span { display: flex; align-items: center; gap: 5px; }
.mz-prog-legend b { font-variant-numeric: tabular-nums; }
.mz-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex: none; }
@media (max-width: 1100px) { .mz-mission { flex-direction: column; align-items: stretch; } }

/* Banner de misión */
.prov-mission { display: grid; grid-template-columns: auto 1fr auto; gap: 22px; align-items: stretch;
  background: var(--in-bg-3); border: 1px solid var(--in-border); border-radius: 14px; padding: 18px 22px; }
.prov-mission.is-degraded { border-color: var(--in-bad); box-shadow: inset 3px 0 0 var(--in-bad); }
.prov-mission.is-calm { border-color: var(--in-ok); box-shadow: inset 3px 0 0 var(--in-ok); }
.prov-btag { display: flex; flex-direction: column; align-items: center; justify-content: center;
  min-width: 120px; padding: 12px 16px; border-radius: 12px; background: var(--in-bg-2); border: 1px solid var(--in-border); }
.prov-mission.is-degraded .prov-btag { background: var(--in-bad-soft); border-color: var(--in-bad); }
.prov-mission.is-calm .prov-btag { background: var(--in-ok-soft); border-color: var(--in-ok); }
.prov-btag-n { font-size: 42px; font-weight: 900; line-height: 1; }
.prov-btag-k { font-size: 12px; font-weight: 800; letter-spacing: 1px; margin-top: 4px; }
.prov-btag-s { font-size: 9.5px; font-weight: 700; color: var(--in-fg-dim); letter-spacing: .6px; margin-top: 3px; }
.prov-mtext { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.prov-m-ttl { font-size: 17px; font-weight: 800; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.prov-m-chip { font-size: 10px; font-weight: 800; letter-spacing: .8px; padding: 3px 9px; border-radius: 8px;
  background: var(--in-bg-2); border: 1px solid var(--in-border); color: var(--in-fg-dim); }
.prov-mission.is-degraded .prov-m-chip { background: var(--in-bad-soft); border-color: var(--in-bad); color: var(--in-bad); }
.prov-mission.is-calm .prov-m-chip { background: var(--in-ok-soft); border-color: var(--in-ok); color: var(--in-ok); }
.prov-m-desc { font-size: 13px; color: var(--in-fg-dim); line-height: 1.5; }
.prov-wmetrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-top: 6px; }
.prov-wm { background: var(--in-bg-2); border: 1px solid var(--in-border); border-radius: 10px; padding: 10px 12px; }
.prov-wm-l { font-size: 9.5px; font-weight: 800; letter-spacing: .6px; color: var(--in-fg-dim); }
.prov-wm-v { font-size: 19px; font-weight: 800; margin-top: 4px; }
.prov-wm-v .u { font-size: 12px; font-weight: 600; color: var(--in-fg-dim); }
.prov-wm-s { font-size: 11px; color: var(--in-fg-dim); margin-top: 3px; }
.prov-mright { display: flex; align-items: stretch; }
.prov-reco { display: flex; flex-direction: column; justify-content: center; min-width: 210px; max-width: 250px;
  background: var(--in-bg-2); border: 1px solid var(--in-border); border-radius: 12px; padding: 12px 14px; }
.prov-mission.is-degraded .prov-reco { border-color: var(--in-warn); }
.prov-reco-l { font-size: 10px; font-weight: 800; letter-spacing: .6px; color: var(--in-fg-dim); }
.prov-reco-t { font-size: 12.5px; font-weight: 600; margin-top: 6px; line-height: 1.45; }

/* Lista de providers — una fila por proveedor */
.prov-list { display: flex; flex-direction: column; gap: 10px; }
.prov-row { display: grid; grid-template-columns: 200px 1.3fr 1.4fr 1.5fr auto; gap: 16px; align-items: center;
  background: var(--in-bg-3); border: 1px solid var(--in-border); border-left: 4px solid var(--row-accent, var(--in-border));
  border-radius: 12px; padding: 14px 18px; }
.prov-id { display: flex; align-items: center; gap: 10px; min-width: 0; }
.prov-dot { width: 12px; height: 12px; border-radius: 50%; flex: none; background: var(--row-accent, var(--in-fg-dim)); box-shadow: 0 0 0 3px color-mix(in srgb, var(--row-accent, #888) 22%, transparent); }
.prov-id-txt { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.prov-name { font-size: 15px; font-weight: 800; }
.prov-tier { display: inline-flex; align-items: center; gap: 5px; font-size: 9.5px; font-weight: 800; letter-spacing: .5px;
  padding: 2px 8px; border-radius: 7px; width: fit-content; border: 1px solid transparent; }
.prov-tier-max  { background: rgba(52,217,224,.14); color: #9fe9ee; border-color: rgba(52,217,224,.4); }
.prov-tier-paid { background: var(--provider-anthropic-bg); color: var(--provider-anthropic-fg); border-color: var(--provider-anthropic-dim); }
.prov-tier-free { background: var(--in-bg-2); color: var(--in-fg-dim); border-color: var(--in-border); }
.prov-col { min-width: 0; }
.prov-key { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-family: var(--in-mono); font-size: 12px; color: var(--in-fg); word-break: break-all; }
.prov-key code { color: var(--in-fg); }
.prov-key-oauth, .prov-key-absent { color: var(--in-fg-dim); font-family: inherit; font-weight: 600; }
.prov-fp { font-size: 10.5px; color: var(--in-fg-dim); }
.prov-col-health { display: flex; flex-direction: column; gap: 6px; }
.prov-health-badges { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.prov-health-reason { font-size: 11px; color: var(--in-fg-dim); }
/* #4283 — chip de cuota real. Reutiliza las parejas MIZPÁ ya validadas (WCAG
   AA en tema oscuro). No introduce colores nuevos. */
.prov-quota-chip { font-size: 10.5px; font-weight: 700; letter-spacing: .04em; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--in-border); white-space: nowrap; }
.prov-quota-chip.is-ok { color: var(--in-ok); background: var(--in-ok-soft); border-color: var(--in-ok); }
.prov-quota-chip.is-bad { color: var(--in-bad); background: var(--in-bad-soft); border-color: var(--in-bad); }
.prov-quota-chip.is-dim { color: var(--in-fg-dim); background: transparent; }
.prov-quota { display: flex; align-items: center; gap: 8px; }
.prov-quota-track { flex: 1; height: 7px; border-radius: 4px; background: var(--in-bg-2); border: 1px solid var(--in-border); overflow: hidden; min-width: 70px; }
.prov-quota-fill { height: 100%; border-radius: 4px; transition: width .3s; }
.prov-quota-fill.is-low { background: var(--in-ok); }
.prov-quota-fill.is-mid { background: var(--in-warn); }
.prov-quota-fill.is-high { background: var(--in-bad); }
.prov-quota-fill.is-empty { background: transparent; }
.prov-quota-lbl { font-size: 10.5px; color: var(--in-fg-dim); white-space: nowrap; }
.prov-models { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.prov-model { font-family: var(--in-mono); font-size: 11px; color: var(--in-fg); background: var(--in-bg-2);
  border: 1px solid var(--in-border); border-radius: 6px; padding: 2px 7px; }
.prov-model-sep { color: var(--in-fg-soft); }
.prov-models-empty { font-size: 11px; color: var(--in-fg-soft); }
.prov-kill { display: inline-flex; align-items: center; gap: 7px; font-size: 11px; font-weight: 800; letter-spacing: .5px;
  padding: 7px 12px; border-radius: 9px; cursor: pointer; border: 1px solid var(--in-border); background: var(--in-bg-2); color: var(--in-fg); }
.prov-kill-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.prov-kill.is-on { border-color: var(--in-ok); color: var(--in-ok); background: var(--in-ok-soft); }
.prov-kill.is-on .prov-kill-dot { background: var(--in-ok); }
.prov-kill.is-off { border-color: var(--in-bad); color: var(--in-bad); background: var(--in-bad-soft); }
.prov-kill.is-off .prov-kill-dot { background: var(--in-bad); }
.prov-kill:hover { filter: brightness(1.12); }

/* Franja por agente */
.prov-chain { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 4px 0 12px; }
.prov-chain-node { font-size: 12px; font-weight: 800; padding: 4px 11px; border-radius: 8px; background: var(--in-bg-2); border: 1px solid var(--in-border); }
.prov-chain-arrow { color: var(--in-fg-dim); font-weight: 800; }
.prov-agent-grid { display: flex; flex-wrap: wrap; gap: 7px; }
.prov-agent { font-size: 11.5px; font-weight: 600; padding: 4px 10px; border-radius: 999px; background: var(--in-bg-2); border: 1px solid var(--in-border); color: var(--in-fg-dim); }
.prov-agent-empty { font-size: 12px; color: var(--in-fg-soft); }

@media (max-width: 1100px) {
  .prov-row { grid-template-columns: 1fr 1fr; }
  .prov-mission { grid-template-columns: 1fr; }
  .prov-wmetrics { grid-template-columns: 1fr; }
}
`;

// ───────────────────────── Client JS (sin handlers inline) ─────────────────────────

const PROVIDERS_CLIENT_JS = `
(function(){
  function tickClock(){ var c = document.getElementById('hdr-clock'); if(c) c.textContent = new Date().toLocaleTimeString('es-AR'); }
  tickClock(); setInterval(tickClock, 1000);

  var csrf = null;
  function fetchJson(url, opts){
    return fetch(url, Object.assign({ cache:'no-store' }, opts||{}))
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(d){ d.__status = r.status; d.__ok = r.ok; return d; }); })
      .catch(function(e){ return { __ok:false, error: e.message }; });
  }

  // #4246 — Hidratación del banner de ola común (② del marco MIZPÁ). El SSR llega
  // neutro (igual que HOME / EQUIPO / DESCANSO); este tick espeja /api/dash/waves
  // a los IDs mission-* del helper compartido renderMissionBanner. Espejo de
  // tickDescansoMission() (#4245). Defensivo: cualquier dato ausente degrada a
  // neutro sin romper el resto de la pantalla.
  function setText(id, value){ var el = document.getElementById(id); if(el && el.textContent !== String(value)) el.textContent = String(value); }
  function tickMission(){
    return fetchJson('/api/dash/waves').then(function(d){
      if(!d || d.__ok === false) return;
      try {
        var wave = d.active_wave;
        if(!wave){
          setText('mission-wave-num', '—');
          setText('mission-wave-name', 'Sin ola activa');
          setText('mission-wave-desc', 'Esperando la planificación de la ola activa.');
          return;
        }
        if(typeof wave.number === 'number' && isFinite(wave.number)) setText('mission-wave-num', String(wave.number));
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
        // #4296 — el avance % ya NO se deriva de conteos acá: lo hidrata el helper
        // compartido (FETCH_CLIENT_JS) desde /api/dash/ola-eta, igual que la HOME.
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
        var openedAt = wave.openedAt ? Date.parse(wave.openedAt) : NaN;
        var vv = document.getElementById('mission-vel-value');
        if(vv){
          if(isFinite(openedAt) && done > 0){
            var hours = (Date.now() - openedAt) / 3600000;
            vv.innerHTML = hours > 0.1
              ? (done/hours).toFixed(1) + ' <span class="mz-wm-u">iss/h</span>'
              : '— <span class="mz-wm-u">iss/h</span>';
          } else {
            vv.innerHTML = '— <span class="mz-wm-u">iss/h</span>';
          }
        }
      } catch(_) {}
    });
  }
  tickMission(); setInterval(function(){ tickMission(); }, 30000);
  function getCsrf(){
    if(csrf) return Promise.resolve(csrf);
    return fetchJson('/api/multi-provider/csrf-token').then(function(r){ csrf = r && r.csrf_token; return csrf; });
  }
  function toggleKill(btn){
    var provider = btn.getAttribute('data-provider');
    var on = btn.getAttribute('data-on') === '1';
    var action = on ? 'disable' : 'enable'; // si está ON -> apagar.
    btn.disabled = true;
    getCsrf().then(function(token){
      return fetchJson('/api/multi-provider/providers/' + encodeURIComponent(provider) + '/' + action, {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'X-CSRF-Token': token || '', 'X-Requested-With':'XMLHttpRequest' },
        body: '{}'
      });
    }).then(function(r){
      btn.disabled = false;
      if(r && r.__ok){ location.reload(); }
      else { alert('No se pudo cambiar el kill-switch: ' + ((r && (r.error||r.message)) || ('HTTP ' + (r && r.__status)))); }
    });
  }
  document.addEventListener('click', function(ev){
    var t = ev.target.closest ? ev.target.closest('[data-action="toggle-kill"]') : null;
    if(t){ ev.preventDefault(); toggleKill(t); }
  });
})();
`;

// ───────────────────────── Render principal ─────────────────────────

function renderProviders() {
    const tokens = loadDesignTokens();
    const theme = loadTheme();
    const spriteInline = loadIconSprite();
    const navHtml = renderNavTabsSsr('providers');
    const brandHtml = renderBrandBar();
    // #4246 — Banner de ola común (② del marco MIZPÁ). Markup reutilizado del
    // helper compartido de la HOME (CA-5); se sirve neutro en SSR y lo hidrata
    // tickMission() desde /api/dash/waves. Si home.js no cargó, el slot va vacío.
    const missionHtml = (homeView && typeof homeView.renderMissionBanner === 'function')
        ? homeView.renderMissionBanner()
        : '';
    const model = buildProvidersModel();
    const breadcrumb = `
  <div class="mz-crumb" aria-label="Ubicación: Más › Providers">
    <span class="mz-crumb-sep">⋯ Más</span>
    <span class="mz-crumb-sep">›</span>
    <b>🔌 Providers</b>
    <span class="mz-crumb-desc">· proveedores LLM · salud y cuota · cadena de fallback</span>
  </div>`;
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Intrale · Providers</title>
<style>${tokens}</style>
<style>${theme}</style>
<style>${PANEL_CSS}</style>
</head>
<body>
<div aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">${spriteInline}</div>
<div class="satellite-frame">
  <header class="in-header">
    ${brandHtml}
    <div class="in-header-meta">
      <span class="in-clock" id="hdr-clock">${escapeHtmlText(new Date().toLocaleTimeString('es-AR'))}</span>
    </div>
  </header>
  ${missionHtml}
  ${navHtml}
  ${breadcrumb}
  <main class="satellite-body">${bodyHtml(model)}</main>
  <footer class="in-footer">
    <span>Solo lectura del estado · el set/rotate de keys vive en terminal Windows (nunca por Telegram)</span>
    <span>Intrale · MIZPÁ · #4201</span>
  </footer>
</div>
<script>${PROVIDERS_CLIENT_JS}</script>
</body>
</html>`;
}

/**
 * Render inerte (CA-A3): visible cuando require()/render fallan aguas arriba.
 * @param {string} reason
 * @returns {string}
 */
function renderInert(reason) {
    const safe = escapeHtmlText(reason || 'módulo no disponible');
    const tokens = loadDesignTokens();
    const theme = loadTheme();
    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Intrale · Providers</title><style>${tokens}</style><style>${theme}</style></head>
<body><main style="padding:32px;max-width:800px;margin:0 auto">
<h1>Ventana Providers no disponible</h1>
<p>${safe}</p>
<p>Revisá los logs del dashboard. El render no queda en blanco (CA-A3).</p>
</main></body></html>`;
}

module.exports = {
    renderProviders,
    bodyHtml,
    buildProvidersModel,
    renderProviderRow,
    renderMissionBanner,
    renderAgentStrip,
    renderInert,
    slug: 'providers',
};
