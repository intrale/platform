// =============================================================================
// credential-retry-wiring.js — CABLEADO del coordinador de retry de credencial
// (#5796, hija de #5792).
//
// QUÉ ES
// ------
// La capa delgada que pone al coordinador de #5794 (`credential-auth-retry.js`)
// en el camino real de los lanzamientos del Pulpo: agente normal, Commander,
// intento primario y cada eslabón de la cadena de fallbacks.
//
// Antes de esta pieza el coordinador existía con sus tests en verde y CERO
// call-sites productivos: `pulpo.js` no lo requería, `operationId` no aparecía
// en ninguna línea y `projectAuthRejection` proyectaba la señal tipada con
// `operation_id: null` — o sea, la auditoría veía los rechazos pero no podía
// correlacionar dos rechazos de la MISMA operación raíz.
//
// POR QUÉ ES UN MÓDULO APARTE Y NO CÓDIGO INLINE EN pulpo.js
// ----------------------------------------------------------
// `pulpo.js` tiene ~26k líneas y los call-sites del env viven a miles de líneas
// de distancia entre sí (agente ~11.8k, Commander ~15.4k, fallback ~15.7k).
// Repetir el gate, la construcción del `operationId` y el sink de auditoría en
// cada uno garantiza que los tres se desincronicen. Acá viven una sola vez, se
// testean sin levantar el Pulpo y los tres caminos consumen exactamente la
// misma función — que es literalmente el CA-1 del issue.
//
// EL GATE ES PROPIO, NO EL DE SNAPSHOT
// ------------------------------------
// `pipeline.credential_snapshot_enabled` (#5799) gatea el snapshot por intento.
// Si el retry colgara del mismo booleano, abrirlo encendería DOS features a la
// vez: el aislamiento de credenciales y el re-spawn del agente. Por eso el gate
// propio `pipeline.credential_retry_enabled`, fail-closed con `=== true` exacto.
//
// Con el gate CERRADO (default del rollout) `runAttempt` es un no-op bit a bit:
// un solo `createSnapshot`, un solo `execute`, cero eventos de auditoría, cero
// invalidaciones. Un rollout que cambia lo observable estando apagado no es un
// rollout, es un despliegue encubierto.
//
// SEGURIDAD
// ---------
//   * El `operationId` se construye SÓLO con tokens del pipeline (tipo de
//     lanzamiento, skill, issue y un nonce criptográfico). Nunca con el nombre
//     del provider, el prompt, el output del child ni nada heredado del env:
//     ese id viaja a la auditoría y se usa para correlacionar, así que una
//     fuente no confiable lo convierte en un canal de inyección hacia el audit.
//   * Los eventos que se persisten son los que EMITE el coordinador, ya
//     construidos campo por campo desde su allowlist y congelados. Este módulo
//     no los enriquece ni les agrega claves: sólo los serializa.
//   * El sink de auditoría es best-effort y nunca tira: corre en el camino
//     caliente del spawn.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const credentialRetry = require('./credential-auth-retry');

// Clave del gate dentro de `pipeline:` en config.yaml. Constante para que el
// test de rollout y el call-site no puedan escribir dos strings distintos.
const RETRY_GATE_KEY = 'credential_retry_enabled';

// Tipo de lanzamiento que origina la operación raíz. Es el primer segmento del
// `operationId` y lo que permite leer de un vistazo, en el audit, si el rechazo
// vino de un agente de fase o del Commander.
const OPERATION_KIND = Object.freeze({
    AGENT: 'agent',
    COMMANDER: 'commander',
});

// Nombre del camino cuando el intento corre con el provider primario. El
// coordinador y `projectAuthRejection` lo tratan como un token más.
const PRIMARY_PATH = 'primary';

// Longitudes máximas por segmento del id. El validador del dispatcher corta en
// 128 chars el token ENTERO y descarta (no recorta) lo que se pase: acotar acá
// evita que un skill con nombre largo tire silenciosamente la correlación.
const MAX_SKILL_CHARS = 40;
const MAX_ISSUE_CHARS = 16;
const NONCE_BYTES = 8;

/**
 * ¿Está abierto el gate del retry de credencial?
 *
 * Fail-closed con comparación estricta contra `true`, mismo criterio que
 * `isSnapshotEnabled` de #5799: un `"true"` string, un `1` o un valor ausente
 * dejan el retry APAGADO. Encender una feature de credenciales por coerción de
 * tipos es exactamente la clase de sorpresa que no queremos en producción.
 */
function isRetryEnabled(config) {
    return !!(config && config.pipeline && config.pipeline[RETRY_GATE_KEY] === true);
}

/**
 * Sanea un segmento del `operationId`.
 *
 * Reemplaza por `-` todo lo que no sea `[A-Za-z0-9_.-]` en vez de descartarlo:
 * acá el input es un token del PIPELINE (un nombre de skill, un número de
 * issue), no un valor del provider, así que normalizar preserva la legibilidad
 * sin abrir ninguna superficie. Lo que sí es innegociable es que el resultado
 * pase después el validador del dispatcher — de eso se encarga `buildOperationId`.
 */
function sanitizeSegment(value, maxChars) {
    if (value === null || value === undefined) return '';
    const crudo = String(value).trim();
    if (!crudo) return '';
    return crudo.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, maxChars);
}

/**
 * Construye el identificador de la operación raíz.
 *
 * Forma: `<kind>:<skill|req>:<issue>:<nonce>` — por ejemplo
 * `agent:pipeline-dev:5796:9f2c1ab3d4e5f607`.
 *
 * @returns {string|null} el id, o `null` si no pasa el validador de tokens del
 *   dispatcher (fail-closed: sin id no se crea operación, y sin operación el
 *   camino degrada al no-op en vez de auditar con `operation_id: null`).
 */
function buildOperationId({ kind, skill, issue, nonce } = {}) {
    const tipo = OPERATION_KIND[String(kind || '').toUpperCase()] || sanitizeSegment(kind, 16);
    if (!tipo) return null;
    const partes = [
        tipo,
        sanitizeSegment(skill, MAX_SKILL_CHARS) || 'unknown',
        sanitizeSegment(issue, MAX_ISSUE_CHARS) || '0',
        sanitizeSegment(nonce, 32) || crypto.randomBytes(NONCE_BYTES).toString('hex'),
    ];
    const id = partes.join(':');
    // Validación final con el MISMO normalizador que usa `projectAuthRejection`.
    // Si acá no pasa, tampoco pasaría allá: mejor enterarse antes de spawnear
    // que descubrir el `operation_id: null` leyendo el audit de un incidente.
    return credentialRetry._normalizeToken(id);
}

/**
 * Crea la operación RAÍZ del lanzamiento, o `null` si el gate está cerrado.
 *
 * Se llama UNA sola vez por lanzamiento/turno, ANTES de resolver el provider:
 * el primario y todos los eslabones de fallback tienen que colgar de la misma
 * operación, porque ahí vive el presupuesto único. Crearla dentro del bucle de
 * fallbacks le daría a cada provider un retry propio, que es precisamente la
 * estampida contra el vault que el coordinador viene a evitar.
 *
 * Nunca tira: un fallo construyendo el id degrada a `null` (no-op) y se loguea.
 * Este módulo no puede ser el motivo por el que el pipeline deja de lanzar.
 */
function createRootOperation({ config, kind, skill, issue, nonce, logger } = {}) {
    if (!isRetryEnabled(config)) return null;
    const log = typeof logger === 'function' ? logger : () => {};
    try {
        const operationId = buildOperationId({ kind, skill, issue, nonce });
        if (!operationId) {
            log(`⚠️ credential-retry: no se pudo construir el operationId (kind=${kind}, skill=${skill}, issue=${issue}) — el lanzamiento sigue SIN retry de credencial`);
            return null;
        }
        return credentialRetry.createOperation({ operationId });
    } catch (e) {
        log(`⚠️ credential-retry: createOperation falló (${(e && e.code) || 'sin codigo'}) — el lanzamiento sigue SIN retry de credencial`);
        return null;
    }
}

// -----------------------------------------------------------------------------
// REGISTRO DE OPERACIONES VIVAS — por qué el presupuesto tiene que sobrevivir
// al proceso del hijo pero NO al issue.
//
// En el Pulpo un "cambio de camino" del agente no ocurre dentro de una sola
// llamada: el resolver elige UN provider por lanzamiento, y la cascada a un
// fallback se materializa como un lanzamiento POSTERIOR del mismo dropfile
// (vuelve a `pendiente/` y el filesystem-como-cola lo recoge). Si la operación
// raíz naciera y muriera con cada llamada, cada eslabón de esa cascada se
// ganaría un retry propio: N invalidaciones y N re-resoluciones para la misma
// caída de credencial — exactamente la estampida que el coordinador evita.
//
// Por eso la operación se indexa por lanzamiento lógico (fase + skill + issue)
// y vive en memoria del padre con un TTL acotado. El TTL es la parte importante:
// sin él, un issue que rebota durante horas arrastraría para siempre un
// presupuesto consumido y nunca volvería a poder re-resolver su credencial,
// aunque la del vault ya estuviera arreglada.
// -----------------------------------------------------------------------------
const DEFAULT_OPERATION_TTL_MS = 30 * 60 * 1000; // 30 min

/** Registro por defecto del proceso. Un test puede pasar el suyo y aislarse. */
const defaultRegistry = new Map();

/** Poda las entradas vencidas. O(n) sobre un mapa que en la práctica tiene <20. */
function pruneOperations(registry, nowMs) {
    for (const [k, v] of registry) {
        if (!v || typeof v.expiresAt !== 'number' || v.expiresAt <= nowMs) registry.delete(k);
    }
}

/**
 * Devuelve la operación raíz de este lanzamiento lógico, creándola si es el
 * primer intento y reusándola —con su presupuesto ya consumido— si el issue
 * vuelve a lanzarse dentro del TTL.
 *
 * Con el gate cerrado devuelve `null` y ni siquiera toca el registro.
 *
 * @returns {object|null} la operación de `createOperation`, o `null`.
 */
function getOrCreateOperation({
    key, config, kind, skill, issue, nonce, logger,
    registry, ttlMs, now,
} = {}) {
    if (!isRetryEnabled(config)) return null;
    const _registry = registry || defaultRegistry;
    const _now = typeof now === 'function' ? now() : Date.now();
    const _ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_OPERATION_TTL_MS;
    const clave = typeof key === 'string' && key !== '' ? key : `${kind}:${skill}:${issue}`;

    pruneOperations(_registry, _now);

    const vigente = _registry.get(clave);
    if (vigente && credentialRetry.isOperation(vigente.operation)) {
        // Se refresca la ventana: el issue sigue vivo, y lo que interesa medir
        // es el tiempo desde el ÚLTIMO intento, no desde el primero.
        vigente.expiresAt = _now + _ttl;
        return vigente.operation;
    }

    const operation = createRootOperation({ config, kind, skill, issue, nonce, logger });
    if (!operation) return null;
    _registry.set(clave, { operation, expiresAt: _now + _ttl });
    return operation;
}

/**
 * Olvida la operación de un lanzamiento lógico.
 *
 * Se llama cuando la corrida cerró por una causa que NO es un rechazo de
 * credencial: el próximo lanzamiento de ese issue es una operación nueva y
 * merece su propio presupuesto. Idempotente.
 */
function forgetOperation({ key, registry } = {}) {
    const _registry = registry || defaultRegistry;
    if (typeof key !== 'string' || key === '') return false;
    return _registry.delete(key);
}

/**
 * Nombre del camino para correlación, derivado de la resolución del dispatcher.
 *
 * `primary` para el intento con el provider primario; `fallback:<n>:<provider>`
 * para cada eslabón de la cascada. El índice viaja porque dos fallbacks del
 * mismo provider (distinto modelo) serían indistinguibles sin él.
 */
function pathForResolution(dispatchResolution) {
    if (!dispatchResolution || typeof dispatchResolution !== 'object') return PRIMARY_PATH;
    if (dispatchResolution.source !== 'fallback') return PRIMARY_PATH;
    const provider = sanitizeSegment(dispatchResolution.provider, 40) || 'unknown';
    const indice = Number.isInteger(dispatchResolution.fallbackIndex)
        ? dispatchResolution.fallbackIndex
        : (Array.isArray(dispatchResolution.chainTried) ? Math.max(0, dispatchResolution.chainTried.length - 1) : 0);
    return `fallback:${indice}:${provider}`;
}

/** Archivo de auditoría del retry, rotado por día UTC (igual que el dispatcher). */
function auditFile(pipelineDir, now = new Date()) {
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    return path.join(pipelineDir, 'logs', `credential-retry-${yyyy}-${mm}-${dd}.jsonl`);
}

/**
 * Sink de auditoría de los eventos del coordinador.
 *
 * Los eventos llegan YA construidos desde la allowlist de `EVENT_FIELDS` y
 * congelados: acá no se agrega ni un campo. Best-effort absoluto — un disco
 * lleno o un permiso mal puesto no puede tumbar un spawn.
 */
function makeAuditEmitter({ pipelineDir, fsImpl, now, logger } = {}) {
    const _fs = fsImpl || fs;
    const log = typeof logger === 'function' ? logger : () => {};
    return function emitirEvento(evento) {
        if (!evento || typeof evento !== 'object' || !pipelineDir) return;
        try {
            const file = auditFile(pipelineDir, typeof now === 'function' ? new Date(now()) : new Date());
            try { _fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* ya existe */ }
            _fs.appendFileSync(file, `${JSON.stringify(evento)}\n`, 'utf8');
        } catch (e) {
            try { log(`credential-retry: audit best-effort falló (${e && e.message})`); } catch { /* nada */ }
        }
    };
}

/**
 * ¿Este desenlace es un rechazo de credencial tipado?
 *
 * Reusa `defaultClassify` del coordinador — el MISMO criterio, no una copia:
 * clasificar por texto libre acá reintroduciría la heurística que #5795 vino a
 * eliminar. Sirve para el "peek" SÍNCRONO del exit handler, que necesita saber
 * antes de ejecutar los efectos de cierre si el coordinador se va a hacer cargo.
 */
function isAuthRejection(candidate) {
    try {
        return credentialRetry.defaultClassify(candidate) !== null;
    } catch {
        return false;
    }
}

/**
 * ¿La operación todavía tiene su retry disponible?
 *
 * Peek síncrono y sin efectos: NO consume el presupuesto (de eso se encarga
 * `consumeRetry` dentro del coordinador, que es la sección crítica). El exit
 * handler lo usa para decidir si difiere los efectos observables del cierre;
 * el consumo real ocurre microsegundos después, en el mismo tick lógico y sin
 * ningún otro camino de la misma operación en vuelo.
 */
function canRetry(operation) {
    return credentialRetry.isOperation(operation) && operation.retryConsumed === false;
}

/**
 * Corre UN intento bajo el coordinador — o el camino no-op si no hay operación.
 *
 * Ésta es la función que unifica los cuatro caminos del CA-1: agente normal,
 * Commander, primario y cada fallback la llaman con la MISMA `operation`.
 *
 * Sin `operation` (gate cerrado, o creación degradada) el camino es
 * deliberadamente pobre y explícito: un `createSnapshot({attempt: 1})` y un
 * `execute`. Ni un evento, ni una invalidación, ni una resolución de scope —
 * paridad bit a bit con el comportamiento previo a este issue.
 *
 * @returns {Promise<{ok:true, result:*, attempts:number, retryUsed:boolean, snapshot:*, events:object[]}>}
 */
async function runAttempt({
    operation, provider, path: attemptPath, destination, scope,
    createSnapshot, execute, emit, invalidate, classify, now,
    invalidableScopes, destinationsCatalog,
} = {}) {
    if (typeof createSnapshot !== 'function' || typeof execute !== 'function') {
        throw new TypeError('[credential-retry-wiring] runAttempt requiere `createSnapshot` y `execute` como funciones');
    }

    if (!credentialRetry.isOperation(operation)) {
        const snapshot = await createSnapshot({
            attempt: 1, provider, scope: scope || null, destination, operationId: null,
        });
        const result = await execute({
            snapshot, attempt: 1, provider, path: attemptPath || PRIMARY_PATH, operationId: null,
        });
        return { ok: true, result, attempts: 1, retryUsed: false, snapshot, events: [] };
    }

    return credentialRetry.runWithCredentialRetry({
        operation,
        provider,
        path: attemptPath || PRIMARY_PATH,
        destination,
        scope,
        createSnapshot,
        execute,
        emit,
        // `classify` e `invalidate` se dejan en los defaults del coordinador a
        // propósito (`defaultClassify` + `resetVaultCache`): un clasificador
        // propio acá volvería a abrir la puerta a decidir por texto libre, y un
        // invalidador propio se saltearía el contrato acotado de #5797.
        invalidate,
        classify,
        now,
        invalidableScopes,
        destinationsCatalog,
    });
}

/**
 * Corre el coordinador sobre un intento que YA OCURRIÓ ("replay").
 *
 * POR QUÉ EXISTE
 * --------------
 * `runWithCredentialRetry` está escrito para ser el dueño del ciclo completo:
 * él pide el snapshot, él ejecuta, él clasifica. Eso encaja perfecto donde el
 * intento es una función awaitable (el Commander), pero NO donde el intento es
 * un `spawn` fire-and-forget cuyo veredicto aparece 20 minutos después, dentro
 * de un `child.on('exit')` de 600 líneas con su propio lifecycle de dropfile
 * (el agente). Envolver ese ciclo obligaría a reestructurar la máquina de
 * estados del lanzamiento —el corazón del Pulpo— para una feature que arranca
 * apagada. El costo de esa reestructuración no se paga con el beneficio.
 *
 * El replay resuelve la impedancia sin duplicar una línea de la política: el
 * primer intento se le entrega al coordinador como hecho consumado (su snapshot
 * y su veredicto reales), y a partir de ahí el coordinador manda de verdad —
 * decide si la señal era un rechazo tipado, consume el presupuesto único,
 * invalida el scope acotado, re-resuelve el snapshot y dispara el reintento.
 * La clasificación, el presupuesto y la auditoría siguen siendo suyos; lo único
 * que cambia es QUIÉN corrió el primer intento.
 *
 * @param {object}   a.firstSnapshot  el snapshot que realmente usó el intento 1.
 * @param {object}   a.firstOutcome   su veredicto (el retorno de `onSpawnExit`).
 * @param {function} a.createSnapshot re-resolución para el intento 2.
 * @param {function} a.retryExecute   el reintento propiamente dicho.
 */
async function runReplayAttempt({
    operation, provider, path: attemptPath, destination, scope,
    firstSnapshot, firstOutcome, createSnapshot, retryExecute,
    emit, invalidate, classify, now, invalidableScopes, destinationsCatalog,
} = {}) {
    if (typeof createSnapshot !== 'function' || typeof retryExecute !== 'function') {
        throw new TypeError('[credential-retry-wiring] runReplayAttempt requiere `createSnapshot` y `retryExecute` como funciones');
    }
    return runAttempt({
        operation, provider, path: attemptPath, destination, scope,
        // El intento 1 no vuelve a pedir credenciales: entrega las que usó. Un
        // `createSnapshot` que re-resolviera acá pediría material nuevo para un
        // spawn que ya terminó, y encima ANTES de que el coordinador decidiera
        // invalidar — o sea, una resolución de más contra el vault por cada
        // muerte de agente, tuviera o nada que ver con la credencial.
        createSnapshot: (ctx) => (ctx && ctx.attempt === 1 ? firstSnapshot : createSnapshot(ctx)),
        execute: (ctx) => (ctx && ctx.attempt === 1 ? firstOutcome : retryExecute(ctx)),
        emit, invalidate, classify, now, invalidableScopes, destinationsCatalog,
    });
}

module.exports = {
    RETRY_GATE_KEY,
    OPERATION_KIND,
    PRIMARY_PATH,
    DEFAULT_OPERATION_TTL_MS,

    isRetryEnabled,
    getOrCreateOperation,
    forgetOperation,
    runReplayAttempt,
    buildOperationId,
    createRootOperation,
    pathForResolution,
    makeAuditEmitter,
    isAuthRejection,
    canRetry,
    runAttempt,

    // Expuestos para tests.
    _sanitizeSegment: sanitizeSegment,
    _auditFile: auditFile,
};
