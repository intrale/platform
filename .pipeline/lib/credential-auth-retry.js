// =============================================================================
// credential-auth-retry.js — Coordinador de retry ÚNICO de credencial (#5794,
// hija de #5792).
//
// QUÉ ES
// ------
// El único dueño del PRESUPUESTO de re-resolución de credenciales. Recibe una
// señal ya tipada (`authentication_rejected`, #5795), y decide —una sola vez
// por operación raíz— invalidar el scope, re-resolver un snapshot nuevo
// (#5797/#5798) y reintentar exactamente una vez. Un segundo rechazo falla
// CERRADO: no hay tercer intento y no hay bucle.
//
// POR QUÉ ES UN MÓDULO APARTE
// ---------------------------
// Las tres capas de abajo ya existen y, por diseño, NINGUNA guarda estado:
//
//   * `providers/*.js`            DETECTAN el rechazo con tablas cerradas.
//   * `provider-error-parser.js`  SELECCIONA el adapter y TRANSPORTA la señal.
//   * `dispatch-with-fallback.js` PROYECTA el rechazo con el contexto raíz.
//
// Si el presupuesto viviera en cualquiera de ellas, cada eslabón de la cadena
// de fallbacks tendría el suyo y "un retry por operación" se convertiría en
// "un retry por provider": N invalidaciones, N re-resoluciones y una estampida
// contra el vault por cada caída de credencial. El estado vive acá, en un
// objeto que PERTENECE a la operación raíz y que el caller propaga; nunca en
// un caché global ni en un módulo con estado de proceso.
//
// LO QUE ESTE MÓDULO NO HACE
// --------------------------
//   * No clasifica errores de provider (eso es #5795 y su tabla cerrada).
//   * No elige fallback ni rota provider (eso es el dispatcher).
//   * No decide cuota, ni toca flags de cuota, ni reintenta el issue.
//   * No lee ni escribe `process.env`, no habla con el vault directamente y no
//     construye el env del hijo: consume el contrato público de #5791.
//
// SEGURIDAD — POR QUÉ LOS EVENTOS NO PUEDEN FILTRAR SECRETOS
// ----------------------------------------------------------
// La garantía es estructural, no cosmética: los eventos se construyen campo por
// campo desde una ALLOWLIST fija (`EVENT_FIELDS`), y cada valor de texto pasa
// por el normalizador de tokens del dispatcher. Nunca se copia un objeto del
// caller, nunca se serializa un error, nunca se lee `message`, `stack`,
// `stderr`, `stdout`, headers, payloads ni `snapshot.env`. Del snapshot sólo
// viaja la CANTIDAD de claves (un número), jamás sus valores ni el objeto.
// Un valor que no calza en la allowlist se descarta ENTERO (no se recorta:
// recortar disfraza un valor inesperado de valor válido).
// =============================================================================

'use strict';

// -----------------------------------------------------------------------------
// Nombres de los eventos auditables. Constantes: ningún call-site los escribe a
// mano, así un typo es un error de módulo y no una línea de audit que nadie
// encuentra después.
// -----------------------------------------------------------------------------
const RETRY_EVENTS = Object.freeze({
    INVALIDATED: 'credential_invalidated',
    RERESOLVED: 'credential_reresolved',
    RETRY_CLOSED: 'credential_retry_closed',
});

// Motivo del cierre. Cerrado a propósito: el operador rutea por acá.
const CLOSE_REASONS = Object.freeze({
    // Ya se había gastado el retry de esta operación (típicamente en otro
    // provider de la cadena de fallbacks). Se cierra SIN invalidar de nuevo.
    BUDGET_EXHAUSTED: 'budget_exhausted',
    // El reintento —el único— también fue rechazado. Fallo cerrado terminal.
    SECOND_REJECTION: 'second_rejection',
    // La invalidación acotada falló: no se puede garantizar que el material
    // viejo salió de la caché, así que no se reintenta con él.
    INVALIDATION_FAILED: 'invalidation_failed',
    // El snapshot nuevo no se pudo emitir. Reintentar con el snapshot VIEJO
    // sería reintentar con la credencial que el provider acaba de rechazar.
    RERESOLUTION_FAILED: 'reresolution_failed',
});

// Códigos estables del error propio. Los consumidores rutean por `code`.
const RETRY_ERROR_CODES = Object.freeze({
    OPERATION_INVALID: 'CREDENTIAL_RETRY_OPERATION_INVALID',
    EXECUTE_REQUIRED: 'CREDENTIAL_RETRY_EXECUTE_REQUIRED',
    SNAPSHOT_REQUIRED: 'CREDENTIAL_RETRY_SNAPSHOT_REQUIRED',
    SCOPE_UNRESOLVED: 'CREDENTIAL_RETRY_SCOPE_UNRESOLVED',
    SCOPE_NOT_INVALIDABLE: 'CREDENTIAL_RETRY_SCOPE_NOT_INVALIDABLE',
    CLOSED: 'CREDENTIAL_RETRY_CLOSED',
    INVALIDATION_FAILED: 'CREDENTIAL_RETRY_INVALIDATION_FAILED',
    RERESOLUTION_FAILED: 'CREDENTIAL_RETRY_RERESOLUTION_FAILED',
});

// Presupuesto: UNO. No es configurable a propósito. Un presupuesto por config
// es un bucle de invalidación esperando a que alguien suba el número en
// producción durante un incidente de credenciales.
const RETRY_BUDGET = 1;

// Allowlist ESTRICTA de campos de evento. Lo que no está acá no puede salir.
const EVENT_FIELDS = Object.freeze([
    'event',
    'operation_id',
    'provider',
    'path',
    'destination',
    'scope',
    'attempt',
    'reason',
    'invalidated_entries',
    'snapshot_keys',
    'signal_source',
    'signal_code',
    'signal_status',
    'signal_type',
    'ts',
]);

/**
 * Error tipado del coordinador. Misma superficie que el resto de la familia:
 * nombres, códigos y contexto de operación; jamás valores de credencial,
 * mensajes del provider ni el error original encadenado (`cause` incluido:
 * encadenar el error del vault arrastraría su `message` a cualquier logger que
 * serialice la excepción).
 */
class CredentialRetryError extends Error {
    constructor(message, { code, operationId, provider, path, scope, attempt, reason } = {}) {
        super(message);
        this.name = 'CredentialRetryError';
        this.code = code || RETRY_ERROR_CODES.CLOSED;
        this.operationId = operationId || null;
        this.provider = provider || null;
        this.path = path || null;
        this.scope = scope || null;
        this.attempt = Number.isInteger(attempt) ? attempt : null;
        this.reason = reason || null;
    }
}

// -----------------------------------------------------------------------------
// Dependencias del pipeline, cargadas PEREZOSAMENTE.
//
// Dos razones, las dos concretas:
//   1. Ciclo — la integración de #5796 hace que `dispatch-with-fallback.js`
//      llame a este módulo. Un `require` en el tope crearía una dependencia
//      circular que, según quién cargue primero, entrega un `module.exports` a
//      medio poblar. Con require diferido ambos módulos ya están completos
//      cuando se resuelve la primera llamada.
//   2. Costo — `credentials.js` es pesado y los tests inyectan todo, así que en
//      la suite no se carga ni una vez.
// -----------------------------------------------------------------------------
function dispatchModule() {
    return require('./agent-launcher/dispatch-with-fallback');
}

function credentialsModule() {
    return require('./credentials');
}

/**
 * Normalizador de tokens de contexto. Se IMPORTA del dispatcher, no se copia:
 * es la misma allowlist que ya filtra `operationId`/`path` en la proyección de
 * #5795, y una segunda copia se desincronizaría en el primer endurecimiento.
 */
function normalizeToken(value) {
    try {
        return dispatchModule()._normalizeContextToken(value);
    } catch {
        return null;
    }
}

/** Entero acotado, o `null`. Los eventos no transportan números arbitrarios. */
function normalizeCount(value, max = 100000) {
    if (!Number.isInteger(value) || value < 0 || value > max) return null;
    return value;
}

// -----------------------------------------------------------------------------
// createOperation — el estado de la operación RAÍZ.
//
// Es un objeto PLANO y explícito, no un handle opaco: el caller lo propaga por
// la cadena de fallbacks y necesita poder inspeccionarlo (y un test necesita
// poder afirmar sobre él). Lo único que muta durante la operación es
// `retryConsumed` y los dos contadores; `operationId` se valida acá una sola vez.
//
// El `operationId` es OBLIGATORIO: sin él dos rechazos de operaciones distintas
// serían indistinguibles en la auditoría, que es justo el problema que la
// correlación viene a resolver.
// -----------------------------------------------------------------------------
function createOperation({ operationId } = {}) {
    const id = normalizeToken(operationId);
    if (!id) {
        throw new CredentialRetryError(
            '[credential-retry] operationId invalido o ausente. '
            + 'Impacto: NO se creo la operacion — sin identidad raiz el presupuesto no se puede '
            + 'compartir entre providers ni correlacionar en la auditoria (fail-closed). '
            + 'Proximo paso: pasar un identificador corto de la operacion raiz '
            + '(ej. "5794:dev:1727384"), sin espacios ni saltos de linea.',
            { code: RETRY_ERROR_CODES.OPERATION_INVALID },
        );
    }
    return {
        operationId: id,
        retryConsumed: false,
        invalidations: 0,
        reresolutions: 0,
    };
}

/** ¿Este objeto es una operación creada por `createOperation`? Fail-closed. */
function isOperation(op) {
    return !!op
        && typeof op === 'object'
        && typeof op.operationId === 'string'
        && op.operationId !== ''
        && typeof op.retryConsumed === 'boolean';
}

// -----------------------------------------------------------------------------
// consumeRetry — la SECCIÓN CRÍTICA del módulo. Síncrona a propósito.
//
// Node corre un tick sin interrupciones: entre el `if` y la asignación no puede
// intercalarse otra continuación. Por eso dos ejecuciones CONCURRENTES que
// comparten la misma operación (el primario y un fallback en vuelo, o dos
// caminos del Commander) no pueden ganar las dos: la primera se lleva el retry
// y la segunda ve `true` y cierra.
//
// Si esta comprobación estuviera después de un `await` —por ejemplo, chequear
// el presupuesto recién antes de invalidar— las dos pasarían el `if` antes de
// que cualquiera asigne, y habría dos invalidaciones y dos re-resoluciones para
// la misma operación. Es la razón de que no haya un solo `await` acá adentro.
//
// @returns {boolean} true si ESTA llamada se quedó con el retry.
// -----------------------------------------------------------------------------
function consumeRetry(operation) {
    if (!isOperation(operation)) return false;
    if (operation.retryConsumed) return false;
    operation.retryConsumed = true;
    return true;
}

// -----------------------------------------------------------------------------
// scopeForDestination — deriva el scope lógico invalidable del DESTINO.
//
// Se lee del catálogo `SNAPSHOT_DESTINATIONS` de #5798, que es el punto único
// de verdad de qué scopes tiene autorizado cada destino. Una lista literal acá
// se desincronizaría del catálogo en el primer destino nuevo y dejaría un
// scope imposible de invalidar (o —peor— invalidaría el equivocado).
//
// Fail-closed ante un destino con MÁS de un scope: la invalidación acotada
// tiene que nombrar UNO. Elegir por nosotros el primero de la lista sería
// invalidar un scope que el caller no pidió; barrerlos todos sería una
// invalidación más amplia que la necesaria. En ese caso el caller declara
// `scope` explícito.
//
// @returns {string|null}
// -----------------------------------------------------------------------------
function scopeForDestination(destination, { destinationsCatalog } = {}) {
    if (typeof destination !== 'string' || destination === '') return null;
    let catalogo = destinationsCatalog;
    if (!catalogo) {
        try {
            catalogo = credentialsModule().SNAPSHOT_DESTINATIONS;
        } catch {
            return null;
        }
    }
    const entrada = catalogo && catalogo[destination];
    if (!entrada || !Array.isArray(entrada.scopes) || entrada.scopes.length !== 1) return null;
    const scope = entrada.scopes[0];
    return (typeof scope === 'string' && scope !== '') ? scope : null;
}

/**
 * Resuelve y VALIDA el scope a invalidar, antes del primer intento.
 *
 * Se valida temprano —no recién cuando hace falta invalidar— porque un scope
 * mal declarado es un error de cableado: descubrirlo al segundo rechazo
 * significa haber gastado dos spawns para enterarse, y encima en el momento en
 * que el pipeline ya está degradado.
 */
function resolveScope({ scope, destination, invalidableScopes, destinationsCatalog, operationId, provider, path }) {
    const declarado = (typeof scope === 'string' && scope !== '')
        ? scope
        : scopeForDestination(destination, { destinationsCatalog });

    if (!declarado) {
        throw new CredentialRetryError(
            '[credential-retry] no se pudo resolver el scope logico a invalidar '
            + `(scope=${scope === undefined ? 'ausente' : typeof scope}, `
            + `destination=${destination === undefined ? 'ausente' : typeof destination}). `
            + 'Impacto: la operacion se aborta ANTES del primer intento — sin scope no hay '
            + 'invalidacion acotada posible y la alternativa (barrer la cache entera) esta '
            + 'prohibida por diseno (fail-closed). '
            + 'Proximo paso: pasar `destination` del catalogo de snapshots (agent-child | commander) '
            + 'o un `scope` explicito de los invalidables.',
            { code: RETRY_ERROR_CODES.SCOPE_UNRESOLVED, operationId, provider, path },
        );
    }

    let invalidables = invalidableScopes;
    if (!invalidables) {
        try {
            invalidables = credentialsModule().scopesInvalidables();
        } catch {
            invalidables = null;
        }
    }
    // Sin lista de invalidables no se puede afirmar que el scope sea legítimo.
    // Fail-closed: se rechaza igual que un scope desconocido.
    if (!Array.isArray(invalidables) || !invalidables.includes(declarado)) {
        throw new CredentialRetryError(
            `[credential-retry] el scope "${normalizeToken(declarado) || 'invalido'}" no es invalidable. `
            + 'Impacto: la operacion se aborta ANTES del primer intento — invalidar un scope que el '
            + 'contrato de #5797 no reconoce terminaria en un barrido total de la cache, que afectaria '
            + 'a otros providers y operaciones (fail-closed). '
            + `Proximo paso: usar uno de los scopes declarados (${Array.isArray(invalidables) ? invalidables.join(', ') : 'inventario no disponible'}).`,
            { code: RETRY_ERROR_CODES.SCOPE_NOT_INVALIDABLE, operationId, provider, path, scope: declarado },
        );
    }
    return declarado;
}

// -----------------------------------------------------------------------------
// defaultClassify — extrae la proyección del rechazo del resultado o del error.
//
// Acepta las dos formas con las que la señal llega hoy:
//   * `onSpawnExit()` devuelve `{ authenticationRejection }`.
//   * un `execute` que prefiera tirar puede colgar `authRejection` del error.
//
// NO clasifica nada por su cuenta: si no hay una proyección con el `kind`
// canónico y una `signal` estructurada, devuelve `null` y el error se trata
// como cualquier otro fallo (sin invalidar y sin consumir el retry). Esa es la
// diferencia entre "el provider dijo que la credencial no sirve" y "algo salió
// mal", y es exactamente lo que separa un retry legítimo de un bucle de
// invalidación disparado por un timeout.
// -----------------------------------------------------------------------------
function defaultClassify(candidate) {
    if (!candidate || typeof candidate !== 'object') return null;
    const proyeccion = candidate.authenticationRejection || candidate.authRejection || null;
    if (!proyeccion || typeof proyeccion !== 'object') return null;

    let claseCanonica;
    try {
        claseCanonica = dispatchModule().AUTH_REJECTED_CLASS;
    } catch {
        return null;
    }
    if (proyeccion.kind !== claseCanonica) return null;
    if (!proyeccion.signal || typeof proyeccion.signal !== 'object') return null;
    return proyeccion;
}

// -----------------------------------------------------------------------------
// buildEvent — construye el evento auditable campo por campo desde la
// allowlist. Congelado, sin claves fuera de `EVENT_FIELDS`, sin un solo valor
// que venga del payload del provider o del snapshot.
// -----------------------------------------------------------------------------
function buildEvent({
    event, operationId, provider, path, destination, scope, attempt, reason,
    invalidatedEntries, snapshotKeys, rejection, ts,
} = {}) {
    const signal = (rejection && typeof rejection.signal === 'object' && rejection.signal) || null;
    const crudo = {
        event,
        operation_id: normalizeToken(operationId),
        provider: normalizeToken(provider),
        path: normalizeToken(path),
        destination: normalizeToken(destination),
        scope: normalizeToken(scope),
        attempt: normalizeCount(attempt, 1000),
        // `reason` sólo puede ser uno de los motivos cerrados de arriba. Un
        // valor que no esté en la tabla se descarta: no hay forma de que un
        // string del provider entre por acá.
        reason: Object.values(CLOSE_REASONS).includes(reason) ? reason : null,
        invalidated_entries: normalizeCount(invalidatedEntries),
        snapshot_keys: normalizeCount(snapshotKeys),
        signal_source: signal ? normalizeToken(signal.source) : null,
        signal_code: signal ? normalizeToken(signal.code) : null,
        signal_status: signal ? normalizeCount(signal.status, 599) : null,
        signal_type: signal ? normalizeToken(signal.type) : null,
        ts: typeof ts === 'string' ? ts : null,
    };
    // Proyección final por la allowlist: aunque alguien agregue una clave arriba
    // sin sumarla a `EVENT_FIELDS`, no sale.
    const salida = {};
    for (const campo of EVENT_FIELDS) salida[campo] = crudo[campo] === undefined ? null : crudo[campo];
    return Object.freeze(salida);
}

/**
 * Emisión best-effort. Un sink de auditoría roto NO puede tumbar el
 * lanzamiento: este coordinador corre en el camino caliente del spawn. Se
 * devuelve el evento igual para que los tests (y un caller que quiera
 * encadenarlo a otro sink) lo tengan aunque el `emit` del caller haya tirado.
 */
function safeEmit(emit, evento) {
    if (typeof emit === 'function') {
        try { emit(evento); } catch { /* best-effort por diseño */ }
    }
    return evento;
}

// -----------------------------------------------------------------------------
// runWithCredentialRetry — el flujo completo.
//
//   snapshot inicial → ejecución → rechazo tipado → UNA invalidación acotada →
//   UNA re-resolución → UN reintento → (segundo rechazo ⇒ fallo cerrado).
//
// Cualquier otra clase de error falla de inmediato, sin invalidar y sin
// consumir el retry.
//
// @param {object}   a
// @param {object}   a.operation      objeto de `createOperation()`; se COMPARTE
//                                    entre providers y caminos de fallback.
// @param {function} a.execute        `({snapshot, attempt, provider, path, operationId}) => any`
// @param {function} a.createSnapshot `({attempt, provider, scope, destination, operationId}) => snapshot`
// @param {string}   [a.provider]     provider EFECTIVO del intento.
// @param {string}   [a.path]         camino de fallback (correlación).
// @param {string}   [a.destination]  destino del catálogo de #5798.
// @param {string}   [a.scope]        scope explícito; si falta se deriva del destino.
// @param {function} [a.invalidate]   `(scope) => {invalidadas}`; default `resetVaultCache`.
// @param {function} [a.classify]     extractor de la señal tipada.
// @param {function} [a.emit]         sink de eventos auditables.
// @param {function} [a.now]          reloj inyectable (ms).
// @param {string[]} [a.invalidableScopes]      inventario inyectable (tests).
// @param {object}   [a.destinationsCatalog]    catálogo inyectable (tests).
// @returns {Promise<{ok:true, result:any, attempts:number, retryUsed:boolean, snapshot:any, events:object[]}>}
// @throws {CredentialRetryError} fallo cerrado; o el error original si no era auth.
// -----------------------------------------------------------------------------
async function runWithCredentialRetry(a = {}) {
    const {
        operation, execute, createSnapshot,
        provider, path, destination, scope,
        invalidate, classify, emit, now,
        invalidableScopes, destinationsCatalog,
    } = a;

    if (!isOperation(operation)) {
        throw new CredentialRetryError(
            '[credential-retry] `operation` invalida o ausente. '
            + 'Impacto: la operacion se aborta ANTES de cualquier intento — sin el estado raiz el '
            + 'presupuesto no se comparte y cada fallback se ganaria un retry propio (fail-closed). '
            + 'Proximo paso: crear el estado una sola vez con createOperation({operationId}) en la '
            + 'operacion raiz y propagarlo a cada intento.',
            { code: RETRY_ERROR_CODES.OPERATION_INVALID },
        );
    }
    if (typeof execute !== 'function') {
        throw new CredentialRetryError(
            '[credential-retry] `execute` tiene que ser una funcion. '
            + 'Impacto: no hay nada que ejecutar; la operacion se aborta sin tocar credenciales. '
            + 'Proximo paso: pasar la funcion que lanza el intento y devuelve su veredicto.',
            { code: RETRY_ERROR_CODES.EXECUTE_REQUIRED, operationId: operation.operationId, provider, path },
        );
    }
    if (typeof createSnapshot !== 'function') {
        throw new CredentialRetryError(
            '[credential-retry] `createSnapshot` tiene que ser una funcion. '
            + 'Impacto: sin re-resolucion el retry reintentaria con la MISMA credencial que el '
            + 'provider acaba de rechazar, que es un bucle garantizado (fail-closed). '
            + 'Proximo paso: pasar el creador de snapshot por intento (createAttemptSnapshot de #5799).',
            { code: RETRY_ERROR_CODES.SNAPSHOT_REQUIRED, operationId: operation.operationId, provider, path },
        );
    }

    const operationId = operation.operationId;
    const scopeEfectivo = resolveScope({
        scope, destination, invalidableScopes, destinationsCatalog, operationId, provider, path,
    });
    const clasificar = typeof classify === 'function' ? classify : defaultClassify;
    const reloj = typeof now === 'function' ? now : Date.now;
    const marca = () => { try { return new Date(reloj()).toISOString(); } catch { return null; } };
    const eventos = [];
    const emitir = (parciales) => {
        const evento = safeEmit(emit, buildEvent({
            operationId, provider, path, destination, scope: scopeEfectivo, ts: marca(), ...parciales,
        }));
        eventos.push(evento);
        return evento;
    };

    // ---- Intento 1 -----------------------------------------------------------
    // El snapshot inicial NO es una re-resolución: si falla, falla el intento
    // (el fail-closed pre-spawn de #5799) y este coordinador no interviene —
    // no hay rechazo de credencial que responder, así que no se invalida nada
    // ni se consume el presupuesto.
    const snapshot1 = await createSnapshot({
        attempt: 1, provider, scope: scopeEfectivo, destination, operationId,
    });

    let resultado1 = null;
    let error1 = null;
    try {
        resultado1 = await execute({ snapshot: snapshot1, attempt: 1, provider, path, operationId });
    } catch (e) {
        error1 = e;
    }

    const rechazo1 = clasificar(error1 || resultado1, { attempt: 1, provider, path, operationId });

    if (!rechazo1) {
        // CA-4 — cualquier otra clase de error sale TAL CUAL: sin invalidar,
        // sin consumir el retry y sin un solo evento de credencial. Un timeout
        // o un 5xx que gastara el presupuesto dejaría a la operación sin
        // defensa contra el rechazo real que viniera después.
        if (error1) throw error1;
        return {
            ok: true, result: resultado1, attempts: 1, retryUsed: false,
            snapshot: snapshot1, events: eventos,
        };
    }

    // ---- Presupuesto ---------------------------------------------------------
    // Sección crítica síncrona. Si otro camino de la MISMA operación ya se llevó
    // el retry (otro provider de la cadena, o un intento concurrente), acá se
    // cierra sin invalidar de nuevo: un fallback no reinicia el presupuesto ni
    // oculta el segundo rechazo.
    if (!consumeRetry(operation)) {
        emitir({
            event: RETRY_EVENTS.RETRY_CLOSED, attempt: 1,
            reason: CLOSE_REASONS.BUDGET_EXHAUSTED, rejection: rechazo1,
        });
        throw new CredentialRetryError(
            '[credential-retry] rechazo de credencial con el presupuesto de la operacion ya consumido. '
            + 'Impacto: se falla CERRADO sin invalidar ni reintentar — el unico retry de esta operacion '
            + 'ya se uso (posiblemente en otro provider de la cadena de fallbacks). '
            + 'Proximo paso: revisar la credencial del provider en el vault; el pipeline no vuelve a '
            + 'intentar solo dentro de esta operacion.',
            {
                code: RETRY_ERROR_CODES.CLOSED, operationId, provider, path,
                scope: scopeEfectivo, attempt: 1, reason: CLOSE_REASONS.BUDGET_EXHAUSTED,
            },
        );
    }

    // ---- Invalidación acotada (exactamente una) ------------------------------
    const invalidar = typeof invalidate === 'function'
        ? invalidate
        : (s) => credentialsModule().resetVaultCache(s);

    let invalidadas = null;
    try {
        const res = await invalidar(scopeEfectivo);
        operation.invalidations += 1;
        invalidadas = (res && Number.isInteger(res.invalidadas)) ? res.invalidadas : null;
    } catch (e) {
        emitir({
            event: RETRY_EVENTS.RETRY_CLOSED, attempt: 1,
            reason: CLOSE_REASONS.INVALIDATION_FAILED, rejection: rechazo1,
        });
        throw new CredentialRetryError(
            `[credential-retry] la invalidacion acotada del scope "${normalizeToken(scopeEfectivo)}" fallo `
            + `(${normalizeToken(e && e.code) || 'sin codigo'}). `
            + 'Impacto: se falla CERRADO — no se puede garantizar que el material rechazado salio de la '
            + 'cache, y reintentar con el mismo material seria repetir el rechazo. '
            + 'Proximo paso: revisar el contrato de invalidacion (resetVaultCache) y el scope declarado.',
            {
                code: RETRY_ERROR_CODES.INVALIDATION_FAILED, operationId, provider, path,
                scope: scopeEfectivo, attempt: 1, reason: CLOSE_REASONS.INVALIDATION_FAILED,
            },
        );
    }
    emitir({
        event: RETRY_EVENTS.INVALIDATED, attempt: 1,
        invalidatedEntries: invalidadas, rejection: rechazo1,
    });

    // ---- Re-resolución (exactamente una) -------------------------------------
    let snapshot2;
    try {
        snapshot2 = await createSnapshot({
            attempt: 2, provider, scope: scopeEfectivo, destination, operationId,
        });
        operation.reresolutions += 1;
    } catch (e) {
        emitir({
            event: RETRY_EVENTS.RETRY_CLOSED, attempt: 2,
            reason: CLOSE_REASONS.RERESOLUTION_FAILED, rejection: rechazo1,
        });
        throw new CredentialRetryError(
            `[credential-retry] la re-resolucion del snapshot fallo (${normalizeToken(e && e.code) || 'sin codigo'}). `
            + 'Impacto: se falla CERRADO — reintentar con el snapshot viejo seria reintentar con la '
            + 'credencial que el provider acaba de rechazar. '
            + 'Proximo paso: revisar el estado del vault y la credencial del provider.',
            {
                code: RETRY_ERROR_CODES.RERESOLUTION_FAILED, operationId, provider, path,
                scope: scopeEfectivo, attempt: 2, reason: CLOSE_REASONS.RERESOLUTION_FAILED,
            },
        );
    }
    emitir({
        event: RETRY_EVENTS.RERESOLVED, attempt: 2, rejection: rechazo1,
        // Del snapshot sale un NÚMERO y nada más. Ni claves, ni env, ni tamaño
        // de los valores: la cardinalidad no dice nada de un secreto.
        snapshotKeys: (snapshot2 && Array.isArray(snapshot2.keys)) ? snapshot2.keys.length : null,
    });

    // ---- Intento 2 — el único reintento --------------------------------------
    let resultado2 = null;
    let error2 = null;
    try {
        resultado2 = await execute({ snapshot: snapshot2, attempt: 2, provider, path, operationId });
    } catch (e) {
        error2 = e;
    }

    const rechazo2 = clasificar(error2 || resultado2, { attempt: 2, provider, path, operationId });

    if (rechazo2) {
        // Fallo CERRADO. No hay tercer intento, no hay segunda invalidación y no
        // se devuelve un resultado que aparente éxito.
        emitir({
            event: RETRY_EVENTS.RETRY_CLOSED, attempt: 2,
            reason: CLOSE_REASONS.SECOND_REJECTION, rejection: rechazo2,
        });
        throw new CredentialRetryError(
            '[credential-retry] segundo rechazo de credencial tras invalidar y re-resolver. '
            + 'Impacto: se falla CERRADO — la credencial re-resuelta tambien fue rechazada, asi que '
            + 'reintentar de nuevo solo reproduciria el rechazo (sin tercer intento, sin bucle). '
            + 'Proximo paso: rotar o corregir la credencial del provider en el vault.',
            {
                code: RETRY_ERROR_CODES.CLOSED, operationId, provider, path,
                scope: scopeEfectivo, attempt: 2, reason: CLOSE_REASONS.SECOND_REJECTION,
            },
        );
    }

    if (error2) throw error2;
    return {
        ok: true, result: resultado2, attempts: 2, retryUsed: true,
        snapshot: snapshot2, events: eventos,
    };
}

module.exports = {
    RETRY_EVENTS,
    CLOSE_REASONS,
    RETRY_ERROR_CODES,
    RETRY_BUDGET,
    EVENT_FIELDS,
    CredentialRetryError,

    createOperation,
    isOperation,
    consumeRetry,
    scopeForDestination,
    runWithCredentialRetry,

    // Expuestos para tests y para un caller que quiera clasificar/auditar con
    // exactamente el mismo criterio que el coordinador.
    defaultClassify,
    buildEvent,
    _resolveScope: resolveScope,
    _normalizeToken: normalizeToken,
    _normalizeCount: normalizeCount,
};
