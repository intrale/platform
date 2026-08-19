'use strict';

// =============================================================================
// fallback-episode-state.js — Política de emisión por EPISODIO del fallback
// cross-provider (#6179, parte 1 del split de #6151).
//
// Por qué existe
// --------------
// Hasta este módulo había TRES mecanismos compitiendo por avisar lo mismo:
//   1. `dispatch-with-fallback.js` — un `_notify` por CADA despacho que caía a
//      un proveedor de respaldo, sin ninguna deduplicación.
//   2. `commander/multi-provider.js:shouldEmitFallbackNotice` — ventana de
//      5 min, sólo del lado del Commander.
//   3. la rama `cross-provider-fallback` del burst grouper, que reagrupaba lo
//      que ya había salido.
// Resultado medido en la definición: 8.984 mensajes de Telegram en 85 días
// (~106/día) que no le pedían al operador ninguna acción. Un canal que avisa
// 106 veces por día es un canal que se deja de leer.
//
// Este módulo es el ÚNICO dueño de la decisión "¿esto se avisa o no?". Los tres
// emisores convergen acá (CA-3): dos políticas vivas = el ruido vuelve por la
// que quedó.
//
// Contrato
// --------
//   recordDispatch(opts) -> { notify, changed, episode, reason }
//       Registra un despacho y decide si corresponde avisar. Persiste ANTES de
//       responder (CA-11). Tiene side-effects sobre el archivo de episodio.
//   readEpisode(opts)    -> { episode, reason }
//       Lectura pura, sin side-effects. La consume la parte 2 del split (panel
//       de estado del dashboard).
//
// Invariantes que NO se negocian
// ------------------------------
//   - `cause` NO es parámetro de entrada (D1). Se deriva SIEMPRE adentro vía
//     `provider-pause-cause.classifyPauseCause`. Un `cause` en la firma es el
//     agujero de SEC-9 con otro nombre: hoy `pulpo.js` pasaba
//     `errorCode: 'quota_exhausted'` como literal, y por eso una credencial
//     revocada se le reportaba al operador como "cuota agotada". Sacándolo de
//     la firma, el literal deja de ser posible por construcción, no por test.
//   - El silencio NUNCA es el default ante duda: estado ausente / ilegible /
//     con shape inválido / persistencia fallida / lock no adquirido ⇒
//     `notify: true` (CA-10 / CA-11 / CA-14). Un mecanismo cuyo trabajo es
//     callar, cuando calla mal, es indistinguible de uno que funciona.
//   - Persistir primero, notificar después (CA-11 / SEC-13).
//   - Cero locks nuevos: se reusa `lib/file-lock.js:withLockSync`, que es el
//     lock canónico del repo (G-1). NO escribir una cuarta implementación, y
//     sobre todo NO sobreescribir `lib/file-lock.js`, que ya lo consumen 10
//     módulos incluido `pulpo.js`.
//   - Cero writers nuevos del archivo de estado: `lib/atomic-json.js`.
// =============================================================================

const fs = require('fs');
const path = require('path');

const { writeJsonAtomic, readJsonSafe } = require('./atomic-json');
const { withLockSync } = require('./file-lock');
const ppc = require('./provider-pause-cause');

// -----------------------------------------------------------------------------
// Vocabulario cerrado del episodio.
// -----------------------------------------------------------------------------

/** Eje 1 — dónde está corriendo el pipeline. */
const MODE_PRIMARIO = 'primario';
const MODE_RESPALDO = 'respaldo';
const MODES = Object.freeze([MODE_PRIMARIO, MODE_RESPALDO]);

/**
 * Eje 2 — escalón de capacidad. El ORDEN IMPORTA: el índice es la severidad
 * (mayor = peor). `tierRank` lo usa para decidir si un cambio es "bajar de
 * escalón" (CA-2).
 *
 * Se llavea por escalón y NO por proveedor a propósito: la definición midió que
 * llavear por proveedor sigue emitiendo 3.675 mensajes (sólo −59 %), porque un
 * pipeline que rota entre tres respaldos gratuitos cambia de clave todo el
 * tiempo sin que la situación del operador cambie en nada.
 */
const TIERS = Object.freeze([
    'respaldo_pago',
    'gratuito_con_herramientas',
    'gratuito_sin_herramientas',
]);

/** Enum de causas — el MISMO de `provider-pause-cause.js:117-121`, no una copia. */
const CAUSES = Object.freeze([
    ppc.CAUSE_REPOSO,
    ppc.CAUSE_CUOTA,
    ppc.CAUSE_AUTH,
    ppc.CAUSE_TRANSITORIA,
]);

/** Eventos que entiende `formatEpisodeNotice` (contrato con el copy de UX). */
const EVENTO_ENTRA = 'entra_respaldo';
const EVENTO_BAJA = 'baja_escalon';
const EVENTO_VUELVE = 'vuelve_principal';
const EVENTO_SOSTENIDO = 'sostenido';

/** Nombre del archivo de estado. Vive en `.pipeline/state/` (gitignored). */
const EPISODE_FILENAME = 'fallback-episode.json';

/** Versión del shape persistido. Un bump obliga a revalidar (CA-10). */
const EPISODE_SCHEMA_VERSION = 1;

/** CA-13 — cada cuánto se re-avisa una degradación sostenida. */
const DEFAULT_HEARTBEAT_MS = 6 * 60 * 60 * 1000;

/**
 * Budget de espera del lock. Holgado a propósito (G-4): la sección crítica es
 * de milisegundos, y un budget corto convertiría el fail-closed de CA-14
 * ("lock no adquirido ⇒ notifico igual") en una fuente de ruido propia.
 */
const LOCK_TIMEOUT_MS = 5000;

/**
 * `deterministic` es el modo determinístico del pipeline, no un proveedor de IA
 * degradado. No declara `billing` en `agent-models.json` y tiene
 * `supports_tool_use: false`, así que sin este corte caería en
 * `gratuito_sin_herramientas` y dispararía el aviso destacado de calidad
 * degradada (CA-15). Un aviso destacado falso es fatiga de alerta, y la fatiga
 * de alerta es exactamente lo que hace que se ignore el aviso verdadero.
 */
const EXCLUDED_PROVIDERS = Object.freeze(['deterministic']);

// -----------------------------------------------------------------------------
// Helpers puros
// -----------------------------------------------------------------------------

/** Lookup que NUNCA hereda de `Object.prototype` (#5667 / D8). */
function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, String(key));
}

function tierRank(tier) {
    const i = TIERS.indexOf(tier);
    // Un tier fuera del enum se trata como el escalón MÁS degradado: describir
    // de menos una degradación es peor que describirla de más (UX, decisión 8).
    return i === -1 ? TIERS.length : i;
}

/**
 * D10 — el path del archivo de episodio se resuelve UNA SOLA VEZ, acá adentro.
 *
 * Si el dispatcher y el Commander resolvieran directorios distintos habría dos
 * archivos de episodio, dos estados y volvería el doble aviso con la política
 * nueva puesta. Mismo criterio que `provider-pause-cause.js:resolveStateDir`.
 */
function resolveStateDir(opts = {}) {
    if (opts.stateDir) return path.resolve(String(opts.stateDir));
    if (opts.pipelineDir) return path.resolve(String(opts.pipelineDir), 'state');
    return path.resolve(__dirname, '..', 'state');
}

/** Path absoluto del archivo de episodio. Exportado para el assert de D10. */
function episodeFilePath(opts = {}) {
    return path.join(resolveStateDir(opts), EPISODE_FILENAME);
}

/**
 * Valida TIPOS y ENUMS, no sólo presencia de claves (D3).
 *
 * `readJsonSafe` colapsa ausente / ilegible / corrupto al mismo fallback. Si el
 * caller trata ese fallback como "estado conocido", un archivo corrupto se lee
 * como "no cambió nada" y produce supresión indefinida y silenciosa — el
 * escenario exacto que CA-10 existe para evitar.
 */
function isValidEpisode(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    if (raw.version !== EPISODE_SCHEMA_VERSION) return false;
    if (!MODES.includes(raw.mode)) return false;
    // En `primario` no hay escalón: `tier` DEBE ser null (y no cualquier cosa).
    if (raw.mode === MODE_PRIMARIO) {
        if (raw.tier !== null) return false;
    } else if (!TIERS.includes(raw.tier)) {
        return false;
    }
    // `cause: null` es el caso legítimo "no se pudo determinar" (CA-12), no un
    // desvío de shape.
    if (raw.cause !== null && !CAUSES.includes(raw.cause)) return false;
    if (!Number.isFinite(raw.since) || raw.since <= 0) return false;
    if (!Number.isFinite(raw.lastNotifiedAt) || raw.lastNotifiedAt < 0) return false;
    if (typeof raw.evento !== 'string') return false;
    return true;
}

/**
 * Lee el estado distinguiendo los TRES casos que `readJsonSafe` colapsa (D3).
 *
 * @returns {{ prev: object|null, reason: string|null }}
 *          `prev === null` en los tres casos de desvío, con `reason` poblado
 *          para que el caller pueda decidir (y para diagnóstico en el log).
 */
function loadPrevious(file, deps) {
    if (!deps.fsImpl.existsSync(file)) {
        return { prev: null, reason: 'ausente' };
    }
    // Fallback EXPLÍCITO a `null`, nunca a `{}`: un `{}` es indistinguible de un
    // estado válido vacío y es justo lo que produce la supresión silenciosa.
    const raw = deps.atomicJson.readJsonSafe(file, null);
    if (raw === null) return { prev: null, reason: 'ilegible' };
    if (!isValidEpisode(raw)) return { prev: null, reason: 'shape_invalido' };
    return { prev: raw, reason: null };
}

/**
 * CA-13 — ventana del heartbeat. Configurable por parámetro (lo que usan los
 * tests) o por `config.yaml: fallback_episode.heartbeat_hours`. Default 6 h.
 *
 * Lectura fail-soft: cualquier problema de YAML cae al default. Un módulo cuyo
 * trabajo es avisar no puede romperse porque la config esté mal escrita.
 */
const _heartbeatCache = new Map(); // cfgPath -> { value, readAt }
const HEARTBEAT_CACHE_TTL_MS = 60 * 1000;

function resolveHeartbeatMs(opts = {}) {
    if (Number.isFinite(opts.heartbeatMs) && opts.heartbeatMs > 0) {
        return Number(opts.heartbeatMs);
    }
    const cfgPath = opts.configPath
        || path.join(
            opts.pipelineDir ? path.resolve(String(opts.pipelineDir)) : path.resolve(__dirname, '..'),
            'config.yaml',
        );
    // Memo corta: `recordDispatch` corre en el path de cada despacho y no tiene
    // por qué parsear el YAML entero cada vez.
    const hit = _heartbeatCache.get(cfgPath);
    if (hit && (Date.now() - hit.readAt) < HEARTBEAT_CACHE_TTL_MS) return hit.value;

    let value = DEFAULT_HEARTBEAT_MS;
    try {
        if (fs.existsSync(cfgPath)) {
            const doc = require('js-yaml').load(fs.readFileSync(cfgPath, 'utf8')) || {};
            const cfg = (doc && typeof doc === 'object' && hasOwn(doc, 'fallback_episode'))
                ? doc.fallback_episode : null;
            const hours = Number(cfg && cfg.heartbeat_hours);
            if (Number.isFinite(hours) && hours > 0 && hours <= 168) {
                value = Math.round(hours * 60 * 60 * 1000);
            }
        }
    } catch { /* default */ }
    _heartbeatCache.set(cfgPath, { value, readAt: Date.now() });
    return value;
}

/**
 * Deriva el escalón de capacidad del proveedor efectivo.
 *
 * `billing` NO se reimplementa: se delega en `billingOf` de
 * `dispatch-with-fallback.js`, que es la fuente única del criterio (#4870).
 * El `require` es LAZY a propósito — `dispatch-with-fallback` requiere a este
 * módulo, y un require en el tope cerraría el ciclo con exports a medio poblar.
 */
function deriveTier(provider, models) {
    let billing = 'free';
    try {
        billing = require('./agent-launcher/dispatch-with-fallback').billingOf(provider, models);
    } catch {
        billing = 'free'; // fail-safe idéntico al de billingOf
    }
    if (billing === 'paid') return 'respaldo_pago';

    let supportsToolUse = false;
    try {
        const def = models && models.providers && hasOwn(models.providers, provider)
            ? models.providers[provider]
            : null;
        supportsToolUse = !!(def && def.supports_tool_use === true);
    } catch {
        supportsToolUse = false;
    }
    return supportsToolUse ? 'gratuito_con_herramientas' : 'gratuito_sin_herramientas';
}

/**
 * D1 / CA-6 — la causa se deriva SIEMPRE acá adentro, jamás entra por la firma.
 *
 * `classifyPauseCause` con `degraded: true` (snapshot ausente o ilegible)
 * devuelve `dominantCause: null`. Ese `null` ES el caso "motivo desconocido" de
 * CA-12, no un error a tapar con un default: si no sabemos por qué se degradó,
 * el operador tiene que enterarse, no recibir una causa inventada.
 */
function deriveCause(chain, { now, stateDir }) {
    try {
        const v = ppc.classifyPauseCause(Array.isArray(chain) ? chain : [], { now, stateDir });
        if (!v || v.degraded) return null;
        return CAUSES.includes(v.dominantCause) ? v.dominantCause : null;
    } catch {
        return null; // desconocida ⇒ notifica (CA-12)
    }
}

// -----------------------------------------------------------------------------
// Núcleo de decisión — puro, sin I/O. Testeable rama por rama.
// -----------------------------------------------------------------------------

/**
 * @param {object|null} prev      episodio previo VÁLIDO, o null si no lo había.
 * @param {object} current        `{ mode, tier, cause }` derivados de este despacho.
 * @param {object} ctx            `{ now, heartbeatMs, unreadableReason }`.
 * @returns {{ notify:boolean, changed:boolean, evento:string|null, reason:string }}
 */
function decide(prev, current, ctx) {
    const { now, heartbeatMs, unreadableReason } = ctx;
    const enRespaldo = current.mode === MODE_RESPALDO;

    // --- Sin estado previo confiable (ausente / ilegible / shape inválido) ---
    if (!prev) {
        if (!enRespaldo) {
            // Estamos en el motor principal y no hay episodio que cerrar. No se
            // suprime nada, así que no hay silencio peligroso que romper.
            // Avisar acá sería anunciar una "vuelta a la normalidad" que quizá
            // nunca ocurrió: un destacado falso, que es la fatiga de alerta que
            // CA-15 manda evitar. Se persiste el estado limpio y se sigue.
            return {
                notify: false, changed: false, evento: null,
                reason: unreadableReason ? `primario_sin_estado:${unreadableReason}` : 'primario_estable',
            };
        }
        // Degradados y sin estado confiable ⇒ se avisa SIEMPRE (CA-10).
        return {
            notify: true, changed: true, evento: EVENTO_ENTRA,
            reason: unreadableReason || 'sin_estado_previo',
        };
    }

    // --- Vuelta al motor principal (CA-2) ---
    if (!enRespaldo) {
        if (prev.mode === MODE_RESPALDO) {
            return { notify: true, changed: true, evento: EVENTO_VUELVE, reason: 'vuelve_principal' };
        }
        return { notify: false, changed: false, evento: null, reason: 'primario_estable' };
    }

    // --- Seguimos/entramos en respaldo ---
    if (prev.mode === MODE_PRIMARIO) {
        return { notify: true, changed: true, evento: EVENTO_ENTRA, reason: 'entra_respaldo' };
    }

    if (prev.tier !== current.tier) {
        const peor = tierRank(current.tier) > tierRank(prev.tier);
        // Un cambio de escalón abre un episodio nuevo: la situación práctica del
        // operador cambió (puede o no puede correr comandos). Hacia arriba se
        // avisa con el titular de "entra_respaldo", que describe correctamente
        // el estado vigente; callarlo dejaría al operador creyendo que sigue en
        // el peor escalón (el mismo problema que CA-13 viene a resolver).
        return {
            notify: true, changed: true,
            evento: peor ? EVENTO_BAJA : EVENTO_ENTRA,
            reason: peor ? 'baja_escalon' : 'sube_escalon',
        };
    }

    // --- Mismo estado: acá es donde se corta el ruido (CA-1 / CA-2) ---

    // CA-12 / SEC-1 · `auth` y causa desconocida notifican SIEMPRE, destacado,
    // aunque el estado no haya cambiado. Fail-closed hacia el aviso: una
    // credencial revocada que se avisa una sola vez y nunca más es peor que el
    // ruido que esta historia viene a sacar.
    //
    // Nunca degrada a `sostenido` (directriz de UX en validación): el marcador
    // tiene que seguir siendo el destacado y el cierre tiene que conservar el
    // pedido de acción.
    if (current.cause === ppc.CAUSE_AUTH) {
        return { notify: true, changed: false, evento: prev.evento || EVENTO_ENTRA, reason: 'auth' };
    }
    if (current.cause === null) {
        return { notify: true, changed: false, evento: prev.evento || EVENTO_ENTRA, reason: 'causa_desconocida' };
    }

    // CA-13 · Heartbeat. Sin esto, "no llegó nada" y "el pipeline lleva 9 horas
    // en el peor escalón" se ven exactamente igual desde el chat.
    //
    // Es dirigido por despacho, no por timer (G-3): si el pipeline queda
    // degradado SIN despachar, no hay re-aviso — tampoco hay impacto que avisar.
    if (Number.isFinite(prev.lastNotifiedAt) && (now - prev.lastNotifiedAt) >= heartbeatMs) {
        return { notify: true, changed: false, evento: EVENTO_SOSTENIDO, reason: 'heartbeat' };
    }

    return { notify: false, changed: false, evento: null, reason: 'sin_cambio' };
}

// -----------------------------------------------------------------------------
// API pública
// -----------------------------------------------------------------------------

function resolveDeps(opts = {}) {
    return {
        fsImpl: opts.fsImpl || fs,
        atomicJson: opts.atomicJson || { writeJsonAtomic, readJsonSafe },
    };
}

/**
 * Lectura PURA del episodio vigente. Sin locks, sin escrituras, sin decisiones.
 * La consume la parte 2 del split (panel de estado del dashboard).
 *
 * @returns {{ episode: object|null, reason: string|null, file: string }}
 */
function readEpisode(opts = {}) {
    const deps = resolveDeps(opts);
    const file = episodeFilePath(opts);
    const { prev, reason } = loadPrevious(file, deps);
    return { episode: prev, reason, file };
}

/**
 * Registra un despacho y decide si corresponde avisar.
 *
 * @param {object} opts
 * @param {string} [opts.pipelineDir]     raíz de `.pipeline/` (D10).
 * @param {string} [opts.stateDir]        override directo del dir de estado (tests).
 * @param {string} opts.provider          proveedor EFECTIVO del despacho.
 * @param {boolean} opts.crossProvider    true si se resolvió a un respaldo.
 * @param {string[]} [opts.chain]         `chain_tried`, insumo de la clasificación de causa.
 * @param {object} [opts.models]          `agent-models.json` ya parseado (se lee si falta).
 * @param {number} [opts.now]             reloj inyectable — SÓLO para los timestamps del
 *                                        episodio. La staleness del lock va con reloj real
 *                                        adentro de `file-lock` (G-2).
 * @param {number} [opts.heartbeatMs]     ventana de re-aviso (CA-13).
 * @returns {{ notify:boolean, changed:boolean, episode:object|null, reason:string }}
 */
function recordDispatch(opts = {}) {
    const deps = resolveDeps(opts);
    const now = Number.isFinite(opts.now) ? Number(opts.now) : Date.now();
    const provider = String(opts.provider == null ? '' : opts.provider);

    // CA-15 · El corte va ANTES de derivar `tier`.
    if (EXCLUDED_PROVIDERS.includes(provider)) {
        return { notify: false, changed: false, episode: null, reason: 'modo_determinista' };
    }

    const stateDir = resolveStateDir(opts);
    const file = path.join(stateDir, EPISODE_FILENAME);
    const heartbeatMs = resolveHeartbeatMs(opts);

    const mode = opts.crossProvider === true ? MODE_RESPALDO : MODE_PRIMARIO;

    let models = opts.models;
    if (models === undefined) {
        try {
            models = require('./agent-launcher/dispatch-with-fallback')
                ._readAgentModelsRaw(opts.pipelineDir || path.resolve(__dirname, '..'), deps.fsImpl);
        } catch {
            models = null;
        }
    }

    const current = {
        mode,
        tier: mode === MODE_RESPALDO ? deriveTier(provider, models) : null,
        // La causa sólo tiene sentido mientras estamos degradados.
        cause: mode === MODE_RESPALDO ? deriveCause(opts.chain, { now, stateDir }) : null,
    };

    // -------------------------------------------------------------------------
    // Sección crítica. Hasta 3 agentes + el Commander escriben concurrentemente
    // desde procesos distintos (CA-14 / SEC-6): sin exclusión mutua dos pueden
    // leer el mismo estado viejo, ambos concluir `changed:true` y ambos avisar.
    //
    // `atomic-json` da atomicidad de ESCRITURA, no de read-modify-write, y
    // `createAlertDedup` es in-memory de un solo proceso: ninguno de los dos
    // resuelve esto. Se reusa el lock canónico del repo (G-1).
    // -------------------------------------------------------------------------
    // El lock se crea al lado del archivo de estado: si el directorio todavía no
    // existe (instalación limpia), `acquireLockSync` fallaría por ENOENT antes
    // de llegar a la sección crítica.
    try { deps.fsImpl.mkdirSync(stateDir, { recursive: true }); } catch { /* lo dirá el write */ }

    try {
        return withLockSync(file, () => {
            const { prev, reason: readReason } = loadPrevious(file, deps);
            const d = decide(prev, current, { now, heartbeatMs, unreadableReason: readReason });

            const since = (d.changed || !prev || !Number.isFinite(prev.since)) ? now : prev.since;
            const lastNotifiedAt = d.notify
                ? now
                : (prev && Number.isFinite(prev.lastNotifiedAt) ? prev.lastNotifiedAt : 0);

            const next = {
                version: EPISODE_SCHEMA_VERSION,
                mode: current.mode,
                tier: current.tier,
                cause: current.cause,
                evento: d.evento || (prev && prev.evento) || EVENTO_ENTRA,
                since,
                lastNotifiedAt,
                updatedAt: now,
            };

            // El episodio que se PERSISTE arranca ahora; el que se RENDERIZA
            // tiene que poder decir cuánto duró lo que se está cerrando. En la
            // vuelta al motor principal son cosas distintas: el episodio nuevo
            // (primario) empieza en `now`, pero el aviso dice "estuvo 4 h con
            // motor de respaldo", y esas 4 h se miden desde el `since` del
            // episodio DEGRADADO. Sin esta distinción el operador lee siempre
            // "estuvo menos de un minuto", que es información falsa.
            const noticeSince = (d.evento === EVENTO_VUELVE && prev && Number.isFinite(prev.since))
                ? prev.since
                : since;

            // CA-11 / SEC-13 · Persistir PRIMERO, notificar después. Descartar
            // el `false` de `writeJsonAtomic` (que es fail-soft y no lanza) es
            // literalmente cómo un control se apaga en silencio: el estado no
            // queda guardado, la próxima lectura ve lo viejo, y la decisión de
            // callar se toma sobre datos que nunca se persistieron.
            const ok = deps.atomicJson.writeJsonAtomic(file, next, { indent: 2 });
            const episode = { ...next, since: noticeSince, heartbeatMs };
            if (!ok) {
                return {
                    notify: true, changed: d.changed, episode,
                    reason: 'persistencia_fallida',
                };
            }
            return { notify: d.notify, changed: d.changed, episode, reason: d.reason };
        }, { component: 'fallback-episode', timeoutMs: LOCK_TIMEOUT_MS });
    } catch (err) {
        // CA-14 · No se pudo entrar a la sección crítica ⇒ se avisa igual.
        // Fail-closed hacia el aviso, coherente con CA-10/CA-11: preferimos un
        // mensaje de más a un silencio que el operador no puede distinguir de
        // "está todo bien".
        if (current.mode === MODE_PRIMARIO) {
            // Salvo en primario, donde no hay degradación que ocultar y avisar
            // sería inventar una vuelta a la normalidad.
            return { notify: false, changed: false, episode: null, reason: 'lock_no_adquirido' };
        }
        return {
            notify: true,
            changed: false,
            episode: {
                version: EPISODE_SCHEMA_VERSION,
                mode: current.mode,
                tier: current.tier,
                cause: current.cause,
                evento: EVENTO_ENTRA,
                since: now,
                lastNotifiedAt: now,
                updatedAt: now,
                heartbeatMs,
            },
            reason: `lock_no_adquirido:${(err && err.code) || 'ERR'}`,
        };
    }
}

module.exports = {
    recordDispatch,
    readEpisode,

    // Path del archivo — exportado para el assert de D10 (que ambos emisores
    // terminan en el MISMO archivo) y para el panel de la parte 2.
    episodeFilePath,

    // Constantes del vocabulario cerrado.
    MODES,
    MODE_PRIMARIO,
    MODE_RESPALDO,
    TIERS,
    CAUSES,
    EVENTO_ENTRA,
    EVENTO_BAJA,
    EVENTO_VUELVE,
    EVENTO_SOSTENIDO,
    EPISODE_FILENAME,
    EPISODE_SCHEMA_VERSION,
    DEFAULT_HEARTBEAT_MS,
    EXCLUDED_PROVIDERS,

    // Expuestos para tests (ramas puras, sin I/O).
    _internal: {
        decide,
        isValidEpisode,
        deriveTier,
        deriveCause,
        tierRank,
        resolveStateDir,
        resolveHeartbeatMs,
        loadPrevious,
    },
};
