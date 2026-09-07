// =============================================================================
// #6144 — Aviso al operador cuando la cadena multi-provider está caída.
//
// Problema que resuelve (observado en operación real el 19/08): con la cadena
// agotada el Commander respondía una variante fija que no decía POR QUÉ, ni
// CUÁNDO vuelve, ni QUÉ pasa con el pedido — y llegaba SOLO por texto. El
// operador opera por audio; dos mensajes suyos quedaron horas sin respuesta
// percibida.
//
// Este módulo concentra TODA la lógica nueva (copy + guion de voz + cooldown +
// resolución de clips). `multi-provider.js` ya pesa ~98 KB; meterlo ahí mezcla
// responsabilidades y lo vuelve inmanejable.
//
// -----------------------------------------------------------------------------
// FUENTE DE VERDAD DEL COPY
// -----------------------------------------------------------------------------
// El texto NO se escribe acá: vive en `.pipeline/assets/audio/provider-down/
// copy.json`, entregado y ratificado por UX + PO (D1..D8). Este módulo sólo lo
// ESTRUCTURA. Si se edita el copy hay que regenerar los `.ogg` en el mismo
// commit (ver README.md del directorio de assets): un copy desincronizado del
// audio hace que el operador escuche algo distinto de lo que lee, que es
// exactamente el problema que #6144 viene a resolver.
//
// -----------------------------------------------------------------------------
// ANONIMIZACIÓN (REQ-SEC-2 / CA-6 / CA-21)
// -----------------------------------------------------------------------------
// El copy se arma 100 % desde una tabla CERRADA (allowlist, no blocklist).
// NUNCA se interpola `chainTried`, `verdict.text`, `providers[].label`,
// `reasonCode`, stderr, códigos de error, rutas ni porcentajes. De la
// clasificación se leen SÓLO cuatro campos: `degraded`, `stale`,
// `dominantCause` y `providers[].rest`.
//
// En particular NO se consume `verdict.text` (`provider-pause-cause.js`): con
// `stale: true` devuelve "Requiere acción: no hay dato de salud fresco (último
// hace N min). Revisá el chequeo periódico." — diagnóstico interno que viola
// D6/CA-19 y CA-6 (riesgo R2 del architect).
//
// El único dato dinámico que entra al texto es la hora de reanudación, y sólo
// tras validarla contra `HHMM_RE`.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

const {
    CAUSE_REPOSO,
    CAUSE_CUOTA,
    CAUSE_AUTH,
    CAUSE_TRANSITORIA,
} = require('../provider-pause-cause');

const { EVENT, shouldEmitAudio } = require('../audio-policy');

// -----------------------------------------------------------------------------
// Rutas
// -----------------------------------------------------------------------------
// __dirname = .pipeline/lib/commander → '..','..' = .pipeline
const PIPELINE_DIR = path.resolve(__dirname, '..', '..');
const CLIP_DIR = path.join(PIPELINE_DIR, 'assets', 'audio', 'provider-down');
const COPY_PATH = path.join(CLIP_DIR, 'copy.json');
const AUDIO_STATE_PATH = path.join(PIPELINE_DIR, '.provider-down-audio-state.json');

/** Cap de longitud para texto y guion hablado (CA-7 / CA-11). */
const MAX_CHARS = 600;

/** Guarda anti-flapping: mínimo entre dos audios, aunque cambie la causa (D7). */
const MIN_AUDIO_GAP_MS = 15 * 60 * 1000;

/**
 * Techo de una ventana de caída. D7 define que la ventana se cierra cuando
 * vuelve un proveedor o cambia la causa dominante; ninguna de las dos cosas nos
 * llega como señal desde acá. Sin un techo, una caída de tres días con causa
 * estable emitiría UN solo audio en 72 h y el operador se quedaría sin aviso
 * audible después del primero. 6 h es el compromiso: respeta CA-14 dentro de
 * una misma ventana operativa y garantiza que una caída larga vuelva a avisar.
 */
const MAX_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Timeout duro del TTS (CA-12 / REQ-SEC-7, riesgo R8). */
const TTS_TIMEOUT_MS = 15 * 1000;

/** Clave de copy para "no afirmamos causa" (D6 / CA-19). */
const GENERIC_KEY = 'generico';

/**
 * Mapa CERRADO causa-dominante → clave de copy. Es la allowlist: cualquier
 * causa fuera de estas cuatro (incluida `disponible`, `null`, o un valor nuevo
 * que aparezca a futuro en `provider-pause-cause.js`) degrada a genérico.
 */
const CAUSE_TO_KEY = Object.freeze({
    [CAUSE_REPOSO]: 'reposo',
    [CAUSE_CUOTA]: 'cuota',
    [CAUSE_AUTH]: 'auth',
    [CAUSE_TRANSITORIA]: 'transitoria',
});

/**
 * Mapa CERRADO clave-de-copy → nombre de archivo de clip (CA-13 / REQ-SEC-5).
 * Literal a propósito: `path.join(dir, cause + '.ogg')` sería path traversal si
 * `cause` alguna vez viniera de un origen menos confiable.
 */
const CLIPS = Object.freeze({
    reposo: 'reposo.ogg',
    cuota: 'cuota.ogg',
    transitoria: 'transitoria.ogg',
    auth: 'auth.ogg',
    [GENERIC_KEY]: 'generico.ogg',
});

/** Hora válida `H:MM` / `HH:MM` en rango real de reloj. */
const HHMM_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

/** Placeholder del slot de hora en el copy de UX. */
const CLOCK_SLOT = '{HH:MM}';

/**
 * Cola del guion hablado de `reposo` en los clips pregrabados. Los clips NO
 * llevan hora (decisión de UX: una hora grabada sería mentira apenas cambie la
 * ventana), así que remiten al texto. En el guion DINÁMICO — el que se sintetiza
 * en vivo — sí podemos decir la hora, y esta frase es el punto de reemplazo.
 */
const REPOSO_CLIP_TAIL = 'La hora de reanudación está en el mensaje de texto.';

// -----------------------------------------------------------------------------
// Carga del copy
// -----------------------------------------------------------------------------

/**
 * Backstop mínimo si `copy.json` falta o está corrupto.
 *
 * Deliberadamente cubre SÓLO el caso genérico: duplicar acá la tabla de las
 * cuatro causas crearía una segunda fuente de verdad que se desincroniza de la
 * de UX en el primer cambio de copy. Degradar a genérico es el mismo
 * fail-closed de D6 — y el piso irrenunciable se mantiene: el operador se
 * entera, nunca queda mudo.
 */
const MINIMAL_COPY = Object.freeze({
    texto: {
        bloque_sigue: 'El pipeline y los agentes siguen trabajando: las tareas en curso no se frenan. '
            + 'Los comandos /status, /listado y /lanzar responden normalmente.',
        bloque_pedido: 'Tu mensaje no quedó encolado: repetilo cuando vuelva el servicio.',
        causas: {
            [GENERIC_KEY]: {
                titular: '⚠️ Ahora mismo no puedo responderte con IA.',
                recuperacion: 'Se reintenta solo. Todavía no puedo confirmarte el motivo.',
            },
        },
    },
    voz_clip: {
        [GENERIC_KEY]: 'Aviso del sistema. Ahora mismo no puedo responderte con inteligencia artificial '
            + 'y todavía no puedo confirmarte el motivo. El pipeline y los agentes siguen trabajando, '
            + 'y los comandos de estado siguen respondiendo. Tu mensaje no quedó encolado: repetilo '
            + 'cuando vuelva el servicio.',
    },
});

let _copyCache = null;

/**
 * Lee el copy canónico. Cachea en memoria (el archivo es versionado y no cambia
 * en caliente). NUNCA lanza: ante cualquier problema devuelve el backstop.
 *
 * @param {boolean} [reload=false] — fuerza relectura (tests).
 * @returns {object}
 */
function loadCopy(reload = false) {
    if (_copyCache && !reload) return _copyCache;
    try {
        const parsed = JSON.parse(fs.readFileSync(COPY_PATH, 'utf8'));
        const ok = parsed
            && parsed.texto
            && typeof parsed.texto.bloque_sigue === 'string'
            && typeof parsed.texto.bloque_pedido === 'string'
            && parsed.texto.causas
            && parsed.texto.causas[GENERIC_KEY]
            && parsed.voz_clip
            && typeof parsed.voz_clip[GENERIC_KEY] === 'string';
        if (ok) {
            _copyCache = parsed;
            return _copyCache;
        }
    } catch { /* ausente o corrupto → backstop */ }
    _copyCache = MINIMAL_COPY;
    return _copyCache;
}

// -----------------------------------------------------------------------------
// Derivación de causa
// -----------------------------------------------------------------------------

/**
 * Resuelve la clave de copy desde la clasificación de `classifyPauseCause`.
 *
 * Fail-closed (D6 / CA-19 / REQ-SEC-8): sin snapshot (`degraded`), con snapshot
 * viejo (`stale`) o con causa fuera de la allowlist → genérico. Afirmar una
 * causa falsa con autoridad es peor que el genérico; quedarse mudo es peor que
 * ambos.
 *
 * @param {object|null} classification
 * @returns {string} clave de `CLIPS` / `copy.texto.causas`
 */
function resolveCauseKey(classification) {
    if (!classification || typeof classification !== 'object') return GENERIC_KEY;
    if (classification.degraded === true) return GENERIC_KEY;
    if (classification.stale === true) return GENERIC_KEY;
    const key = CAUSE_TO_KEY[classification.dominantCause];
    return key || GENERIC_KEY;
}

/**
 * De los proveedores en reposo, el que despierta primero.
 *
 * Se recomputa desde `providers[].rest` en vez de parsear `verdict.text`: ese
 * texto es formato interno y frágil (riesgo R2).
 *
 * @param {object[]} providers
 * @returns {object|null} el `rest` ganador
 */
function soonestResumeRest(providers) {
    let best = null;
    for (const p of Array.isArray(providers) ? providers : []) {
        if (!p || p.cause !== CAUSE_REPOSO) continue;
        const rest = p.rest;
        if (!rest || typeof rest.atHHMM !== 'string') continue;
        const minutes = Number.isFinite(rest.minutesFromNow) ? rest.minutesFromNow : Infinity;
        if (best === null || minutes < best.minutes) best = { minutes, rest };
    }
    return best ? best.rest : null;
}

/**
 * Formatea la hora para el slot `{HH:MM}` del copy de UX.
 *
 * `formatResumeClock` (`provider-pause-cause.js`) devuelve `hoy 07:00` /
 * `mañana 07:00`, pensado para una línea de diagnóstico. Interpolado en la
 * plantilla de UX daría "Se reanuda a las hoy 07:00." — agramatical. Reordenamos
 * manteniendo el día explícito, que es lo que ese helper protege: a las 23:50,
 * un "~07:00" pelado es ambiguo.
 *
 * Devuelve '' si la hora no supera `HHMM_RE` — validación de forma antes de
 * interpolar cualquier dato que venga de otro módulo (REQ-SEC-2).
 *
 * @param {object|null} rest
 * @returns {string}
 */
function formatClockForCopy(rest) {
    if (!rest || typeof rest.atHHMM !== 'string') return '';
    const hhmm = rest.atHHMM.trim();
    if (!HHMM_RE.test(hhmm)) return '';
    return rest.when === 'tomorrow' ? `${hhmm} de mañana` : hhmm;
}

// -----------------------------------------------------------------------------
// CA-1..CA-7 — texto para Telegram
// -----------------------------------------------------------------------------

/**
 * Arma el aviso de texto.
 *
 * Estructura fija en el orden de CA-1, ratificado por UX:
 *   (a) qué pasó            → titular por causa dominante
 *   (b) qué sigue vivo      → bloque fijo
 *   (c) qué pasó con tu pedido → bloque fijo, sin eufemismos (D3)
 *   (d) cuándo vuelve       → sólo si es estimable (D2)
 *
 * El orden (b) antes de (c) es deliberado: baja la ansiedad del operador antes
 * de darle la mala noticia. No invertir.
 *
 * Sobre `(d)` y la causa `reposo`: es la única causa con recuperación
 * determinística, y por eso la única que lleva hora (CA-3). Si por algún motivo
 * no se puede resolver un reloj válido, se OMITE el bloque (d) en vez de
 * inventar una hora o degradar el titular: CA-1(d) declara (d) condicional
 * ("sólo si es estimable") y D2 prohíbe explícitamente inventar horas. El
 * titular sigue siendo verdadero — la pausa por horario existe igual.
 *
 * @param {object|null} classification — salida de `classifyPauseCause`.
 * @param {object} [opts]
 * @param {boolean} [opts.verifiedAllFailed] — aceptado por compat de firma.
 * @param {string}  [opts.requestId]         — aceptado por compat de firma.
 * @returns {string} texto ≤ 600 chars, sin datos internos.
 */
function buildDownNoticeText(classification, opts = {}) {
    // #4440 distinguía copy "verificado" vs "no verificado" para no afirmar que
    // fallaron TODOS los providers sin comprobarlo. El copy de #6144 ya es
    // honesto en ambas ramas: describe el efecto observable ("no puedo
    // responderte con IA" / la causa dominante), nunca el alcance de la falla,
    // así que no necesita bifurcarse. Los parámetros se conservan porque los 3
    // callers de `pulpo.js` los pasan.
    void opts.verifiedAllFailed;
    // `requestId` servía de semilla para rotar variantes anti-robot. Con el copy
    // canónico de UX como fuente de verdad hay una sola redacción por causa: la
    // variación la aporta ahora la causa, no un hash.
    void opts.requestId;

    const copy = loadCopy();
    const t = copy.texto;
    const key = resolveCauseKey(classification);
    const causa = (t.causas && t.causas[key]) || t.causas[GENERIC_KEY];

    const partes = [causa.titular, t.bloque_sigue, t.bloque_pedido];

    let recuperacion = typeof causa.recuperacion === 'string' ? causa.recuperacion : '';
    if (recuperacion.includes(CLOCK_SLOT)) {
        const clock = formatClockForCopy(
            soonestResumeRest(classification && classification.providers),
        );
        // Sin reloj válido no hay estimación → se omite (d). Ver docblock.
        recuperacion = clock ? recuperacion.split(CLOCK_SLOT).join(clock) : '';
    }
    if (recuperacion) partes.push(recuperacion);

    return partes.join('\n\n').slice(0, MAX_CHARS);
}

// -----------------------------------------------------------------------------
// CA-9 / CA-11 — guion hablado
// -----------------------------------------------------------------------------

/**
 * Arma el guion hablado.
 *
 * Nace de la plantilla fija de `copy.json` (mismo patrón que
 * `buildNeedHumanAudioText`): NUNCA ecoa el mensaje del operador ni ningún
 * fragmento de su entrada (REQ-SEC-3 / CA-11). Encabezado fijo "Aviso del
 * sistema." como earcon verbal — el operador reconoce de qué se trata en el
 * primer segundo, sin escuchar los 20 restantes.
 *
 * Sin `/`, sin markdown, sin emojis: leído en voz alta, "barra status" es ruido.
 * El guion dice "los comandos de estado siguen respondiendo"; el texto sí lista
 * los comandos, que en Telegram son tappables.
 *
 * Variante DINÁMICA de `reposo`: cuando hay un reloj válido, la frase que remite
 * al texto se reemplaza por la hora concreta. Si la frase no está (el copy
 * cambió), se deja el guion tal cual — degradación segura: remite al texto, que
 * sí lleva la hora.
 *
 * @param {object|null} classification
 * @returns {string} guion ≤ 600 chars
 */
function buildDownNoticeAudioText(classification) {
    const copy = loadCopy();
    const key = resolveCauseKey(classification);
    const base = (copy.voz_clip && copy.voz_clip[key]) || copy.voz_clip[GENERIC_KEY];
    let script = String(base || '');

    if (key === 'reposo' && script.includes(REPOSO_CLIP_TAIL)) {
        const clock = formatClockForCopy(
            soonestResumeRest(classification && classification.providers),
        );
        if (clock) {
            script = script.split(REPOSO_CLIP_TAIL).join(`Se reanuda a las ${clock}.`);
        }
    }

    return script.slice(0, MAX_CHARS);
}

// -----------------------------------------------------------------------------
// CA-13 — clips pregrabados
// -----------------------------------------------------------------------------

/**
 * Resuelve el clip pregrabado de una causa.
 *
 * Último recurso de audio cuando el TTS en vivo no puede completarse — típicamente
 * porque la caída es de conectividad y `edge-tts` también necesita red (D8/R6).
 *
 * Resolución por mapa estático + `path.resolve` + confinamiento al directorio
 * (REQ-SEC-5). Devuelve `null` si la causa no está en el mapa o el archivo no
 * existe: en ese caso el aviso sale sólo por texto, nunca se busca fuera del
 * directorio de assets.
 *
 * @param {string} causeKey — clave de copy (`reposo`/`cuota`/.../`generico`).
 * @returns {string|null} ruta absoluta, o null.
 */
function resolveFallbackClip(causeKey) {
    const file = Object.prototype.hasOwnProperty.call(CLIPS, causeKey) ? CLIPS[causeKey] : null;
    if (!file) return null;
    const abs = path.resolve(CLIP_DIR, file);
    // Confinamiento defensivo: aunque el mapa es literal, la comprobación
    // documenta la invariante y sobrevive a un cambio futuro del mapa.
    const root = CLIP_DIR.endsWith(path.sep) ? CLIP_DIR : CLIP_DIR + path.sep;
    if (!abs.startsWith(root)) return null;
    try {
        return fs.existsSync(abs) ? abs : null;
    } catch {
        return null;
    }
}

// -----------------------------------------------------------------------------
// CA-14 / CA-15 / CA-16 — cooldown del audio
// -----------------------------------------------------------------------------

/**
 * Decide si corresponde emitir audio. FUNCIÓN PURA: sin I/O, sin reloj propio.
 *
 * El cooldown es un control de seguridad, no sólo UX (REQ-SEC-6): cada emisión
 * spawnea dos procesos (`edge-tts` + `ffmpeg`), sale a red y escribe disco —
 * justo cuando el sistema YA está degradado. Sin cooldown, un operador ansioso
 * escribiendo diez veces genera veinte procesos (denial-of-wallet / self-DoS).
 *
 * Reglas (D7):
 *   - Misma causa dentro de la misma ventana → NO se emite (CA-14).
 *   - Cambio de causa dominante → ventana nueva, es información accionable
 *     distinta (CA-16).
 *   - Ventana que superó `maxWindowMs` → ventana nueva.
 *   - Guarda anti-flapping: nunca dos audios a menos de `minGapMs`, aunque la
 *     causa cambie (CA-16).
 *
 * Detalle importante: si la ventana debería abrirse pero la guarda anti-flapping
 * lo impide, el estado se devuelve SIN TOCAR. Si se persistiera la ventana nueva
 * con el audio suprimido, la causa nueva nunca llegaría a sonar: al reevaluarse
 * pasados los 15 min la vería como "misma causa, ventana vigente". Dejarlo
 * intacto hace que el cambio quede pendiente y se emita en la próxima
 * oportunidad válida.
 *
 * El texto NO tiene cooldown: se responde siempre (D7).
 *
 * @param {object|null} stateObj — estado persistido.
 * @param {string} causeKey — clave de copy de la causa dominante.
 * @param {number} nowMs
 * @param {object} [opts]
 * @param {number} [opts.minGapMs=900000]
 * @param {number} [opts.maxWindowMs=21600000]
 * @returns {{notify: boolean, nextState: object}}
 */
function shouldEmitDownAudio(stateObj, causeKey, nowMs, opts = {}) {
    const minGapMs = Number.isFinite(opts.minGapMs) ? opts.minGapMs : MIN_AUDIO_GAP_MS;
    const maxWindowMs = Number.isFinite(opts.maxWindowMs) ? opts.maxWindowMs : MAX_WINDOW_MS;

    // Tolerante a un estado inutilizable: arrancamos limpio. (La corrupción del
    // ARCHIVO se trata en el load, que es fail-closed y no emite.)
    const st = (stateObj && typeof stateObj === 'object') ? stateObj : {};
    const key = Object.prototype.hasOwnProperty.call(CLIPS, causeKey) ? causeKey : GENERIC_KEY;

    const prevCause = typeof st.cause === 'string' ? st.cause : null;
    const windowStartedAtMs = Number.isFinite(st.windowStartedAtMs) ? st.windowStartedAtMs : null;
    const lastAudioAtMs = Number.isFinite(st.lastAudioAtMs) ? st.lastAudioAtMs : null;

    const causaCambio = prevCause !== key;
    const ventanaVencida = windowStartedAtMs === null || (nowMs - windowStartedAtMs) >= maxWindowMs;
    const abreVentana = causaCambio || ventanaVencida;

    const gapOk = lastAudioAtMs === null || (nowMs - lastAudioAtMs) >= minGapMs;
    const notify = abreVentana && gapOk;

    if (!notify) {
        // Estado intacto: o no hay nada que cambiar (misma causa, misma
        // ventana), o hay un cambio pendiente que la guarda difiere.
        return { notify: false, nextState: { cause: prevCause, windowStartedAtMs, lastAudioAtMs } };
    }
    return {
        notify: true,
        nextState: { cause: key, windowStartedAtMs: nowMs, lastAudioAtMs: nowMs },
    };
}

/**
 * Carga el estado de cooldown desde disco.
 *
 * Fail-closed (REQ-SEC-6): distingue "no existe" de "corrupto".
 *   - Ausente  → `{ ok: true, state: {} }`: primer arranque, se puede emitir.
 *   - Corrupto → `{ ok: false }`: NO se emite. Con el estado ilegible no
 *     podemos garantizar el cooldown, y ante la duda no gastamos procesos.
 *
 * @param {string} [statePath]
 * @returns {{ok: boolean, state: object}}
 */
function loadDownAudioState(statePath = AUDIO_STATE_PATH) {
    let raw;
    try {
        raw = fs.readFileSync(statePath, 'utf8');
    } catch (e) {
        if (e && e.code === 'ENOENT') return { ok: true, state: {} };
        return { ok: false, state: {} };
    }
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return { ok: true, state: parsed };
        }
        return { ok: false, state: {} };
    } catch {
        return { ok: false, state: {} };
    }
}

/**
 * Persiste el estado de cooldown: write-tmp + rename atómico (patrón de
 * `saveDegradationNotifyState`). El pipeline es event-driven con escrituras
 * concurrentes; un write directo puede dejar el archivo a medias y romper el
 * cooldown en el peor momento.
 *
 * @param {object} state
 * @param {string} [statePath]
 * @returns {boolean} true si quedó persistido.
 */
function saveDownAudioState(state, statePath = AUDIO_STATE_PATH) {
    const tmp = `${statePath}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
        fs.renameSync(tmp, statePath);
        return true;
    } catch {
        try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
        return false;
    }
}

// -----------------------------------------------------------------------------
// CA-8..CA-18 — orquestación del envío de voz
// -----------------------------------------------------------------------------

/**
 * Envuelve una promesa con timeout duro.
 *
 * `textToSpeechEdge` (`multimedia.js`) NO tiene timer ni `proc.kill()`: una
 * promesa que nunca resuelve dentro del turno del Commander lo bloquea
 * indefinidamente (riesgo R8, CA-12, REQ-SEC-7). El fix de raíz vive en #6154;
 * acá se mitiga en el call-site sin duplicarlo.
 *
 * Resuelve `null` en vez de rechazar: el caller ya trata "sin buffer" como
 * degradación al clip.
 */
function withTimeout(promise, ms) {
    return new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            resolve(null);
        }, ms);
        // `unref` para no mantener vivo el proceso por un timer pendiente.
        if (typeof timer.unref === 'function') timer.unref();
        Promise.resolve(promise).then(
            (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); },
            () => { if (done) return; done = true; clearTimeout(timer); resolve(null); },
        );
    });
}

/**
 * Emite el aviso hablado. Best-effort y NUNCA lanza: el texto ya se entregó
 * antes de llamar acá, así que una falla de audio jamás rompe la notificación
 * de texto (mismo contrato que `sendNeedHumanAudio`).
 *
 * Cascada de degradación (CA-12): TTS en vivo → clip pregrabado → sólo texto.
 * El error crudo nunca llega al chat.
 *
 * Orden deliberado: el cooldown se PERSISTE ANTES de sintetizar y enviar. Si el
 * proceso muere a mitad del envío se pierde un audio; si se persistiera después,
 * un respawn en el medio emitiría de nuevo. Perder un aviso es mejor que
 * spamear al operador con el sistema ya degradado.
 *
 * @param {object} deps
 * @param {object|null} deps.classification
 * @param {string} deps.botToken
 * @param {string} deps.chatId — destino ya resuelto y autorizado (CA-17).
 * @param {object|null} [deps.audioPolicy] — bloque `audio_policy` de config.
 * @param {string} [deps.profile='need-human'] — D5 / CA-10.
 * @param {function} [deps.textToSpeechWithMeta]
 * @param {function} [deps.sendVoiceTelegram]
 * @param {function} [deps.readClip] — inyectable (tests); default `fs.readFileSync`.
 * @param {number} [deps.now]
 * @param {number} [deps.ttsTimeoutMs]
 * @param {string} [deps.statePath]
 * @param {object} [deps.cooldownOpts]
 * @returns {Promise<{sent: boolean, via?: string, skipped?: string, error?: string}>}
 */
async function sendDownNoticeAudio(deps = {}) {
    try {
        const {
            classification,
            botToken,
            chatId,
            audioPolicy = null,
            profile = 'need-human',
            textToSpeechWithMeta,
            sendVoiceTelegram,
            readClip,
            now,
            ttsTimeoutMs = TTS_TIMEOUT_MS,
            statePath = AUDIO_STATE_PATH,
            cooldownOpts = {},
        } = deps;

        // CA-17 — fail-closed de destino: sin chat autorizado no se emite nada.
        if (!botToken || !chatId) return { sent: false, skipped: 'no-destino' };

        // CA-18 — política de audio + kill switch global.
        if (!shouldEmitAudio(audioPolicy, EVENT.COMMANDER_REPLY)) {
            return { sent: false, skipped: 'policy' };
        }

        if (typeof textToSpeechWithMeta !== 'function' || typeof sendVoiceTelegram !== 'function') {
            return { sent: false, skipped: 'no-tts' };
        }

        const nowMs = Number.isFinite(now) ? now : Date.now();
        const causeKey = resolveCauseKey(classification);

        // CA-14/15/16 — cooldown persistido.
        const loaded = loadDownAudioState(statePath);
        if (!loaded.ok) return { sent: false, skipped: 'estado-ilegible' };
        const { notify, nextState } = shouldEmitDownAudio(loaded.state, causeKey, nowMs, cooldownOpts);
        if (!notify) return { sent: false, skipped: 'cooldown' };
        if (!saveDownAudioState(nextState, statePath)) {
            return { sent: false, skipped: 'estado-no-persistible' };
        }

        // CA-9 — el guion es plantilla fija: no hay ninguna llamada a un proveedor
        // de IA para producirlo. El perfil `need-human` usa `edge` como primary y
        // no declara fallback, así que la síntesis tampoco toca un LLM.
        const script = buildDownNoticeAudioText(classification);

        let buffer = null;
        let via = null;
        try {
            const meta = await withTimeout(
                textToSpeechWithMeta(script, { profile }),
                ttsTimeoutMs,
            );
            if (meta && meta.buffer) { buffer = meta.buffer; via = 'tts'; }
        } catch { /* degrada al clip */ }

        if (!buffer) {
            const clip = resolveFallbackClip(causeKey);
            if (clip) {
                try {
                    const reader = typeof readClip === 'function' ? readClip : fs.readFileSync;
                    const buf = reader(clip);
                    if (buf && buf.length) { buffer = buf; via = 'clip'; }
                } catch { /* degrada a sólo texto */ }
            }
        }

        if (!buffer) return { sent: false, skipped: 'sin-audio' };

        const ok = await sendVoiceTelegram(buffer, botToken, chatId);
        return { sent: !!ok, via };
    } catch (e) {
        return { sent: false, error: e && e.message ? e.message : String(e) };
    }
}

module.exports = {
    // API principal
    buildDownNoticeText,
    buildDownNoticeAudioText,
    resolveFallbackClip,
    shouldEmitDownAudio,
    sendDownNoticeAudio,

    // Estado del cooldown
    loadDownAudioState,
    saveDownAudioState,

    // Helpers expuestos para tests
    loadCopy,
    resolveCauseKey,
    soonestResumeRest,
    formatClockForCopy,
    withTimeout,

    // Constantes
    CLIP_DIR,
    COPY_PATH,
    AUDIO_STATE_PATH,
    CAUSE_TO_KEY,
    CLIPS,
    GENERIC_KEY,
    MAX_CHARS,
    MIN_AUDIO_GAP_MS,
    MAX_WINDOW_MS,
    TTS_TIMEOUT_MS,
    REPOSO_CLIP_TAIL,
};
