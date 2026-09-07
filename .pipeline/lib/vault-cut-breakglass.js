// =============================================================================
// vault-cut-breakglass.js — Corte del fallback FUERA DE BANDA (#5460 · CA-28).
//
// Camino de emergencia para cortar `vault.bootstrap_fallback` cuando el canal
// normal —la propuesta por Telegram con capability firmada (#5458)— no está
// disponible: bot caído, token reprovisionado (que invalida todos los
// action-tokens en vuelo), o el host sin salida a internet.
//
// -----------------------------------------------------------------------------
// Por qué esto NO es un bypass de seguridad
// -----------------------------------------------------------------------------
//
// El break-glass cambia QUIÉN autoriza, no QUÉ se verifica. Sustituye una única
// cosa —la prueba de identidad por Telegram— por otra prueba de identidad, y
// deja intacto todo el resto del control:
//
//   se conserva  · cobertura positiva revalidada antes de persistir (#5427)
//   se conserva  · escritura atómica + relectura + auditoría (#5459)
//   se conserva  · lock exclusivo, idempotencia, journal recuperable (#5459)
//   se sustituye · HMAC + nonce sobre chat de Telegram
//                  →  identidad LOCAL de la allowlist cerrada en código
//                     (`operator-allowlist.js`, cambiable sólo por CODEOWNERS)
//                  +  frase de confirmación explícita leída por STDIN
//
// Un break-glass que además saltea la cobertura no sería un break-glass: sería
// un `--force`, y el modo de falla que evita el corte del fallback no es "el
// operador no puede confirmar", es "se corta la vía vieja antes de que la nueva
// funcione en todos los hosts". Ese riesgo no cambia porque Telegram esté caído.
//
// -----------------------------------------------------------------------------
// Por qué la frase va por STDIN y nunca por argv
// -----------------------------------------------------------------------------
//
// `argv` es legible por cualquier proceso del host (`ps`, `wmic`, `/proc`),
// queda en el historial del shell y lo capturan los wrappers de logging del
// pipeline. Es el mismo criterio con el que `.pipeline/tools/vault-provision.js`
// lee los VALORES de secreto por stdin. La frase de confirmación no es un
// secreto de alto valor, pero es el segundo factor: filtrarla degrada el
// break-glass a "lo dispara cualquiera que sepa el nombre del script".
//
// El id de operador SÍ puede ir por argv/env: es un identificador público
// (aparece en CODEOWNERS), no una prueba.
//
// -----------------------------------------------------------------------------
// Qué NO se filtra
// -----------------------------------------------------------------------------
//
// La salida del break-glass —stdout y el registro de auditoría— nunca contiene
// valores de secreto, tokens, firmas, nonces, chat ids, ARNs, hostnames ni
// paths absolutos. Sólo: código de resultado del enum cerrado, el id de
// operador (público) y la referencia al runbook. El test lo cementa con
// canarios falsos y aserciones negativas.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const absencePolicy = require('./operator-absence-policy');

/** Frase exacta de confirmación. Se compara literal, sin normalizar. */
const CONFIRM_PHRASE = 'CORTAR FALLBACK';

/** Resultados posibles. Enum cerrado; ninguno lleva detalle libre. */
const RESULT = Object.freeze({
    CUT: 'cut',
    ALREADY_CUT: 'already-cut',
    UNAUTHORIZED: 'unauthorized',
    NOT_CONFIRMED: 'not-confirmed',
    COVERAGE_INCOMPLETE: 'coverage-incomplete',
    PRECONDITION_FAILED: 'precondition-failed',
    UNAVAILABLE: 'unavailable',
});

/**
 * Códigos de salida del proceso. Estables: el runbook los documenta y un
 * operador sin Telegram los usa para decidir el paso siguiente.
 */
const EXIT_CODE = Object.freeze({
    [RESULT.CUT]: 0,
    [RESULT.ALREADY_CUT]: 0,
    [RESULT.UNAUTHORIZED]: 10,
    [RESULT.NOT_CONFIRMED]: 11,
    [RESULT.COVERAGE_INCOMPLETE]: 12,
    [RESULT.PRECONDITION_FAILED]: 13,
    [RESULT.UNAVAILABLE]: 14,
});

/** Estado de la ventana sombra que habilita el corte. Uno solo. */
const COVERAGE_OK = 'cumple';

/**
 * Valida la identidad local contra la allowlist cerrada en código.
 *
 * Sólo `primary` autoriza. Un `backup` puede EJERCER una firma delegada por el
 * canal normal, pero no puede originar un corte irreversible sin nadie que lo
 * haya delegado: eso es exactamente "otorgar", y `operator-allowlist` ya
 * reserva esa autoridad al primario (`assertCanGrant`).
 *
 * @param {string} operatorId
 * @param {object} [allowlist] — inyectable (tests). Default: singleton.
 * @returns {{ok:true, operator:object}|{ok:false, reason:string}}
 */
function authorizeLocalIdentity(operatorId, allowlist) {
    const list = allowlist || require('./operator-allowlist');
    if (typeof operatorId !== 'string' || !operatorId.trim()) {
        return { ok: false, reason: 'missing-operator' };
    }
    const id = operatorId.trim();
    // `assertCanGrant` es el punto único de la política: primary → ok,
    // backup → 'not-primary', desconocido → 'unknown-operator'. No se
    // reimplementa la comparación acá.
    const verdict = list.assertCanGrant(id);
    if (!verdict || verdict.ok !== true) {
        return { ok: false, reason: (verdict && verdict.reason) || 'unknown-operator' };
    }
    return { ok: true, operator: verdict.operator || { id, role: 'primary' } };
}

/**
 * Verifica la frase de confirmación. Comparación exacta tras recortar sólo el
 * whitespace de los bordes (el terminal agrega `\r\n`).
 * @param {*} raw
 * @returns {boolean}
 */
function isConfirmed(raw) {
    return typeof raw === 'string' && raw.trim() === CONFIRM_PHRASE;
}

/**
 * Registra el intento en la auditoría del corte, con la MISMA forma de evento
 * que usa el ejecutor (`vault-cut-fallback.js`): un JSONL append-only bajo
 * `.pipeline/audit/`. Nunca lanza: un audit que falla no puede impedir que el
 * operador vea el resultado del break-glass.
 *
 * @param {object} params
 * @returns {boolean} true si se pudo escribir.
 */
function appendBreakGlassAudit({ auditPath, operatorId, result, runbook, now, fsImpl } = {}) {
    const _fs = fsImpl || fs;
    try {
        const entry = {
            ts: new Date(typeof now === 'function' ? now() : Date.now()).toISOString(),
            event: 'breakglass_cut',
            ok: result === RESULT.CUT || result === RESULT.ALREADY_CUT,
            // Enum cerrado, nunca el mensaje del error.
            result,
            // Id público de la allowlist en código. No es un secreto.
            operator: typeof operatorId === 'string' ? operatorId.slice(0, 64) : null,
            runbook: absencePolicy.sanitizeRunbookRef(runbook),
            // Marca explícita: este corte NO pasó por el canal de firma.
            channel: 'break-glass',
        };
        _fs.mkdirSync(path.dirname(auditPath), { recursive: true });
        _fs.appendFileSync(auditPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
        return true;
    } catch {
        return false;
    }
}

/**
 * Ejecuta el break-glass.
 *
 * @param {object} opts
 * @param {string}   opts.operatorId        — identidad local (público).
 * @param {string}   opts.confirmation      — frase leída por STDIN.
 * @param {Function} opts.evaluateCoverage  — `() => {estado}` de vault-shadow-metrics.
 * @param {Function} opts.executeCut        — `(cutOpts) => Promise<{ok, alreadyCut}>`
 *                                            (default: `vault-cut-fallback.execute`).
 * @param {object}   [opts.allowlist]       — inyectable (tests).
 * @param {string}   [opts.configPath]
 * @param {string}   [opts.auditPath]
 * @param {string}   [opts.runbook]
 * @param {Function} [opts.now]
 * @param {object}   [opts.fsImpl]
 * @returns {Promise<{result:string, exitCode:number, runbook:string, audited:boolean}>}
 */
async function runBreakGlass(opts = {}) {
    const runbook = absencePolicy.sanitizeRunbookRef(opts.runbook);
    const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    const configPath = opts.configPath || path.join(__dirname, '..', 'config.yaml');
    const auditPath = opts.auditPath
        || path.join(path.dirname(configPath), 'audit', 'vault-cut-fallback.jsonl');
    const fsImpl = opts.fsImpl || fs;

    const finish = (result) => {
        const audited = appendBreakGlassAudit({
            auditPath, operatorId: opts.operatorId, result, runbook, now, fsImpl,
        });
        return { result, exitCode: EXIT_CODE[result], runbook, audited };
    };

    // --- 1 · identidad local ------------------------------------------------
    // Primero la identidad: un no autorizado no debe poder ni siquiera inferir
    // el estado de la cobertura por el código de salida.
    const auth = authorizeLocalIdentity(opts.operatorId, opts.allowlist);
    if (!auth.ok) return finish(RESULT.UNAUTHORIZED);

    // --- 2 · segundo factor: frase por stdin --------------------------------
    if (!isConfirmed(opts.confirmation)) return finish(RESULT.NOT_CONFIRMED);

    // --- 3 · cobertura positiva (NO se saltea) ------------------------------
    let estado = null;
    try {
        const coverage = typeof opts.evaluateCoverage === 'function' ? opts.evaluateCoverage() : null;
        estado = coverage && typeof coverage.estado === 'string' ? coverage.estado : null;
    } catch {
        estado = null;
    }
    if (estado !== COVERAGE_OK) return finish(RESULT.COVERAGE_INCOMPLETE);

    // --- 4 · corte, con el MISMO ejecutor del canal normal -------------------
    // Se reusa `vault-cut-fallback.execute` entero: lock, relectura, escritura
    // atómica, verificación y journal recuperable. La autorización que se le
    // pasa ya viene consumida —el consumo fue la identidad local + la frase—,
    // y `issuedAt` es AHORA, así que el TTL del ejecutor no la rechaza.
    const executeCut = typeof opts.executeCut === 'function'
        // eslint-disable-next-line global-require
        ? opts.executeCut : require('./vault-cut-fallback').execute;

    try {
        const result = await executeCut({
            configPath,
            auditPath,
            fsImpl,
            now: () => new Date(now()),
            // La allowlist ya se validó arriba contra la identidad LOCAL; el
            // ejecutor revalida que alguien la haya autorizado.
            validateAllowlist: () => true,
            // Revalidación dentro del lock: la cobertura se vuelve a mirar
            // inmediatamente antes de persistir, no sólo en el paso 3.
            evaluateCoverage: () => {
                try {
                    const c = typeof opts.evaluateCoverage === 'function' ? opts.evaluateCoverage() : null;
                    return !!(c && c.estado === COVERAGE_OK);
                } catch { return false; }
            },
            authorization: { consumed: true, issuedAt: new Date(now()).toISOString() },
        });
        return finish(result && result.alreadyCut ? RESULT.ALREADY_CUT : RESULT.CUT);
    } catch (error) {
        // El `code` del ejecutor es un enum cerrado; el `message` puede traer
        // contexto. Se usa sólo el code, y sólo para elegir entre dos salidas.
        const code = error && typeof error.code === 'string' ? error.code : '';
        if (code === 'coverage_incomplete') return finish(RESULT.COVERAGE_INCOMPLETE);
        if (code === 'audit_pending' && error.stateApplied === true) return finish(RESULT.CUT);
        if (code === 'unexpected_error' || code === '') return finish(RESULT.UNAVAILABLE);
        return finish(RESULT.PRECONDITION_FAILED);
    }
}

/**
 * Copy operativo del resultado. Sin infraestructura: el operador lo lee en una
 * terminal, no en el chat.
 * @param {{result:string, runbook:string}} outcome
 * @returns {string}
 */
function formatBreakGlassOutcome(outcome = {}) {
    const linea = {
        [RESULT.CUT]: 'CORTADO · el fallback quedo en false y la relectura lo confirmo.',
        [RESULT.ALREADY_CUT]: 'YA CORTADO · el fallback ya estaba en false; nada que hacer.',
        [RESULT.UNAUTHORIZED]: 'NO AUTORIZADO · la identidad local no es un operador primario.',
        [RESULT.NOT_CONFIRMED]: `NO CONFIRMADO · se esperaba la frase exacta "${CONFIRM_PHRASE}" por stdin.`,
        [RESULT.COVERAGE_INCOMPLETE]: 'BLOQUEADO · la cobertura positiva del vault no habilita el corte.',
        [RESULT.PRECONDITION_FAILED]: 'BLOQUEADO · una precondicion del corte no se cumple; el fallback se conserva.',
        [RESULT.UNAVAILABLE]: 'INDETERMINADO · el corte no se pudo completar; el fallback se conserva.',
    }[outcome.result] || 'INDETERMINADO · resultado no reconocido; el fallback se conserva.';
    return [
        'VAULT · break-glass del corte del fallback',
        linea,
        `Runbook: ${absencePolicy.sanitizeRunbookRef(outcome.runbook)}`,
    ].join('\n');
}

module.exports = {
    runBreakGlass,
    authorizeLocalIdentity,
    isConfirmed,
    appendBreakGlassAudit,
    formatBreakGlassOutcome,
    CONFIRM_PHRASE,
    RESULT,
    EXIT_CODE,
};
