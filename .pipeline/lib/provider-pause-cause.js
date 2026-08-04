// =============================================================================
// provider-pause-cause.js — Clasificación de la causa de una pausa por falta de
// proveedor disponible (#5467).
//
// PROBLEMA QUE RESUELVE
//   `provider-exhaustion-pause.js#formatExhaustionMessage` titulaba SIEMPRE
//   "Pipeline pausado — cuota agotada", sin importar la causa real. Hay al menos
//   cuatro causas distintas que llegan al mismo lugar y exigen reacciones
//   OPUESTAS del operador:
//
//     reposo      → ventana de descanso programada. Se recupera solo.
//     cuota       → cuota realmente agotada / rate limit. Esperar reset.
//     auth        → licencia / credenciales caídas. Requiere intervención.
//     transitoria → timeout / error de red. Se recupera solo, sin hora.
//
//   Este módulo clasifica la causa leyendo SÓLO archivos locales ya frescos en
//   disco, y devuelve una estructura lista para que el formateador arme texto.
//
// DECISIÓN DE ARQUITECTURA (receta del arquitecto, #5467)
//   Módulo NUEVO y PURO en vez de engordar `provider-exhaustion-pause.js`
//   (892 líneas, mezcla gh CLI + cola Telegram + marker + audit). Todo el I/O
//   entra por `opts` (`stateDir`, `now`, `scheduleModule`, `restWindowModule`),
//   así los tests corren con fixtures y nunca contra el snapshot vivo — que
//   rota en minutos y haría los tests flaky por diseño (CA-12).
//
// SEGURIDAD (SEC-1..SEC-7 de la revisión de `security`)
//   SEC-1 · `reason_code` → castellano por tabla CERRADA. Nunca se interpola el
//           código crudo: el snapshot es un archivo escrito por otro proceso.
//   SEC-3 · `key_status` / `auth_mode` son insumo de decisión y NUNCA salen al
//           texto. Publicar el modo de auth es postura de seguridad que no le
//           sirve al operador para actuar.
//   SEC-4 · El snapshot es INPUT NO CONFIABLE: `JSON.parse` en try/catch,
//           validación de forma (`providers` array), lectura campo por campo
//           por nombre (nunca spread/Object.assign de claves arbitrarias →
//           prototype pollution), id validado contra el mismo patrón que usa
//           `multi-provider/health-alerts.js:103`.
//   SEC-6 · La causa dominante que se persiste en el marker es la categoría
//           GRUESA, nunca el `reason_code` crudo: un provider que flapea
//           green↔red no debe convertirse en fatiga de alertas.
//   SEC-7 · Con datos vencidos (`stale`) o ausentes (`degraded`) está PROHIBIDO
//           afirmar "se recupera solo". Afirmar recuperación automática con
//           datos viejos es la misma desinformación que el issue elimina.
//
// FAIL-OPEN DE SCHEDULE (R3)
//   `provider-schedule.js` es fail-open estricto: sin archivo → provider activo.
//   Eso se PRESERVA: un provider nunca se clasifica `reposo` por ausencia de
//   datos. Un `active:false` o un schedule vacío devuelven "no está en reposo".
//
// Sin dependencias npm nuevas (Node puro: fs, path).
// =============================================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// -----------------------------------------------------------------------------
// Carga defensiva de dependencias
// -----------------------------------------------------------------------------
// Ninguna es obligatoria: si alguna falla, degradamos. Este módulo alimenta un
// mensaje de Telegram accesorio y NUNCA debe tumbar el barrido del Pulpo.

let healthCronLib = null;
try { healthCronLib = require('./multi-provider/health-cron'); } catch { /* opcional */ }

let providerScheduleLib = null;
try { providerScheduleLib = require('./provider-schedule'); } catch { /* opcional */ }

let restWindowLib = null;
try { restWindowLib = require('./rest-mode-window'); } catch { /* opcional */ }

// -----------------------------------------------------------------------------
// Constantes
// -----------------------------------------------------------------------------

/** Nombre del snapshot de salud. Fallback si `health-cron` no cargó. */
const SNAPSHOT_FILENAME_FALLBACK = 'multi-provider-health.json';

/** Cadencia default del cron de salud si `readTickIntervalMs()` no está. */
const DEFAULT_TICK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Margen de frescura: 3 ticks perdidos. Derivado, NO hardcodeado — si cambia la
 * cadencia del cron en `config.yaml`, el umbral acompaña (nota (c) de `guru`).
 */
const STALE_TICKS = 3;

/**
 * Patrón de id de proveedor. Mismo que `multi-provider/health-alerts.js:103`.
 * Un id que no matchea se DESCARTA (SEC-4).
 */
const PROVIDER_ID_RE = /^[a-z][a-z0-9-]{0,32}$/;

/**
 * Alias id-de-salud → id-canónico-de-cadena.
 *
 * El cron de salud persiste `openai`; `agent-models.json` y las cadenas usan
 * `openai-codex`. Mismo alias que declara `multi-provider/health-cron.js:73`.
 * Sin esto, el desglose no encuentra la fila de salud del provider de la cadena.
 */
const PROVIDER_ALIAS = Object.freeze({ openai: 'openai-codex' });

/** Categorías gruesas. Es lo único que se persiste en el marker (SEC-6). */
const CAUSE_REPOSO = 'reposo';
const CAUSE_CUOTA = 'cuota';
const CAUSE_AUTH = 'auth';
const CAUSE_TRANSITORIA = 'transitoria';
const CAUSE_DISPONIBLE = 'disponible';

/**
 * Precedencia de la causa dominante — gana la que más urgencia impone
 * (UX-1, ratificado por CA-13 del PO): auth > cuota > transitoria > reposo.
 *
 * `disponible` NUNCA es dominante: no es una causa, es la ausencia de una.
 */
const CAUSE_PRIORITY = Object.freeze({
    [CAUSE_AUTH]: 0,
    [CAUSE_CUOTA]: 1,
    [CAUSE_TRANSITORIA]: 2,
    [CAUSE_REPOSO]: 3,
    [CAUSE_DISPONIBLE]: 4,
});

/** Copy default para cualquier `reason_code` fuera de la tabla (SEC-1). */
const REASON_LABEL_DEFAULT = 'motivo desconocido';

/**
 * Tabla de copy CERRADA — UX-3, los 15 códigos de `ALLOWED_REASON_CODES` + default.
 *
 * Reglas de redacción (UX-3):
 *   - minúscula inicial (la línea ya arranca con el nombre del proveedor),
 *   - sin punto final,
 *   - sin jerga en inglés salvo `CLI` (no hay equivalente instalado),
 *   - el porcentaje SÓLO si existe: `cuota agotada (— %)` es peor que
 *     `cuota agotada`.
 *
 * `quota_exhausted` (flag reactivo, sin medición) NO puede decir "cuota agotada"
 * a secas (UX-2): un titular que dice "sin proveedor disponible" con una línea
 * abajo que dice "cuota agotada" es un mensaje que se contradice a sí mismo.
 */
const REASON_TABLE = Object.freeze({
    authenticated: { text: () => 'disponible', cause: CAUSE_DISPONIBLE },
    cli_oauth_ok: { text: () => 'disponible', cause: CAUSE_DISPONIBLE },

    quota_exhausted_real: {
        text: (entry) => {
            const pct = formatPct(entry && entry.quotaPct);
            return pct ? `cuota agotada (${pct})` : 'cuota agotada';
        },
        cause: CAUSE_CUOTA,
    },
    quota_exhausted: {
        text: () => 'el proveedor la reporta agotada (sin medición)',
        cause: CAUSE_CUOTA,
    },
    rate_limited: { text: () => 'frenado por límite de frecuencia', cause: CAUSE_CUOTA },

    invalid_credentials: { text: () => 'credenciales inválidas', cause: CAUSE_AUTH },
    no_key_configured: { text: () => 'sin credenciales configuradas', cause: CAUSE_AUTH },
    forbidden: { text: () => 'acceso denegado por el proveedor', cause: CAUSE_AUTH },
    cli_license_unavailable: { text: () => 'sin licencia CLI habilitada', cause: CAUSE_AUTH },
    cli_unavailable: { text: () => 'CLI no disponible', cause: CAUSE_AUTH },
    cli_binary_undeclared: { text: () => 'CLI sin declarar en la configuración', cause: CAUSE_AUTH },
    unknown_provider: { text: () => 'proveedor desconocido en la configuración', cause: CAUSE_AUTH },

    timeout: { text: () => 'sin respuesta a tiempo', cause: CAUSE_TRANSITORIA },
    network_error: { text: () => 'error de red', cause: CAUSE_TRANSITORIA },
    unknown: { text: () => REASON_LABEL_DEFAULT, cause: CAUSE_TRANSITORIA },
});

/**
 * Frase corta por `reason_code`, para la línea de acción cuando hay VARIOS
 * proveedores accionables ("2 proveedores necesitan atención. X sin licencia,
 * Y con la cuota agotada").
 */
const ACTION_SHORT = Object.freeze({
    cli_license_unavailable: 'sin licencia',
    cli_unavailable: 'sin CLI disponible',
    cli_binary_undeclared: 'sin CLI declarado',
    invalid_credentials: 'con credenciales inválidas',
    no_key_configured: 'sin credenciales',
    forbidden: 'con el acceso denegado',
    unknown_provider: 'sin declarar en la configuración',
    quota_exhausted_real: 'con la cuota agotada',
    quota_exhausted: 'reportando la cuota agotada',
    rate_limited: 'frenado por rate limit',
});

/**
 * Frase completa por `reason_code`, para cuando hay UN SOLO proveedor accionable.
 *
 * Tono (UX): imperativo CON OBJETO. `Reautenticá Gemini (Antigravity CLI)` sí;
 * `revisá la licencia` no — no dice de qué proveedor. Segunda persona directa,
 * sin humor: esto es una alerta operativa que se lee a las 3 AM.
 */
const ACTION_FULL = Object.freeze({
    cli_license_unavailable: (l) => `${l} no tiene licencia habilitada. Reautenticá o revisá el billing.`,
    cli_unavailable: (l) => `${l} no tiene el CLI disponible. Instalalo o revisá el PATH.`,
    cli_binary_undeclared: (l) => `${l} no tiene el CLI declarado. Declaralo en agent-models.json.`,
    invalid_credentials: (l) => `${l} tiene credenciales inválidas. Reautenticá el proveedor.`,
    no_key_configured: (l) => `${l} no tiene credenciales configuradas. Cargá la API key.`,
    forbidden: (l) => `${l} rechaza el acceso. Revisá permisos o billing.`,
    unknown_provider: (l) => `${l} no está declarado en la configuración. Revisalo en agent-models.json.`,
    quota_exhausted_real: (l) => `${l} agotó la cuota. Esperá el reset o sacalo de la cadena.`,
    quota_exhausted: (l) => `${l} reporta la cuota agotada. Esperá el reset o sacalo de la cadena.`,
    rate_limited: (l) => `${l} está frenado por rate limit. Esperá o sacalo de la cadena.`,
});

/** Días en el orden semanal que usa `rest-mode-window.js`. */
const DAY_NAMES = Object.freeze([
    'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
]);

/** Tope de pasadas del merge de períodos. Backstop anti-loop infinito. */
const MERGE_MAX_PASSES = 8;

/** Tope de períodos por día que aceptamos del archivo. Defensa anti-DoS. */
const MAX_PERIODS_PER_DAY = 24;

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// -----------------------------------------------------------------------------
// Helpers puros
// -----------------------------------------------------------------------------

function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Formatea el porcentaje de cuota. Devuelve '' si no hay medición (UX-3).
 *
 * OJO con `Number()`: `Number(null)` y `Number('')` son `0`, ambos finitos. Un
 * chequeo con `Number.isFinite(Number(pct))` haría que un provider SIN medición
 * (`quota.pct: null`, que es el caso real de openai/cerebras/nvidia en el
 * snapshot vivo) reportara `cuota agotada (0 %)` — un dato inventado y además
 * invertido. Por eso exigimos `typeof number`.
 */
function formatPct(pct) {
    if (typeof pct !== 'number' || !Number.isFinite(pct)) return '';
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    return `${clamped} %`;
}

/** Normaliza un id de salud al id canónico que usan las cadenas. */
function canonicalProviderId(id) {
    if (typeof id !== 'string') return null;
    if (!PROVIDER_ID_RE.test(id)) return null;
    return Object.prototype.hasOwnProperty.call(PROVIDER_ALIAS, id)
        ? PROVIDER_ALIAS[id]
        : id;
}

function hhmmToMinutes(hhmm) {
    const m = HHMM_RE.exec(String(hhmm || ''));
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
}

// -----------------------------------------------------------------------------
// Lectura del snapshot de salud (SEC-4 — input no confiable)
// -----------------------------------------------------------------------------

/** Resuelve el directorio de estado. Inyectable por `opts.stateDir` (CA-12). */
function resolveStateDir(opts = {}) {
    if (opts.stateDir) return String(opts.stateDir);
    if (healthCronLib && typeof healthCronLib.defaultStateDir === 'function') {
        try { return String(healthCronLib.defaultStateDir()); } catch { /* fallback */ }
    }
    return path.resolve(__dirname, '..', 'state');
}

function snapshotFilename() {
    if (healthCronLib && typeof healthCronLib.SNAPSHOT_FILENAME === 'string') {
        return healthCronLib.SNAPSHOT_FILENAME;
    }
    return SNAPSHOT_FILENAME_FALLBACK;
}

/**
 * Umbral de frescura DERIVADO de la cadencia real del cron (`config.yaml`),
 * no hardcodeado. `readTickIntervalMs()` sólo lee disco — no dispara ningún
 * chequeo en línea contra proveedores (CA-11 / R6).
 */
function staleThresholdMs(opts = {}) {
    if (Number.isFinite(opts.staleMs) && opts.staleMs > 0) return Number(opts.staleMs);
    let tick = DEFAULT_TICK_INTERVAL_MS;
    if (healthCronLib && typeof healthCronLib.readTickIntervalMs === 'function') {
        try {
            const v = Number(healthCronLib.readTickIntervalMs());
            if (Number.isFinite(v) && v > 0) tick = v;
        } catch { /* default */ }
    }
    return tick * STALE_TICKS;
}

/**
 * Lee y valida el snapshot de salud.
 *
 * NUNCA lanza. Degrada ante: archivo ausente, JSON corrupto, o JSON válido con
 * forma inesperada (`providers` no es array) — CA-7.
 *
 * Las filas se indexan campo por campo POR NOMBRE sobre un objeto sin prototipo:
 * `{...entry}` / `Object.assign` sobre claves del archivo abriría prototype
 * pollution, porque el archivo lo escribe otro proceso (SEC-4).
 *
 * @returns {{
 *   degraded: boolean, stale: boolean, tsMs: number|null,
 *   ageMs: number|null, ageMinutes: number|null,
 *   byProvider: object, file: string
 * }}
 */
function readHealthSnapshot(opts = {}) {
    const now = Number.isFinite(opts.now) ? Number(opts.now) : Date.now();
    const file = path.join(resolveStateDir(opts), snapshotFilename());
    const out = {
        degraded: true,
        stale: false,
        tsMs: null,
        ageMs: null,
        ageMinutes: null,
        byProvider: Object.create(null),
        file,
    };

    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch {
        return out; // ausente / ilegible → degradado, sin excepción (CA-7)
    }

    let snap;
    try {
        snap = JSON.parse(raw);
    } catch {
        return out; // corrupto → degradado (CA-7)
    }

    // "Parsea pero tiene forma inesperada" también degrada (SEC-4).
    if (!isPlainObject(snap) || !Array.isArray(snap.providers)) return out;

    const byProvider = Object.create(null);
    for (const entry of snap.providers) {
        if (!isPlainObject(entry)) continue;

        // Lectura campo por campo POR NOMBRE. Nunca spread de claves del archivo.
        const rawId = typeof entry.provider === 'string' ? entry.provider : null;
        const id = canonicalProviderId(rawId);
        if (!id) continue; // id fuera del patrón seguro → fila descartada (SEC-4)

        const label = typeof entry.label === 'string' ? entry.label : '';
        const state = typeof entry.state === 'string' ? entry.state : '';
        const reasonCode = typeof entry.reason_code === 'string' ? entry.reason_code : '';

        // `typeof number` estricto: `quota.pct: null` es el caso NORMAL para los
        // providers sin adapter de medición. Coercionarlo daría `0 %`.
        let quotaPct = null;
        if (isPlainObject(entry.quota) && typeof entry.quota.pct === 'number'
            && Number.isFinite(entry.quota.pct)) {
            quotaPct = entry.quota.pct;
        }

        // `key_status` y `auth_mode` NO se leen a propósito: SEC-3 los prohíbe
        // en el texto y no aportan a la clasificación por categoría (el
        // `reason_code` ya la determina). No leerlos es la garantía más simple
        // de que no pueden filtrarse al mensaje.

        byProvider[id] = { id, rawId, label, state, reasonCode, quotaPct };
    }

    let tsMs = null;
    if (typeof snap.ts === 'string' || typeof snap.ts === 'number') {
        const parsed = Date.parse(snap.ts);
        if (Number.isFinite(parsed)) tsMs = parsed;
    }

    const threshold = staleThresholdMs(opts);
    let stale = true;
    let ageMs = null;
    if (tsMs !== null) {
        ageMs = Math.max(0, now - tsMs);
        stale = ageMs > threshold;
    }
    // `ts` ausente o no parseable → stale (no podemos afirmar frescura, SEC-7).

    out.degraded = false;
    out.stale = stale;
    out.tsMs = tsMs;
    out.ageMs = ageMs;
    out.ageMinutes = ageMs === null ? null : Math.round(ageMs / 60000);
    out.byProvider = byProvider;
    return out;
}

// -----------------------------------------------------------------------------
// Merge de períodos contiguos (CA-4 — el riesgo que levantó `guru`)
// -----------------------------------------------------------------------------

/**
 * Normaliza el schedule del archivo a `{ day: [{start, end}] }` con validación
 * estricta de HH:MM. Descarta lo que no matchea en vez de confiar.
 */
function normalizeSchedule(schedule) {
    const out = {};
    for (const day of DAY_NAMES) {
        const arr = isPlainObject(schedule) && Array.isArray(schedule[day]) ? schedule[day] : [];
        const periods = [];
        for (const p of arr.slice(0, MAX_PERIODS_PER_DAY)) {
            if (!isPlainObject(p)) continue;
            const start = typeof p.start === 'string' ? p.start : '';
            const end = typeof p.end === 'string' ? p.end : '';
            if (hhmmToMinutes(start) === null || hhmmToMinutes(end) === null) continue;
            if (start === end) continue; // período degenerado: no participa del merge
            periods.push({ start, end });
        }
        periods.sort((a, b) => hhmmToMinutes(a.start) - hhmmToMinutes(b.start));
        out[day] = periods;
    }
    return out;
}

/**
 * Fusiona períodos CONTIGUOS de un schedule de reposo, incluido el cruce por
 * medianoche entre días distintos.
 *
 * POR QUÉ EXISTE (CA-4, bloqueante). `anthropic` tiene lunes
 * `[00:00-07:00]` + `[20:00-00:00]`, que en la práctica son un solo bloque
 * continuo con el `[00:00-07:00]` del martes. Sin fusionar,
 * `nextWindowTransition` a las 21:00 del lunes reporta reanudación a las
 * **00:00** — pero el pipeline sigue dormido hasta las **07:00**. Un error de
 * 4 horas en el único dato que al operador le importa: exactamente la
 * desinformación que #5467 existe para eliminar.
 *
 * POR QUÉ ACÁ Y NO EN `rest-mode-window.js`. `nextWindowTransition` e
 * `isSkillAllowedNow` son API estable que consume `pulpo.js` para el gate de
 * rest-mode. Cambiarles la semántica tiene un blast radius mucho mayor que
 * este issue. Normalizamos en memoria y le pasamos un window ya fusionado.
 *
 * Tolera días SIN bloque nocturno contiguo sin inventar uno (viernes a domingo
 * de `anthropic` sólo tienen `00:00-07:00`).
 *
 * @param {object} schedule — `{ monday: [{start,end}], ... }`
 * @returns {object} schedule nuevo, sin mutar el original.
 */
function mergeContiguousPeriods(schedule) {
    const days = normalizeSchedule(schedule);

    for (let pass = 0; pass < MERGE_MAX_PASSES; pass++) {
        let changed = false;

        for (let d = 0; d < DAY_NAMES.length; d++) {
            const dayName = DAY_NAMES[d];
            const periods = days[dayName];

            for (const p of periods) {
                if (p.end === '00:00') {
                    // Cruce de medianoche: buscar en el día siguiente un período
                    // que arranque justo a las 00:00.
                    const nextName = DAY_NAMES[(d + 1) % DAY_NAMES.length];
                    const nextPeriods = days[nextName];
                    const idx = nextPeriods.findIndex(q => q !== p && q.start === '00:00');
                    if (idx >= 0) {
                        const absorbed = nextPeriods[idx];
                        // Guard anti-loop: no absorber algo que devuelva el
                        // período a su propio estado (`00:00-00:00` ya lo filtra
                        // `normalizeSchedule`, esto es defensa redundante).
                        if (absorbed.end !== p.end) {
                            p.end = absorbed.end;
                            nextPeriods.splice(idx, 1);
                            changed = true;
                        }
                    }
                } else {
                    // Contigüidad intra-día: `08:00-12:00` + `12:00-15:00`.
                    const idx = periods.findIndex(q => q !== p && q.start === p.end);
                    if (idx >= 0) {
                        const absorbed = periods[idx];
                        if (absorbed.end !== p.end) {
                            p.end = absorbed.end;
                            periods.splice(idx, 1);
                            changed = true;
                        }
                    }
                }
            }
        }

        if (!changed) break;
    }

    return days;
}

// -----------------------------------------------------------------------------
// Estado de reposo por proveedor
// -----------------------------------------------------------------------------

/**
 * ¿El proveedor está dentro de su ventana de reposo AHORA? Y si sí, ¿hasta
 * cuándo, con los períodos contiguos ya fusionados?
 *
 * FAIL-OPEN PRESERVADO (R3): sin schedule, con `active:false`, o si los módulos
 * no cargaron, devuelve `{ resting: false }`. Un proveedor NUNCA se clasifica
 * `reposo` por ausencia de datos.
 *
 * OJO (UX-V3): `isProviderActiveNow(provider, now, opts)` tiene firma
 * POSICIONAL. Pasarle `{now}` como 2º argumento se ignora en silencio y cae al
 * reloj real. Acá no la usamos: derivamos todo del window fusionado, que es
 * determinístico e inyectable.
 *
 * @returns {{ resting: boolean, atHHMM?: string, when?: 'today'|'tomorrow',
 *             minutesFromNow?: number }}
 */
function restStatusFor(providerId, nowMs, opts = {}) {
    const schedLib = opts.scheduleModule || providerScheduleLib;
    const rmw = opts.restWindowModule || restWindowLib;
    if (!schedLib || !rmw) return { resting: false };
    if (typeof rmw.describeRestModeNow !== 'function' || typeof rmw.nextWindowTransition !== 'function') {
        return { resting: false };
    }

    // R5: provider fuera de VALID_PROVIDERS → `getProviderSchedule` devuelve
    // null. Guard antes de usar.
    let sched = null;
    try {
        if (typeof schedLib.isValidProvider === 'function' && !schedLib.isValidProvider(providerId)) {
            return { resting: false };
        }
        sched = schedLib.getProviderSchedule(providerId, opts);
    } catch {
        return { resting: false }; // fail-open
    }
    if (!isPlainObject(sched) || !sched.active) return { resting: false };

    const window = {
        active: true,
        schedule: mergeContiguousPeriods(sched.schedule),
        timezone: sched.timezone || undefined,
    };

    let desc = null;
    try { desc = rmw.describeRestModeNow(window, nowMs); } catch { return { resting: false }; }
    if (!desc || !desc.isWithinNow) return { resting: false };

    let trans = null;
    try { trans = rmw.nextWindowTransition(window, nowMs); } catch { /* sin hora */ }
    if (!trans || trans.kind !== 'exit') return { resting: true };

    return {
        resting: true,
        atHHMM: trans.atHHMM,
        when: trans.when === 'tomorrow' ? 'tomorrow' : 'today',
        minutesFromNow: Number.isFinite(trans.minutesFromNow) ? trans.minutesFromNow : null,
    };
}

/** `hoy 07:00` / `mañana 07:00`. Día SIEMPRE explícito: `~07:00` a las 23:50 es ambiguo. */
function formatResumeClock(rest) {
    if (!rest || !rest.atHHMM) return '';
    return `${rest.when === 'tomorrow' ? 'mañana' : 'hoy'} ${rest.atHHMM}`;
}

// -----------------------------------------------------------------------------
// Clasificación
// -----------------------------------------------------------------------------

/**
 * Clasifica un proveedor de la cadena.
 *
 * REPOSO vs `reason_code`: se resuelve con la MISMA tabla de precedencia que la
 * causa dominante (`auth > cuota > transitoria > reposo > disponible`), aplicada
 * ahora al par (causa-del-snapshot, reposo). Una sola regla para los dos
 * niveles: menos superficie para que diverjan.
 *
 *   - Gana el reposo sobre `disponible`: un provider verde dentro de su ventana
 *     de descanso no está disponible para el dispatch, y decirle "disponible"
 *     al operador sería mentirle.
 *   - Pierde el reposo contra `auth` y `cuota`: esos problemas SOBREVIVEN al
 *     despertar. Si openai está en reposo Y con la cuota al 94 %, mostrar sólo
 *     "en reposo hasta 07:00" le promete al operador una recuperación que no va
 *     a ocurrir — la misma clase de desinformación que #5467 elimina.
 *   - Pierde el reposo contra `transitoria`: un provider que además no responde
 *     puede seguir sin responder al despertar. Es la opción CONSERVADORA —
 *     evita el titular `🌙 pausa programada` y su promesa de hora exacta cuando
 *     hay un síntoma que el schedule no explica.
 */
function classifyProvider(providerId, snapshot, nowMs, opts = {}) {
    const rest = restStatusFor(providerId, nowMs, opts);
    const entry = snapshot.byProvider[providerId] || null;
    const label = (entry && entry.label) ? entry.label : providerId;

    const restResult = () => {
        const clock = formatResumeClock(rest);
        return {
            id: providerId,
            label,
            cause: CAUSE_REPOSO,
            reasonCode: '',
            text: clock ? `en reposo hasta ${clock}` : 'en reposo programado',
            rest,
        };
    };

    // Reposo sin fila de salud: no hay nada que pueda ganarle.
    if (rest.resting && !entry) return restResult();

    if (rest.resting && entry) {
        const row = Object.prototype.hasOwnProperty.call(REASON_TABLE, entry.reasonCode)
            ? REASON_TABLE[entry.reasonCode]
            : null;
        const snapshotCause = row ? row.cause : CAUSE_TRANSITORIA;
        // Sólo `auth` y `cuota` (prioridad menor a la de reposo) lo desplazan.
        if (CAUSE_PRIORITY[snapshotCause] >= CAUSE_PRIORITY[CAUSE_REPOSO]) return restResult();
        return {
            id: providerId,
            label,
            cause: snapshotCause,
            reasonCode: entry.reasonCode,
            text: row.text(entry),
            rest,
        };
    }

    if (!entry) {
        // Sin fila de salud para este provider: no podemos afirmar una causa.
        return {
            id: providerId,
            label,
            cause: CAUSE_TRANSITORIA,
            reasonCode: '',
            text: REASON_LABEL_DEFAULT,
            rest,
        };
    }

    const row = Object.prototype.hasOwnProperty.call(REASON_TABLE, entry.reasonCode)
        ? REASON_TABLE[entry.reasonCode]
        : null;

    if (!row) {
        // Código fuera de la tabla cerrada → default explícito (SEC-1).
        return {
            id: providerId,
            label,
            cause: CAUSE_TRANSITORIA,
            reasonCode: entry.reasonCode,
            text: REASON_LABEL_DEFAULT,
            rest,
        };
    }

    return {
        id: providerId,
        label,
        cause: row.cause,
        reasonCode: entry.reasonCode,
        text: row.text(entry),
        rest,
    };
}

/** Elige la causa dominante por precedencia `auth > cuota > transitoria > reposo`. */
function pickDominantCause(providers) {
    let best = null;
    for (const p of providers) {
        if (p.cause === CAUSE_DISPONIBLE) continue;
        if (best === null || CAUSE_PRIORITY[p.cause] < CAUSE_PRIORITY[best]) best = p.cause;
    }
    return best;
}

/**
 * Arma la línea de acción para el operador.
 *
 * @returns {{ requiresAction: boolean, text: string }}
 */
function buildVerdict(dominant, providers, snapshot) {
    // SEC-7 · Con datos vencidos está PROHIBIDO prometer recuperación
    // automática. Afirmar "se recupera solo" con datos viejos puede hacer que
    // el operador no atienda una caída real.
    if (snapshot.stale) {
        const age = snapshot.ageMinutes;
        const ageTxt = Number.isFinite(age) ? ` (último hace ${age} min)` : '';
        return {
            requiresAction: true,
            text: `Requiere acción: no hay dato de salud fresco${ageTxt}. Revisá el chequeo periódico.`,
        };
    }

    if (dominant === CAUSE_REPOSO) {
        // El pipeline se reanuda cuando despierta el PRIMERO de la cadena.
        let soonest = null;
        for (const p of providers) {
            if (p.cause !== CAUSE_REPOSO || !p.rest || !p.rest.atHHMM) continue;
            const m = Number.isFinite(p.rest.minutesFromNow) ? p.rest.minutesFromNow : Infinity;
            if (soonest === null || m < soonest.m) soonest = { m, rest: p.rest };
        }
        const clock = soonest ? formatResumeClock(soonest.rest) : '';
        return {
            requiresAction: false,
            text: clock
                ? `Se recupera solo — reanuda ${clock}`
                : 'Se recupera solo — reintento automático',
        };
    }

    if (dominant === CAUSE_TRANSITORIA) {
        // No hay hora conocida y no hay acción que el operador pueda tomar
        // (CA-13). Prometer una sería inventar.
        return { requiresAction: false, text: 'Se recupera solo — reintento automático' };
    }

    // `auth` y `cuota` → requieren acción.
    const actionable = providers.filter(p => p.cause === CAUSE_AUTH || p.cause === CAUSE_CUOTA);
    if (actionable.length === 0) {
        return { requiresAction: true, text: 'Requiere acción: revisá la salud de los proveedores.' };
    }
    if (actionable.length === 1) {
        const p = actionable[0];
        const fn = Object.prototype.hasOwnProperty.call(ACTION_FULL, p.reasonCode)
            ? ACTION_FULL[p.reasonCode]
            : null;
        const body = fn ? fn(p.label) : `${p.label} no está disponible. Revisá su configuración.`;
        return { requiresAction: true, text: `Requiere acción: ${body}` };
    }

    const parts = actionable.slice(0, 3).map((p) => {
        const short = Object.prototype.hasOwnProperty.call(ACTION_SHORT, p.reasonCode)
            ? ACTION_SHORT[p.reasonCode]
            : 'no disponible';
        return `${p.label} ${short}`;
    });
    return {
        requiresAction: true,
        text: `Requiere acción: ${actionable.length} proveedores necesitan atención. ${parts.join(', ')}.`,
    };
}

/**
 * Punto de entrada. Clasifica la causa de una pausa a partir de la cadena
 * intentada.
 *
 * SÓLO LEE ARCHIVOS. No dispara ningún health-check contra proveedores: el
 * mensaje se arma en el camino de notificación, fuera del path crítico (CA-11).
 *
 * @param {string[]} chain — providers de `chain_tried` (ids canónicos).
 * @param {object} [opts] — `{ now, stateDir, staleMs, scheduleModule, restWindowModule }`.
 * @returns {{
 *   degraded: boolean, stale: boolean, ageMinutes: number|null,
 *   dominantCause: string|null, providers: object[],
 *   verdict: {requiresAction: boolean, text: string}|null
 * }}
 */
function classifyPauseCause(chain, opts = {}) {
    const nowMs = Number.isFinite(opts.now) ? Number(opts.now) : Date.now();
    const snapshot = readHealthSnapshot({ ...opts, now: nowMs });

    // CA-7 / UX-V2 · Sin snapshot no hay causa. Se degrada sin desglose y SIN
    // veredicto: afirmar uno sería inventar la atribución que el issue mata.
    if (snapshot.degraded) {
        return {
            degraded: true,
            stale: false,
            ageMinutes: null,
            dominantCause: null,
            providers: [],
            verdict: null,
        };
    }

    const seen = new Set();
    const ids = [];
    for (const raw of Array.isArray(chain) ? chain : []) {
        const id = canonicalProviderId(typeof raw === 'string' ? raw : '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
    }

    const providers = ids.map(id => classifyProvider(id, snapshot, nowMs, opts));
    let dominant = pickDominantCause(providers);

    // Cadena entera "disponible" según el snapshot pero el dispatch igual quedó
    // sin proveedor: no hay nada roto ni accionable, es un corte transitorio.
    if (dominant === null && providers.length > 0) dominant = CAUSE_TRANSITORIA;

    return {
        degraded: false,
        stale: snapshot.stale,
        ageMinutes: snapshot.ageMinutes,
        dominantCause: dominant,
        providers,
        verdict: dominant === null ? null : buildVerdict(dominant, providers, snapshot),
    };
}

module.exports = {
    // API pública
    classifyPauseCause,
    readHealthSnapshot,
    mergeContiguousPeriods,

    // Helpers expuestos para tests
    normalizeSchedule,
    restStatusFor,
    classifyProvider,
    pickDominantCause,
    buildVerdict,
    canonicalProviderId,
    formatPct,
    formatResumeClock,
    staleThresholdMs,

    // Constantes
    CAUSE_REPOSO,
    CAUSE_CUOTA,
    CAUSE_AUTH,
    CAUSE_TRANSITORIA,
    CAUSE_DISPONIBLE,
    CAUSE_PRIORITY,
    REASON_TABLE,
    REASON_LABEL_DEFAULT,
    ACTION_SHORT,
    ACTION_FULL,
    PROVIDER_ALIAS,
    PROVIDER_ID_RE,
    STALE_TICKS,
    DEFAULT_TICK_INTERVAL_MS,
};
