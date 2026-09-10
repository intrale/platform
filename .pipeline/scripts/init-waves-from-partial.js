#!/usr/bin/env node
// =============================================================================
// init-waves-from-partial.js — Seed inicial de waves.json desde .partial-pause.json
// Issue #3616.
//
// Por qué este script existe
// --------------------------
// Hasta #3616, `.partial-pause.json` era la fuente operativa real del intake
// (el pulpo mira `partialPause.isIssueAllowed()`), pero `waves.json` quedó
// vacío desde 2026-05-24 (sin source-of-truth de planificación). El fallback
// de `lib/waves.js:getAllowlist()` enmascaraba el problema durante días sin
// que nadie notara el desync.
//
// Este init **siembra** `waves.json` UNA sola vez (cuando arranca el pulpo y
// detecta el estado degradado) usando como input la allowlist actual de
// `.partial-pause.json`. Después de eso, el flujo Opción A queda armado:
//
//   waves.json (canónica) → /wave promote → .partial-pause.json (espejo)
//
// Garantías inquebrantables (PO CA-1 + security req 1)
// ----------------------------------------------------
//   - **Idempotente**: si `waves.json` ya tiene `active_wave != null`, no
//     toca nada. Re-ejecutable infinitas veces sin corromper estado.
//   - **Atómico**: write vía la capa de storage — en modo filesystem es el
//     mismo `atomicWriteFile` de siempre (tmp + fsync + rename, retry
//     EPERM/EBUSY en Windows); en modo remoto es un CAS contra la versión leída.
//     Cero archivos parciales, cero lost update entre instancias.
//   - **Fail-closed**: si `.partial-pause.json` está malformado (IDs no
//     enteros, payload inesperado, campos extra que no parsean), aborta sin
//     tocar `waves.json` + log explícito + Telegram dedupedo.
//   - **Cero deps npm**: sólo libs internas del pipeline (la capa de storage
//     `operational-state-backend`, waves, notify-telegram).
//   - **Sin red**: no llama a GitHub ni servicios externos.
//
// Numeración (guru riesgo #4)
// ---------------------------
// La ola sembrada usa `number = max(archived.number) + 1` (default `1` si no
// hay archivadas). Esto es un seed conservador — el operador puede renombrar
// después con `/wave promote N` si quiere otro número, pero el init no inventa
// nombres tipo "N+11" ni los lee del environment.
//
// API
// ---
//   initWavesFromPartial(opts?) →
//     { action, reason?, seededWave?, waveNumber?, allowlist?, skipAlert? }
//
//   action ∈ { 'noop_already_seeded', 'noop_no_partial', 'noop_empty_partial',
//              'seeded', 'aborted_invalid_partial', 'aborted_waves_corrupt',
//              'aborted_remote_degraded' }
//
// Ejecutar como CLI (para debugging):
//   node .pipeline/scripts/init-waves-from-partial.js [--dry-run]
// =============================================================================

'use strict';

// #5113 CA-C1 — Este módulo ya no importa `fs` ni resuelve el root del pipeline:
// no le queda ni un acceso físico al estado. Todo pasa por la capa de storage,
// que es la que sabe si hoy el registro de olas vive en un archivo o en el store
// remoto. Que el `require('fs')` haya desaparecido del archivo NO es cosmético:
// es la propiedad que hace verificable "cero segunda fuente de verdad".

// #5179 grupo 3b — los paths de estado NO se construyen a mano: se los pide a
// los módulos DUEÑOS del estado, que los resuelven honrando
// `PIPELINE_DIR_OVERRIDE` igual que `pipelineDir()`.
//
// Por qué el seed no consume la superficie pública del envoltorio (y no es un
// bypass): este script es el BOOTSTRAP que corre justo sobre los estados en los
// que los lectores estrictos del envoltorio TIRAN — `waves.json` ausente o
// corrupto — y cuyo trabajo es precisamente crearlo/repararlo. Además necesita
// el payload CRUDO de `.partial-pause.json` (`wave_number`, `wave_name`, `note`)
// con su propia validación fail-closed, y esos campos no viajan en
// `getDispatchState()`. Opera deliberadamente por debajo de la abstracción; lo
// que sí respeta es la propiedad del path.
//
// #5113 CA-C1 (rebote rev-1) — Operar por debajo de la FACHADA no autoriza a
// operar por debajo del SUSTRATO. Este script leía y escribía con `fs` los dos
// paths que le daban los dueños, así que con el flag de cutover encendido
// sembraba una ola en `waves.json` local mientras el pipeline leía el store
// remoto: dos fuentes de verdad simultáneas en el propio boot del pulpo, y un
// log de "waves.json sembrado" que el resto del pipeline no veía. El bootstrap
// pasa a resolverse contra `operational-state-backend`, que es exactamente la
// capa que necesita: crudo, tolerante y con la misma noción de ausencia.
//
// Ya no se pide `_paths()` a los dueños: pedir el path FISICO del estado desde
// fuera del sustrato es el bypass que la regla `paths-indirect` del guardrail
// marca desde #5113 — es como este defecto quedo invisible para el grep de
// control. El path sobrevive solo como ETIQUETA de los mensajes al operador, y
// lo da la propia capa de storage (`fileFor`), que sabe si hoy significa algo.
function backend() { return require('../lib/operational-state-backend'); }

/**
 * Etiqueta del sustrato para los mensajes: en modo remoto no hay archivo que
 * mirar, y decirle al operador "revisá .pipeline/waves.json" cuando el dato
 * vive en el store lo manda al lugar equivocado.
 */
function labelFor(key) {
    try {
        const b = backend();
        if (!b.isRemote()) return b.fileFor(key);
    } catch { /* si el backend no carga, caemos al nombre lógico */ }
    return `store remoto [${key}]`;
}

// ─── Sanitización defensiva ─────────────────────────────────────────────────

function normalizeIssue(issue) {
    // Trim + strip de `#` opcional — patrón replicado de lib/waves.js.
    const n = Number(String(issue).trim().replace(/^#/, ''));
    return Number.isInteger(n) && n > 0 ? n : null;
}

// ─── #4030 — Metadata real de la ola (nombre/número del plan maestro) ────────
//
// El seeder recupera el nombre/número reales de la ola activa para que
// sobrevivan a un `/restart` sin renombrado manual. Fuente de verdad en orden
// de preferencia:
//   1. Campos estructurados `wave_number`/`wave_name`/`wave_goal` (robusto).
//   2. Parseo del `note` de texto libre (fallback de compatibilidad, tolerante).
//   3. `Ola seed #N` (último recurso, en el constructor del seed).
//
// Ambos extractores son TOLERANTES A FALLO: nunca lanzan ni convierten el
// payload en `aborted_invalid_partial`. Un meta inválido degrada al fallback.

/**
 * Saneado fail-closed de los campos estructurados (security #4030):
 *   - `wave_number`: entero positivo.
 *   - `wave_name`: string, strip de control-chars (U+0000..U+001F), cap 120.
 *   - `wave_goal`: string opcional, strip de control-chars, cap 500.
 * Convención de display (UX #4030): el `name` guarda SÓLO el título; si viene
 * con prefijo "Ola N — " se normaliza quitándolo. Devuelve null si falta
 * número+nombre válidos.
 */
function sanitizeWaveMeta(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;
    const stripCtl = (s) => String(s).replace(/[\x00-\x1f]/g, '').trim();
    const num = Number.isInteger(parsed.wave_number) && parsed.wave_number > 0
        ? parsed.wave_number : null;
    const rawName = typeof parsed.wave_name === 'string' ? stripCtl(parsed.wave_name) : '';
    const name = rawName
        ? rawName.replace(/^Ola\s+\d+\s*[—–-]\s*/i, '').slice(0, 120)
        : null;
    const goal = typeof parsed.wave_goal === 'string'
        ? stripCtl(parsed.wave_goal).slice(0, 500) : '';
    if (num === null || !name) return null;
    return { number: num, name, goal };
}

/**
 * Fallback de compatibilidad: parsea el `note` de texto libre del Commander
 * (ej. "Ola 4 'Memoria + dashboard operativo núcleo' habilitada por..."). Tolera
 * comillas simples, dobles y tipográficas. NO lanza ni loguea el contenido
 * crudo (security req 3). Si no matchea, devuelve null.
 */
function parseWaveMetaFromNote(note) {
    if (typeof note !== 'string' || !note) return null;
    const stripCtl = (s) => String(s).replace(/[\x00-\x1f]/g, '').trim();
    const m = note.match(/Ola\s+(\d+)\s+['"‘’“”]([^'"‘’“”]+)['"‘’“”]/);
    if (!m) return null;
    const num = Number(m[1]);
    if (!Number.isInteger(num) || num <= 0) return null;
    const name = stripCtl(m[2]).slice(0, 120);
    if (!name) return null;
    return { number: num, name, goal: '' };
}

/**
 * Extrae la metadata de ola del payload, preferencia estructurado > note > null.
 * Tolerante a fallo: nunca lanza.
 */
function extractWaveMeta(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;
    return sanitizeWaveMeta(parsed) || parseWaveMetaFromNote(parsed.note) || null;
}

function nowIso() {
    return new Date().toISOString();
}

function logInfo(msg) {
    console.log(`[init-waves] ${msg}`);
}

function logWarn(msg) {
    console.warn(`[init-waves] ${msg}`);
}

/**
 * Lee `.partial-pause.json` y devuelve `{ ok, allowedIssues, errors, raw }`.
 * Fail-closed: si CUALQUIER allowed_issue no es entero positivo, devuelve
 * ok=false + lista de errores. NO acepta payloads parciales.
 *
 * Aceptación CA-1 + security req 1:
 *   - `allowed_issues` debe ser array.
 *   - cada entrada debe normalizar a int positivo.
 *   - campos extra del payload no rompen — son ignorados (forward compat).
 */
function readPartialStrict() {
    const b = backend();
    const res = b.readKeyWithVersion(b.KEYS.PARTIAL_PAUSE);
    // #5113 CA-A7 — degradación del store ⇒ ABORTAR, jamás degradar a
    // filesystem. Con el store mudo no sabemos si hay allowlist: sembrar una ola
    // con lo que quedó en el disco del host resucita autorizaciones revocadas.
    if (res.degraded) {
        return {
            ok: false,
            action: 'aborted_remote_degraded',
            allowedIssues: [],
            errors: [`store del estado operativo no disponible: ${res.error ? res.error.message : 'sin detalle'}`],
        };
    }
    if (res.error) {
        return {
            ok: false,
            action: 'aborted_invalid_partial',
            allowedIssues: [],
            errors: [res.error.opstateKind === 'parse'
                ? `JSON inválido: ${res.error.message}`
                : `read falló: ${res.error.message}`],
        };
    }
    // Ausencia legítima (ENOENT local o clave inexistente en el store).
    if (res.value === null || res.value === undefined) {
        return { ok: true, action: 'noop_no_partial', allowedIssues: [], errors: [] };
    }
    const parsed = res.value;
    if (!parsed || typeof parsed !== 'object') {
        return {
            ok: false,
            action: 'aborted_invalid_partial',
            allowedIssues: [],
            errors: ['payload no es un objeto'],
        };
    }
    if (!Array.isArray(parsed.allowed_issues)) {
        return {
            ok: false,
            action: 'aborted_invalid_partial',
            allowedIssues: [],
            errors: ['allowed_issues ausente o no-array'],
        };
    }
    // Fail-closed: si cualquier ID no normaliza a int positivo, abortamos.
    // No "filtramos los buenos" silenciosamente — el operador necesita saber
    // que su payload tiene basura antes de que el init siembre estado.
    const errors = [];
    const allowed = [];
    for (const raw of parsed.allowed_issues) {
        const n = normalizeIssue(raw);
        if (n === null) {
            errors.push(`ID inválido: ${JSON.stringify(raw)}`);
        } else {
            allowed.push(n);
        }
    }
    if (errors.length > 0) {
        return {
            ok: false,
            action: 'aborted_invalid_partial',
            allowedIssues: [],
            errors,
        };
    }
    // Deduplicar manteniendo orden de aparición.
    const unique = [...new Set(allowed)];
    // #4030 — Extracción tolerante de metadata de ola (aditiva, NO fail-closed):
    // un meta ausente/inválido degrada a null y el seed cae al fallback genérico.
    const waveMeta = extractWaveMeta(parsed);
    return { ok: true, allowedIssues: unique, errors: [], waveMeta };
}

/**
 * Lee `waves.json` (si existe) y devuelve `{ ok, hasActiveWave, maxArchivedNumber, errors }`.
 *
 * - Si no existe: ok=true, hasActiveWave=false, maxArchivedNumber=0.
 * - Si existe y parsea: revisa `active_wave` y `archived_waves[*].number`.
 * - Si existe pero está corrupto: ok=false, errors. NO tocamos en ese caso —
 *   el desync-detector y el recovery del Commander lo manejan.
 */
function readWavesState() {
    const b = backend();
    const res = b.readKeyWithVersion(b.KEYS.WAVES);
    // #5113 CA-C1 — La guarda de idempotencia (`hasActiveWave`) resuelve contra
    // el MISMO sustrato que el resto del pipeline. Resolverla leyendo el disco
    // en régimen remoto la dejaba ciega: veía un `waves.json` local vacío,
    // concluía "no hay ola" y volvía a sembrar sobre estado ya migrado.
    if (res.degraded) {
        return {
            ok: false,
            action: 'aborted_remote_degraded',
            hasActiveWave: false,
            maxArchivedNumber: 0,
            errors: [`store del estado operativo no disponible: ${res.error ? res.error.message : 'sin detalle'}`],
        };
    }
    if (res.error) {
        return {
            ok: false,
            action: 'aborted_waves_corrupt',
            hasActiveWave: false,
            maxArchivedNumber: 0,
            errors: [res.error.opstateKind === 'parse'
                ? `JSON inválido: ${res.error.message}`
                : `read falló: ${res.error.message}`],
        };
    }
    const parsed = res.value;
    if (parsed === null || parsed === undefined) {
        return {
            ok: true,
            hasActiveWave: false,
            maxArchivedNumber: 0,
            nextWaveNumber: 1,
            preservedIdentity: null,
            raw: null,
            version: null,
        };
    }
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
            ok: false,
            action: 'aborted_waves_corrupt',
            hasActiveWave: false,
            maxArchivedNumber: 0,
            errors: ['payload no es un objeto'],
        };
    }
    // active_wave != null + es objeto + tiene number → ya hay ola activa.
    const hasActiveWave = !!(parsed.active_wave && typeof parsed.active_wave === 'object'
        && Number.isInteger(parsed.active_wave.number));
    // Calcular max archived number para el seed (guru riesgo #4).
    let maxArchivedNumber = 0;
    const archived = Array.isArray(parsed.archived_waves) ? parsed.archived_waves : [];
    for (const w of archived) {
        if (w && Number.isInteger(w.number) && w.number > maxArchivedNumber) {
            maxArchivedNumber = w.number;
        }
    }
    // Considerar también planned_waves para no chocar con números ya planificados.
    const planned = Array.isArray(parsed.planned_waves) ? parsed.planned_waves : [];
    for (const w of planned) {
        if (w && Number.isInteger(w.number) && w.number > maxArchivedNumber) {
            maxArchivedNumber = w.number;
        }
    }
    // #4446 — contador monotónico persistido. Es la fuente de identidad del seed:
    // si existe en `meta.next_wave_number` (entero ≥ 1) lo usamos tal cual; si no,
    // backfill `max(existentes) + 1` (incluye active_wave si lo hubiera). NUNCA se
    // deriva la identidad del `waveMeta.number` externo del .partial-pause.json.
    let maxKnown = maxArchivedNumber;
    if (parsed.active_wave && Number.isInteger(parsed.active_wave.number) && parsed.active_wave.number > maxKnown) {
        maxKnown = parsed.active_wave.number;
    }
    const persistedCounter = parsed.meta && Number.isInteger(parsed.meta.next_wave_number)
        && parsed.meta.next_wave_number >= 1
        ? parsed.meta.next_wave_number
        : null;
    const nextWaveNumber = persistedCounter !== null ? persistedCounter : (maxKnown + 1);
    // #4532 — Identidad persistida de la ola (número/título/goal/comienzo),
    // escrita por `waves.js` en cada save (`meta.active_wave_identity`). Cuando
    // `active_wave` se vació (wipe/restore parcial), esta sombra permite RECUPERAR
    // la identidad real en el re-seed en vez de mintear placeholders. Se sanea:
    // sólo se acepta si trae un `number` entero positivo.
    let preservedIdentity = null;
    const rawIdentity = parsed.meta && parsed.meta.active_wave_identity;
    if (rawIdentity && typeof rawIdentity === 'object'
        && Number.isInteger(rawIdentity.number) && rawIdentity.number > 0) {
        const stripCtl = (s) => (typeof s === 'string' ? s.replace(/[\x00-\x1f]/g, '').trim() : null);
        preservedIdentity = {
            number: rawIdentity.number,
            name: stripCtl(rawIdentity.name) || null,
            goal: stripCtl(rawIdentity.goal) || null,
            started_at: (typeof rawIdentity.started_at === 'string'
                && Number.isFinite(Date.parse(rawIdentity.started_at)))
                ? rawIdentity.started_at : null,
        };
    }
    // `version` viaja hasta el write: es el `expectedVersion` del CAS remoto
    // (CA-A4). Sin él, dos instancias booteando a la vez sembrarían dos olas
    // distintas y la última ganaría en silencio.
    return { ok: true, hasActiveWave, maxArchivedNumber, nextWaveNumber, preservedIdentity, raw: parsed, version: res.version };
}

/**
 * Notifica Telegram con dedupe simple por boot (flag in-memory por proceso).
 * Si Telegram no está disponible (require falla, settings inválidas), no rompe.
 */
let _telegramSentForBoot = false;
function notifyOnceForBoot(payload) {
    if (_telegramSentForBoot) return false;
    _telegramSentForBoot = true;
    try {
        const { notifyTelegram } = require('../lib/notify-telegram');
        notifyTelegram(payload);
        return true;
    } catch (err) {
        logWarn(`notifyTelegram falló: ${err.message}`);
        return false;
    }
}

// Reset interno para tests — permite que cada caso simule un boot fresco.
function _resetDedupeForTests() {
    _telegramSentForBoot = false;
}

/**
 * Punto de entrada principal.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false] — si true, no escribe waves.json.
 * @param {boolean} [opts.skipAlert=false] — si true, no envía Telegram.
 * @returns {{
 *   action: 'noop_already_seeded'|'noop_no_partial'|'noop_empty_partial'|
 *           'seeded'|'aborted_invalid_partial'|'aborted_waves_corrupt'|
 *           'aborted_remote_degraded',
 *   reason?: string,
 *   seededWave?: object,
 *   waveNumber?: number,
 *   allowlist?: number[],
 *   alerted?: boolean,
 *   errors?: string[],
 * }}
 */
function initWavesFromPartial(opts = {}) {
    const dryRun = opts.dryRun === true;
    const skipAlert = opts.skipAlert === true;

    // 1. Leer el registro de olas — si está corrupto o el store no responde,
    //    abortamos sin tocar.
    const wavesState = readWavesState();
    if (!wavesState.ok) {
        const degradado = wavesState.action === 'aborted_remote_degraded';
        const etiqueta = labelFor(backend().KEYS.WAVES);
        logWarn(degradado
            ? `store del estado operativo no disponible, init abortado: ${wavesState.errors.join('; ')}`
            : `${etiqueta} corrupto, no toco: ${wavesState.errors.join('; ')}`);
        if (!skipAlert) {
            notifyOnceForBoot({
                level: 'error',
                component: 'init-waves',
                message: degradado
                    ? 'estado operativo remoto no disponible, init abortado'
                    : 'registro de olas corrupto, init abortado',
                detail: wavesState.errors.join('; ').slice(0, 200),
                action: degradado
                    ? 'El store del estado operativo no respondió. El init NO sembró nada y NO ' +
                        'degradó a filesystem (CA-A7). Revisá conectividad/credenciales; el rollback ' +
                        'es `operational_state.durable: false` + reinicio.'
                    : `Revisá ${etiqueta}. El init NO modificó el estado. ` +
                        'El desync-detector va a alertar también si el partial-pause queda sin canónica.',
            });
        }
        return {
            action: wavesState.action || 'aborted_waves_corrupt',
            reason: degradado ? 'store del estado operativo no disponible' : 'registro de olas corrupto',
            errors: wavesState.errors,
        };
    }

    // 2. Idempotencia: si ya hay ola activa, NO tocar (CA-1 punto 3).
    if (wavesState.hasActiveWave) {
        logInfo(`${labelFor(backend().KEYS.WAVES)} ya tiene active_wave `
            + `(number=${wavesState.raw.active_wave.number}) — no-op.`);
        return {
            action: 'noop_already_seeded',
            reason: 'active_wave existe',
            waveNumber: wavesState.raw.active_wave.number,
        };
    }

    // 3. Leer .partial-pause.json — si está malformado, fail-closed.
    const partial = readPartialStrict();
    if (!partial.ok) {
        const degradado = partial.action === 'aborted_remote_degraded';
        const etiqueta = labelFor(backend().KEYS.PARTIAL_PAUSE);
        logWarn(degradado
            ? `store del estado operativo no disponible, init abortado: ${partial.errors.join('; ')}`
            : `${etiqueta} malformado, init abortado: ${partial.errors.join('; ')}`);
        if (!skipAlert) {
            // Importante: NO incluir el raw del archivo (security req 3) — solo
            // contar cuántos errores hubo y el primer error para diagnóstico.
            const firstError = partial.errors[0] || 'desconocido';
            notifyOnceForBoot({
                level: 'error',
                component: 'init-waves',
                message: degradado
                    ? 'estado operativo remoto no disponible, init abortado'
                    : 'allowlist de la ola malformada, init abortado',
                detail: `${partial.errors.length} error(es); primero: ${firstError.slice(0, 120)}`,
                action: degradado
                    ? 'El store del estado operativo no respondió. El init NO sembró nada y NO ' +
                        'degradó a filesystem (CA-A7): la allowlist local puede tener autorizaciones ' +
                        'ya revocadas. Rollback: `operational_state.durable: false` + reinicio.'
                    : `Revisá ${etiqueta}. ` +
                        'El init NO sembró el registro de olas. Allowlist queda vacía hasta que se corrija.',
            });
        }
        return {
            action: degradado ? 'aborted_remote_degraded' : 'aborted_invalid_partial',
            reason: degradado ? 'store del estado operativo no disponible' : 'partial-pause malformado',
            errors: partial.errors,
        };
    }

    // 4. Si no hay partial-pause o está vacío, no hay nada que sembrar.
    //    Esto NO es un error — es un estado válido (pipeline fresco, sin issues
    //    en intake). El desync-detector ya tolera este caso.
    if (partial.action === 'noop_no_partial' || partial.allowedIssues.length === 0) {
        const reason = partial.action === 'noop_no_partial'
            ? `no hay allowlist en ${labelFor(backend().KEYS.PARTIAL_PAUSE)}`
            : 'allowlist vacía';
        logInfo(`Nada para sembrar (${reason}) — no-op.`);
        return {
            action: partial.action === 'noop_no_partial' ? 'noop_no_partial' : 'noop_empty_partial',
            reason,
        };
    }

    // 5. Construir el seed: ola activa con los issues del allowlist.
    //    #4446 — La IDENTIDAD (número) de la ola sembrada sale del contador
    //    monotónico persistido (`meta.next_wave_number`), NO de `maxArchivedNumber
    //    + 1` ni del `waveMeta.number` externo del .partial-pause.json (fuente
    //    semi-confiable). Así un re-seed post-restart conserva el número sin
    //    reasignarlo desde metadata externa. El contador se incrementa y se
    //    persiste en el newState.meta más abajo.
    //    Guard de colisión defensivo (riesgo guru #1 + security #4): el contador
    //    monotónico es por diseño > cualquier archived/planned; si por un state
    //    corrupto quedara ≤ max conocido, lo elevamos a `maxArchivedNumber + 1`.
    // #4532 — RECUPERACIÓN DE IDENTIDAD. Si existe una identidad persistida
    // (`meta.active_wave_identity`, escrita por waves.js mientras había ola
    // activa), este re-seed NO está comenzando una ola nueva: la ola se vació
    // (wipe/restore parcial) y la estamos reconstruyendo. En ese caso preservamos
    // número, título, goal y —crítico— el `started_at` ORIGINAL (nunca `nowIso()`,
    // que es justo el bug de este issue: comienzo/velocidad reseteados). La
    // identidad SÓLO se mintea de cero cuando no hay identidad previa (primer
    // arranque real del pipeline).
    let waveNumber;
    let name;
    let goal;
    let startedAt;
    let preservingIdentity = false;
    let counterOverride = null; // si preservamos, no incrementamos el contador
    if (wavesState.preservedIdentity) {
        preservingIdentity = true;
        const pi = wavesState.preservedIdentity;
        waveNumber = pi.number;
        name = pi.name || `Ola ${waveNumber}`;
        goal = pi.goal || 'Ola recuperada tras reinicio — identidad preservada (#4532).';
        startedAt = pi.started_at || nowIso();
        // El contador ya reflejaba esta identidad; lo conservamos tal cual (no
        // "gastamos" un número nuevo por reconstruir la misma ola).
        counterOverride = (wavesState.raw && wavesState.raw.meta
            && Number.isInteger(wavesState.raw.meta.next_wave_number))
            ? wavesState.raw.meta.next_wave_number
            : (waveNumber + 1);
        logInfo(`Identidad de ola RECUPERADA de meta.active_wave_identity: #${waveNumber} "${name}" ` +
            `(comienzo original ${startedAt}) — re-seed NO resetea identidad ni comienzo.`);
    } else {
        // Sin identidad previa → minteo genuino de una ola nueva.
        waveNumber = wavesState.nextWaveNumber;
        if (!Number.isInteger(waveNumber) || waveNumber <= wavesState.maxArchivedNumber) {
            const safe = wavesState.maxArchivedNumber + 1;
            logWarn(`Contador de ola inválido/colisiona (#${waveNumber} ≤ max=${wavesState.maxArchivedNumber}) ` +
                `— elevo a #${safe}.`);
            waveNumber = safe;
        }
        //    #4030 — El partial-pause SÍ aporta nombre/goal reales del plan maestro
        //    (mejor UX que `Ola seed #N`). Mantenemos el guard de confianza original
        //    para el NOMBRE/GOAL (sólo si `waveMeta.number` supera lo archivado/
        //    planificado); pero el NÚMERO ya lo fijó el contador, nunca `waveMeta`.
        name = `Ola seed #${waveNumber}`;
        goal = 'Seed inicial generado desde .partial-pause.json (issue #3616).';
        if (partial.waveMeta && partial.waveMeta.number > wavesState.maxArchivedNumber) {
            name = partial.waveMeta.name;
            goal = partial.waveMeta.goal || goal;
            logInfo(`Metadata de ola recuperada del plan maestro: ola #${waveNumber} "${name}" ` +
                `(número asignado por contador monotónico, no por metadata externa).`);
        } else if (partial.waveMeta) {
            logWarn(`Número externo (#${partial.waveMeta.number}) colisiona con archived/planned ` +
                `(max=${wavesState.maxArchivedNumber}) — nombre genérico, número por contador #${waveNumber}.`);
        }
        startedAt = nowIso();
    }
    const seededWave = {
        number: waveNumber,
        name,
        goal,
        started_at: startedAt,
        issues: partial.allowedIssues.map((n) => ({ number: n, status: 'in_progress' })),
    };

    if (dryRun) {
        logInfo(`[dry-run] sembraría ola #${waveNumber} con ${partial.allowedIssues.length} issues.`);
        return {
            action: 'seeded',
            reason: 'dry-run',
            seededWave,
            waveNumber,
            allowlist: partial.allowedIssues,
        };
    }

    // 6. Persistir. Usamos `saveState` interno (vía `addIssueToWave` o el
    //    `_internal` export) NO — porque eso requeriría crear la ola "vacía"
    //    primero y después agregar issues uno a uno. En cambio escribimos el
    //    state completo por la CAPA DE STORAGE (`operational-state-backend`).
    //    Esto es seguro porque:
    //      - validamos el state contra `validateStateStrict` antes de escribir.
    //      - en modo filesystem el backend delega en el mismo write atómico de
    //        siempre (tmp + fsync + rename + retry EPERM).
    //      - en modo remoto el write es un CAS contra la versión que leímos, así
    //        que si otra instancia sembró entremedio perdemos la carrera en vez
    //        de pisarla (CA-A4).
    //      - no estamos pisando datos: `hasActiveWave` ya fue chequeado, y ahora
    //        contra el MISMO sustrato donde vamos a escribir.
    //
    //    #5113 CA-C1 (rebote rev-1) — Antes esto era `waves.atomicWriteFile(...)`
    //    directo: con el flag encendido escribía el disco local mientras el
    //    pipeline leía el store, y el log decía "waves.json sembrado" sobre una
    //    ola que nadie iba a ver.
    let waves;
    try {
        waves = require('../lib/waves');
    } catch (err) {
        logWarn(`lib/waves no cargó: ${err.message}`);
        return {
            action: 'aborted_waves_corrupt',
            reason: `lib/waves no disponible: ${err.message}`,
            errors: [err.message],
        };
    }

    // Construir state completo preservando lo que había (planned_waves, etc.).
    const prev = wavesState.raw || {};
    const newState = {
        version: '1.0',
        meta: {
            created_at: (prev.meta && prev.meta.created_at) || nowIso(),
            updated_at: nowIso(),
            updated_by: 'init-waves-from-partial',
            source: preservingIdentity ? 'auto-seed-recovered' : 'auto-seed',
            // #4446/#4532 — contador monotónico. Al MINTEAR una ola nueva se
            // incrementa (nunca reutiliza el número recién sembrado). Al RECUPERAR
            // una identidad existente (re-seed post-wipe) se conserva el contador
            // previo: no gastamos un número nuevo por reconstruir la misma ola.
            next_wave_number: preservingIdentity ? counterOverride : (waveNumber + 1),
            note: preservingIdentity
                ? `Re-seed con identidad RECUPERADA (#4532): ola #${waveNumber} "${name}" ` +
                    `(comienzo original preservado). ${partial.allowedIssues.length} issue(s) re-sembrados.`
                : (partial.waveMeta && partial.waveMeta.number > wavesState.maxArchivedNumber)
                    ? `Seed desde .partial-pause.json (#3616/#4030): ola #${waveNumber} "${name}" ` +
                        `con ${partial.allowedIssues.length} issue(s).`
                    : `Seed inicial desde .partial-pause.json (#3616). ` +
                        `${partial.allowedIssues.length} issue(s) sembrados en ola #${waveNumber}.`,
        },
        active_wave: seededWave,
        planned_waves: Array.isArray(prev.planned_waves) ? prev.planned_waves : [],
        archived_waves: Array.isArray(prev.archived_waves) ? prev.archived_waves : [],
        dependencies: Array.isArray(prev.dependencies) ? prev.dependencies : [],
    };

    // Validación strict pre-write (security req 1, fail-closed).
    const validationErrors = waves.validateStateStrict
        ? waves.validateStateStrict(newState)
        : [];
    if (validationErrors.length > 0) {
        logWarn(`state inválido pre-write: ${validationErrors.join('; ')}`);
        if (!skipAlert) {
            notifyOnceForBoot({
                level: 'error',
                component: 'init-waves',
                message: 'state generado inválido pre-write, init abortado',
                detail: validationErrors.join('; ').slice(0, 200),
                action: 'Bug interno del init — revisá lib/waves.validateStateStrict.',
            });
        }
        return {
            action: 'aborted_invalid_partial',
            reason: 'state generado inválido',
            errors: validationErrors,
        };
    }

    // #4577 GATE 3 — INVARIANTE log-antes-de-mutar (RS-2): registrar el seed de
    // ola ANTES del write atómico de waves.json. Best-effort: el audit nunca
    // bloquea el seed (la trazabilidad tamper-evident es el valor de GATE 3).
    //
    // Nota (regresión de #4633 — corregida): la instrumentación original de
    // GATE 3 abortaba este path con `aborted_gate3_confirmation_required` cuando
    // la política `reseed-wave` es `wait-confirmation`. Eso rompía el boot:
    // `pulpo.js:boot()` llama `initWavesFromPartial()` esperando `seeded` y no
    // hay superficie de confirmación cableada en ese caller, dejando el pipeline
    // sin auto-seed de waves.json (y 21 tests pre-existentes en rojo).
    //
    // El bloqueo estaba MAL UBICADO: la guarda de idempotencia (paso 2) ya
    // retorna `noop_already_seeded` cuando existe `active_wave`, así que este
    // path NUNCA pisa una ola activa — sólo corre en el seed inicial (sin estado
    // previo) o en la recuperación post-WIPE (#4532), casos que RESTAURAN estado
    // canónico desde `.partial-pause.json` (fuente curada por el operador), no
    // acciones autónomas destructivas. Por eso no requiere confirmación: el
    // "reset de progreso/identidad" que GATE 3 protege no puede ocurrir aquí.
    // Se conserva el audit (safeAppendAction) para la traza forense.
    // (#4572 rebote rev-1: idéntico enfoque; main ya removió el enforcement
    //  bloqueante mal ubicado en este path — este commit queda sin delta funcional.)
    try {
        require('../lib/kernel-actions-audit').safeAppendAction({
            action: 'reseed-wave', impact: 'alto',
            reason: `initWavesFromPartial: seed ola #${waveNumber} "${name}" con ${partial.allowedIssues.length} issue(s)` +
                (preservingIdentity ? ' (identidad recuperada #4532)' : ' (minteo nuevo)'),
            authorizedBy: 'kernel:auto',
        });
    } catch {}

    const destino = labelFor(backend().KEYS.WAVES);
    try {
        // #5113 rev-8 — `version: null` significa "la clave NO existía", y la
        // convención del backend para eso es `0` = create-once
        // (`attribute_not_exists`), no "sin condición". Pasar el `null` crudo
        // funcionaba de casualidad: el backend lo trataba como incondicional y
        // rellenaba con la versión que él mismo leía (0), que da la misma
        // condición. Desde esta revisión el write remoto sin versión se rechaza
        // de plano, así que la intención se declara acá — que además es donde se
        // sabe: quien leyó el estado es quien sabe si existía.
        const expectedVersion = wavesState.version === null || wavesState.version === undefined
            ? 0
            : wavesState.version;
        const write = backend().writeKey(backend().KEYS.WAVES, newState, expectedVersion);
        if (write && write.conflict) {
            // Otra instancia sembró entre nuestra lectura y nuestro write. NO se
            // reintenta ni se fuerza: el estado que quedó es el de la otra
            // instancia y pisarlo sería exactamente el lost update que el CAS
            // viene a impedir. El próximo boot lee `hasActiveWave` y hace no-op.
            logWarn(`seed descartado por conflicto de versión en ${destino}: otra instancia ` +
                'sembró primero. No se pisa (CA-A4).');
            return {
                action: 'noop_already_seeded',
                reason: 'otra instancia sembró primero (conflicto de versión)',
            };
        }
        if (write && write.ok === false) {
            throw write.error || new Error('escritura rechazada por la capa de storage');
        }
        waves.invalidateCache();
    } catch (err) {
        // #5113 rev-12 — Un fallo del STORE durante el write no es un
        // `waves.json` corrupto. El rótulo importa porque el pulpo lo traduce a
        // una acción para el operador: `aborted_waves_corrupt` le dice
        // "restaurá desde archived/", que es exactamente la acción equivocada
        // para un timeout de DynamoDB (restauraría estado viejo sobre un store
        // que está sano y sólo no respondía). `aborted_remote_degraded` ya
        // existía en el vocabulario de este módulo y no se usaba en este camino.
        const degradadoRemoto = esFalloDeSustratoRemoto();
        logWarn(`write del registro de olas falló (${destino}): ${err.message}`);
        if (!skipAlert) {
            notifyOnceForBoot({
                level: 'error',
                component: 'init-waves',
                message: 'write del registro de olas falló',
                detail: err.message.slice(0, 200),
                action: degradadoRemoto
                    ? 'El estado operativo externo no respondió. NO restaures desde archived/: ' +
                      'el registro local no está corrupto. Revisá el store (o volvé ' +
                      '`operational_state.durable` a `false` siguiendo el runbook de cutover) y reintentá.'
                    : `Revisá el sustrato del estado operativo (${destino}). ` +
                      'Pipeline puede quedar con allowlist vacía.',
            });
        }
        return {
            action: degradadoRemoto ? 'aborted_remote_degraded' : 'aborted_waves_corrupt',
            reason: `write falló: ${err.message}`,
            errors: [err.message],
        };
    }

    logInfo(`registro de olas sembrado en ${destino}: ola #${waveNumber} con ${partial.allowedIssues.length} issue(s).`);
    return {
        action: 'seeded',
        seededWave,
        waveNumber,
        allowlist: partial.allowedIssues,
    };
}

/**
 * ¿El fallo que acabamos de ver viene del sustrato REMOTO y no del archivo?
 *
 * Se le pregunta al backend por la clave concreta (`waves`), no por un flag
 * global: con la degradación llaveada (#5113 rev-12 R-2) esto distingue "el
 * store no respondió" de "el JSON local está roto". Ante cualquier duda
 * devuelve `false`, que conserva el rótulo histórico.
 *
 * @returns {boolean}
 */
function esFalloDeSustratoRemoto() {
    try {
        const backend = require('../lib/operational-state-backend');
        if (typeof backend.isRemote === 'function' && backend.isRemote() !== true) return false;
        return typeof backend.isDegraded === 'function' && backend.isDegraded('waves') === true;
    } catch {
        return false;
    }
}

module.exports = {
    initWavesFromPartial,
    // Helpers expuestos para tests.
    _internal: {
        readPartialStrict,
        readWavesState,
        normalizeIssue,
        _resetDedupeForTests,
        // #4030 — extractores de metadata de ola (expuestos para tests).
        sanitizeWaveMeta,
        parseWaveMetaFromNote,
        extractWaveMeta,
    },
};

// ─── CLI mode ───────────────────────────────────────────────────────────────

if (require.main === module) {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const result = initWavesFromPartial({ dryRun });
    console.log(JSON.stringify(result, null, 2));
    // Exit code: 0 si no hubo error fatal, 2 si abortamos por inputs inválidos.
    if (result.action === 'aborted_invalid_partial' || result.action === 'aborted_waves_corrupt'
        || result.action === 'aborted_remote_degraded') {
        process.exit(2);
    }
    process.exit(0);
}
