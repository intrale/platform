// =============================================================================
// operator-absence-policy.js — Política de operador ausente sobre la máquina
// `waiting-operator` / puerto `gates` (issue #4632 · split de #4581).
//
// Decide, cuando el operador está AUSENTE frente a un gate en estado
// `waiting-operator`, si el pipeline debe:
//
//   - `fail-closed`  → BLOQUEAR y esperar firma humana (default seguro).
//   - `auto-proceed` → avanzar dentro de un scope acotado, notificado y
//                      auditado, SOLO cuando toda la escalera de seguridad lo
//                      habilita.
//
// Este módulo **extiende el patrón GATE 3** (`kernel-action-policy.js`) al
// escenario de ausencia del operador. NO inventa infraestructura nueva:
//
//   - Es una función **pura** (`resolveAbsenceDecision`): sin IO de red, sin
//     side-effects. Defaults fail-closed cuando falta config (nunca fail-open
//     implícito — OWASP A04 Insecure Design).
//
//   - Reutiliza `validateConfirmer(chatId, allowlist)` de
//     `kernel-action-policy.js` para autorizar al operador primario que ejerce
//     o revisa una delegación (OWASP A07).
//
//   - La superficie Telegram (encolar la notificación) reusa
//     `kernel-action-policy.notifyOperator` / la cola
//     `.pipeline/servicios/telegram/pendiente/`. El registro tamper-evident de
//     cada decisión vive en `operator-absence-audit.js`.
//
// Invariantes NO negociables:
//   1. GATE 1 (Definición) y GATE 2 (Aceptación) son **hard-deny**: nunca
//      auto-proceden aunque exista allowlist o índice de confianza. No es
//      configurable desde YAML (OWASP A01 Broken Access Control).
//   2. Sin base de confianza vigente (#4576) → fail-closed puro para toda
//      clase, ANTES de mirar la allowlist.
//   3. Kill-switch activo o clase fuera de la allowlist cerrada → fail-closed.
//   4. Solo con las cuatro condiciones simultáneas → auto-proceder dentro del
//      scope de la clase.
//
// Ver: docs/pipeline/operador-ausente.md
// =============================================================================
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const { validateConfirmer } = require('./kernel-action-policy');

// -----------------------------------------------------------------------------
// Constantes de decisión.
// -----------------------------------------------------------------------------
const DECISIONS = Object.freeze(['fail-closed', 'auto-proceed']);

// Hard-deny NO negociable: los gates de firma humana nunca auto-proceden.
// Evaluado ANTES que cualquier allowlist o índice de confianza (OWASP A01).
const NON_DELEGABLE_GATES = Object.freeze(['gate1', 'gate2']);

// Motivos estructurados (enum abierto pero estable para la UI/audit).
const REASONS = Object.freeze({
    GATE_NO_DELEGABLE: 'gate_no_delegable_firma_humana',
    SIN_BASE_CONFIANZA: 'sin_base_confianza_4576',
    KILLSWITCH_O_ALLOWLIST: 'clase_no_en_allowlist_o_killswitch',
    AUTO_PROCEED: 'allowlist+indice_vigente',
});

// -----------------------------------------------------------------------------
// Carga de config.yaml (lazy, defensiva). NUNCA throw: ante cualquier error
// devolvemos `{}` y caemos a los defaults fail-closed. Mismo criterio que
// `kernel-action-policy.loadGate3Config`.
// -----------------------------------------------------------------------------
function pipelineDir() {
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.resolve(__dirname, '..');
}

function extractAbsenceConfig(doc) {
    const gates = (doc && typeof doc.gates === 'object' && doc.gates) || {};
    const abs = (gates && typeof gates.operator_absence === 'object' && gates.operator_absence) || {};
    return abs;
}

/**
 * Carga la sub-sección `gates.operator_absence` de config.yaml.
 * @param {object} [configOverride] — doc ya parseado (evita IO en tests).
 * @returns {object}
 */
function loadAbsenceConfig(configOverride) {
    if (configOverride && typeof configOverride === 'object') {
        return extractAbsenceConfig(configOverride);
    }
    try {
        const yaml = require('js-yaml');
        const file = path.join(pipelineDir(), 'config.yaml');
        const doc = yaml.load(fs.readFileSync(file, 'utf8')) || {};
        return extractAbsenceConfig(doc);
    } catch {
        return {};
    }
}

/**
 * Normaliza un identificador de gate a su clave comparable ('gate1', 'gate2', …).
 * Tolera 'GATE 1', 'gate-1', 'gate_1', números, etc.
 * @param {string|number} gate
 * @returns {string}
 */
function normalizeGate(gate) {
    if (gate == null) return '';
    return String(gate).toLowerCase().replace(/[\s_-]+/g, '');
}

/**
 * ¿La allowlist cerrada de clases delegables incluye esta clase?
 * Default seguro: allowlist ausente/no-array => vacía => nada delegable.
 * @param {object} config — sub-sección operator_absence.
 * @param {string} clase
 * @returns {boolean}
 */
function claseEnAllowlist(config, clase) {
    const list = Array.isArray(config?.allowlist) ? config.allowlist : [];
    return typeof clase === 'string' && clase.length > 0 && list.includes(clase);
}

/**
 * Resuelve el kill-switch efectivo. Prioridad: parámetro explícito >
 * `config.kill_switch` > default `true` (bloqueado). El default fail-closed
 * es deliberado: config parcial o ausente == bloqueado, nunca fail-open.
 * @param {boolean|undefined} killSwitchParam
 * @param {object} config
 * @returns {boolean}
 */
function resolveKillSwitch(killSwitchParam, config) {
    if (typeof killSwitchParam === 'boolean') return killSwitchParam;
    if (config && typeof config.kill_switch === 'boolean') return config.kill_switch;
    return true; // default seguro: bloqueado.
}

/**
 * Decide la política de ausencia del operador para un gate/clase dados.
 *
 * Función **pura**: sin IO, sin side-effects. Evalúa las guardas en orden
 * estricto de seguridad (ver header). El primer motivo de bloqueo gana; el
 * `auto-proceed` solo se alcanza si NINGUNA guarda dispara.
 *
 * @param {object} params
 * @param {string|number} params.gate — identificador del gate ('gate1'…'gate3', clase custom).
 * @param {string} params.clase — clase de la acción a evaluar contra la allowlist.
 * @param {object} [params.config] — sub-sección `gates.operator_absence` (o se carga de YAML).
 * @param {object} [params.confidenceIndex] — base de confianza (#4576). Requiere `.vigente === true`.
 * @param {boolean} [params.killSwitch] — override del kill-switch (default: config o true).
 * @returns {{ decision: 'fail-closed'|'auto-proceed', reason: string, gate: string, clase: string, scope?: string }}
 */
function resolveAbsenceDecision({ gate, clase, config, confidenceIndex, killSwitch } = {}) {
    const cfg = (config && typeof config === 'object' && !Array.isArray(config))
        ? config
        : loadAbsenceConfig(config);
    const gateKey = normalizeGate(gate);
    const base = { gate: gateKey, clase: typeof clase === 'string' ? clase : '' };

    // 1. Hard-deny GATE 1 / GATE 2 — firma humana, jamás delegable (OWASP A01).
    if (NON_DELEGABLE_GATES.includes(gateKey)) {
        return { ...base, decision: 'fail-closed', reason: REASONS.GATE_NO_DELEGABLE };
    }

    // 2. Sin base de confianza vigente (#4576) → fail-closed puro (OWASP A04).
    //    Se evalúa ANTES que la allowlist: sin escalera vigente nada procede.
    if (!confidenceIndex || confidenceIndex.vigente !== true) {
        return { ...base, decision: 'fail-closed', reason: REASONS.SIN_BASE_CONFIANZA };
    }

    // 3. Kill-switch activo o clase fuera de la allowlist cerrada → fail-closed.
    if (resolveKillSwitch(killSwitch, cfg) || !claseEnAllowlist(cfg, clase)) {
        return { ...base, decision: 'fail-closed', reason: REASONS.KILLSWITCH_O_ALLOWLIST };
    }

    // 4. Todas las condiciones simultáneas → auto-proceder dentro del scope.
    return { ...base, decision: 'auto-proceed', reason: REASONS.AUTO_PROCEED, scope: clase };
}

// -----------------------------------------------------------------------------
// Autorización del operador primario (OWASP A07). Reusa `validateConfirmer`
// del patrón GATE 3: fail-closed si la allowlist de operadores está vacía.
// -----------------------------------------------------------------------------

/**
 * Valida que el `chatId` que ejerce/revisa una delegación sea el operador
 * primario autorizado. Wrapper delgado sobre `validateConfirmer` para dejar
 * explícita la superficie de este módulo.
 *
 * @param {string|number} chatId
 * @param {string|number|Array<string|number>} operatorAllowlist
 * @returns {{ authorized: boolean, chatId: string|null, reason?: string }}
 */
function authorizeOperator(chatId, operatorAllowlist) {
    return validateConfirmer(chatId, operatorAllowlist);
}

// -----------------------------------------------------------------------------
// Mensajería al operador (Telegram). Reusa la cola/patrón de GATE 3. El texto
// prioriza escaneabilidad (<10s) y una acción concreta de revisión/revocación.
// -----------------------------------------------------------------------------

function safeLine(value) {
    return String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').slice(0, 300);
}

/**
 * Construye el mensaje de una delegación auto-procedida. Orden pensado para
 * lectura rápida (UX #4632): decisión, issue/gate, ejecutor, clase/scope,
 * base de confianza, timestamp, acción de revocación/revisión.
 *
 * @param {object} p
 * @returns {string}
 */
function buildDelegationMessage(p = {}) {
    return [
        'GATE · Operador ausente — se AUTO-PROCEDIO una delegacion',
        `Issue/Gate: #${safeLine(p.issue)} / ${safeLine(p.gate)}`,
        `Ejecutor: ${safeLine(p.actor || 'kernel:absence-policy')}`,
        `Clase/Scope: ${safeLine(p.clase)} / ${safeLine(p.scope || p.clase)}`,
        `Base de confianza: ${safeLine(p.confidenceBase || 'indice #4576 vigente')}`,
        `Cuando: ${safeLine(p.timestamp)}`,
        `Motivo: ${safeLine(p.reason)}`,
        'Revisar/Revocar: comentá "revocar auto-proceed #' + safeLine(p.issue) + '" en el issue,',
        'o ejecutá `node .pipeline/restart.js` tras poner gates.operator_absence.kill_switch=true.',
        'Audit: .pipeline/audit/operator-absence.jsonl (verificable con verifyChain).',
    ].join('\n');
}

/**
 * Construye el mensaje de un estado fail-closed por ausencia del operador.
 * Comunica explícitamente que la espera es por diseño y nada avanzó, y
 * diferencia el motivo (gate no delegable / sin base de confianza / kill-switch
 * o allowlist).
 *
 * @param {object} p
 * @returns {string}
 */
function buildFailClosedMessage(p = {}) {
    const motivoHumano = {
        [REASONS.GATE_NO_DELEGABLE]: 'este gate exige FIRMA HUMANA explicita y nunca se delega',
        [REASONS.SIN_BASE_CONFIANZA]: 'no hay base de confianza vigente (#4576) para delegar',
        [REASONS.KILLSWITCH_O_ALLOWLIST]: 'la clase no esta en la allowlist cerrada o el kill-switch esta activo',
    }[p.reason] || 'la delegacion no esta habilitada';
    return [
        'GATE · Operador ausente — BLOQUEADO y esperando (por diseño)',
        `Issue/Gate: #${safeLine(p.issue)} / ${safeLine(p.gate)}`,
        `Clase: ${safeLine(p.clase)}`,
        `Motivo: ${motivoHumano}.`,
        'Nada avanzo sin vos. Esta espera es intencional, no es un error ni un fallo silencioso.',
        'Para destrabar: firmá el gate cuando vuelvas (la accion queda pendiente, no se pierde).',
    ].join('\n');
}

/**
 * Encola una notificación de delegación auto-procedida al operador primario.
 * Usa la misma cola `.pipeline/servicios/telegram/pendiente/` que GATE 3
 * (`notifyOperator`), pero con un FORMATO de mensaje propio (por eso no reusa
 * `buildOperatorMessage`, cuyo layout es distinto). No toca red; nunca bloquea.
 *
 * @param {object} params — ver `buildDelegationMessage`.
 * @param {Function} [send] — inyección para tests.
 * @returns {{ ok: boolean, path?: string, error?: string }}
 */
function notifyDelegation(params = {}, send) {
    const text = buildDelegationMessage(params);
    if (typeof send === 'function') return send({ text });
    return _enqueue(text);
}

/**
 * Encola una notificación de fail-closed por ausencia del operador.
 * @param {object} params — ver `buildFailClosedMessage`.
 * @param {Function} [send] — inyección para tests.
 * @returns {{ ok: boolean, path?: string, error?: string }}
 */
function notifyFailClosed(params = {}, send) {
    const text = buildFailClosedMessage(params);
    if (typeof send === 'function') return send({ text });
    return _enqueue(text);
}

/**
 * Escribe un drop en la cola de Telegram. Idéntico patrón a
 * `kernel-action-policy.notifyOperator`, aislado para reuso interno.
 * @param {string} text
 * @returns {{ ok: boolean, path?: string, error?: string }}
 */
function _enqueue(text) {
    try {
        const dir = path.join(pipelineDir(), 'servicios', 'telegram', 'pendiente');
        fs.mkdirSync(dir, { recursive: true });
        const rnd = Math.random().toString(36).slice(2, 8);
        const id = `operator-absence-${Date.now()}-${process.pid}-${rnd}`;
        const file = path.join(dir, `${id}.json`);
        fs.writeFileSync(file, JSON.stringify({ text, parse_mode: 'Markdown', _correlationId: id }));
        return { ok: true, path: file };
    } catch (e) {
        return { ok: false, error: (e && e.message) ? String(e.message).slice(0, 200) : 'unknown' };
    }
}

module.exports = {
    resolveAbsenceDecision,
    authorizeOperator,
    loadAbsenceConfig,
    buildDelegationMessage,
    buildFailClosedMessage,
    notifyDelegation,
    notifyFailClosed,
    // Helpers exportados para tests.
    normalizeGate,
    claseEnAllowlist,
    resolveKillSwitch,
    // Constantes.
    DECISIONS,
    NON_DELEGABLE_GATES,
    REASONS,
};
