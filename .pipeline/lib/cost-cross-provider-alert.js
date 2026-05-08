// =============================================================================
// cost-cross-provider-alert.js — Detector + alerta Telegram para spikes de
// costo cuando un skill cambia de provider (#3090 / U5 multi-provider).
//
// Responsabilidad:
//   - evaluateSpikes(crossProvider, config) → array de evaluaciones { skill,
//     provider_from, provider_to, delta_pct, ... } cuando hay spike.
//   - formatTelegramMessage(evaluation, opts) → string MarkdownV2 sanitizado.
//   - sendTelegramAlert(evaluation, opts) → encola fire-and-forget en
//     `.pipeline/servicios/telegram/pendiente/`.
//   - applyNeedsHumanLabel(issue, opts) → label automático para skills FIJAS
//     (CA-8 — security/review/builder/tester).
//   - Debounce por (skill, provider_to): persistido en
//     `.pipeline/cost-cross-provider-state.json` (CA-6, anti-tormenta).
//
// Reglas inquebrantables:
//   1. Sanitización canónica ANTES del envío: sanitize() + redactSensitive()
//      del módulo central. Defensa en profundidad incluso si svc-telegram
//      sanitiza al final (mismo patrón de cost-anomaly-alert.js).
//   2. Whitelist explícita de chars en skill names y provider/model
//      (^[a-zA-Z0-9_/.-]+$). Cualquier basura → '[invalid]'.
//   3. NUNCA loguea credenciales del provider (Authorization, API keys, etc.).
//      El módulo solo recibe shape ya filtrado por el aggregator.
//   4. Debounce ESTRICTO por (skill, provider_to) ≥ debounce_min_per_pair.
//      Si el state file no se puede escribir, se asume OK y se sigue (la
//      alerta es accesoria, no debe matar el detector ni el pulpo).
//   5. CA-9 — si crossProvider.degraded.reason !== null, NO disparar
//      ninguna alerta (pre-S5/pre-H3 = sin baseline confiable).
//
// Tests: lib/__tests__/cost-cross-provider-alert.test.js
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { redactSensitive } = require('./redact');
const { sanitize } = require('../sanitizer');
const { isFixedSkill, FIXED_SKILLS } = require('../metrics/aggregator');

// Whitelist de chars permitidos en skill / provider / model. Cubre alfanum
// + dash + underscore + slash + dot (para 'anthropic/claude-sonnet-4-6').
const SAFE_NAME_RE = /^[a-zA-Z0-9_/.-]{1,80}$/;

function safeName(name) {
    if (typeof name !== 'string') return '[invalid]';
    if (!SAFE_NAME_RE.test(name)) return '[invalid]';
    return name;
}

// Defaults coherentes con `config.yaml:cost_cross_provider`. Si la config
// no se pasa, el detector usa estos.
const DEFAULTS = {
    enabled: true,
    threshold_pct: 0.30,                 // +30%
    min_sessions_for_baseline: 5,
    debounce_min_per_pair: 60,           // 1h por (skill, provider_to)
    channels: { telegram: true, dashboard_banner: true },
};

function mergeConfig(cfg) {
    const c = cfg || {};
    return {
        enabled: c.enabled !== false && c.enabled !== 'false',
        threshold_pct: Number.isFinite(Number(c.threshold_pct)) ? Number(c.threshold_pct) : DEFAULTS.threshold_pct,
        min_sessions_for_baseline: Number.isFinite(Number(c.min_sessions_for_baseline)) ? Number(c.min_sessions_for_baseline) : DEFAULTS.min_sessions_for_baseline,
        debounce_min_per_pair: Number.isFinite(Number(c.debounce_min_per_pair)) ? Number(c.debounce_min_per_pair) : DEFAULTS.debounce_min_per_pair,
        channels: Object.assign({}, DEFAULTS.channels, c.channels || {}),
    };
}

// -----------------------------------------------------------------------------
// MarkdownV2 escape helper (CA-5 — sanitización Telegram MarkdownV2).
//
// Anticipa el módulo central de #3112 (escapeMdV2 sanitización de payloads
// Telegram). Cuando #3112 cierre, este helper local se elimina y se reemplaza
// por el import de `lib/escape-mdv2.js`. Sin breaking change: la API es
// `escapeMdV2(str): string`.
//
// Caracteres reservados de Telegram MarkdownV2 según docs oficiales:
//   _  *  [  ]  (  )  ~  `  >  #  +  -  =  |  {  }  .  !  \
// -----------------------------------------------------------------------------

const MDV2_RESERVED_RE = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

function escapeMdV2(str) {
    if (typeof str !== 'string') return '';
    return str.replace(MDV2_RESERVED_RE, '\\$1');
}

// -----------------------------------------------------------------------------
// Detector (CA-4).
//
// Toma `snapshot.crossProvider` (output del aggregator) + config.
// Retorna un array de evaluaciones — una por cada skill con spike confirmado.
// El detector NO dispara alertas ni encola Telegram — solo computa.
// -----------------------------------------------------------------------------

function evaluateSpikes(crossProvider, config) {
    const cp = crossProvider || {};
    const cfg = mergeConfig(config);
    const out = [];

    if (!cfg.enabled) return out;

    // CA-9 — estado degradado: no disparar.
    if (cp.degraded && cp.degraded.reason) return out;

    const skills = Array.isArray(cp.bySkill) ? cp.bySkill : [];
    for (const row of skills) {
        if (!row || !Array.isArray(row.switches) || row.switches.length === 0) continue;

        const preSessions = Number(row.pre_switch_sessions || 0);
        const postSessions = Number(row.post_switch_sessions || 0);
        const preAvg = Number(row.pre_switch_avg_cost_usd || 0);
        const postAvg = Number(row.post_switch_avg_cost_usd || 0);

        // CA-4 — muestra chica: NO dispara.
        if (preSessions < cfg.min_sessions_for_baseline) continue;
        if (postSessions < cfg.min_sessions_for_baseline) continue;
        if (preAvg <= 0) continue;

        const deltaPct = (postAvg - preAvg) / preAvg;
        if (deltaPct <= cfg.threshold_pct) continue;

        const lastSwitch = row.switches[row.switches.length - 1];
        const evalRow = {
            skill: row.skill,
            provider_from: lastSwitch.from,
            provider_to: lastSwitch.to,
            delta_pct: Math.round(deltaPct * 1000) / 1000,
            pre_switch_avg_cost_usd: preAvg,
            post_switch_avg_cost_usd: postAvg,
            pre_switch_sessions: preSessions,
            post_switch_sessions: postSessions,
            issue_origen: lastSwitch.issue,
            ts: lastSwitch.ts,
            severity: row.fixed ? 'high' : 'medium',
            fixed: !!row.fixed,
        };
        out.push(evalRow);
    }

    return out;
}

// -----------------------------------------------------------------------------
// Debounce state — persistido en cost-cross-provider-state.json.
// Shape:
//   { last_alerts: { 'skill|provider_to': { last_alert_ms } } }
// -----------------------------------------------------------------------------

function loadState(pipelineDir) {
    const file = path.join(pipelineDir, 'cost-cross-provider-state.json');
    try {
        if (!fs.existsSync(file)) return { last_alerts: {} };
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return { last_alerts: {} };
        if (!parsed.last_alerts || typeof parsed.last_alerts !== 'object') {
            parsed.last_alerts = {};
        }
        return parsed;
    } catch (_) {
        return { last_alerts: {} };
    }
}

function saveState(pipelineDir, state) {
    const file = path.join(pipelineDir, 'cost-cross-provider-state.json');
    try {
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
        fs.renameSync(tmp, file);
        return { ok: true };
    } catch (e) {
        return { ok: false, reason: e.message };
    }
}

function debounceKey(evalRow) {
    return `${safeName(evalRow.skill)}|${safeName(evalRow.provider_to)}`;
}

// Devuelve true si la alerta DEBE silenciarse por debounce.
function isDebounced(evalRow, state, cfg, nowMs) {
    const key = debounceKey(evalRow);
    const last = state.last_alerts && state.last_alerts[key];
    if (!last || !last.last_alert_ms) return false;
    const elapsedMin = (nowMs - last.last_alert_ms) / 60000;
    return elapsedMin < cfg.debounce_min_per_pair;
}

function recordAlert(state, evalRow, nowMs) {
    const key = debounceKey(evalRow);
    state.last_alerts[key] = { last_alert_ms: nowMs };
    return state;
}

// -----------------------------------------------------------------------------
// Format Telegram message (CA-5, CA-7, CA-8).
//
// MarkdownV2 sanitizado. Drill-down a GitHub issue público — NUNCA session_id
// en URL externa (CA-7).
// -----------------------------------------------------------------------------

function pctSigned(n) {
    if (!Number.isFinite(n)) return '0%';
    const sign = n >= 0 ? '+' : '';
    return `${sign}${Math.round(n * 100)}%`;
}

function usd(n) {
    if (!Number.isFinite(n) || n < 0) return '$0.00';
    return `$${n.toFixed(2)}`;
}

function formatTelegramMessage(evalRow, opts) {
    const _opts = opts || {};
    const repoUrl = _opts.repoUrl || 'https://github.com/intrale/platform';
    const ev = evalRow || {};

    const skill = safeName(ev.skill);
    const from = safeName(ev.provider_from);
    const to = safeName(ev.provider_to);
    const issue = Number.isInteger(ev.issue_origen) ? ev.issue_origen : null;
    const deltaPct = Number(ev.delta_pct || 0);
    const preAvg = Number(ev.pre_switch_avg_cost_usd || 0);
    const postAvg = Number(ev.post_switch_avg_cost_usd || 0);
    const preSessions = Number(ev.pre_switch_sessions || 0);
    const postSessions = Number(ev.post_switch_sessions || 0);

    const lines = [];
    if (ev.fixed) {
        // CA-8 — prefijo crítico para skills FIJAS.
        lines.push('🔴 *SKILL FIJA — CONTRATO DE CALIDAD ROTO*');
    }
    lines.push(`⚠ *Spike cross\\-provider en ${escapeMdV2(skill)}*`);
    lines.push(`Switch: \`${escapeMdV2(from)}\` → \`${escapeMdV2(to)}\``);
    lines.push(`Delta: *${escapeMdV2(pctSigned(deltaPct))}* sobre baseline`);
    lines.push(`Pre: *${escapeMdV2(usd(preAvg))}* USD/sesión \\(${preSessions} sesiones\\)`);
    lines.push(`Post: *${escapeMdV2(usd(postAvg))}* USD/sesión \\(${postSessions} sesiones\\)`);

    if (issue) {
        const issueUrl = `${repoUrl}/issues/${issue}`;
        lines.push(`Origen: [#${issue}](${issueUrl})`);
    } else {
        lines.push(`Origen: \\(sin issue conocido\\)`);
    }

    lines.push('');
    lines.push('→ Ver detalle en `/consumo`');

    const raw = lines.join('\n');

    // Pipeline canónico de sanitización ANTES del envío (defensa en
    // profundidad — mismo patrón que cost-anomaly-alert.js).
    const sanitized = sanitize(raw);
    return redactSensitive(sanitized);
}

// -----------------------------------------------------------------------------
// Sender — encola en `.pipeline/servicios/telegram/pendiente/`.
// -----------------------------------------------------------------------------

function sendTelegramAlert(evalRow, opts) {
    const _opts = opts || {};
    const pipelineDir = _opts.pipelineDir || path.resolve(__dirname, '..');
    const queueDir = path.join(pipelineDir, 'servicios', 'telegram', 'pendiente');
    const now = typeof _opts.now === 'function' ? _opts.now() : Date.now();
    const text = formatTelegramMessage(evalRow, _opts);

    try {
        if (!fs.existsSync(queueDir)) {
            fs.mkdirSync(queueDir, { recursive: true });
        }
    } catch (e) {
        return { ok: false, reason: `cannot_create_queue_dir: ${e.message}`, text };
    }

    const filename = `${now}-cross-provider-spike.json`;
    const file = path.join(queueDir, filename);
    try {
        fs.writeFileSync(file, JSON.stringify({ text, parse_mode: 'MarkdownV2' }), 'utf8');
        return { ok: true, file, text };
    } catch (e) {
        return { ok: false, reason: `cannot_write_file: ${e.message}`, text };
    }
}

// -----------------------------------------------------------------------------
// Apply needs-human label (CA-8 — solo skills FIJAS).
//
// Idempotente: si ya tiene el label, gh no hace nada y devuelve ok.
// Si gh falla (sin red, sin auth, etc.), loguea y devuelve ok:false. La
// alerta Telegram ya se envió antes — esto es accesorio.
// -----------------------------------------------------------------------------

function applyNeedsHumanLabel(issue, opts) {
    const _opts = opts || {};
    if (!Number.isInteger(issue) || issue <= 0) {
        return { ok: false, reason: 'invalid_issue' };
    }
    const ghBin = _opts.ghBin || 'gh';
    try {
        const stdout = execSync(`${ghBin} issue edit ${issue} --add-label needs-human`, {
            timeout: _opts.timeoutMs || 15000,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        return { ok: true, stdout: String(stdout) };
    } catch (e) {
        return { ok: false, reason: e.message };
    }
}

// -----------------------------------------------------------------------------
// Orchestrator — evalúa, debounce, encola, label.
//
// Uso típico desde el pulpo (cron interno):
//
//   const snap = require('./metrics/aggregator').buildSnapshot({ ... });
//   const result = processSpikes(snap.crossProvider, { config, pipelineDir });
//   // result = { fired: [{ skill, ... }], silenced_by_debounce: [...], skipped_degraded: bool }
// -----------------------------------------------------------------------------

function processSpikes(crossProvider, opts) {
    const _opts = opts || {};
    const cfg = mergeConfig(_opts.config);
    const pipelineDir = _opts.pipelineDir || path.resolve(__dirname, '..');
    const nowMs = typeof _opts.now === 'function' ? _opts.now() : Date.now();
    const repoUrl = _opts.repoUrl || 'https://github.com/intrale/platform';
    const result = {
        fired: [],
        silenced_by_debounce: [],
        labeled: [],
        skipped_degraded: false,
    };

    if (!cfg.enabled) return result;

    if (crossProvider && crossProvider.degraded && crossProvider.degraded.reason) {
        result.skipped_degraded = true;
        return result;
    }

    const evals = evaluateSpikes(crossProvider, cfg);
    if (evals.length === 0) return result;

    const state = loadState(pipelineDir);
    let stateChanged = false;

    for (const ev of evals) {
        if (isDebounced(ev, state, cfg, nowMs)) {
            result.silenced_by_debounce.push({
                skill: ev.skill,
                provider_to: ev.provider_to,
            });
            continue;
        }

        // Encolar Telegram (si está en channels).
        if (cfg.channels.telegram) {
            const send = sendTelegramAlert(ev, { pipelineDir, repoUrl, now: () => nowMs });
            if (send.ok) {
                result.fired.push(ev);
                recordAlert(state, ev, nowMs);
                stateChanged = true;
            } else {
                // No fallar: solo loguear. El siguiente tick reintentará.
                try { process.stderr.write(`[cost-cross-provider-alert] send failed: ${send.reason}\n`); } catch (_) {}
            }
        }

        // CA-8 — skills FIJAS reciben label needs-human automático.
        if (ev.fixed && ev.issue_origen) {
            const lr = applyNeedsHumanLabel(ev.issue_origen, { ghBin: _opts.ghBin });
            if (lr.ok) {
                result.labeled.push({ skill: ev.skill, issue: ev.issue_origen });
            } else {
                try { process.stderr.write(`[cost-cross-provider-alert] label failed: ${lr.reason}\n`); } catch (_) {}
            }
        }
    }

    if (stateChanged) saveState(pipelineDir, state);
    return result;
}

module.exports = {
    evaluateSpikes,
    formatTelegramMessage,
    sendTelegramAlert,
    applyNeedsHumanLabel,
    processSpikes,
    safeName,
    escapeMdV2,
    mergeConfig,
    loadState,
    saveState,
    isDebounced,
    DEFAULTS,
    FIXED_SKILLS,
};
