'use strict';

// =============================================================================
// kernel-degradation-alert.js — Sink fail-loud de la degradación del store
// durable a filesystem (#5135 · split de #5125 · Ola 9.4 · E2).
//
// PROBLEMA QUE CIERRA
// -------------------
// La degradación del catálogo durable (DynamoDB) a filesystem era SILENCIOSA en
// los dos caminos que existen:
//   1. `product-catalog.listProductsResolved` → `logDegraded` con un
//      `try { onDegraded() } catch {}` que se traga hasta un sink que lanza.
//   2. `pulpo.js` → `kernelSupervisor.bootKernelDurable` → best-effort: un
//      `WARN [kernel-durable]` y el pulpo sigue desde FS.
// Resultado: la verificación de paridad del cutover podía dar VERDE comparando
// filesystem contra filesystem mientras el write path escribía a DynamoDB —
// dos fuentes de verdad activas sin que el operador se entere (falso verde).
//
// QUÉ HACE ESTE MÓDULO
// --------------------
// Es el BORDE DE SALIDA (D-2 · CA-3): acá vive el mapeo a enum cerrado, el
// template fijo y el rate-limit. NO vive en `kernel-supervisor.js` —
// `bootKernelDurable` sigue devolviendo el detalle CRUDO en `res.error`, que es
// lo que assertea `kernel-supervisor.test.js:1028` (#4822) y debe seguir verde.
//
// Módulo PURO: sin I/O propio. `sendTelegram`, `log`, `halt`, `redact`, `now` y
// `generateCorrelationId` se inyectan. Existe aparte de `pulpo.js` porque ese
// archivo tiene >19.000 líneas y no es requerible desde un test sin arrancar el
// pulpo; CA-5 exige assertear las 4 piezas del mensaje UNA POR UNA.
//
// INVARIANTES (no relajar sin releer los CA)
// ------------------------------------------
//  - CA-4 · Enum CERRADO de 7 causas por ALLOW-LIST. Un error no reconocido cae
//    en `desconocido`, NUNCA en "pego lo que vino". CERO bytes originados en el
//    driver AWS salen al canal: la causa entra al template sólo como TOKEN.
//  - CA-5/D-4 · DOS templates, no uno. Dentro de la ventana el pipeline queda
//    PAUSADO; fuera SIGUE despachando sobre FS. Un solo mensaje mentiría en uno
//    de los dos casos.
//  - CA-10/SEC-13 · El rate-limit gatea EXCLUSIVAMENTE el `sendTelegram`. Nunca
//    la clasificación, nunca el log local, nunca el abort. Gatear el abort sería
//    fail-open por throttling: un driver flapeando dejaría de abortar el
//    encendido, que es justo la invariante que este módulo existe para garantizar.
//  - CA-20/SEC-15 · El abort deja auditoría PROPIA aunque no logre escribir el
//    marker de pausa (ya había una pausa de otro origen). Sin eso, el operador
//    levanta la pausa que ve y el cutover abortado desaparece del registro.
//  - R1 · El abort es una LLAMADA EXPLÍCITA (halt + `.paused`), nunca un `throw`
//    ni un `process.exit`. El bloque que invoca este sink en `pulpo.js` está
//    envuelto en un `try/catch` que se tragaría la excepción, y matar el proceso
//    viola "el pipeline no puede morir".
//  - UX-6 · El dialecto Markdown se DECLARA (`PARSE_MODE`) y se verifica por
//    test (paridad de `*` y de backticks, largo ≤ 4000). Un 400 de Telegram por
//    parseo NO se recupera con reintentos: `servicio-telegram.js` agota el
//    contador y manda el saliente a `fallido/` — la alerta muere en silencio,
//    que es exactamente el modo de falla que esta historia cierra.
//  - R6 · El rate-limit es EN MEMORIA y se pierde en un restart. Aceptable: la
//    ventana de cutover es supervisada y dura minutos. El dedupe persistente del
//    canal es #5128, fuera de alcance.
//
// Tests: lib/__tests__/durable-cutover.test.js (CA-2/4/5/6/8/9/10/20 + UX-6).
// =============================================================================

// -----------------------------------------------------------------------------
// CA-4 · Enum cerrado (allow-list). El orden de `classifyDegradation` importa:
// `config_incompleta` se evalúa PRIMERO porque su mensaje es código nuestro
// (`kernel-store.js` normalizeConfig) y no debe caer en los patrones del driver.
// -----------------------------------------------------------------------------
const CAUSES = Object.freeze([
    'access_denied',
    'credenciales_ausentes',
    'driver_ausente',
    'throttling',
    'red',
    'config_incompleta',
    'desconocido',
]);

// UX-8 · El TOKEN del enum no se traduce (es la clave estable de la que dependen
// tests, greps y el rate-limit de CA-10), pero el mensaje lo acompaña con una
// glosa fija en español. Las 7 glosas son strings FIJOS: no interpolan nada del
// driver, así que no abren superficie para CA-4/CA-8.
const CAUSA_GLOSA = Object.freeze({
    access_denied: 'el rol no tiene permiso sobre la tabla',
    credenciales_ausentes: 'no hay credenciales AWS configuradas',
    driver_ausente: 'el driver de DynamoDB no está disponible',
    throttling: 'DynamoDB está limitando la tasa de pedidos',
    red: 'no hubo respuesta de red al consultar la tabla',
    config_incompleta: 'falta completar la configuración del store durable',
    desconocido: 'el store durable falló por un motivo no clasificado',
});

// UX-6 · Dialecto declarado. `sendTelegram` usa legacy `Markdown` por default
// (`pulpo.js`); los templates de acá están escritos PARA ese dialecto (sólo
// `*negrita*` y `` `code` ``, sin escapes V2). El caller lo pasa explícito para
// que un cambio de default no rompa el render en silencio.
const PARSE_MODE = 'Markdown';

// CA-10 · Una alerta por causa del enum por ventana. La ventana de cutover es
// supervisada y de minutos, así que 10' equivale en la práctica a "una por causa
// por cutover" sin ahogar un flapeo largo.
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * CA-4 · Mapea el `reason` crudo (stderr del AWS CLI, re-lanzado tal cual como
 * `Error.message` por `provisioner-infra.js`) a una causa del enum cerrado.
 *
 * ALLOW-LIST: sólo se miran patrones CONOCIDOS. Todo lo demás cae en
 * `desconocido`. NINGÚN byte del argumento sale de esta función — el retorno es
 * siempre uno de los 7 tokens de `CAUSES`.
 *
 * @param {*} raw  detalle crudo (string, Error.message, o cualquier cosa).
 * @returns {string} una de las 7 causas de `CAUSES`.
 */
function classifyDegradation(raw) {
    const s = typeof raw === 'string' ? raw : String((raw && raw.message) || raw || '');
    // GURU-8 · PRIMERO: config incompleta. Hoy `main` tiene `tableName: ""` y
    // `region: ""`, así que el fallo MÁS PROBABLE del primer cutover real es este
    // mensaje de `kernel-store.js` (código nuestro, no del driver AWS). Con el
    // enum de 6 causas caía en `desconocido` y le daba al operador la acción
    // equivocada ("volvé durable a false") cuando el arreglo es llenar la config.
    if (/config\.(tableName|coordinationTableName|region) requerido|requerido para el driver real/i.test(s)) {
        return 'config_incompleta';
    }
    if (/AccessDenied|not authorized|UnauthorizedOperation/i.test(s)) return 'access_denied';
    if (/Unable to locate credentials|ExpiredToken|InvalidClientTokenId|credenciales/i.test(s)) {
        return 'credenciales_ausentes';
    }
    if (/no driver|driver AWS no disponible|aws: (command )?not found|ENOENT/i.test(s)) return 'driver_ausente';
    if (/Throttling|ProvisionedThroughputExceeded|TooManyRequests|RequestLimitExceeded/i.test(s)) return 'throttling';
    if (/ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/i.test(s)) return 'red';
    return 'desconocido'; // <- nunca "pego lo que vino"
}

// -----------------------------------------------------------------------------
// CA-5 · Copy de los dos templates. Texto 100% FIJO. La causa entra sólo como
// TOKEN del enum + glosa de tabla; el `correlationId` es el único otro valor
// variable y lo genera el pipeline, no el driver.
//
// Precedencia de la copy aplicada acá (regla del UX en `validacion`):
//   body < PO `criterios` (D-3/D-4) < UX `criterios` (UX-4..UX-8) < consolidación UX.
//   - D-3: el léxico real del repo es `🛑 *Pipeline PAUSADO*` (pulpo.js), no el
//     `🔴 *Pipeline frenado*` del body, que NO existe.
//   - UX-4: (B) abre con ⚠️ — el glifo que el repo usa para "anomalía notificada,
//     el pipeline SIGUE". Con 🔴 (que en el repo significa "algo quedó frenado")
//     (A) y (B) se leerían igual en la lista de chats, borrando la distinción
//     que D-4 acaba de construir.
//   - UX-7: la acción de (A) nombra el MECANISMO concreto de despause
//     (`/reanudar` o borrar `.pipeline/.paused`), no el verbo "despausar".
// -----------------------------------------------------------------------------

const HEADER_ABORTADO = '🛑 *Pipeline PAUSADO* — degradación del store durable';
const HEADER_SIGUE = '⚠️ *Degradación del store durable* — el pipeline sigue por filesystem';

const CONSECUENCIA_ABORTADO = 'el catálogo durable no se pudo leer: los productos registrados en DynamoDB '
    + 'quedaron invisibles y el pipeline hubiera seguido operando sobre el filesystem — se abortó el '
    + 'encendido para no dejar dos fuentes de verdad activas';

const CONSECUENCIA_SIGUE = 'el catálogo durable no se pudo leer: los productos registrados en DynamoDB '
    + 'quedaron invisibles y el pipeline sigue operando sobre el filesystem — hay dos fuentes de verdad activas';

const ACCION_ABORTADO = 'el encendido ya se abortó y el pipeline quedó pausado. Volvé `kernel.durable` a '
    + '`false` en `.pipeline/config.yaml` y mandá /reanudar (o borrá `.pipeline/.paused`), o corregí la '
    + 'causa y reintentá el cutover.';

const ACCION_SIGUE = 'volvé `kernel.durable` a `false` en `.pipeline/config.yaml`, o abrí '
    + '`kernel.cutover_window` para reintentar el encendido de forma supervisada.';

// Excepción por causa (PO · CA-5): con `config_incompleta` la pieza (3) NO puede
// decir "volvé `kernel.durable` a `false`" — al operador sólo le falta llenar dos
// campos de config, y mandarlo a apagar el cutover es la acción equivocada.
const ACCION_CONFIG_ABORTADO = 'el encendido ya se abortó y el pipeline quedó pausado. Para reintentar, '
    + 'completá `kernel.tableName` y `kernel.region` en `.pipeline/config.yaml` y mandá /reanudar '
    + '(o borrá `.pipeline/.paused`).';

const ACCION_CONFIG_SIGUE = 'completá `kernel.tableName` y `kernel.region` en `.pipeline/config.yaml` '
    + 'para poder reintentar el encendido de forma supervisada.';

// CA-20 · Cuando el abort NO pudo escribir su marker porque ya había una pausa de
// otro origen, esa distinción viaja en la alerta: sin esto el operador levanta la
// pausa que ve y el cutover abortado desaparece sin registro.
const NOTA_PAUSA_PREEXISTENTE = 'Ojo: ya había una pausa activa de otro origen, así que no se pisó. '
    + 'No la levantes sin revisar antes este cutover.';

/**
 * CA-5 · Arma el mensaje de operador desde un template FIJO.
 *
 * Las 4 piezas de UX-1, en orden: (1) severidad + léxico del repo,
 * (2) consecuencia en criollo, (3) acción siguiente concreta, (4) el string se
 * emite efectivamente por `sendTelegram` (lo hace `createDegradationSink`).
 *
 * @param {object}  opts
 * @param {string}  opts.cause              causa del enum (fuera del enum ⇒ `desconocido`).
 * @param {string}  [opts.correlationId]    handle que liga alerta ↔ recibo ↔ pulpo.log.
 *                                          R7: `sendTelegram` puede devolver null, así que
 *                                          el template TOLERA la ausencia.
 * @param {number}  [opts.repeats=1]        repeticiones acumuladas desde el último envío (CA-10).
 * @param {boolean} [opts.aborted=false]    true ⇒ template (A); false ⇒ template (B) (D-4).
 * @param {boolean} [opts.pausePreexisting] true ⇒ suma la nota de CA-20.
 * @returns {string} mensaje listo para `sendTelegram` en dialecto `PARSE_MODE`.
 */
function formatDegradationAlert(opts = {}) {
    const cause = CAUSES.includes(opts.cause) ? opts.cause : 'desconocido';
    const aborted = opts.aborted === true;
    const repeats = Number.isFinite(opts.repeats) ? opts.repeats : 1;
    const correlationId = (typeof opts.correlationId === 'string' && opts.correlationId)
        ? opts.correlationId
        : null;

    let accion;
    if (cause === 'config_incompleta') {
        accion = aborted ? ACCION_CONFIG_ABORTADO : ACCION_CONFIG_SIGUE;
    } else {
        accion = aborted ? ACCION_ABORTADO : ACCION_SIGUE;
    }

    return [
        aborted ? HEADER_ABORTADO : HEADER_SIGUE,                       // (1) severidad
        '',
        aborted ? CONSECUENCIA_ABORTADO : CONSECUENCIA_SIGUE,           // (2) consecuencia
        '',
        'Causa: `' + cause + '` — ' + CAUSA_GLOSA[cause],               //     token del enum + glosa (UX-8)
        '',
        'Qué hacer: ' + accion,                                          // (3) acción siguiente
        (aborted && opts.pausePreexisting === true) ? '' : null,
        (aborted && opts.pausePreexisting === true) ? NOTA_PAUSA_PREEXISTENTE : null,
        repeats > 1 ? '' : null,
        repeats > 1 ? '(se repitió ' + repeats + ' veces en esta ventana)' : null,
        correlationId ? '' : null,
        correlationId ? 'id: ' + correlationId : null,
    ].filter((l) => l !== null).join('\n');
}

/**
 * CA-2/CA-6/CA-10/CA-20 · Sink fail-loud de la degradación durable.
 *
 * Orden de operaciones (NO reordenar — cada paso tiene un CA detrás):
 *   1. Clasificar        — SIEMPRE (nunca gateado por el rate-limit · SEC-13).
 *   2. Abortar           — SIEMPRE que la ventana esté abierta (idem).
 *   3. Log local + auditoría — SIEMPRE, redactado (D-5/SEC-10 · CA-6 · CA-20).
 *   4. Telegram          — ÚNICO paso gateado por el rate-limit (CA-10).
 *
 * CA-6 · Asimetría por frontera de confianza: a Telegram va el template
 * normalizado + `correlationId` y NADA del detalle del driver; al log local va el
 * mensaje diagnóstico completo (stage, causa, texto del error) pero pasado por
 * `redact` — porque `pulpo.log` NO es una frontera de confianza: está en
 * `TAIL_ALLOWED_FILES` y sale por Telegram vía `/tail` y `/salud` (SEC-10), y
 * `redact-read.js` tiene tabla propia que no cubre topología AWS (#5142).
 *
 * @param {object}   deps
 * @param {object}   [deps.config]                 config del pipeline; se lee `kernel.cutover_window`.
 * @param {function} [deps.sendTelegram]           (text, opts) => correlationId|null.
 * @param {function} [deps.log]                    (message) => void — escribe a pulpo.log.
 * @param {function} [deps.halt]                   ({cause}) => {markerWritten, preexisting} — abort.
 * @param {function} [deps.redact]                 (str) => str — `redactSecretValue` en producción.
 * @param {function} [deps.now]                    () => ms (inyectable para testear el cooldown).
 * @param {function} [deps.generateCorrelationId]  () => string.
 * @param {number}   [deps.cooldownMs]             ventana del rate-limit por causa.
 * @returns {{onDegraded: function, aborted: boolean, causes: string[], alertsSent: number}}
 */
function createDegradationSink(deps = {}) {
    const cfg = (deps.config && typeof deps.config === 'object') ? deps.config : {};
    const kernel = (cfg.kernel && typeof cfg.kernel === 'object') ? cfg.kernel : {};
    // CA-1 · Fail-closed: sólo el booleano `true` exacto abre la ventana. Ausente,
    // null, 'true' string o cualquier otra cosa ⇒ best-effort actual sin cambios.
    const cutoverWindow = kernel.cutover_window === true;

    const sendTelegram = typeof deps.sendTelegram === 'function' ? deps.sendTelegram : null;
    const log = typeof deps.log === 'function' ? deps.log : null;
    const halt = typeof deps.halt === 'function' ? deps.halt : null;
    const redact = typeof deps.redact === 'function' ? deps.redact : ((s) => s);
    const now = typeof deps.now === 'function' ? deps.now : (() => Date.now());
    const genCid = typeof deps.generateCorrelationId === 'function'
        ? deps.generateCorrelationId
        : (() => require('./telegram-receipt').generateCorrelationId('kdeg'));
    const cooldownMs = Number.isFinite(deps.cooldownMs) ? deps.cooldownMs : DEFAULT_COOLDOWN_MS;

    // R6 · Rate-limit EN MEMORIA (se pierde en restart — aceptable, ver cabecera).
    // Firma = la causa del enum, igual que `partialPauseDepsAlertCache` en pulpo.js.
    const byCause = new Map(); // cause -> { lastSentTs, sinceLastSend }

    const state = { aborted: false, causes: [], alertsSent: 0 };

    function safe(fn, label) {
        try { return fn(); } catch (e) {
            // El sink NUNCA propaga: un fallo del canal no puede tumbar el arranque
            // (R1). Se deja rastro por el log si está disponible.
            if (log) { try { log(`WARN [kernel-cutover] ${label} falló: ${e && e.message ? e.message : e}`); } catch { /* noop */ } }
            return null;
        }
    }

    /**
     * @param {*} rawReason  detalle crudo de la degradación.
     * @param {object} [meta] {stage} — el camino que la originó (default 'boot-durable').
     */
    function onDegraded(rawReason, meta) {
        const stage = (meta && typeof meta.stage === 'string' && meta.stage) ? meta.stage : 'boot-durable';

        // (1) CLASIFICACIÓN — siempre. Nunca gateada por el rate-limit (SEC-13).
        const cause = classifyDegradation(rawReason);
        state.causes.push(cause);

        const entry = byCause.get(cause) || { lastSentTs: null, sinceLastSend: 0 };
        entry.sinceLastSend += 1;
        byCause.set(cause, entry);

        const correlationId = safe(() => genCid(), 'generateCorrelationId');

        // (2) ABORT — siempre que la ventana esté abierta. Nunca gateado por el
        // rate-limit: gatearlo sería fail-open por throttling (SEC-13). El abort
        // es una LLAMADA explícita (halt + `.paused`), nunca throw/exit (R1).
        let haltInfo = null;
        if (cutoverWindow) {
            state.aborted = true;
            if (halt) haltInfo = safe(() => halt({ cause, stage, correlationId }), 'halt');
        }

        // (3) LOG LOCAL + AUDITORÍA — siempre (CA-20), redactado (CA-6/D-5).
        if (log) {
            const detalle = redact(typeof rawReason === 'string'
                ? rawReason
                : String((rawReason && rawReason.message) || rawReason || ''));
            safe(() => log(
                `WARN [kernel-cutover] degradación del store durable (stage ${stage}, causa ${cause}`
                + `${correlationId ? `, id ${correlationId}` : ''}): ${detalle}`,
            ), 'log');
            if (cutoverWindow) {
                const marker = haltInfo && haltInfo.markerWritten
                    ? 'marker `.paused` escrito (source kernel-cutover-degraded-halt)'
                    : (haltInfo && haltInfo.preexisting
                        ? 'ya había una pausa activa de otro origen — NO se pisó'
                        : 'no se pudo escribir el marker de pausa');
                safe(() => log(
                    `WARN [kernel-cutover] encendido durable ABORTADO por la ventana de cutover `
                    + `(causa ${cause}${correlationId ? `, id ${correlationId}` : ''}): ${marker}`,
                ), 'log');
            }
        }

        // (4) TELEGRAM — ÚNICO paso gateado por el rate-limit (CA-10/SEC-13).
        let alerted = false;
        const ts = now();
        const vencido = entry.lastSentTs === null || (ts - entry.lastSentTs) >= cooldownMs;
        if (vencido) {
            const repeats = entry.sinceLastSend;
            entry.lastSentTs = ts;
            entry.sinceLastSend = 0;
            const text = formatDegradationAlert({
                cause,
                correlationId,
                repeats,
                aborted: cutoverWindow,
                pausePreexisting: !!(haltInfo && haltInfo.preexisting),
            });
            if (sendTelegram) safe(() => sendTelegram(text, { parseMode: PARSE_MODE }), 'sendTelegram');
            state.alertsSent += 1;
            alerted = true;
        }

        return { cause, aborted: cutoverWindow, correlationId, alerted, halt: haltInfo };
    }

    const sink = {
        onDegraded,
        // CA-2 · `failLoud` para el camino de `product-catalog.listProductsResolved`:
        // con la ventana abierta el fallback a FS debe CORTARSE, no sólo alertarse
        // (R2: `logDegraded` se traga un sink que lanza, así que "inyectar el sink"
        // por sí solo sería un falso verde).
        failLoud: cutoverWindow,
        cutoverWindow,
    };
    Object.defineProperty(sink, 'aborted', { get: () => state.aborted, enumerable: true });
    Object.defineProperty(sink, 'causes', { get: () => state.causes.slice(), enumerable: true });
    Object.defineProperty(sink, 'alertsSent', { get: () => state.alertsSent, enumerable: true });
    return sink;
}

module.exports = {
    classifyDegradation,
    formatDegradationAlert,
    createDegradationSink,
    CAUSES,
    CAUSA_GLOSA,
    PARSE_MODE,
    DEFAULT_COOLDOWN_MS,
};
