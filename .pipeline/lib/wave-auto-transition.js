// =============================================================================
// wave-auto-transition.js — Transición automática de ola al terminar la activa
// (#4368, Ola 8.3).
//
// Detecta si TODOS los issues de la ola activa están cerrados/terminales en
// GitHub y, según el modo configurado:
//
//   - mode: "notify" (DEFAULT) → NO muta estado; notifica al operador
//     ("/wave ready-to-close N") + deja evidencia en el audit log. Respeta el
//     diseño aprobado `docs/pipeline/modelo-planificacion-multi-ola.md` §3
//     ("nunca se abre una ola por automatismo", "la ola no se cierra sola").
//   - mode: "auto" (opt-in explícito de Leo) → promueve la siguiente ola
//     planificada vía `waves.promoteWaveAtomic` (transacción atómica con
//     backup + rollback), sincroniza el allowlist recursivamente y audita.
//
// Doctrina de seguridad (#4368, agente security):
//   1. Fail-closed ante cualquier ambigüedad de `gh` (exit≠0, timeout,
//      rate-limit, respuesta parcial, issue ausente) ⇒ NO promover. Un issue
//      ausente NO cuenta como terminal.
//   2. Kill-switch maestro (`enabled: false` / `kill_switch: true`) ⇒ cero
//      acciones (ni notify ni auto).
//   3. Anti doble promoción / TOCTOU: `isWavePromoteBlocked()` + re-verificación
//      de que la ola activa no cambió antes de promover. La escritura ya está
//      gateada por el marker in-progress de `promoteWaveAtomic`.
//   4. `planned_waves` vacío ⇒ halt + alerta, nunca `promoteWaveAtomic(null)`.
//   5. Sin interpolación de metadata de ola en shell: `gh` siempre con args
//      ARRAY (el `ghCall` inyectado usa el patrón de `brazoDesbloqueo`).
//   6. Auditoría append-only hash-encadenada de cada detección/transición.
//
// Este módulo NO reimplementa primitivas endurecidas: reusa `promoteWaveAtomic`
// (#3520), `expandRecursiveOpenIssues` (#4350), `appendChained` (#3275) y
// `notifyTelegram`.
//
// Ejecutar tests:  node --test .pipeline/lib/__tests__/wave-auto-transition.test.js
// =============================================================================
'use strict';

const path = require('path');

const waves = require('./waves');
const auditLog = require('./audit-log');
const recursivePromote = require('./allowlist-recursive-promote');
const { notifyTelegram } = require('./notify-telegram');

const DEFAULT_GH_TIMEOUT_MS = 30000;

// ─── Paths ────────────────────────────────────────────────────────────────
// Mismo criterio de resolución que waves.js: respeta PIPELINE_DIR_OVERRIDE
// para que los tests aislados apunten a su tmpdir.
function pipelineDir() {
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.join(__dirname, '..');
}

function wavesAuditFile() {
    return path.join(pipelineDir(), 'logs', 'waves.jsonl');
}

function partialFile() {
    return path.join(pipelineDir(), '.partial-pause.json');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function normNum(n) {
    const x = Number(n);
    return Number.isInteger(x) && x > 0 ? x : null;
}

/**
 * Escribe una entrada de auditoría best-effort. Un fallo del audit log NO debe
 * tumbar la transición ni el tick del Pulpo (fire-and-forget upstream), pero sí
 * se loguea a stderr para que quede rastro.
 */
function safeAudit(entry) {
    try {
        auditLog.appendChained({ file: wavesAuditFile(), entry });
        return true;
    } catch (err) {
        try { console.warn(`[wave-auto-transition] audit falló: ${err.message}`); } catch { /* noop */ }
        return false;
    }
}

/** Lee el allowlist actual de `.partial-pause.json` (defensivo, nunca lanza). */
function readAllowlistSafe() {
    try {
        const fs = require('fs');
        const p = partialFile();
        if (!fs.existsSync(p)) return [];
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        return Array.isArray(parsed.allowed_issues)
            ? parsed.allowed_issues.map(normNum).filter(Boolean)
            : [];
    } catch {
        return [];
    }
}

/** Diff added/removed entre dos allowlists (arrays de números). */
function allowlistDiff(prev, next) {
    const prevSet = new Set(prev);
    const nextSet = new Set(next);
    return {
        added: next.filter((n) => !prevSet.has(n)).sort((a, b) => a - b),
        removed: prev.filter((n) => !nextSet.has(n)).sort((a, b) => a - b),
    };
}

/**
 * Selecciona la siguiente ola planificada por número ascendente.
 * @param {object} state — estado de waves.loadWaves()
 * @returns {object|null} ola planificada o null si no hay
 */
function pickNextPlannedWave(state) {
    const planned = state && Array.isArray(state.planned_waves) ? state.planned_waves : [];
    const valid = planned.filter((w) => w && Number.isInteger(w.number));
    if (valid.length === 0) return null;
    return [...valid].sort((a, b) => a.number - b.number)[0];
}

/**
 * Construye el mensaje accionable de "ola lista para cerrar" (modo notify).
 * Guidelines UX del issue: número de ola, cierre verificado (N/M), siguiente
 * candidata y acción literal copy-paste.
 */
function buildNotifyMessage(fromWave, det, next) {
    const total = Array.isArray(det.checked) ? det.checked.length : 0;
    const nextLine = next
        ? `Siguiente ola candidata: ${next.number}${next.name ? ` (${next.name})` : ''}.`
        : 'No hay olas planificadas: al cerrar, definí la próxima manualmente.';
    return (
        `Ola ${fromWave} completa — ${total}/${total} issues cerrados verificados.\n` +
        `${nextLine}\n` +
        `Acción sugerida: /wave ready-to-close ${fromWave}`
    );
}

// ─── Detección de completitud (fail-closed) ─────────────────────────────────

/**
 * Determina si la ola activa está completa consultando el estado GitHub de
 * cada issue. FAIL-CLOSED: cualquier exit≠0, timeout, respuesta sin `state` o
 * issue ausente ⇒ `complete: false`.
 *
 * @param {object} config — config del pipeline (usa `config.wave_auto_transition.gh_timeout_ms`)
 * @param {object} deps
 * @param {(args:string[], timeoutMs:number)=>Promise<{stdout:string}|string>} deps.ghCall
 *        — invocador de `gh` con args ARRAY (patrón `ghDesbloqueoCall`).
 * @returns {Promise<{complete:boolean, reason:string, checked:Array, missing:number[], from_wave?:number}>}
 */
async function detectWaveComplete(config, { ghCall } = {}) {
    const fail = (reason, extra = {}) => ({
        complete: false,
        reason,
        checked: [],
        missing: [],
        ...extra,
    });

    if (typeof ghCall !== 'function') {
        return fail('no_ghcall');
    }

    let active;
    try {
        active = waves.getActiveWave();
    } catch (err) {
        return fail(`active_wave_read_error: ${err.message}`);
    }
    if (!active || !Number.isInteger(active.number)) {
        return fail('no_active_wave');
    }

    const issueNums = (Array.isArray(active.issues) ? active.issues : [])
        .map((i) => normNum(i && i.number))
        .filter(Boolean);

    // Ola activa sin issues: no la consideramos completa (evita promover al
    // vacío por un estado degradado).
    if (issueNums.length === 0) {
        return fail('active_wave_no_issues', { from_wave: active.number });
    }

    const cfg = (config && config.wave_auto_transition) || {};
    const timeoutMs = Number.isInteger(cfg.gh_timeout_ms) && cfg.gh_timeout_ms > 0
        ? cfg.gh_timeout_ms
        : DEFAULT_GH_TIMEOUT_MS;

    const checked = [];
    const missing = [];

    for (const n of issueNums) {
        let res;
        try {
            // Args ARRAY — cero interpolación de metadata en shell (CA-8).
            res = await ghCall(['issue', 'view', String(n), '--json', 'state'], timeoutMs);
        } catch (err) {
            // exit≠0 / timeout / rate-limit ⇒ fail-closed.
            return fail(`gh_error_issue_${n}: ${err && err.message ? err.message : String(err)}`, {
                from_wave: active.number,
                checked,
            });
        }

        const raw = res && typeof res === 'object' ? res.stdout : res;
        let parsed;
        try {
            parsed = JSON.parse(raw || '');
        } catch {
            return fail(`gh_parse_error_issue_${n}`, { from_wave: active.number, checked });
        }

        const state = parsed && typeof parsed.state === 'string' ? parsed.state.toUpperCase() : null;
        if (!state) {
            // Respuesta parcial / issue ausente ⇒ NO terminal, fail-closed.
            missing.push(n);
            return fail(`gh_no_state_issue_${n}`, { from_wave: active.number, checked, missing });
        }

        checked.push({ number: n, state });
        if (state !== 'CLOSED') {
            return {
                complete: false,
                reason: `issue_open_${n}`,
                checked,
                missing,
                from_wave: active.number,
            };
        }
    }

    return { complete: true, reason: 'all_closed', checked, missing, from_wave: active.number };
}

// ─── Orquestador notify/auto ─────────────────────────────────────────────────

/**
 * Orquesta la transición: detecta → según `mode` notifica o promueve → audita.
 * Idempotente y fail-closed. Nunca lanza (best-effort); devuelve un objeto
 * descriptivo con `action`.
 *
 * @param {object} config
 * @param {object} deps
 * @param {Function} deps.ghCall — invocador de `gh` (args array).
 * @returns {Promise<{action:string, [k:string]:any}>}
 */
async function autoTransitionIfComplete(config, { ghCall } = {}) {
    const cfg = (config && config.wave_auto_transition) || {};

    // CA-6 — kill switch maestro. Default conservador: si `enabled` no es
    // explícitamente true, o el kill_switch está activo, no hacemos nada.
    if (cfg.enabled !== true || cfg.kill_switch === true) {
        return { action: 'disabled', reason: cfg.kill_switch === true ? 'kill_switch' : 'not_enabled' };
    }

    const mode = cfg.mode === 'auto' ? 'auto' : 'notify';

    let det;
    try {
        det = await detectWaveComplete(config, { ghCall });
    } catch (err) {
        // detectWaveComplete es fail-closed y no debería lanzar, pero
        // blindamos igual el tick del Pulpo.
        return { action: 'error', reason: `detect_threw: ${err.message}` };
    }

    if (!det.complete) {
        return { action: 'noop', reason: det.reason, detail: det };
    }

    const fromWave = det.from_wave;
    let state;
    try {
        state = waves.loadWaves();
    } catch (err) {
        return { action: 'error', reason: `load_waves_failed: ${err.message}`, from_wave: fromWave };
    }
    const next = pickNextPlannedWave(state);

    const baseAudit = () => ({
        ts: new Date().toISOString(),
        actor: 'auto-transition',
        from_wave: fromWave,
        to_wave: next ? next.number : null,
    });

    // ── CA-2 — modo notify (default): detecta, NO muta estado, notifica ──────
    if (mode === 'notify') {
        notifyTelegram({
            level: 'warn',
            component: 'wave-auto-transition',
            message: buildNotifyMessage(fromWave, det, next),
        });
        safeAudit({
            ...baseAudit(),
            action: 'detected_complete',
            allowlist_diff: { added: [], removed: [] },
        });
        return { action: 'detected_complete', from_wave: fromWave, to_wave: next ? next.number : null };
    }

    // ── CA-3 — modo auto (opt-in) ───────────────────────────────────────────

    // CA-3b — planned_waves vacío: halt + alerta, jamás promover a null.
    if (!next) {
        notifyTelegram({
            level: 'error',
            component: 'wave-auto-transition',
            message:
                `Ola ${fromWave} completa pero NO hay olas planificadas. ` +
                `Acción humana requerida: el pipeline NO promovió. Definí la próxima ola.`,
        });
        safeAudit({ ...baseAudit(), action: 'halt_no_planned' });
        return { action: 'halt_no_planned', from_wave: fromWave };
    }

    // CA-4 — anti doble promoción: fail-closed markers activos ⇒ no promover.
    let block;
    try {
        block = waves.isWavePromoteBlocked();
    } catch (err) {
        safeAudit({ ...baseAudit(), action: 'skip_block_check_failed', error: err.message });
        return { action: 'skip_block_check_failed', from_wave: fromWave, error: err.message };
    }
    if (block && block.blocked) {
        safeAudit({ ...baseAudit(), action: 'skip_promote_blocked', markers: block.markers || [] });
        return { action: 'skip_promote_blocked', from_wave: fromWave, markers: block.markers || [] };
    }

    // CA-4 — TOCTOU: re-verificar que la ola activa no cambió entre la
    // detección y la promoción. Si cambió, otro tick ya actuó.
    let activeNow;
    try {
        activeNow = waves.getActiveWave();
    } catch {
        activeNow = null;
    }
    if (!activeNow || activeNow.number !== fromWave) {
        safeAudit({ ...baseAudit(), action: 'skip_state_changed' });
        return { action: 'skip_state_changed', from_wave: fromWave };
    }

    // CA-5 — proyección recursiva del allowlist (hijos/deps/bloqueos) sobre los
    // issues de la nueva ola. Función pura; el walk se hace sobre el grafo
    // `dependencies[]` de waves.json (filesystem propio, sin red).
    const nextSeed = (Array.isArray(next.issues) ? next.issues : [])
        .map((i) => normNum(i && i.number))
        .filter(Boolean);
    let expandedIssues;
    try {
        expandedIssues = recursivePromote.expandRecursiveOpenIssues({
            seedIssues: nextSeed,
            getDeps: (n) => {
                try { return waves.getBlockingIssues(n); } catch { return []; }
            },
        });
    } catch {
        // Fallback conservador: sin expansión, promoteWaveAtomic cae a getAllowlist.
        expandedIssues = null;
    }

    const prevAllow = readAllowlistSafe();

    try {
        const meta = {
            updated_by: 'auto-transition',
            source: 'wave-auto-transition',
            note: `auto-transition ola ${fromWave} → ${next.number}`,
        };
        if (Array.isArray(expandedIssues)) meta.expandedIssues = expandedIssues;
        waves.promoteWaveAtomic(next.number, meta);
    } catch (err) {
        // promoteWaveAtomic ya hace rollback interno ante fallo; acá sólo
        // notificamos y auditamos.
        notifyTelegram({
            level: 'error',
            component: 'wave-auto-transition',
            message:
                `Falló la promoción automática ola ${fromWave} → ${next.number}: ${err.message}. ` +
                `Estado revertido; revisá manualmente.`,
        });
        safeAudit({ ...baseAudit(), action: 'promote_failed', error: err.message });
        return { action: 'promote_failed', from_wave: fromWave, to_wave: next.number, error: err.message };
    }

    const newAllow = readAllowlistSafe();
    const diff = allowlistDiff(prevAllow, newAllow);

    safeAudit({ ...baseAudit(), action: 'auto_transition', allowlist_diff: diff });
    notifyTelegram({
        level: 'warn',
        component: 'wave-auto-transition',
        message:
            `Transición automática: ola ${fromWave} archivada, ola ${next.number}` +
            `${next.name ? ` (${next.name})` : ''} promovida a activa.`,
    });

    return { action: 'auto_transition', from_wave: fromWave, to_wave: next.number, allowlist_diff: diff };
}

module.exports = {
    detectWaveComplete,
    autoTransitionIfComplete,
    // Helpers expuestos para tests.
    _internal: {
        pickNextPlannedWave,
        allowlistDiff,
        buildNotifyMessage,
        readAllowlistSafe,
        wavesAuditFile,
        DEFAULT_GH_TIMEOUT_MS,
    },
};
