// =============================================================================
// agent-launcher/auth-rejection.js — Contrato compartido de la clasificación
// cerrada `authentication_rejected` (issue #5795, hija de #5792).
//
// QUÉ ES
// ------
// Una señal TIPADA que significa exactamente una cosa: **el provider rechazó
// la credencial presentada porque es inválida o expiró**. Nada más.
//
// NO es cuota. NO es billing. NO es autorización/permisos (el token es válido
// pero no alcanza para el recurso). NO es un 403 genérico. NO es un timeout,
// un 5xx, una config faltante ni una credencial ausente. Cada una de esas
// clases ya tiene su camino en `provider-error-parser.js` y ahí se queda.
//
// POR QUÉ UNA CLASE APARTE DE `auth`
// ----------------------------------
// El `errorClass: 'auth'` que ya existe nace de regex sobre texto libre
// (`CLI_AUTH_PATTERNS`): "Unauthorized", "401", "auth failed". Sirve para
// decidir fallback grueso, pero es demasiado ruidoso para colgarle una
// política de invalidación de credencial: un 403 de permisos o un mensaje del
// modelo que menciona "Unauthorized" lo disparan igual.
//
// `authentication_rejected` es lo opuesto: sólo nace de **combinaciones
// estructuradas documentadas por provider** (código/status/tipo dentro de un
// frame JSON o SSE). Si no hay señal inequívoca, no hay clasificación. La
// clase `auth` queda intacta y compatible: este módulo no la toca.
//
// QUIÉN DECIDE QUÉ
// ----------------
//   * Los adapters (`providers/*.js`) DETECTAN con tablas cerradas propias.
//   * El parser (`provider-error-parser.js`) SELECCIONA el adapter por
//     `ctx.provider` y TRANSPORTA la señal (`retriable:false`,
//     `shouldFallback:false`).
//   * El dispatcher (`dispatch-with-fallback.js`) PROYECTA y CONGELA el
//     rechazo con el contexto raíz de la operación.
//   * Ninguno de los tres decide retry, invalidación ni presupuesto: eso es
//     del coordinador de #5794, único dueño del presupuesto de re-resolución.
//
// SEGURIDAD — POR QUÉ ESTA SEÑAL NO PUEDE FILTRAR SECRETOS
// --------------------------------------------------------
// La garantía no es "sanitizamos el mensaje": es que **nunca copiamos texto
// del provider**. `code` y `type` sólo pueden tomar valores que ya viven como
// constantes en la tabla cerrada del adapter — para emitirlos hubo que
// matchear por igualdad contra esa tabla, así que el string devuelto es
// nuestro, no del payload. `status` es un entero HTTP acotado. No hay campo
// donde un mensaje, header, token, payload, stdout o stderr pueda viajar.
// `makeSignal` rechaza (devuelve null) cualquier valor fuera de esos límites,
// así que un adapter mal escrito falla cerrado en vez de filtrar.
// =============================================================================
'use strict';

// Nombre canónico de la clase. Se exporta como constante para que ningún
// call-site lo escriba a mano y se desincronice por un typo.
const AUTH_REJECTED_CLASS = 'authentication_rejected';

// De dónde salió el frame que disparó la clasificación. Cerrado a propósito:
// documenta el canal de control y deja afuera cualquier origen de texto libre.
const SIGNAL_SOURCES = Object.freeze(new Set([
    'cli-stream-json', // frame JSON del stream del CLI (una línea = un evento)
    'api-json',        // body JSON completo de una respuesta de API directa
    'api-sse',         // frame `data: {...}` de un stream SSE
]));

// Cotas duras del token. Los códigos/tipos documentados por los providers son
// identificadores cortos en snake_case o SCREAMING_SNAKE_CASE
// (`authentication_error`, `invalid_api_key`, `API_KEY_INVALID`). Un secreto
// real no cabe en este molde, y aunque cupiera nunca llegaría acá: el valor
// emitido sale de la tabla cerrada del adapter, no del payload.
const MAX_TOKEN_CHARS = 64;
const TOKEN_CHARSET = /^[A-Za-z0-9_.-]{1,64}$/;

// Rango HTTP válido. Fuera de esto el status se descarta (queda `null`).
const MIN_HTTP_STATUS = 100;
const MAX_HTTP_STATUS = 599;

// -----------------------------------------------------------------------------
// normalizeToken — devuelve el string si respeta charset y cota, o null.
//
// Deliberadamente NO recorta ni sanea: un valor que no calza se descarta
// entero. Recortar convertiría un valor inesperado en uno que parece válido, y
// eso es justo lo que esta clase no puede permitirse.
// -----------------------------------------------------------------------------
function normalizeToken(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_TOKEN_CHARS) return null;
    if (!TOKEN_CHARSET.test(trimmed)) return null;
    return trimmed;
}

// -----------------------------------------------------------------------------
// normalizeStatus — entero HTTP dentro de rango, o null.
//
// Acepta number o string numérico (los providers alternan entre
// `"status": 401` y `"code": "401"` según el shape).
// -----------------------------------------------------------------------------
function normalizeStatus(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isInteger(n)) return null;
    if (n < MIN_HTTP_STATUS || n > MAX_HTTP_STATUS) return null;
    return n;
}

// -----------------------------------------------------------------------------
// makeSignal — construye la señal tipada, allowlisted y congelada.
//
//   makeSignal({ source, code, status, type }) → Frozen{source, code, status, type} | null
//
// Contrato:
//   * `source` es obligatorio y tiene que estar en SIGNAL_SOURCES.
//   * `code` y `type` son opcionales; si vienen, tienen que pasar
//     `normalizeToken`, si no se descartan a `null`.
//   * `status` es opcional; si viene, tiene que ser un HTTP válido.
//   * Al menos uno de `code`/`type`/`status` tiene que sobrevivir. Una señal
//     sin ninguna evidencia estructural no es una señal.
//   * El objeto devuelto está congelado. El llamador no puede mutarlo ni
//     agregarle campos con datos del provider.
//
// Devuelve `null` (no tira) ante cualquier input inválido: los llamadores
// viven en el path de `child.on('exit')` y no pueden romperse.
// -----------------------------------------------------------------------------
function makeSignal({ source, code, status, type } = {}) {
    if (typeof source !== 'string' || !SIGNAL_SOURCES.has(source)) return null;

    const safeCode = normalizeToken(code);
    const safeType = normalizeToken(type);
    const safeStatus = normalizeStatus(status);

    if (safeCode === null && safeType === null && safeStatus === null) return null;

    return Object.freeze({
        source,
        code: safeCode,
        status: safeStatus,
        type: safeType,
    });
}

// -----------------------------------------------------------------------------
// makeRejection — el shape que devuelve `detectAuthenticationRejected` de cada
// adapter. Congelado, con la señal adentro (también congelada).
//
// Se mantiene mínimo a propósito: `kind` + `signal`. El provider emisor, el
// `operationId`, el `path` y el `attempt` los agrega el dispatcher, que es
// quien conoce el contexto de la operación raíz. El adapter sólo sabe de
// frames.
// -----------------------------------------------------------------------------
function makeRejection(signal) {
    if (!signal || typeof signal !== 'object') return null;
    return Object.freeze({
        kind: AUTH_REJECTED_CLASS,
        signal,
    });
}

// -----------------------------------------------------------------------------
// canonicalProvider — normaliza los alias conocidos a la identidad del adapter.
//
// `agent-models.json` usa `anthropic-claude` como alias de `anthropic` en las
// cadenas de fallback. Cualquier otro valor se devuelve tal cual (en
// minúsculas) para que el chequeo de aislamiento cross-provider del adapter
// falle cerrado ante un provider desconocido.
// -----------------------------------------------------------------------------
const PROVIDER_ALIASES = Object.freeze({
    'anthropic-claude': 'anthropic',
});

function canonicalProvider(provider) {
    if (typeof provider !== 'string') return '';
    const lower = provider.trim().toLowerCase();
    if (!lower) return '';
    return PROVIDER_ALIASES[lower] || lower;
}

// -----------------------------------------------------------------------------
// ownsContext — guardia de aislamiento cross-provider que usa cada adapter.
//
// Una señal válida para el provider X NO puede clasificar cuando el spawn fue
// del provider Y. `invalid_api_key` significa credencial inválida en OpenAI,
// pero no existe como tipo documentado en Anthropic: si el log de un spawn
// Anthropic trae ese token (por un tool_result, por un frame ajeno embebido o
// por inyección), el adapter de Anthropic tiene que devolver "sin
// clasificación".
//
// El provider es input AUTORITATIVO del caller (SR-5): no se infiere del
// contenido. Sin `ctx.provider` explícito → falla cerrado.
// -----------------------------------------------------------------------------
function ownsContext(context, adapterName) {
    if (!context || typeof context !== 'object') return false;
    const p = canonicalProvider(context.provider);
    if (!p) return false;
    return p === canonicalProvider(adapterName);
}

// -----------------------------------------------------------------------------
// isPlainFrame — el detector sólo acepta objetos ya parseados.
//
// Nunca un string: si el adapter recibiera texto crudo estaría a un regex de
// distancia de reintroducir el matching de texto libre que esta clase existe
// para evitar. Los arrays también quedan afuera (ningún provider documenta un
// error como array top-level).
// -----------------------------------------------------------------------------
function isPlainFrame(frame) {
    return !!frame && typeof frame === 'object' && !Array.isArray(frame);
}

// -----------------------------------------------------------------------------
// extractErrorObject — ubica el objeto de error dentro de los shapes que los
// CLIs y las APIs usan hoy.
//
// Cubre, en orden:
//   { error: {...} }                       API directa / CLI genérico
//   { error: { error: {...} } }            runners que envuelven la respuesta
//   { data: { error: {...} } }             frames SSE envueltos
//   { item: { type:'error', error:{...} } } codex exec
//   el frame mismo                         cuando trae `type`/`code` arriba
//
// Devuelve `null` si no hay ningún objeto candidato. Nunca lee `message`,
// `content`, `result` ni ningún campo de texto libre.
// -----------------------------------------------------------------------------
function extractErrorObject(frame) {
    if (!isPlainFrame(frame)) return null;

    const err = frame.error;
    if (isPlainFrame(err)) {
        if (isPlainFrame(err.error)) return err.error;
        return err;
    }
    if (isPlainFrame(frame.data) && isPlainFrame(frame.data.error)) {
        return frame.data.error;
    }
    if (isPlainFrame(frame.item) && frame.item.type === 'error' && isPlainFrame(frame.item.error)) {
        return frame.item.error;
    }
    return null;
}

// -----------------------------------------------------------------------------
// structuredTokens — candidatos estructurales de un objeto de error.
//
// SÓLO campos dedicados a clasificar el error: `type`, `code`, `reason`,
// `status` (cuando es string enum como el `UNAUTHENTICATED` de Google) y
// `details[].reason` (shape de google.rpc.ErrorInfo).
//
// PROHIBIDO agregar `message`, `error_description`, `detail` o cualquier campo
// de prosa: son texto libre controlado por el provider y traerlos acá volvería
// a abrir el matching ambiguo que esta clase cierra.
//
// Devuelve un Set de strings normalizados a minúsculas para comparar contra
// tablas cerradas sin depender del casing del provider.
// -----------------------------------------------------------------------------
function structuredTokens(errObj) {
    const out = new Set();
    if (!isPlainFrame(errObj)) return out;

    const push = (v) => {
        if (typeof v === 'string' && v.trim()) out.add(v.trim().toLowerCase());
    };

    push(errObj.type);
    push(errObj.code);
    push(errObj.reason);
    if (typeof errObj.status === 'string') push(errObj.status);

    if (Array.isArray(errObj.details)) {
        // Cota defensiva: un payload hostil podría mandar miles de details.
        const capped = errObj.details.slice(0, 32);
        for (const d of capped) {
            // `d.reason` es el campo de google.rpc.ErrorInfo. No filtramos por
            // `@type`: un `reason` sólo clasifica si además matchea la tabla
            // cerrada del adapter, así que el discriminante de tipo no agrega
            // seguridad y sí agregaría un modo de falla silencioso si Google
            // cambia la URL del `@type`.
            if (isPlainFrame(d)) push(d.reason);
        }
    }
    return out;
}

// -----------------------------------------------------------------------------
// httpStatusOf — extrae el status HTTP numérico del error o del frame.
//
// Google manda `error.code: 401` (numérico) mientras que Anthropic/OpenAI
// mandan `error.status` o el status va fuera del objeto de error. Probamos los
// lugares documentados y devolvemos `null` si ninguno da un HTTP válido.
// -----------------------------------------------------------------------------
function httpStatusOf(errObj, frame) {
    const candidates = [];
    if (isPlainFrame(errObj)) {
        candidates.push(errObj.status);
        candidates.push(errObj.code);
        candidates.push(errObj.status_code);
    }
    if (isPlainFrame(frame)) {
        candidates.push(frame.status);
        candidates.push(frame.status_code);
    }
    for (const c of candidates) {
        // Un `status` string tipo 'UNAUTHENTICATED' no es número: normalizeStatus
        // lo descarta solo y seguimos con el siguiente candidato.
        const n = normalizeStatus(c);
        if (n !== null) return n;
    }
    return null;
}

// -----------------------------------------------------------------------------
// structuredTokenPairs — igual que `structuredTokens` pero conservando de qué
// campo salió cada token, en orden de prioridad.
//
// Lo necesita `makeDetector` para poblar la señal con precisión: si el token
// que disparó la clasificación vino de `code`, viaja como `code`; si vino de
// `type`/`reason`/`status`, viaja como `type`. Sin la procedencia habría que
// duplicar el mismo string en los dos campos y la señal perdería significado.
// -----------------------------------------------------------------------------
function structuredTokenPairs(errObj) {
    const out = [];
    if (!isPlainFrame(errObj)) return out;

    const push = (field, v) => {
        if (typeof v === 'string' && v.trim()) out.push({ field, value: v.trim().toLowerCase() });
    };

    push('type', errObj.type);
    push('code', errObj.code);
    push('reason', errObj.reason);
    if (typeof errObj.status === 'string') push('status', errObj.status);

    if (Array.isArray(errObj.details)) {
        for (const d of errObj.details.slice(0, 32)) {
            if (isPlainFrame(d)) push('reason', d.reason);
        }
    }
    return out;
}

// -----------------------------------------------------------------------------
// resolveSource — canal del frame que se está clasificando.
//
// El parser lo pasa explícito (sabe si leyó una línea de stream-json, un frame
// `data:` de SSE o un body JSON entero). Si no viene, lo derivamos del
// `transport`, que es input autoritativo del caller (SR-5). Sin ninguno de los
// dos → `null`, y `makeSignal` termina rechazando la señal (fail-closed).
// -----------------------------------------------------------------------------
function resolveSource(context) {
    const explicit = context && typeof context.source === 'string' ? context.source : '';
    if (SIGNAL_SOURCES.has(explicit)) return explicit;
    const transport = context && typeof context.transport === 'string'
        ? context.transport.trim().toLowerCase()
        : '';
    if (transport === 'cli') return 'cli-stream-json';
    if (transport === 'api') return 'api-json';
    return null;
}

// -----------------------------------------------------------------------------
// makeDetector — fábrica del `detectAuthenticationRejected` de cada adapter.
//
//   makeDetector({ adapter, positives, negatives })
//     → (frame, context) => Frozen{kind, signal} | null
//
// Cada adapter aporta SÓLO sus dos tablas cerradas; el algoritmo es común para
// que no haya siete variantes sutilmente distintas de la misma decisión.
//
// ALGORITMO
//   1. Aislamiento cross-provider: si `context.provider` no es este adapter,
//      no hay clasificación. Sin `provider` explícito tampoco (fail-closed).
//   2. El frame tiene que ser un objeto ya parseado con un objeto de error
//      adentro. Nunca texto.
//   3. Se extraen los tokens ESTRUCTURALES (type/code/reason/status enum).
//      Nunca `message` ni ningún campo de prosa.
//   4. GUARDIA DE AMBIGÜEDAD: si aparece cualquier token de la tabla negativa,
//      no hay clasificación — aunque también hubiera uno positivo. Evidencia
//      contradictoria es evidencia insuficiente para invalidar una credencial.
//   5. Recién ahí, el primer token que matchea la tabla positiva clasifica.
//
// El `status` HTTP viaja como CONTEXTO de la señal, nunca como disparador: un
// 401 o un 403 sin token documentado NO produce `authentication_rejected`.
// Eso es exactamente lo que separa esta clase del `auth` genérico.
// -----------------------------------------------------------------------------
function makeDetector({ adapter, positives = [], negatives = [] } = {}) {
    const adapterName = canonicalProvider(adapter);
    const POSITIVE = Object.freeze(new Set(positives.map((t) => String(t).toLowerCase())));
    const NEGATIVE = Object.freeze(new Set(negatives.map((t) => String(t).toLowerCase())));

    function detectAuthenticationRejected(frame, context) {
        try {
            if (!adapterName) return null;
            if (!ownsContext(context, adapterName)) return null;
            if (!isPlainFrame(frame)) return null;

            const errObj = extractErrorObject(frame);
            if (!errObj) return null;

            const pairs = structuredTokenPairs(errObj);
            if (pairs.length === 0) return null;

            // Paso 4 — guardia de ambigüedad (antes que el match positivo).
            for (const { value } of pairs) {
                if (NEGATIVE.has(value)) return null;
            }

            // Paso 5 — primer token positivo, respetando la prioridad de campos.
            const hit = pairs.find(({ value }) => POSITIVE.has(value));
            if (!hit) return null;

            const signal = makeSignal({
                source: resolveSource(context),
                // El token viaja en el campo del que salió. Es un valor de
                // NUESTRA tabla (matcheó por igualdad), no del payload.
                code: hit.field === 'code' ? hit.value : null,
                type: hit.field === 'code' ? null : hit.value,
                status: httpStatusOf(errObj, frame),
            });
            if (!signal) return null;

            return makeRejection(signal);
        } catch {
            // Vive en el path de `child.on('exit')`: falla cerrado, nunca tira.
            return null;
        }
    }

    // Las tablas quedan colgadas del detector para que los tests puedan
    // afirmar sobre ellas sin re-declararlas (y así no se desincronizan).
    detectAuthenticationRejected.adapter = adapterName;
    detectAuthenticationRejected.POSITIVE_TOKENS = POSITIVE;
    detectAuthenticationRejected.NEGATIVE_TOKENS = NEGATIVE;
    return detectAuthenticationRejected;
}

// -----------------------------------------------------------------------------
// NEVER_CLASSIFIES — detector explícito para adapters que, por contrato, jamás
// clasifican autenticación (hoy `deterministic`: corre scripts locales, no
// tiene credencial de provider que pueda ser rechazada).
//
// Existe como función nombrada en vez de "no exportar nada" para que el
// contrato sea uniforme: el parser puede llamar al detector de cualquier
// adapter sin chequear si existe, y un adapter nuevo que se olvide de declarar
// su tabla no hereda por accidente la de otro.
// -----------------------------------------------------------------------------
function neverClassifies() {
    return null;
}

module.exports = {
    AUTH_REJECTED_CLASS,
    SIGNAL_SOURCES,
    MAX_TOKEN_CHARS,
    MIN_HTTP_STATUS,
    MAX_HTTP_STATUS,

    makeSignal,
    makeRejection,
    canonicalProvider,
    ownsContext,
    isPlainFrame,
    extractErrorObject,
    structuredTokens,
    structuredTokenPairs,
    httpStatusOf,
    resolveSource,
    makeDetector,
    neverClassifies,

    // Internos expuestos para tests.
    _normalizeToken: normalizeToken,
    _normalizeStatus: normalizeStatus,
    _PROVIDER_ALIASES: PROVIDER_ALIASES,
};
