// =============================================================================
// quota-exhausted.js — Detector de cuota agotada multi-proveedor (#2974, #3077)
//
// Núcleo del modo fallback determinístico del pipeline V3. Cuando un CLI
// de un provider de IA reporta cuota agotada, este módulo:
//
//   1. Persiste un flag JSON en `.pipeline/quota-exhausted.json` con
//      `{ exhausted, provider, model, resets_at, detected_at, pattern_matched }`.
//   2. El pulpo consulta `shouldGateSpawn(skill, { provider })` antes de
//      cada spawn LLM. Skills determinísticos
//      (`build/tester/linter/delivery`) NO se gatean.
//   3. **Scope por provider** (#3077 SEC-1, SEC-5): si el flag activo es
//      del provider X y un skill corre con provider Y, el spawn pasa.
//      Esto da valor real al rediseño multi-provider — cuando Anthropic se
//      agota, los skills configurados con OpenAI siguen corriendo.
//   4. Cuando `Date.now() > resets_at`, la lectura defensiva devuelve
//      `exhausted: false` y el módulo borra el flag (drenado natural).
//
// HISTORIA:
// - #2974 (hija de #2955): detector inicial Anthropic-only.
// - #3077 (H5 multi-provider): generalización con tabla `quota_error_types`
//   por proveedor + scope per-provider + dispatcher por shape estructural.
//
// CRITERIOS DE ACEPTACIÓN ACTIVOS:
//
//   CA-4 (#3077 SEC-3): dispatcher por provider con shape estructural
//        explícito. Anthropic: stream-json. OpenAI/Codex: SSE.
//        PROHIBIDO matchear por substring sobre texto libre.
//   CA-5 (#3077 SEC-1): match cross-provider PROHIBIDO. detectQuotaError
//        recibe `provider` y matchea SOLO contra el set del provider en uso.
//   CA-7 (#3077 SEC-5): shouldGateSpawn consulta el provider del skill y
//        gatea SOLO si coincide con el provider del flag activo.
//   CA-9 (#3077 SEC-8): snapshot_threshold_90 queda exclusivamente en
//        provider=anthropic. quota-snapshot-integration pasa el provider
//        explícito al setFlag.
//   CA-10 (#3077 SEC-7): cada línea del audit log incluye `provider` y `model`.
//   CA-11 (#3077 SEC-4): raw_excerpt pasa por lib/redact.js antes de logear.
//   CA-14 (#3077): backward-compat — flag persistido sin campo `provider`
//        se lee como `provider: 'anthropic'` (default histórico pre-migración).
//
// INVARIANTE DE RACE (documentado por guru y security en el issue):
//   El flag previene FUTUROS spawns, NO mata los in-flight. Los procesos
//   claude.exe corriendo terminan naturalmente (con respuesta truncada o
//   error similar). Si el siguiente spawn también dispara el flag, set/set
//   son idempotentes. No hay corrupción posible.
//
// SCHEMA del archivo `.pipeline/quota-exhausted.json` (post-#4731):
//   ESTADO POR-PROVEEDOR (fuente de verdad = mapa `providers`). Los campos
//   top-level son un ESPEJO del slot primario (reset más próximo) para
//   backward-compat con lectores legacy (`commander /quota`, provider-health,
//   tests #3077). Al haber un solo proveedor agotado, espejo == único slot.
//   {
//     exhausted: true,                              // espejo: hay ≥1 slot activo
//     provider: "openai-codex",                     // espejo: slot primario
//     resets_at, detected_at, pattern_matched,      // espejo del slot primario
//     providers: {                                  // AUTORITATIVO — por proveedor
//       "openai-codex": { exhausted:true, resets_at, detected_at, pattern_matched, model? },
//       "anthropic":    { exhausted:true, resets_at, detected_at, pattern_matched }
//     }
//   }
//   #4731: cada slot expira INDEPENDIENTE por su `resets_at`. `clearFlag({provider})`
//   drena SÓLO ese slot → el vector de #3077 (un provider limpia el ajeno) queda
//   cerrado por construcción, sin el guard `clear_skipped_provider_mismatch`.
//
//   SCHEMA legacy pre-#4731 (aún leído por backward-compat #3077 CA-14):
//   { exhausted:true, provider?, model?, resets_at, detected_at, pattern_matched }
//   → se normaliza a slot `provider || 'anthropic'`.
//
// KILL-SWITCH OPERACIONAL: si por bug el flag queda persistente,
//   `rm .pipeline/quota-exhausted.json` desbloquea el pipeline.
//
// Sin nuevas dependencias externas (Node puro: fs, path).
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

// Reutilizamos el helper canónico de getNextWeeklyResetMs (CA-5 fallback).
const { getNextWeeklyResetMs } = require('./weekly-quota');

// CA-11 (#3077 SEC-4): sanitizar raw_excerpt para evitar exfiltración pasiva
// de keys/prompts en el audit log.
let _redact = null;
function getRedact() {
    if (_redact) return _redact;
    try {
        _redact = require('./redact');
    } catch {
        // Defensa: si el módulo no carga (no debería), null-op.
        _redact = { redactSensitive: (s) => s };
    }
    return _redact;
}

// -----------------------------------------------------------------------------
// Paths y constantes
// -----------------------------------------------------------------------------

function pipelineDir() {
    // Permitir override en tests vía env var (mismo patrón que partial-pause).
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.resolve(__dirname, '..');
}

function flagFile() {
    return path.join(pipelineDir(), 'quota-exhausted.json');
}

function tmpDir() {
    return path.join(pipelineDir(), 'tmp');
}

function logsDir() {
    return path.join(pipelineDir(), 'logs');
}

function auditLogFile(now = new Date()) {
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    return path.join(logsDir(), `quota-detector-${yyyy}-${mm}-${dd}.log`);
}

// CA-5: cap del `resets_at`. Mínimo 5 min para que un flag con drift de unos
// segundos no se borre instantáneamente; máximo configurable (default 7 días).
const MIN_RESETS_AT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RESETS_AT_DAYS = 7;

// CA-7: cap de raw_excerpt en log (defensa anti DoS de log size).
const RAW_EXCERPT_MAX_CHARS = 200;

// #3077 CA-6 (editorial): cap de pattern_matched en payload persistido.
// 64 era suficiente para Anthropic; OpenAI/Codex puede emitir codes largos
// como `tokens_per_minute_rate_limit_exceeded_for_organization_xxxxxx`.
const PATTERN_MATCHED_MAX_CHARS = 128;

// Default provider para backward-compat (#3077 CA-14): flags persistidos
// pre-migración no tienen el campo `provider`. Al leer, los normalizamos a
// `anthropic` (único provider activo antes de #3077).
const DEFAULT_PROVIDER = 'anthropic';

// Allowlist por DEFAULT (Anthropic-only — backward-compat #2974).
// CONFIGURABLE: cuando se invoca con providerDef de agent-models.json, se
// usa providerDef.quota_error_types en lugar de este default. Mantener este
// constante por compatibilidad con tests/callers que llaman sin provider.
//
// `rate_limit_error` (429 transitorio) NO entra acá — eso se maneja con
// backoff/retry, no con flag global del pipeline.
//
// `snapshot_threshold_90` (#3013): trigger emitido por
// quota-snapshot-integration cuando el snapshot real reporta
// `weekly_all_models_pct >= 90`. Es Anthropic-específico (#3077 SEC-8).
const DEFAULT_ERROR_TYPES = Object.freeze([
    'usage_limit_error',
    'weekly_quota_exhausted',
    'snapshot_threshold_90',
]);

// -----------------------------------------------------------------------------
// #5455 — EXCEPCIÓN ACOTADA AL CANAL DE CONTENIDO (Anthropic-only)
//
// Este módulo documenta como invariante que está PROHIBIDO matchear contra
// campos controlados por el modelo (canal de contenido). #5424 demostró que
// existe UN caso real donde el CLI de Anthropic no tiene otro canal: al cortar
// por límite SEMANAL emite el aviso como frame final `type:'result'` SIN
// `is_error` ni `error_type`. Sin detectarlo, el flag nunca se persiste, el
// fallback pre-spawn del Commander vuelve a elegir Anthropic y el operador
// queda sin canal (incidente 2026-08-02, ~1h sin Commander).
//
// La excepción se abre con TODAS estas compensaciones simultáneas — quitar
// cualquiera reabre el vector de DoS auto-infligido por contenido inducido
// (prompt/comentario/handoff que imite el aviso):
//
//   1. SCOPE ANTHROPIC. El tipo vive SÓLO en `KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER
//      .anthropic`; `agent-models-validate.js` hace fail-fast al boot si otro
//      provider lo declara. Además `_detectAnthropic` acepta un `providerId`
//      explícito y descarta el path si el canónico no es `anthropic`.
//   2. FRAME COMPLETO. Sólo `evt.type === 'result'`, y el contenido COMPLETO
//      normalizado debe coincidir con el aviso. Una mención embebida en una
//      respuesta larga NO matchea (el regex está anclado `^...$`).
//   3. SHAPES CERRADOS. `result` string, o array de bloques EXCLUSIVAMENTE
//      `{type:'text', text:string}`. Cualquier bloque mixto/no textual falla
//      cerrado.
//   4. LÍMITE DE LONGITUD. Trim exterior y rechazo por encima de 200 chars —
//      el regex NUNCA corre sobre más de 200 caracteres (garantía anti-ReDoS).
//   5. REGEX ANCLADO con cuantificadores acotados, sin `.*` y sin construirse
//      desde input externo.
//   6. TIPO DEDICADO. Se persiste como `weekly_limit_content_channel`, jamás
//      como un tipo estructural. El bypass del veto `provider_healthy_fresh`
//      (ver `isWeeklyLimitContentChannel`) depende de provider Y tipo a la vez.
//   7. TTL EFECTIVO ≤ 60 MIN. `setFlag` clampea este tipo a `maxDays = 1/24`
//      aunque el texto anuncie un reset semanal y aunque el caller pase otro
//      `maxDays`. Un falso positivo cuesta como máximo una hora de gate.
//   8. PROCEDENCIA + REDACCIÓN. El resultado lleva `source` explícito y el
//      excerpt pasa por `sanitizeRawExcerpt` (redact central) antes de
//      persistirse o loguearse.
// -----------------------------------------------------------------------------
const WEEKLY_LIMIT_CONTENT_ERROR_TYPE = 'weekly_limit_content_channel';

// Procedencia auditable del match (compensación 8).
const WEEKLY_LIMIT_CONTENT_SOURCE = 'anthropic-result-content';

// Compensación 4: cota dura del contenido normalizado. El regex sólo corre
// sobre entradas ya validadas por debajo de este límite.
const WEEKLY_LIMIT_CONTENT_MAX_CHARS = 200;

// Compensación 3: cota de bloques del shape array (defensa anti-DoS de memoria
// al concatenar). Un aviso real es 1 bloque; 8 es holgado y sigue acotado.
const WEEKLY_LIMIT_CONTENT_MAX_BLOCKS = 8;

// Compensación 7: TTL efectivo máximo, en días (1/24 == 60 minutos). Coincide
// con MIN_TTL_DAYS, el piso del clamp de `resolveMaxDays`.
const WEEKLY_LIMIT_CONTENT_MAX_DAYS = 1 / 24;

// Compensación 5: regex ANCLADO al frame completo. Cuantificadores acotados,
// sin `.*`, sin alternancias anidadas y sin construcción dinámica. Cubre el
// texto real del incidente y sus variantes de apóstrofe/sufijo:
//   "You've hit your weekly limit · resets 9pm (America/Buenos_Aires)"
//   "You've hit your weekly limit · resets Aug 9, 9pm (America/Buenos_Aires)"
//   "You've hit your weekly limit"
// El grupo 1 captura el reset crudo (incluida la TZ entre paréntesis) para
// delegarlo a `parseResetToIso`; NO se interpreta la TZ acá.
const _ANTHROPIC_WEEKLY_LIMIT_CONTENT_PATTERN =
    /^you['’]?ve\s{1,3}hit\s{1,3}your\s{1,3}weekly\s{1,3}limit(?:\s{0,3}[·•]?\s{0,3}resets\s{1,3}([a-z0-9][a-z0-9 ,:]{0,39}(?:\([a-z0-9_+\-/]{1,40}\))?))?\s{0,3}\.?$/i;

// #3077 SEC-2: meta-allowlist hardcoded de tipos de error de cuota por
// provider. Si agent-models.json declara un valor fuera de este set, el caller
// (lib/agent-models-validate.js → validateCrossReferences) hace fail-fast al
// boot. Esta es la fuente única de verdad: los tests verifican que cada
// provider en agent-models.json sólo declara error_types que existen acá.
//
// Tipos "externos" vienen del CLI del provider; tipos "internos" son emitidos
// por integraciones del propio pipeline (snapshot_threshold_90).
const KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER = Object.freeze({
    anthropic: Object.freeze([
        // Externos (CLI claude-code)
        'usage_limit_error',
        'weekly_quota_exhausted',
        // Internos (#3013 snapshot integration)
        'snapshot_threshold_90',
        // #5455 — Canal de CONTENIDO (excepción acotada documentada arriba).
        // Anthropic-ONLY por diseño: ningún otro provider puede declararlo sin
        // que `agent-models-validate.js` falle al boot.
        WEEKLY_LIMIT_CONTENT_ERROR_TYPE,
        // Reservados para futuras extensiones documentadas
        'plan_max_reset_required',
    ]),
    'openai-codex': Object.freeze([
        // Externos (CLI codex / OpenAI con API key paga)
        'insufficient_quota',
        'billing_hard_limit_reached',
        'tokens_exhausted',
        // Codex con cuenta ChatGPT (OAuth): el CLI reporta el cap rolling como
        // texto libre en el canal de control ("You've hit your usage limit").
        // error_type sintético emitido por _detectOpenAI (no viene del CLI).
        'usage_limit_reached',
    ]),
    // #3220 — rename ex-`gemini` → `gemini-google` (sign-off 2026-05-15).
    // Coordinación cross-archivo: ALLOWED_LAUNCHERS, ALLOWED_PROVIDERS y
    // adapter filename. Single source of truth para naming en pipeline V3.
    // SEC-3 (#3220): handler estructurado `_detectGemini` pendiente — la
    // detección actual queda declarativa, sólo soportada por string-matching
    // heurístico (issue de recomendación #3226).
    'gemini-google': Object.freeze([
        'quota_exceeded',
        'resource_exhausted',
    ]),
    // #3353 (mayo 2026) — Groq descontinuado: la entrada `groq` se removió
    // de la meta-allowlist; agent-models.json con quota_error_types declarado
    // para groq ahora falla la cross-validation con mensaje accionable.
    //
    // #3220 — Cerebras también es OpenAI-compatible. Lista conservadora.
    // #5978 — `insufficient_quota` verificado empíricamente: al agotarse el
    // crédito, Cerebras devuelve HTTP 402 con
    // `{"error":{"status":402,"message":"Payment required...","code":"insufficient_quota"}}`.
    // Sin este tipo el 402 no seteaba flag de cuota y el provider seguía en la
    // cadena, matando agentes al spawn y rebotando issues sanos. Alineado con
    // nvidia-nim/kimi-moonshot, que ya lo declaran (mismo contrato OpenAI-compat).
    cerebras: Object.freeze([
        'rate_limit_exceeded',
        'quota_exceeded',
        'insufficient_quota',
    ]),
    // #3243 — NVIDIA NIM, 4to free provider. API OpenAI-compat: `_detectOpenAI`
    // reusa el shape SSE sin código nuevo. Lista conservadora — NVIDIA no
    // publica códigos formales del free tier; estos cubren los casos típicos
    // de un OpenAI-compat provider (429 → quota / rate limit).
    'nvidia-nim': Object.freeze([
        'rate_limit_exceeded',
        'quota_exceeded',
        'insufficient_quota',
    ]),
    // #4880 — Kimi (Moonshot). Drop-in de Claude Code contra el endpoint
    // Anthropic-compatible: el error viaja con shape Anthropic-like por el
    // stream-json, pero con SU allowlist de tipos (api-key metered, NO el
    // snapshot MAX de Anthropic). El handler `providers/kimi-moonshot.js` la usa
    // vía `_detectAnthropic` con `provider: 'kimi-moonshot'`.
    'kimi-moonshot': Object.freeze([
        'rate_limit_exceeded',
        'quota_exceeded',
        'insufficient_quota',
    ]),
});

// -----------------------------------------------------------------------------
// IO atómica (CA-6)
// -----------------------------------------------------------------------------

function ensureDir(dir) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

/**
 * Escritura atómica replicada del patrón de connectivity-state.js (líneas
 * 154-173). writeFileSync en tmp + fsync + rename. Mode 0o600 para que el
 * flag y el audit log no sean world-readable (defensa en profundidad).
 *
 * Si el rename falla (FS lleno, permisos), limpia tmp y propaga el error.
 * El caller (typically pulpo.js) decide si ignorarlo (best-effort) o no.
 *
 * #3575 — Retry bounded en `fs.renameSync`
 * ---------------------------------------
 * En Windows, `fs.renameSync` puede fallar con `EBUSY|EPERM|EEXIST|EACCES`
 * cuando dos procesos renombran al mismo destino casi simultáneamente (handle
 * brevemente abierto por antivirus, indexador o el propio FS). En POSIX el
 * rename es atómico y este path raramente dispara, pero el costo del retry
 * acotado es despreciable.
 *
 * Cap explícito (anti-DoS): máximo `RENAME_RETRY_MAX_ATTEMPTS` intentos y
 * `RENAME_RETRY_MAX_TOTAL_MS` totales (ver #5400 abajo para la calibración). Si
 * el destino está realmente bloqueado, propagamos al caller en vez de spinear
 * el proceso indefinidamente.
 */
// #5400 — Recalibración del budget. El original (3 intentos / 50ms) daba, en
// los hechos, ~15ms de espera total: 5ms + 10ms y al tercer fallo tiraba. Eso
// alcanza para un handle suelto de antivirus, pero NO para 10 escritores
// concurrentes sobre el mismo destino con la máquina cargada (la suite completa
// corre miles de tests en paralelo). Síntoma: `setFlag` lanzaba EPERM y el test
// de concurrencia caía de forma intermitente, sólo bajo carga.
const RENAME_RETRY_MAX_ATTEMPTS = 6;
const RENAME_RETRY_MAX_TOTAL_MS = 400;
const RENAME_RETRY_INITIAL_MS = 5;
// EACCES lo tira Windows en la misma carrera que EPERM (depende de si el handle
// en conflicto es del propio FS o de un tercero). Sin él, la carrera más común
// del CI ni siquiera entraba al retry.
const RENAME_RETRYABLE_ERRORS = new Set(['EBUSY', 'EPERM', 'EEXIST', 'EACCES']);

function sleepSyncMs(ms) {
    if (!(ms > 0)) return;
    // #5400 — Espera síncrona REAL (bloquea el hilo sin quemar CPU).
    //
    // Antes esto era un busy-wait `while (Date.now() < end) {}`, que bajo
    // contención es contraproducente: el proceso que reintenta le roba CPU
    // justamente al proceso que tiene tomado el handle que él está esperando
    // que se libere. Con 10 escritores concurrentes eso se realimenta y alarga
    // la ventana de conflicto en vez de acortarla.
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch {
        // Entorno sin SharedArrayBuffer: degradar al busy-wait acotado.
        const end = Date.now() + ms;
        // eslint-disable-next-line no-empty
        while (Date.now() < end) {}
    }
}

function renameWithRetry(tmp, filepath) {
    let lastErr = null;
    let delayMs = RENAME_RETRY_INITIAL_MS;
    const totalDeadline = Date.now() + RENAME_RETRY_MAX_TOTAL_MS;
    for (let attempt = 1; attempt <= RENAME_RETRY_MAX_ATTEMPTS; attempt++) {
        try {
            fs.renameSync(tmp, filepath);
            return;
        } catch (err) {
            lastErr = err;
            if (!RENAME_RETRYABLE_ERRORS.has(err && err.code)) throw err;
            if (attempt === RENAME_RETRY_MAX_ATTEMPTS) throw err;
            const remaining = totalDeadline - Date.now();
            if (remaining <= 0) throw err;
            // Jitter [0.5x, 1.5x): N escritores que chocan a la vez esperan lo
            // mismo y vuelven a chocar a la vez. El jitter rompe ese lockstep.
            const jittered = Math.max(1, Math.round(delayMs * (0.5 + Math.random())));
            sleepSyncMs(Math.min(jittered, remaining));
            delayMs = Math.min(delayMs * 2, RENAME_RETRY_MAX_TOTAL_MS);
        }
    }
    // Defensivo (no debería alcanzarse): el loop sale por return o throw.
    throw lastErr || new Error('renameWithRetry: unexpected fallthrough');
}

function writeJsonAtomic(filepath, data) {
    ensureDir(tmpDir());
    ensureDir(path.dirname(filepath));
    const tmp = path.join(
        tmpDir(),
        `${path.basename(filepath)}.${process.pid}.${Date.now()}.tmp`
    );
    const payload = JSON.stringify(data, null, 2);
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
        fs.writeSync(fd, payload);
        try { fs.fsyncSync(fd); } catch { /* best-effort */ }
    } finally {
        try { fs.closeSync(fd); } catch {}
    }
    try {
        renameWithRetry(tmp, filepath);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch {}
        throw err;
    }
}

// -----------------------------------------------------------------------------
// Sanitización (CA-7 + #3077 CA-11/SEC-4)
// -----------------------------------------------------------------------------

// Patrones de API keys multi-proveedor — defensa en profundidad para
// raw_excerpt de eventos del CLI (SSE de OpenAI/Codex puede emitir errores
// con context que contiene fragmentos de la API key cuando el cliente
// configuró auth incorrectamente). El módulo lib/redact.js no captura
// patrones en texto libre — esta lista es complemento explícito hasta que
// S2 (#3073) generalice la sanitización con regex multi-proveedor.
//
// Cada patrón es conservador: requiere prefijo + longitud mínima, evita
// falsos positivos contra texto natural. Si un nuevo provider agrega un
// patrón propio, sumarlo acá con review humano.
const API_KEY_PATTERNS = [
    // Anthropic específico (`sk-ant-...`). PRIMERO para que matchee antes
    // del sk-* genérico (sino el genérico se traga el ant- y queda residuo).
    /\bsk-ant-[A-Za-z0-9_\-]{16,}\b/g,
    // Anthropic + OpenAI (`sk-...`, 20+ chars opacos)
    /\bsk-[A-Za-z0-9_\-]{16,}\b/g,
    // Google API keys (`AIza...`, 35 chars en total)
    /\bAIza[0-9A-Za-z_\-]{30,}\b/g,
    // Google OAuth tokens (`ya29...`)
    /\bya29\.[0-9A-Za-z_\-]{20,}\b/g,
    // Bearer token genérico (más permisivo: cualquier token opaco después de Bearer)
    /\bBearer\s+[A-Za-z0-9_\-\.]{16,}/gi,
    // JWT (3 segmentos base64url separados por puntos)
    /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g,
    // #3576 NEW-1 — AWS access keys (AKIA + 16 alfanum) y temporary
    // credentials (ASIA prefix). Cubre el caso en que un agente o el
    // commander pegue accidentalmente un dump del entorno de AWS en
    // stderr/stdout del CLI.
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
];

/**
 * Sanitiza el raw_excerpt antes de loguearlo. Tres pasos:
 *
 *   1. Pasar por lib/redact.js (#3077 SEC-4): redacta JSON keys sensibles,
 *      emails, query params, URL userinfo, paths absolutos.
 *   2. Aplicar patrones de API keys multi-proveedor (sk-..., AIza..., Bearer)
 *      como defensa en profundidad para texto libre (lib/redact no captura
 *      patrones en strings sueltos). Cierra el vector "OpenAI emite eventos
 *      de error con context que contiene la API key → audit log se vuelve
 *      vector de exfiltración pasivo".
 *   3. Strip de CR/LF/TAB (CWE-117 log injection): cada línea del audit
 *      log debe seguir siendo una entrada JSON válida.
 *   4. Truncar a RAW_EXCERPT_MAX_CHARS para defensa anti-DoS de log size.
 */
function sanitizeRawExcerpt(raw) {
    if (raw == null) return '';
    let str = String(raw);
    // 1. Redactar secretos JSON / headers / emails / URLs vía lib/redact.
    str = String(getRedact().redactSensitive(str));
    // 2. Redactar patrones de API keys en texto libre (multi-proveedor).
    for (const pattern of API_KEY_PATTERNS) {
        str = str.replace(pattern, '[REDACTED]');
    }
    // 3. Strip CR/LF/TAB.
    str = str.replace(/[\r\n\t]/g, ' ');
    // 4. Truncar.
    return str.slice(0, RAW_EXCERPT_MAX_CHARS);
}

// -----------------------------------------------------------------------------
// Schema validation y cap (CA-5 + #3077 SEC-6)
// -----------------------------------------------------------------------------

/**
 * Acota `resets_at` (en ms desde epoch o ISO8601) al rango [now+5min, now+maxDays].
 *
 * Si el valor es inválido (no parseable, NaN, negativo) o cae fuera del rango,
 * usa `getNextWeeklyResetMs()` como fallback siempre que ese fallback esté
 * dentro del rango. Si el fallback también está fuera (improbable, pero por
 * defensa) se acota al límite superior.
 *
 * #3077 SEC-6: el `maxDays` ahora es obligatoriamente configurable por
 * provider — Anthropic mantiene 7 días (semanal); OpenAI debe usar 31 días
 * (mensual). El caller pasa el valor correcto desde providerDef.
 *
 * @param {string|number|Date} input candidato del CLI o del archivo persistido
 * @param {object} opts
 * @param {number} opts.maxDays cap superior en días (default 7)
 * @param {number} opts.now Date.now() override (para tests)
 * @returns {{ ms: number, iso: string, source: 'input'|'fallback'|'cap_max' }}
 */
function capResetsAt(input, opts = {}) {
    const maxDays = Number.isFinite(opts.maxDays) && opts.maxDays > 0
        ? opts.maxDays
        : DEFAULT_MAX_RESETS_AT_DAYS;
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const lower = now + MIN_RESETS_AT_MS;
    const upper = now + maxDays * 24 * 60 * 60 * 1000;

    // Parseo robusto del input
    let ms = NaN;
    if (typeof input === 'number' && Number.isFinite(input)) {
        ms = input;
    } else if (input instanceof Date) {
        ms = input.getTime();
    } else if (typeof input === 'string') {
        const parsed = Date.parse(input);
        if (Number.isFinite(parsed)) ms = parsed;
    }

    if (Number.isFinite(ms) && ms >= lower && ms <= upper) {
        return { ms, iso: new Date(ms).toISOString(), source: 'input' };
    }

    // Input fuera de rango → fallback al próximo reset semanal calculado.
    let fallback;
    try { fallback = getNextWeeklyResetMs(now); } catch { fallback = NaN; }
    if (Number.isFinite(fallback) && fallback >= lower && fallback <= upper) {
        return { ms: fallback, iso: new Date(fallback).toISOString(), source: 'fallback' };
    }

    // Defensa final: si ni el input ni el fallback son seguros, usar el cap superior.
    return { ms: upper, iso: new Date(upper).toISOString(), source: 'cap_max' };
}

/**
 * #4731 — Valida el shape de UN slot de proveedor (los campos comunes al flag
 * legacy y a cada entrada del mapa `providers`). NO muta el input: sólo valida
 * tipos y que las fechas sean parseables. Devuelve `true`/`false`.
 *
 * `exhausted` es opcional dentro de un slot del mapa nuevo (el mapa YA implica
 * exhausted); si viene, debe ser exactamente `true`. `provider`/`model` son
 * opcionales pero, si están, deben ser strings válidos.
 */
function isValidProviderSlot(slot) {
    if (!slot || typeof slot !== 'object') return false;
    if (slot.exhausted !== undefined && slot.exhausted !== true) return false;
    if (typeof slot.resets_at !== 'string') return false;
    if (typeof slot.detected_at !== 'string') return false;
    if (typeof slot.pattern_matched !== 'string') return false;
    if (!Number.isFinite(Date.parse(slot.resets_at))) return false;
    if (!Number.isFinite(Date.parse(slot.detected_at))) return false;
    if (slot.provider !== undefined) {
        if (typeof slot.provider !== 'string' || slot.provider.length === 0) return false;
    }
    if (slot.model !== undefined && typeof slot.model !== 'string') return false;
    return true;
}

/**
 * Valida el shape del flag persistido. Devuelve `null` si no es válido, o el
 * `parsed` intacto (sin normalizar) si lo es.
 *
 * #4731 — Soporta DOS shapes:
 *   1. Nuevo (por-proveedor): `{ providers: { "<id>": { resets_at, detected_at,
 *      pattern_matched, ... } } }`. Válido si el mapa tiene ≥1 slot válido.
 *   2. Legacy (single-flag): `{ exhausted:true, provider?, resets_at,
 *      detected_at, pattern_matched, model? }`. #3077 CA-14: `provider` opcional
 *      (default `anthropic`).
 *
 * NO normaliza: los callers que necesitan el mapa unificado usan
 * `readProvidersMap()`. Mantener el retorno "parsed intacto" preserva el
 * contrato de los tests que hacen `deepEqual(validateFlagShape(x), x)`.
 */
function validateFlagShape(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;
    // Shape nuevo por-proveedor.
    if (parsed.providers !== undefined) {
        const map = parsed.providers;
        if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
        const ids = Object.keys(map);
        if (ids.length === 0) return null;
        // Requerimos que TODOS los slots presentes sean válidos: un slot
        // corrupto es señal de manipulación → safe-default (no fail-open).
        for (const id of ids) {
            if (!isValidProviderSlot(map[id])) return null;
        }
        return parsed;
    }
    // Shape legacy single-flag.
    if (parsed.exhausted !== true) return null;
    if (!isValidProviderSlot(parsed)) return null;
    return parsed;
}

/**
 * #4731 — Normaliza cualquier shape persistido (legacy o nuevo) a un mapa
 * unificado `{ "<id>": { provider, exhausted:true, resets_at, detected_at,
 * pattern_matched, model|null, resets_at_ms } }`. Devuelve `null` si el shape
 * es inválido. NO toca el filesystem ni drena por tiempo (eso lo hace el
 * caller). Backward-compat #3077 CA-14 / seguridad A04: legacy sin `provider`
 * → slot `DEFAULT_PROVIDER` (`anthropic`), NUNCA fail-open.
 */
function readProvidersMap(parsed) {
    const valid = validateFlagShape(parsed);
    if (!valid) return null;
    const out = {};
    const toSlot = (id, raw) => ({
        provider: id,
        exhausted: true,
        resets_at: raw.resets_at,
        detected_at: raw.detected_at,
        pattern_matched: raw.pattern_matched,
        model: raw.model || null,
        resets_at_ms: Date.parse(raw.resets_at),
    });
    if (valid.providers) {
        for (const [id, raw] of Object.entries(valid.providers)) {
            const pid = (raw && typeof raw.provider === 'string' && raw.provider) || id;
            out[pid] = toSlot(pid, raw);
        }
    } else {
        const id = valid.provider || DEFAULT_PROVIDER;
        out[id] = toSlot(id, valid);
    }
    return Object.keys(out).length ? out : null;
}

/**
 * #4731 — Construye el payload persistido HÍBRIDO desde un mapa de slots. El
 * mapa `providers` es la FUENTE DE VERDAD; los campos top-level (`exhausted`,
 * `provider`, `resets_at`, ...) son un ESPEJO del slot primario (el de reset
 * más próximo) para backward-compat con lectores que aún leen el shape legacy
 * (`commander /quota`, `provider-health`, tests #3077). Al haber un solo slot,
 * el espejo coincide con él (los tests legacy siguen verdes).
 */
function buildHybridPayload(map) {
    const ids = Object.keys(map);
    if (ids.length === 0) return null;
    let primaryId = ids[0];
    for (const id of ids) {
        if (Date.parse(map[id].resets_at) < Date.parse(map[primaryId].resets_at)) {
            primaryId = id;
        }
    }
    const p = map[primaryId];
    const providers = {};
    for (const id of ids) {
        const s = map[id];
        providers[id] = {
            exhausted: true,
            resets_at: s.resets_at,
            detected_at: s.detected_at,
            pattern_matched: s.pattern_matched,
            ...(s.model ? { model: s.model } : {}),
        };
    }
    return {
        exhausted: true,
        provider: primaryId,
        ...(p.model ? { model: p.model } : {}),
        resets_at: p.resets_at,
        detected_at: p.detected_at,
        pattern_matched: p.pattern_matched,
        providers,
    };
}

/**
 * #4731 — Lee y normaliza el mapa de slots del archivo persistido. Devuelve
 * `{}` si el archivo no existe o es inválido (para read-modify-write en
 * `setFlag`/`clearFlag`). NO drena por tiempo ni audita.
 */
function readCurrentMap() {
    let raw;
    try {
        raw = fs.readFileSync(flagFile(), 'utf8');
    } catch { return {}; }
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return {}; }
    return readProvidersMap(parsed) || {};
}

// -----------------------------------------------------------------------------
// Lectura defensiva (CA-4) y borrado del flag
// -----------------------------------------------------------------------------

/**
 * Lectura defensiva del flag.
 *   - Si no existe el archivo → `{ exhausted: false, reason: 'absent' }`.
 *   - Si está corrupto / shape inválido / fields faltantes → safe-default,
 *     registra incidente en audit log y deja el archivo intacto (operador
 *     puede inspeccionar manualmente). El operador desbloquea con `rm`.
 *   - Si `resets_at` ya pasó → `{ exhausted: false, reason: 'expired' }`,
 *     borra el archivo (drenado natural CA-7 del issue padre).
 *   - Si todo OK → `{ exhausted: true, ...payload }`.
 *
 * #3077 CA-14: el campo `provider` se rellena con DEFAULT_PROVIDER si el
 * flag persistido viene sin él (backward-compat).
 */
function readDefensive(opts = {}) {
    const file = flagFile();
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const auditEnabled = opts.auditLogEnabled !== false;

    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
        if (e && e.code === 'ENOENT') {
            return { exhausted: false, reason: 'absent' };
        }
        // Otro error de IO (permisos, etc) — degradar a safe-default.
        if (auditEnabled) {
            appendAudit({
                event: 'read_io_error',
                error_type: null,
                raw_excerpt: e.message,
                flag_set: false,
            });
        }
        return { exhausted: false, reason: 'io_error' };
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        if (auditEnabled) {
            appendAudit({
                event: 'parse_error',
                error_type: null,
                raw_excerpt: raw,
                flag_set: false,
            });
        }
        return { exhausted: false, reason: 'parse_error' };
    }

    const map = readProvidersMap(parsed);
    if (!map) {
        if (auditEnabled) {
            appendAudit({
                event: 'schema_invalid',
                error_type: null,
                raw_excerpt: raw,
                flag_set: false,
            });
        }
        return { exhausted: false, reason: 'schema_invalid' };
    }

    // #4731 — Drenado POR SLOT: cada proveedor expira independiente por su
    // `resets_at`. Los slots vencidos se drenan (audit `drained_post_reset`),
    // los activos se conservan. Si todos vencieron → se borra el archivo.
    const active = {};
    const expiredIds = [];
    for (const [id, slot] of Object.entries(map)) {
        if (now >= slot.resets_at_ms) {
            expiredIds.push(id);
            if (auditEnabled) {
                appendAudit({
                    event: 'drained_post_reset',
                    provider: id,
                    model: slot.model,
                    error_type: slot.pattern_matched,
                    raw_excerpt: `resets_at=${slot.resets_at}`,
                    flag_set: false,
                });
            }
        } else {
            active[id] = slot;
        }
    }

    const activeIds = Object.keys(active);
    if (activeIds.length === 0) {
        // Todos los slots vencieron (o el mapa quedó vacío) → drenado total.
        try { fs.unlinkSync(file); } catch {}
        const anyExpired = expiredIds.length > 0;
        return { exhausted: false, reason: anyExpired ? 'expired' : 'absent' };
    }

    // Drenado PARCIAL: si algún slot venció pero quedan activos, reescribimos
    // el archivo sólo con los activos (best-effort — no rompe el pipeline si
    // falla la escritura; el drenado se reintenta en la próxima lectura).
    if (expiredIds.length > 0) {
        try { writeJsonAtomic(file, buildHybridPayload(active)); } catch { /* best-effort */ }
    }

    // Slot primario = reset más próximo (para el espejo legacy + countdown).
    let primaryId = activeIds[0];
    for (const id of activeIds) {
        if (active[id].resets_at_ms < active[primaryId].resets_at_ms) primaryId = id;
    }
    const p = active[primaryId];

    // Lista de proveedores afectados, ordenada por reset ascendente (el más
    // próximo primero) para que el banner muestre el/los provider(s) real(es).
    const providers = activeIds
        .map((id) => ({
            provider: id,
            model: active[id].model,
            resets_at: active[id].resets_at,
            detected_at: active[id].detected_at,
            pattern_matched: active[id].pattern_matched,
            resets_at_ms: active[id].resets_at_ms,
        }))
        .sort((a, b) => a.resets_at_ms - b.resets_at_ms);

    return {
        exhausted: true,
        // Espejo del slot primario — backward-compat con callers legacy.
        provider: primaryId,
        model: p.model,
        resets_at: p.resets_at,
        detected_at: p.detected_at,
        pattern_matched: p.pattern_matched,
        resets_at_ms: p.resets_at_ms,
        // #4731 — lista completa de slots activos (fuente por-proveedor).
        providers,
    };
}

/**
 * `isQuotaExhausted()` — variante simple para callers que solo quieren el bool.
 * Hace el mismo readDefensive() incluyendo drenado natural.
 */
function isQuotaExhausted(opts = {}) {
    return readDefensive(opts).exhausted === true;
}

/**
 * Borra el flag (idempotente). Útil en dos contextos:
 *   1. Drenado por `readDefensive` cuando `resets_at` ya pasó.
 *   2. Drenado proactivo cuando un spawn LLM termina exitoso (probó que
 *      la cuota volvió antes del `resets_at` calculado).
 *
 * #3077 CA-8: scope por provider — si el flag activo es de provider X y el
 * caller intenta limpiar con provider Y, el flag NO se borra. Esto cierra
 * el vector "spawn exitoso de OpenAI limpia el flag de Anthropic". Si el
 * caller no pasa `provider`, conserva el comportamiento previo (limpia
 * cualquier flag).
 */
function clearFlag(opts = {}) {
    const file = flagFile();
    const auditEnabled = opts.auditLogEnabled !== false;
    const callerProvider = opts.provider || null;

    // #4731 — Con estado por-proveedor el guard `clear_skipped_provider_mismatch`
    // deja de ser necesario: `clearFlag({provider:X})` opera SÓLO sobre el slot
    // de X. Un proveedor sano nunca puede limpiar el slot de otro (el vector
    // de #3077 CA-8 / SEC-1 queda cerrado por construcción, no por guard).
    //
    // #4577 GATE 3 — INVARIANTE log-antes-de-mutar (RS-2): registrar el clear
    // ANTES de mutar, y SOLO cuando hay algo real que borrar (no floodear el
    // audit con `success_spawn` que no tocan estado).
    const logBeforeMutate = () => {
        try {
            require('./kernel-actions-audit').safeAppendAction({
                action: 'quota-flag-clear', impact: 'alto',
                reason: `clearFlag event=${opts.event || 'cleared'} provider=${callerProvider || 'any'} reason=${opts.reason || 'manual_or_post_success'}`,
                authorizedBy: 'quota-detector',
            });
            require('./kernel-action-policy').enforceActionPolicy('quota-flag-clear', {
                impact: 'alto',
                reason: `clearFlag event=${opts.event || 'cleared'} provider=${callerProvider || 'any'} reason=${opts.reason || 'manual_or_post_success'}`,
            });
        } catch (e) {
            // #5172 — dejó de ser mudo. `quota-flag-clear` es notify-and-proceed
            // y el veredicto no se lee: el clear del flag sigue igual. Sólo se
            // hace visible que el aviso al operador no salió.
            require('./kernel-action-policy').logPolicyEnforcementFailure(
                'quota-exhausted', 'quota-flag-clear', e);
        }
    };
    const auditCleared = (provider, model) => {
        if (!auditEnabled) return;
        appendAudit({
            event: opts.event || 'cleared',
            provider: provider || null,
            model: model || null,
            error_type: null,
            raw_excerpt: opts.reason || 'manual_or_post_success',
            flag_set: false,
        });
    };

    // Caller legacy sin provider: limpia TODO el flag (backward-compat).
    if (!callerProvider) {
        if (!fs.existsSync(file)) return false;
        logBeforeMutate();
        let existed = false;
        try { fs.unlinkSync(file); existed = true; }
        catch (e) { if (e && e.code !== 'ENOENT') { /* best-effort */ } }
        if (existed) auditCleared(null, opts.model || null);
        return existed;
    }

    // Scope por-proveedor: sólo drena el slot de `callerProvider`.
    const map = readCurrentMap();
    if (!map[callerProvider]) {
        // El proveedor no tiene slot activo → no-op silencioso (NO es un
        // mismatch: los otros slots, si existen, quedan intactos).
        return false;
    }
    const model = map[callerProvider].model || opts.model || null;
    logBeforeMutate();
    delete map[callerProvider];
    try {
        if (Object.keys(map).length === 0) {
            fs.unlinkSync(file);
        } else {
            writeJsonAtomic(file, buildHybridPayload(map));
        }
    } catch (e) {
        if (e && e.code !== 'ENOENT') { /* best-effort */ }
    }
    auditCleared(callerProvider, model);
    return true;
}

// -----------------------------------------------------------------------------
// #4865 — Subordinación a la fuente única de verdad de cuota por proveedor.
//
// El gate de cuota agotada (`setFlag`/`shouldGateSpawn`) es un CONSUMIDOR de
// cuota: decide spawn/no-spawn. Antes de #4865 decidía en base a la detección
// por substring del stdout del agente (heurística), no al valor real del
// adapter canónico (`lib/quota-adapters`) que #4861 (Anthropic, `claude -p
// /usage`) y #4868/#4863 (Codex, `codex.rate_limits`) consolidan como fuente
// única. Un falso positivo por substring (issue cuyo body menciona "quota
// exhausted") marcaba anthropic agotado siendo falso y bloqueaba todo el
// dispatch.
//
// Solución: reconciliar contra el adapter ANTES de SETEAR o de HONRAR un flag.
// Si el adapter reporta el proveedor SANO con dato FRESCO (adapterStatus 'ok' y
// pct claramente por debajo del techo), se VETA el set/gate y se audita la
// discrepancia. Fail-closed: si el adapter NO tiene dato fresco (unknown/stale/
// error/ausente), se mantiene el comportamiento conservador actual (set/gate).
//
// La lectura es OFFLINE y NO bloqueante: `autoRefresh:false` → el adapter sólo
// LEE el cache de /usage, nunca spawnea desde el hot-path del detector.
// -----------------------------------------------------------------------------

// pct por debajo del cual, con dato FRESCO, una señal de "cuota agotada" se
// considera falso positivo. 90 coincide con el corte 'critical' del adapter y
// con el gateo de provider-health (`adapterStatus==='ok' && status==='critical'`):
// por debajo de 90% el proveedor NO está agotado, así que una detección por
// substring es espuria. En 90%+ el adapter coincide en que está cerca del techo
// → NO vetamos (honramos el flag).
const RECONCILE_HEALTHY_MAX_PCT = 90;

// Normalización de alias de provider hacia el id canónico del adapter.
const RECONCILE_PROVIDER_ALIAS = Object.freeze({
    openai: 'openai-codex',
    'anthropic-claude': 'anthropic',
});

/**
 * #5455 — Normaliza un id de provider al canónico del adapter.
 */
function canonicalProvider(provider) {
    const raw = typeof provider === 'string' ? provider.trim() : '';
    if (!raw) return '';
    return RECONCILE_PROVIDER_ALIAS[raw] || raw;
}

/**
 * #5455 — PREDICADO EXACTO compartido por `setFlag` (SET) y `shouldGateSpawn`
 * (GET) para la ÚNICA excepción al veto `provider_healthy_fresh` de #4865.
 *
 * Existe porque el adapter canónico reportó `ok/pct:3` DURANTE el incidente
 * real: el corte semanal de Anthropic no se refleja en `/usage` a tiempo, así
 * que el reconcile —correcto para señales por substring— vetaría la única
 * señal fidedigna que existe para este corte. Exceptuar sólo el SET produciría
 * un slot que el GET ignora (y el turno siguiente nunca caería a Codex), por
 * eso el predicado es UNO SOLO y se aplica en ambos puntos.
 *
 * Requiere las DOS condiciones a la vez. Ningún otro tipo (incluido
 * `usage_limit_error`) ni ningún otro provider evita el veto.
 *
 * @param {string} provider        id del provider (acepta alias).
 * @param {string} patternMatched  `errorType` en SET / `pattern_matched` del
 *                                 slot activo en GET.
 * @returns {boolean}
 */
function isWeeklyLimitContentChannel(provider, patternMatched) {
    return canonicalProvider(provider) === DEFAULT_PROVIDER
        && patternMatched === WEEKLY_LIMIT_CONTENT_ERROR_TYPE;
}

function metricsDir() {
    return path.join(pipelineDir(), 'metrics');
}

function repoRootDir() {
    // pipelineDir() == <repo>/.pipeline → el root del repo es su padre.
    return path.resolve(pipelineDir(), '..');
}

// Carga perezosa de los adapters de cuota. Cache local. Devuelve null si el
// módulo no carga (defensa: el detector NUNCA debe crashear el pipeline).
let _quotaAdaptersCache = null;
function getQuotaAdapters(override) {
    if (override) return override;
    if (_quotaAdaptersCache) return _quotaAdaptersCache;
    try {
        _quotaAdaptersCache = require('./quota-adapters');
    } catch {
        _quotaAdaptersCache = null;
    }
    return _quotaAdaptersCache;
}

/**
 * #4865 — Reconcilia una señal de cuota agotada contra la fuente única de
 * verdad (adapter canónico) del proveedor.
 *
 * @param {string} provider  provider del flag/skill.
 * @param {object} [opts]
 *   @property {number}   [now]              reloj override (tests).
 *   @property {function} [_quotaUsageImpl]  inyección de quotaUsage (tests).
 *   @property {object}   [_quotaAdapters]   inyección del módulo (tests).
 * @returns {{ veto: boolean, reason: string, adapterStatus: string|null, pct: number|null }}
 *   veto=true SÓLO cuando el adapter reporta SANO + FRESCO (adapterStatus 'ok'
 *   y pct < RECONCILE_HEALTHY_MAX_PCT). En todo otro caso veto=false (fail-closed:
 *   el caller mantiene el comportamiento conservador).
 */
function reconcileWithCanonicalSource(provider, opts = {}) {
    const noVeto = (reason, extra = {}) =>
        ({ veto: false, reason, adapterStatus: null, pct: null, ...extra });

    // Kill-switch operacional: si por bug la reconciliación bloquea sets
    // legítimos, `QUOTA_RECONCILE_DISABLED=1` la desactiva sin redeploy y el
    // gate vuelve al comportamiento legacy (substring como autoridad).
    if (process.env.QUOTA_RECONCILE_DISABLED === '1') return noVeto('reconcile_disabled');

    const canonical = RECONCILE_PROVIDER_ALIAS[provider] || provider;

    const adapters = getQuotaAdapters(opts._quotaAdapters);
    const quotaUsageFn = opts._quotaUsageImpl
        || (adapters && typeof adapters.quotaUsage === 'function' ? adapters.quotaUsage : null);
    if (!quotaUsageFn) return noVeto('no_adapter');

    // Sólo providers con adapter de cuota real. Un provider fuera de la allowlist
    // (o free) no tiene /usage canónico → fail-closed (no veto).
    const allowed = adapters && Array.isArray(adapters.ALLOWED_PROVIDERS)
        ? adapters.ALLOWED_PROVIDERS : [];
    if (allowed.length && !allowed.includes(canonical)) {
        return noVeto('provider_not_in_adapters', { adapterStatus: null });
    }

    let q;
    try {
        q = quotaUsageFn(canonical, {
            metricsDir: metricsDir(),
            activityLogPath: path.join(repoRootDir(), '.claude', 'activity-log.jsonl'),
            // NO spawnear desde el detector: sólo lectura del cache canónico.
            autoRefresh: false,
            now: Number.isFinite(opts.now) ? opts.now : undefined,
        });
    } catch {
        return noVeto('adapter_threw'); // fail-closed ante excepción del adapter.
    }
    if (!q || typeof q !== 'object') return noVeto('adapter_no_result');

    const adapterStatus = typeof q.adapterStatus === 'string' ? q.adapterStatus : 'unknown';
    const pct = Number.isFinite(q.pct) ? q.pct : null;

    // Veto SÓLO con dato fresco ('ok') y pct claramente por debajo del techo.
    // Cualquier otro estado (unknown/stale/error/no_usage_data, o pct null, o
    // pct >= techo) es fail-closed: mantenemos el comportamiento conservador.
    if (adapterStatus === 'ok' && pct != null && pct < RECONCILE_HEALTHY_MAX_PCT) {
        return { veto: true, reason: 'provider_healthy_fresh', adapterStatus, pct };
    }
    return { veto: false, reason: 'no_fresh_healthy_signal', adapterStatus, pct };
}

// -----------------------------------------------------------------------------
// Set del flag (escritor único: pulpo.js — CA-6)
// -----------------------------------------------------------------------------

/**
 * Persiste el flag de cuota agotada. Idempotente: escribir dos veces con el
 * mismo `pattern_matched` no rompe nada (CA-S4: race detector ↔ gate).
 *
 * #3077:
 *   - Acepta `provider` y `model` (opcionales, persistidos en el flag).
 *   - `errorType` truncado a 128 chars (CA-6 editorial) para acomodar codes
 *     largos de OpenAI tipo `tokens_per_minute_rate_limit_exceeded_for_org_x`.
 *   - Si `provider` viene, se pasa también al audit log (CA-10 / SEC-7).
 *
 * #3575 — Contrato de atomicidad y last-writer-wins
 * -------------------------------------------------
 * La persistencia se hace vía `writeJsonAtomic`, que ejecuta:
 *   1. `fs.writeFileSync(tmp, 0o600) + fs.fsyncSync` sobre un archivo
 *      temporal en `tmpDir()` con sufijo `pid.timestamp.tmp` (único por
 *      escritor).
 *   2. `fs.renameSync(tmp, flagFile())` — atómico en POSIX. En Windows el
 *      rename es semi-atómico y puede dispararse `EBUSY|EPERM|EEXIST`;
 *      `writeJsonAtomic` aplica retry bounded (3 intentos / ≤50ms totales)
 *      sobre esos códigos para amortiguar el flake sin riesgo de spin
 *      infinito.
 *
 * Bajo concurrencia (N procesos invocando `setFlag` simultáneamente):
 *   - **El JSON final SIEMPRE es válido** (no truncado, no campos perdidos):
 *     cada escritor renombra su propio tmp completo y `renameSync` es
 *     atómico — no hay punto en el que un lector pueda observar un archivo
 *     parcialmente escrito.
 *   - **Last-writer-wins**: el `pattern_matched`, `provider`, `model`,
 *     `resets_at` finales corresponden al proceso que ganó el rename. Los
 *     campos perdidos de los otros escritores existen en el audit log
 *     (`appendChained`) — esa es la fuente de verdad para auditoría
 *     cross-skill.
 *   - El permiso `0o600` se preserva en cada rename (mode del tmp se
 *     conserva). En POSIX, asserción anti-regresión:
 *     `(fs.statSync(flagFile()).mode & 0o777) === 0o600`.
 *
 * Esta atomicidad es prerequisito para que #3576 habilite `setFlag` desde
 * más call sites (cross-skill) sin race conditions.
 *
 * @param {object} opts
 * @param {string} opts.errorType valor del error_type del CLI (debe estar en allowlist)
 * @param {string} [opts.provider] provider del agente (default DEFAULT_PROVIDER)
 * @param {string} [opts.model] model del agente (informativo)
 * @param {string|number|Date} [opts.resetsAt] candidato; si falta o malformado, fallback
 * @param {number} [opts.maxDays] cap superior (default DEFAULT_MAX_RESETS_AT_DAYS)
 * @param {number} [opts.now] Date.now() override (tests)
 * @param {boolean} [opts.auditLogEnabled] (default true)
 * @param {string} [opts.agent] skill del agente que disparó (para audit log)
 * @returns {{ flagPath: string, payload: object, source: 'input'|'fallback'|'cap_max' }}
 */
function setFlag(opts = {}) {
    const errorType = String(opts.errorType || '').slice(0, PATTERN_MATCHED_MAX_CHARS);
    const provider = opts.provider || DEFAULT_PROVIDER;
    const model = opts.model || null;
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();

    // #4865 — Subordinación a la fuente única: antes de SETEAR el flag,
    // reconciliar contra el adapter canónico. Si la fuente de verdad dice que el
    // proveedor está sano con dato fresco, la señal por substring es un falso
    // positivo → vetamos el set y auditamos la discrepancia (no fail-open: sólo
    // vetamos con dato fresco; sin dato, se persiste igual — fail-closed).
    const reconciliation = reconcileWithCanonicalSource(provider, opts);
    // #5455 — ÚNICA excepción al veto: el aviso del canal de contenido de
    // Anthropic (ver `isWeeklyLimitContentChannel`). Se audita explícitamente
    // para que el bypass quede trazable, y el TTL queda clampeado a 60 min más
    // abajo, así un eventual falso positivo cuesta como máximo una hora.
    const bypassVeto = reconciliation.veto
        && isWeeklyLimitContentChannel(provider, errorType);
    if (bypassVeto && opts.auditLogEnabled !== false) {
        appendAudit({
            event: 'flag_set_veto_bypassed',
            agent: opts.agent || null,
            provider,
            model,
            error_type: errorType,
            raw_excerpt: `reconcile veto bypassed (#5455 content channel): adapter_status=${reconciliation.adapterStatus} pct=${reconciliation.pct}`,
            flag_set: true,
        }, { now });
    }
    if (reconciliation.veto && !bypassVeto) {
        if (opts.auditLogEnabled !== false) {
            appendAudit({
                event: 'flag_set_vetoed',
                agent: opts.agent || null,
                provider,
                model,
                error_type: errorType,
                raw_excerpt: `reconcile veto: adapter_status=${reconciliation.adapterStatus} pct=${reconciliation.pct} pattern="${errorType}"`,
                flag_set: false,
            }, { now });
        }
        return {
            flagPath: flagFile(),
            payload: null,
            vetoed: true,
            source: 'reconcile_veto',
            reconciliation,
        };
    }
    // Codex/ChatGPT `usage_limit_reached` es un cap rolling: si el caller no
    // aportó un `resets_at` (el CLI lo emite como texto libre, sin campo
    // estructurado), gateamos por una ventana corta en vez del fallback semanal.
    let effectiveResetsAt = opts.resetsAt;
    if (effectiveResetsAt == null && errorType === 'usage_limit_reached') {
        effectiveResetsAt = now + CODEX_USAGE_LIMIT_RESET_MS;
    }
    // #4731 — TTL configurable por proveedor (clampeado). Prioriza opts.maxDays.
    let maxDays = resolveMaxDays(provider, opts);
    // #5455 (compensación 7) — El tipo del canal de contenido tiene un TTL
    // efectivo máximo de 60 minutos, INDEPENDIENTE de lo que anuncie el texto,
    // de `config.yaml:ttl_by_provider` y de lo que pase el caller. El clamp vive
    // acá (escritor único) y no en el caller: así ningún call-site futuro puede
    // persistir este tipo con el default de 7 días por olvido.
    if (isWeeklyLimitContentChannel(provider, errorType)) {
        maxDays = Math.min(maxDays, WEEKLY_LIMIT_CONTENT_MAX_DAYS);
    }
    const cap = capResetsAt(effectiveResetsAt, { maxDays, now });
    const slot = {
        exhausted: true,
        resets_at: cap.iso,
        detected_at: new Date(now).toISOString(),
        pattern_matched: errorType,
        ...(model ? { model } : {}),
    };
    // #4577 GATE 3 — INVARIANTE log-antes-de-mutar (RS-2): registrar el set del
    // flag de cuota ANTES del write atómico (incidente #4565).
    try {
        require('./kernel-actions-audit').safeAppendAction({
            action: 'quota-flag-set', impact: 'alto',
            reason: `setFlag provider=${provider} error_type=${errorType} agent=${opts.agent || 'unknown'}`,
            authorizedBy: 'quota-detector',
        });
        require('./kernel-action-policy').enforceActionPolicy('quota-flag-set', {
            impact: 'alto',
            reason: `setFlag provider=${provider} error_type=${errorType} agent=${opts.agent || 'unknown'}`,
        });
    } catch (e) {
        // #5172 — dejó de ser mudo. `quota-flag-set` es notify-and-proceed y el
        // veredicto no se lee: el set del flag sigue igual. Sólo se hace visible
        // que el aviso al operador no salió.
        require('./kernel-action-policy').logPolicyEnforcementFailure(
            'quota-exhausted', 'quota-flag-set', e);
    }
    // #4731 — Read-modify-write del mapa por-proveedor: NO pisa slots de otros
    // proveedores agotados (habilita coexistencia CA-3). Bajo concurrencia exacta
    // aplica last-writer-wins sobre el mapa (documentado, atomicidad garantizada
    // por el rename de writeJsonAtomic).
    const map = readCurrentMap();
    map[provider] = { provider, ...slot, resets_at_ms: cap.ms };
    const payload = buildHybridPayload(map);
    writeJsonAtomic(flagFile(), payload);
    if (opts.auditLogEnabled !== false) {
        appendAudit({
            event: 'flag_set',
            agent: opts.agent || null,
            provider,
            model,
            error_type: errorType,
            raw_excerpt: opts.rawExcerpt || `resets_at_source=${cap.source}`,
            flag_set: true,
        });
    }
    return { flagPath: flagFile(), payload, source: cap.source };
}

// -----------------------------------------------------------------------------
// Audit log (CA-7 del issue, CA-11 del padre, #3077 SEC-7)
// -----------------------------------------------------------------------------

/**
 * Append una entrada al audit log diario. Cada línea es JSON con shape
 * sanitizado. Best-effort: errores de IO se silencian para no romper el
 * pipeline (el detector NUNCA debe ser el causante de un crash).
 *
 * #3077 CA-10 / SEC-7: cada entry incluye `provider` y `model` para
 * debugging multi-provider ("se gateó pero no sé quién").
 */
function appendAudit(entry, opts = {}) {
    try {
        const ts = entry.timestamp || new Date().toISOString();
        const line = JSON.stringify({
            timestamp: ts,
            event: entry.event || null,
            agent: entry.agent || null,
            provider: entry.provider || null,
            model: entry.model || null,
            error_type: entry.error_type || null,
            raw_excerpt: sanitizeRawExcerpt(entry.raw_excerpt),
            flag_set: entry.flag_set === true,
        }) + '\n';
        ensureDir(logsDir());
        fs.appendFileSync(auditLogFile(opts.now ? new Date(opts.now) : undefined), line, {
            flag: 'a',
            mode: 0o600,
        });
    } catch { /* best-effort */ }
}

// -----------------------------------------------------------------------------
// Detector estructurado (CA-1, CA-4) — anti prompt-injection, multi-provider
// -----------------------------------------------------------------------------

/**
 * Handler Anthropic: matchea el shape del JSON stream del CLI claude-code.
 *
 *   Match: `evt.type === 'result' && evt.is_error === true && evt.error_type ∈ allowlist`
 */
// #3506: pattern del glitch del CLI Anthropic Claude Code con Opus 4.7 1M.
// El CLI tira "Usage credits required for 1M context" intermitentemente
// aunque el plan Claude Max 20x incluya 1M para Opus 4.7. NO es cuota real
// — no debe contaminar el flag global ni disparar fallback cross-provider.
// Detalle completo en `lib/commander/provider-error-parser.js` (#3506).
const _CLI_1M_CONTEXT_GLITCH_PATTERN =
    /\bUsage\s+credits?\s+required\s+for\s+1M\s+context\b/i;

// Codex CLI con cuenta ChatGPT (OAuth, sin API key paga) reporta el límite de
// uso como TEXTO LIBRE, sin `error.type` estructurado, en eventos del canal de
// CONTROL del CLI:
//   {"type":"error","message":"You've hit your usage limit. Upgrade to Pro..."}
//   {"type":"turn.failed","error":{"message":"You've hit your usage limit..."}}
// A diferencia del canal de contenido del modelo, estos frames de protocolo NO
// pueden ser inyectados por el modelo, así que matchear un regex ACOTADO sobre
// su `message` es seguro (mismo criterio estructural que el glitch 1M de
// Anthropic). ReDoS-safe: clases restringidas y cuantificadores acotados.
const _CODEX_USAGE_LIMIT_PATTERN =
    /\byou'?ve\s+hit\s+your\s+usage\s+limit\b/i;

// El límite de uso de la cuenta ChatGPT es un cap ROLLING (resetea en minutos/
// horas, no semanal). Cuando el CLI no entrega un `resets_at` estructurado,
// gateamos codex por esta ventana corta en vez del fallback semanal — así no
// desperdiciamos el fallback pago durante días. Es auto-corrector: si al drenar
// la cuota sigue agotada, el próximo intento re-setea el flag (idempotente).
const CODEX_USAGE_LIMIT_RESET_MS = 60 * 60 * 1000; // 1h

// #4731 — TTL (cap de `resets_at`) configurable POR PROVEEDOR. Fuente:
// `config.yaml:quota_detector.ttl_by_provider.<id>` (en días) con default
// `quota_detector.resets_at_cap_max_days`. Clampeado a rango seguro
// [MIN_TTL_DAYS, MAX_TTL_DAYS] (security A05): un valor inválido o fuera de
// rango cae al default conservador y se acota — nunca deja flags eternos ni
// expira sin evidencia. La lectura es defensiva y cacheada: si el config no
// carga, se usa DEFAULT_MAX_RESETS_AT_DAYS.
const MIN_TTL_DAYS = 1 / 24;              // 1h — piso (evita flags que expiran al instante)
const MAX_TTL_DAYS = 31;                  // 31d — techo (cuota mensual OpenAI)

// #5172 — La lectura y la validación pasan por el punto único
// (`lib/config-resolver`). Se elimina el `catch { defaults }`: enmascaraba un
// fallo de LECTURA (archivo ausente, YAML roto, schema violado) como "el
// operador no configuró TTLs", que es indistinguible de la configuración por
// defecto. Ahora el error tipado se PROPAGA.
//
// Lo que SÍ se conserva (D-4): un config VÁLIDO **sin sección `quota_detector:`**
// no es corrupción ⇒ `{}` y cada TTL cae a su default conservador clampeado.
//
// El caché local sobrevive porque cachea la SECCIÓN ya extraída (el resolver
// cachea el documento completo por ruta) y sólo se puebla en el camino de éxito:
// un fallo de lectura no queda pegado como "sin configuración".
let _quotaDetectorCfgCache = null;
function loadQuotaDetectorConfig() {
    if (_quotaDetectorCfgCache !== null) return _quotaDetectorCfgCache;
    // Lazy-require deliberado (G-3): el resolver arrastra `js-yaml` + `ajv`.
    const configResolver = require('./config-resolver');
    const full = configResolver.resolve({ pipelineDir: pipelineDir() });
    const cfg = (full && full.quota_detector && typeof full.quota_detector === 'object')
        ? full.quota_detector
        : {};
    _quotaDetectorCfgCache = cfg;
    return cfg;
}

/**
 * #5172 (rebote rev-1) — Deja traza de que el TTL cayó al default porque la
 * configuración no se pudo leer. Nunca lanza (corre dentro del camino de
 * escritura del flag) y nunca reexpone el `.message` crudo de js-yaml (SEC-1):
 * de una violación de config sólo se emiten `causa`, `linea` y `columna`, que
 * son metadata segura y accionable.
 */
function logMaxDaysDegradation(provider, err) {
    try {
        let detalle;
        let esViolacion = false;
        try {
            esViolacion = require('./config-resolver').isConfigViolation(err);
        } catch { /* resolver no cargable: se trata como no-violación */ }
        if (esViolacion) {
            detalle = `config inválida (causa=${(err && err.causa) || 'desconocida'}`
                + `${err && err.linea != null ? `, linea=${err.linea}` : ''}`
                + `${err && err.columna != null ? `, columna=${err.columna}` : ''})`;
        } else if (err && err.code === 'MODULE_NOT_FOUND') {
            detalle = 'config-resolver no cargable (worktree sin node_modules)';
        } else {
            detalle = `error inesperado (${(err && err.name) || 'Error'})`;
        }
        process.stderr.write(
            `[quota-exhausted] DEGRADACION TTL: no se pudo resolver el cap de días para `
            + `provider=${provider} — ${detalle}. Se usa el default conservador de `
            + `${DEFAULT_MAX_RESETS_AT_DAYS}d y el flag de cuota SE PERSISTE igual `
            + `(perderlo dejaría al pipeline despachando contra un proveedor agotado).\n`
        );
    } catch { /* fail-soft: si no podemos loguear, seguimos */ }
}

/**
 * #4731 — Resuelve el cap de días (`maxDays`) para un proveedor. Prioridad:
 *   1. `opts.maxDays` explícito del caller (contrato #3077 preservado).
 *   2. `config.quota_detector.ttl_by_provider.<provider>`.
 *   3. `config.quota_detector.resets_at_cap_max_days` (default legacy).
 *   4. `DEFAULT_MAX_RESETS_AT_DAYS`.
 * El resultado se clampa a [MIN_TTL_DAYS, MAX_TTL_DAYS]; un valor inválido cae
 * al default conservador (`DEFAULT_MAX_RESETS_AT_DAYS`).
 */
function resolveMaxDays(provider, opts = {}) {
    if (Number.isFinite(opts.maxDays) && opts.maxDays > 0) {
        return Math.min(MAX_TTL_DAYS, Math.max(MIN_TTL_DAYS, opts.maxDays));
    }
    // #5172 (rebote rev-1) — INVERSIÓN DEL FAIL-CLOSED EN ESTE PUNTO.
    //
    // `resolveMaxDays` se invoca DENTRO de `setFlag`, es decir en el camino de
    // ESCRITURA del flag de cuota agotada. Propagar acá el error tipado del
    // resolver NO es fail-closed: es fail-OPEN. El único call-site de producción
    // (`lib/agent-launcher/dispatch-with-fallback.js`) envuelve `setFlag` en un
    // catch best-effort, así que un config corrupto hacía que el flag NUNCA se
    // persistiera y el pipeline siguiera despachando contra un proveedor en 429.
    //
    // Lo que se resuelve acá es SÓLO un cap de TTL cuyo default
    // (`DEFAULT_MAX_RESETS_AT_DAYS`, clampeado a [MIN_TTL_DAYS, MAX_TTL_DAYS])
    // es seguro por construcción. La acción conservadora ante config ilegible es
    // PERSISTIR el flag con el TTL default — no perder la señal de cuota.
    //
    // La degradación NO es silenciosa: queda traza explícita. El fail-closed
    // ruidoso del resolver sigue vigente en los lectores cuyo camino NO es una
    // escritura de seguridad (pulpo, dashboard, project-bootstrap).
    let cfg;
    try {
        cfg = loadQuotaDetectorConfig();
    } catch (e) {
        logMaxDaysDegradation(provider, e);
        return Math.min(MAX_TTL_DAYS, Math.max(MIN_TTL_DAYS, DEFAULT_MAX_RESETS_AT_DAYS));
    }
    let days = DEFAULT_MAX_RESETS_AT_DAYS;
    const perProvider = cfg && cfg.ttl_by_provider;
    if (perProvider && typeof perProvider === 'object'
        && Number.isFinite(perProvider[provider]) && perProvider[provider] > 0) {
        days = perProvider[provider];
    } else if (Number.isFinite(cfg && cfg.resets_at_cap_max_days) && cfg.resets_at_cap_max_days > 0) {
        days = cfg.resets_at_cap_max_days;
    }
    if (!Number.isFinite(days) || days <= 0) days = DEFAULT_MAX_RESETS_AT_DAYS;
    return Math.min(MAX_TTL_DAYS, Math.max(MIN_TTL_DAYS, days));
}

// #5455 — Cota dura de acumulación al concatenar bloques. Es una defensa de
// MEMORIA, no un criterio de match: cualquier contenido que la supere ya está
// muy por encima de `WEEKLY_LIMIT_CONTENT_MAX_CHARS` y sería rechazado igual
// tras el `trim()`. Existe para no materializar un string gigante antes de
// medirlo.
const _WEEKLY_LIMIT_CONTENT_ACCUM_CAP = WEEKLY_LIMIT_CONTENT_MAX_CHARS * 8;

/**
 * #5455 — Normaliza el contenido de un frame `result` de Anthropic a string.
 *
 * SHAPES ACEPTADOS (compensación 3, fail-closed):
 *   - `string` — el shape del incidente real.
 *   - `Array` de bloques EXCLUSIVAMENTE `{ type: 'text', text: string }`.
 *
 * Cualquier otra cosa (número, objeto suelto, array vacío, array con un bloque
 * `tool_use`/`image`/sin `text` string, o más de `WEEKLY_LIMIT_CONTENT_MAX_BLOCKS`
 * bloques) devuelve `null`. Un solo bloque no textual invalida TODO el frame —
 * no se filtran los textuales y se concatenan los que "sirven", porque eso
 * permitiría esconder el aviso dentro de una respuesta con herramientas.
 *
 * @returns {string|null} contenido crudo concatenado (sin trim) o null.
 */
function _normalizeAnthropicResultContent(raw) {
    if (typeof raw === 'string') return raw;
    if (!Array.isArray(raw)) return null;
    if (raw.length === 0 || raw.length > WEEKLY_LIMIT_CONTENT_MAX_BLOCKS) return null;
    let out = '';
    for (const block of raw) {
        if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
        if (block.type !== 'text' || typeof block.text !== 'string') return null;
        out += block.text;
        if (out.length > _WEEKLY_LIMIT_CONTENT_ACCUM_CAP) return null;
    }
    return out;
}

/**
 * #5455 — Delega el reset crudo del aviso en el ÚNICO parser del pipeline
 * (`anthropic-usage.parseResetToIso`). Require perezoso + try/catch: el
 * detector NUNCA debe tirar, y así evitamos cualquier ciclo de require.
 *
 * Un reset ausente o no interpretable devuelve `null` (fail-closed, sin
 * inventar fecha); `setFlag` aplica entonces su fallback y, en cualquier caso,
 * clampea el TTL efectivo a 60 minutos para este tipo.
 *
 * @param {string|undefined} rawReset texto capturado por el regex.
 * @param {number} [nowMs] reloj inyectable (tests determinísticos).
 * @returns {string|null} ISO o null.
 */
function _parseWeeklyLimitReset(rawReset, nowMs) {
    if (typeof rawReset !== 'string' || !rawReset.trim()) return null;
    try {
        const { parseResetToIso } = require('./anthropic-usage');
        if (typeof parseResetToIso !== 'function') return null;
        return parseResetToIso(rawReset, Number.isFinite(nowMs) ? nowMs : undefined);
    } catch {
        return null;
    }
}

/**
 * #5455 — Detector del canal de CONTENIDO de Anthropic (excepción acotada).
 *
 * Devuelve el resultado DISCRIMINADO que consumen adapter/dispatcher, o `null`
 * si no aplica (para que el caller siga con el path estructural de siempre).
 * Nunca devuelve `{ matched: false }`: `null` significa "este path no opina".
 *
 * Todas las compensaciones del bloque de cabecera se aplican acá, en orden de
 * costo creciente — el regex es lo ÚLTIMO y sólo corre sobre ≤200 caracteres.
 *
 * @param {object} evt        frame ya validado como `type === 'result'`.
 * @param {string[]} allowlist quota_error_types del provider EN USO.
 * @param {object} [opts]
 * @param {string} [opts.providerId] provider explícito (refuerzo de scope).
 * @param {number} [opts.now] reloj inyectable para el parseo del reset.
 * @returns {{matched: true, errorType: string, resetsAt: string|null,
 *            source: string, rawExcerpt: string}|null}
 */
function _detectAnthropicContentChannel(evt, allowlist, opts = {}) {
    // Compensación 1 (scope por allowlist): el tipo dedicado debe estar
    // declarado por el provider EN USO. Sólo `anthropic` puede declararlo sin
    // que `agent-models-validate.js` falle al boot, así que esto ancla el path
    // a Anthropic incluso cuando el caller no aporta el nombre del provider.
    if (!Array.isArray(allowlist)) return null;
    if (!allowlist.includes(WEEKLY_LIMIT_CONTENT_ERROR_TYPE)) return null;

    // Compensación 1 (refuerzo explícito): si el caller SÍ sabe qué provider
    // corrió y no es el canónico `anthropic`, el path no aplica. Defensa contra
    // un provider mal configurado que copiara la allowlist de Anthropic.
    if (opts.providerId != null
        && canonicalProvider(opts.providerId) !== DEFAULT_PROVIDER) {
        return null;
    }

    // Compensación 3: shapes cerrados.
    const normalized = _normalizeAnthropicResultContent(evt.result);
    if (normalized === null) return null;

    // Compensación 2 + 4: frame COMPLETO, trim sólo exterior, cota de 200.
    const content = normalized.trim();
    if (!content || content.length > WEEKLY_LIMIT_CONTENT_MAX_CHARS) return null;

    // Compensación 5: regex anclado, cuantificadores acotados, sobre ≤200 chars.
    const m = _ANTHROPIC_WEEKLY_LIMIT_CONTENT_PATTERN.exec(content);
    if (!m) return null;

    return {
        matched: true,
        errorType: WEEKLY_LIMIT_CONTENT_ERROR_TYPE,        // compensación 6
        resetsAt: _parseWeeklyLimitReset(m[1], opts.now),
        source: WEEKLY_LIMIT_CONTENT_SOURCE,               // compensación 8
        rawExcerpt: sanitizeRawExcerpt(content),           // compensación 8
    };
}

// #5455 — Cotas del barrido de log (`detectWeeklyLimitContentChannelFromLog`).
// El log crudo de un spawn puede ser grande; el barrido queda acotado para que
// el detector no se vuelva un costo relevante ni un vector de DoS por tamaño.
const _WEEKLY_LIMIT_SCAN_MAX_LINES = 5000;
const _WEEKLY_LIMIT_SCAN_MAX_LINE_CHARS = 8192;

/**
 * #5455 — Barre un log crudo de CLI buscando el frame del canal de contenido.
 *
 * Existe para que adapter y dispatcher compartan UNA sola implementación y no
 * tengan que re-parsear `verdict.evidence`: ese campo pasa por
 * `sanitizeRawExcerpt` (redacción + truncado a `RAW_EXCERPT_MAX_CHARS`), así
 * que NO es JSON re-parseable de forma confiable. La fuente correcta es el log
 * crudo.
 *
 * SCOPE ANTHROPIC — ENFORCED, no "por construcción" (fix del rechazo de #5455).
 * Antes esta función forzaba `providerId: DEFAULT_PROVIDER` hardcodeado: eso
 * sólo decidía QUÉ allowlist se consultaba, no SOBRE QUÉ PROVIDER aterrizaba el
 * flag. El caller persistía el `errorType` devuelto con el provider que
 * realmente corrió, así que un spawn de `openai-codex` podía terminar con
 * `weekly_limit_content_channel` — un tipo ajeno a SU allowlist — vía una línea
 * con forma de frame inyectada en el log (el pipeline ingiere texto de GitHub
 * hacia los agentes, y en los CLIs no-Anthropic el log crudo es texto plano).
 *
 * Ahora el providerId REAL es obligatorio y se valida contra el canónico:
 * fail-closed (sin provider, o provider != `anthropic` => `null`). El default
 * implícito se eliminó a propósito: un caller que se olvide de declararlo debe
 * obtener "no match", nunca un flag espurio de Anthropic.
 *
 * @param {string} rawText contenido crudo del log del spawn.
 * @param {object} [opts] `{ now, providerId }`. `providerId` es OBLIGATORIO y
 *                        debe canonicalizar a `anthropic`; `now` es el reloj
 *                        inyectable para el parseo del reset.
 * @returns {{matched: true, errorType: string, resetsAt: string|null,
 *            source: string, rawExcerpt: string}|null}
 */
function detectWeeklyLimitContentChannelFromLog(rawText, opts = {}) {
    if (typeof rawText !== 'string' || !rawText) return null;
    // SCOPE ANTHROPIC enforced: el barrido no corre para ningún otro provider.
    if (canonicalProvider(opts.providerId) !== DEFAULT_PROVIDER) return null;
    const allowlist = KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER[DEFAULT_PROVIDER] || [];
    if (!allowlist.includes(WEEKLY_LIMIT_CONTENT_ERROR_TYPE)) return null;
    const lines = rawText.split('\n');
    const limit = Math.min(lines.length, _WEEKLY_LIMIT_SCAN_MAX_LINES);
    for (let i = 0; i < limit; i++) {
        const line = lines[i].trim();
        // Sólo frames JSON del stream. `startsWith('{')` replica el criterio ya
        // usado por `providers/anthropic.js`.
        if (line.length === 0 || line.length > _WEEKLY_LIMIT_SCAN_MAX_LINE_CHARS) continue;
        if (line.charCodeAt(0) !== 123 /* '{' */) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        if (!evt || typeof evt !== 'object' || evt.type !== 'result') continue;
        const r = _detectAnthropicContentChannel(evt, allowlist, {
            ...opts,
            providerId: DEFAULT_PROVIDER,
        });
        if (r) return r;
    }
    return null;
}

function _detectAnthropic(evt, allowlist, opts = {}) {
    if (!evt || typeof evt !== 'object') return { matched: false };
    if (evt.type !== 'result') return { matched: false };

    // #5455 — CANAL DE CONTENIDO (excepción acotada; ver bloque de compensaciones
    // arriba). Corre ANTES del path estructural porque el frame real NO trae
    // `is_error` ni `error_type` — el path estructural lo descartaría. No hay
    // solapamiento: el regex está anclado al aviso semanal completo, así que un
    // frame estructural legítimo nunca matchea acá y cae al path de siempre.
    const contentMatch = _detectAnthropicContentChannel(evt, allowlist, opts);
    if (contentMatch) return contentMatch;

    if (evt.is_error !== true) return { matched: false };
    const errorType = typeof evt.error_type === 'string' ? evt.error_type : null;
    if (!errorType) return { matched: false };
    if (!allowlist.includes(errorType)) return { matched: false };

    // #3506: subcase del glitch del CLI con 1M context. Si el mensaje
    // estructural lo identifica, marcamos `cliGlitch: true` y NO matched —
    // el caller debe inspeccionar el flag y aplicar política propia
    // (retry sin contaminar el flag global de quota).
    // #3508 SEC-2: feature flag operativo. Si el operador desactiva el
    // workaround (`ANTHROPIC_1M_WORKAROUND_ENABLED=0`), saltamos el regex y
    // dejamos que el error caiga al path genérico `quota_exhausted`. Carga
    // perezosa del módulo para no introducir ciclo de require al boot.
    let oneMEnabled = true;
    try {
        oneMEnabled = require('./commander/anthropic-1m-workaround').isWorkaroundEnabled();
    } catch { /* defensa: si el módulo no carga, mantener comportamiento #3506 */ }
    if (oneMEnabled) {
        const textChunks = [evt.result, evt.error, evt.message, evt.error_message]
            .filter(s => typeof s === 'string')
            .join(' ');
        if (textChunks && _CLI_1M_CONTEXT_GLITCH_PATTERN.test(textChunks)) {
            return {
                matched: false,
                cliGlitch: true,
                glitchType: 'cli_1m_context_glitch',
            };
        }
    }
    return { matched: true, errorType };
}

/**
 * Handler OpenAI/Codex: matchea el shape SSE del CLI codex.
 *
 *   Shape canónico (a confirmar/refinar cuando #3075 H3 desbloquee con CLI real):
 *   `evt.event === 'error' && typeof evt.data === 'object' && evt.data.error.type ∈ allowlist`
 *
 *   Alternativa observada en algunos clientes OpenAI:
 *   `evt.type === 'response.error' && evt.error.type ∈ allowlist`
 *
 *   Shape DESNUDO observado empíricamente en Cerebras (#5978, 2026-08-22), sin
 *   sobre SSE y con el discriminador en `code` en vez de `type`:
 *   `{"error":{"status":402,"message":"Payment required ...","code":"insufficient_quota"}}`
 *   Este shape hacía invisible el 402 de billing: el detector devolvía
 *   `matched:false`, nunca se seteaba el flag de cuota, el resolver seguía
 *   eligiendo el provider muerto y cada relanzamiento quemaba un reintento del
 *   ISSUE hasta rebotarlo por "huérfano tras 3 reintentos".
 *
 * Soportamos los tres shapes para tolerancia. PROHIBIDO matchear por substring
 * sobre texto libre. PROHIBIDO matchear contra campos controlados por el
 * modelo (canal de contenido). El match sigue siendo fail-closed: `type`/`code`
 * sólo cuentan si el provider DECLARÓ ese error_type en su allowlist.
 */
function _detectOpenAI(evt, allowlist) {
    if (!evt || typeof evt !== 'object') return { matched: false };

    // Shape SSE canónico: { event: 'error', data: { error: { type, message } } }
    if (evt.event === 'error' && evt.data && typeof evt.data === 'object') {
        const errType = evt.data.error && typeof evt.data.error.type === 'string'
            ? evt.data.error.type
            : null;
        if (errType && allowlist.includes(errType)) {
            return { matched: true, errorType: errType };
        }
    }

    // Shape alternativo: { type: 'response.error', error: { type } }
    if (evt.type === 'response.error' && evt.error && typeof evt.error === 'object') {
        const errType = typeof evt.error.type === 'string' ? evt.error.type : null;
        if (errType && allowlist.includes(errType)) {
            return { matched: true, errorType: errType };
        }
    }

    // Shape DESNUDO (#5978): `{ error: { status, message, code } }` — sin sobre
    // SSE. Es lo que emite Cerebras (y varios OpenAI-compat) al morir por 402 de
    // billing. Se leen SOLO los campos de control `type` y `code` del objeto
    // `error` de nivel raíz; nunca texto libre ni canal de contenido. Se exige
    // que NO haya discriminador de evento (`evt.event`/`evt.type`) para no pisar
    // los shapes de arriba, y el valor debe estar en la allowlist del provider
    // (fail-closed: un provider que no declara el tipo jamás matchea).
    if (!evt.event && !evt.type && evt.error && typeof evt.error === 'object' && !Array.isArray(evt.error)) {
        const bareType = typeof evt.error.type === 'string' ? evt.error.type : null;
        const bareCode = typeof evt.error.code === 'string' ? evt.error.code : null;
        for (const candidate of [bareType, bareCode]) {
            if (candidate && allowlist.includes(candidate)) {
                return { matched: true, errorType: candidate };
            }
        }
    }

    // Codex CLI (cuenta ChatGPT): límite de uso reportado como texto libre en el
    // canal de control (`turn.failed` / `error`), sin `error.type` estructurado.
    // Solo se activa si el provider declara el error_type sintético
    // `usage_limit_reached` en su allowlist (SR-7). El regex se aplica ÚNICAMENTE
    // sobre eventos de control — nunca sobre el canal de contenido del modelo.
    if ((evt.type === 'turn.failed' || evt.type === 'error')
        && allowlist.includes('usage_limit_reached')) {
        const msg = (evt.error && typeof evt.error.message === 'string')
            ? evt.error.message
            : (typeof evt.message === 'string' ? evt.message : '');
        if (msg && _CODEX_USAGE_LIMIT_PATTERN.test(msg)) {
            return { matched: true, errorType: 'usage_limit_reached' };
        }
    }

    return { matched: false };
}

/**
 * Dispatcher por provider. Resuelve el handler por launcher/output_parser y
 * matchea el evento contra el set de quota_error_types del provider en uso.
 *
 * #3077 SEC-1: PROHIBIDO match cross-provider. Si el provider del flag activo
 * es X y el evento viene de un skill con provider Y, el match SOLO usa el
 * allowlist de Y (no la unión de ambos).
 *
 * @param {object} parsedEvent evento parseado del stream del CLI
 * @param {object} providerDef providerDef desde agent-models.json
 * @param {object} [opts] reservado
 * @returns {{ matched: boolean, errorType?: string, provider?: string }}
 */
function detectQuotaError(parsedEvent, providerDef, opts = {}) {
    if (!providerDef || typeof providerDef !== 'object') {
        return { matched: false };
    }
    const allowlist = Array.isArray(providerDef.quota_error_types)
        ? providerDef.quota_error_types
        : [];
    if (allowlist.length === 0) return { matched: false };

    const parser = providerDef.output_parser;
    let result;
    if (parser === 'anthropic-stream-json') {
        result = _detectAnthropic(parsedEvent, allowlist);
    } else if (parser === 'openai-sse') {
        result = _detectOpenAI(parsedEvent, allowlist);
    } else {
        // Provider sin handler conocido (deterministic, gemini, ollama):
        // no aplica detección de cuota basada en eventos.
        return { matched: false };
    }

    if (result.matched && providerDef.launcher) {
        // Inferir nombre de provider para info de retorno (informativo).
        // El caller pasa el providerDef por nombre; acá solo devolvemos el
        // launcher como hint. El nombre canónico lo conoce el caller.
        return { ...result, launcherUsed: providerDef.launcher };
    }
    return result;
}

/**
 * Detector legacy (#2974) — backward-compat para callers que aún no migraron
 * a `detectQuotaError(evt, providerDef)`.
 *
 * Si `cfg` viene con `error_types` array, lo usa como allowlist (config legacy
 * de config.yaml:quota_detector.error_types). Si no, usa DEFAULT_ERROR_TYPES.
 *
 * Asume shape Anthropic — para multi-provider los callers DEBEN migrar a
 * detectQuotaError(evt, providerDef).
 *
 * @param {object} evt evento parseado del stream-json
 * @param {object} cfg config quota_detector (legacy; si null, usa defaults)
 * @returns {{ matched: boolean, errorType?: string }}
 */
function detectFromResultEvent(evt, cfg = null) {
    const allowlist = (cfg && Array.isArray(cfg.error_types) && cfg.error_types.length > 0)
        ? cfg.error_types
        : DEFAULT_ERROR_TYPES;
    return _detectAnthropic(evt, allowlist);
}

/**
 * Skills determinísticos (espejo de DETERMINISTIC_SKILLS en pulpo.js#L4782).
 * El gate pre-spawn deja pasar estos skills incluso con flag activo —
 * corren en Node puro sin tokens LLM.
 */
const DETERMINISTIC_SKILLS = Object.freeze(
    new Set(['build', 'tester', 'delivery', 'linter'])
);

function isDeterministicSkill(skill) {
    return DETERMINISTIC_SKILLS.has(String(skill || '').trim().toLowerCase());
}

/**
 * Decide si el spawn de un skill se debe gatear (es decir, NO spawnear).
 *
 * #3077 CA-7 / SEC-5: scope por provider. Si el caller pasa `provider`, el
 * gate dispara SOLO si el flag activo es del MISMO provider. Esto da valor
 * real al multi-provider — Anthropic agotado NO bloquea skills configurados
 * con OpenAI o Google.
 *
 * Si el caller NO pasa provider, conserva el comportamiento previo (gate si
 * cualquier flag activo) — backward-compat con callers sin migrar.
 *
 * Uso típico en pulpo.js antes del `spawn(claude.exe, ...)`:
 *
 *     const skillProvider = agentModels.resolveProvider(skill);
 *     if (shouldGateSpawn(skill, { provider: skillProvider })) {
 *         // dejar archivo en pendiente/, no spawnear, opcional notificar.
 *         return;
 *     }
 *
 * @param {string} skill
 * @param {object} [opts]
 * @param {string} [opts.provider] provider del skill (para scope)
 * @param {number} [opts.now] Date.now() override (tests)
 * @returns {boolean}
 */
function shouldGateSpawn(skill, opts = {}) {
    if (isDeterministicSkill(skill)) return false;
    const flag = readDefensive(opts);
    if (flag.exhausted !== true) return false;
    // #3077 CA-7 / #4731: si el caller pasó provider, gatear SOLO si ese
    // proveedor tiene un slot activo (scope por-proveedor). Con múltiples
    // proveedores agotados, cada uno gatea sólo sus propios skills.
    if (opts.provider) {
        const slots = Array.isArray(flag.providers) ? flag.providers : [];
        // #5455 — Seleccionamos el SLOT ACTIVO (no sólo su existencia) porque el
        // bypass del veto depende de su `pattern_matched`.
        const activeSlot = slots.find((p) => p && p.provider === opts.provider) || null;
        if (!activeSlot) return false;
        // #4865 — antes de HONRAR el gate, reconciliar contra la fuente única.
        // Si el adapter canónico reporta el proveedor sano con dato fresco, el
        // slot activo es un remanente o falso positivo → NO gateamos y auditamos
        // la discrepancia. Fail-closed: sin dato fresco, honramos el flag (return
        // true), preservando el comportamiento conservador previo.
        const reconciliation = reconcileWithCanonicalSource(opts.provider, opts);
        // #5455 — MISMO predicado exacto que en `setFlag` (SET). Sin esto, el
        // subtipo se persistiría y el GET lo ignoraría con el adapter en
        // `ok/pct:3`: el turno siguiente volvería a elegir Anthropic y el gate
        // no serviría de nada. El bypass exige provider `anthropic` Y
        // `pattern_matched === weekly_limit_content_channel` en el slot ACTIVO;
        // cualquier otro tipo (incluido `usage_limit_error`) o cualquier otro
        // provider conserva el veto de #4865 intacto.
        const bypassVeto = reconciliation.veto
            && isWeeklyLimitContentChannel(opts.provider, activeSlot.pattern_matched);
        if (bypassVeto) {
            appendAudit({
                event: 'gate_veto_bypassed',
                agent: skill || null,
                provider: opts.provider,
                model: null,
                error_type: activeSlot.pattern_matched || null,
                raw_excerpt: `reconcile veto bypassed (#5455 content channel): adapter_status=${reconciliation.adapterStatus} pct=${reconciliation.pct}`,
                flag_set: false,
            }, { now: Number.isFinite(opts.now) ? opts.now : undefined });
            return true;
        }
        if (reconciliation.veto) {
            appendAudit({
                event: 'gate_vetoed',
                agent: skill || null,
                provider: opts.provider,
                model: null,
                error_type: null,
                raw_excerpt: `reconcile veto: adapter_status=${reconciliation.adapterStatus} pct=${reconciliation.pct}`,
                flag_set: false,
            }, { now: Number.isFinite(opts.now) ? opts.now : undefined });
            return false;
        }
        return true;
    }
    // Sin provider del caller: comportamiento legacy (cualquier flag bloquea).
    return true;
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
    // API pública
    isQuotaExhausted,
    readDefensive,
    setFlag,
    clearFlag,
    detectFromResultEvent, // legacy (Anthropic-only)
    detectQuotaError,      // #3077 — dispatcher por provider
    shouldGateSpawn,
    isDeterministicSkill,
    appendAudit,
    // #4865 — reconciliación contra la fuente única de verdad por proveedor.
    reconcileWithCanonicalSource,
    // #5455 — predicado exacto de la única excepción al veto (SET + GET).
    isWeeklyLimitContentChannel,
    canonicalProvider,
    // #5455 — barrido compartido por adapter y dispatcher.
    detectWeeklyLimitContentChannelFromLog,

    // Helpers expuestos para integración con pulpo.js
    // #5400 — expuesto para poder testear el retry de forma determinística
    // (inyectando fallos transitorios) en vez de depender de ganarle a una
    // carrera real, que es justo lo que hacía intermitente al test.
    renameWithRetry,
    RENAME_RETRY_MAX_ATTEMPTS,
    RENAME_RETRYABLE_ERRORS,
    capResetsAt,
    sanitizeRawExcerpt,
    validateFlagShape,
    // #4731 — estado por-proveedor
    isValidProviderSlot,
    readProvidersMap,
    buildHybridPayload,
    resolveMaxDays,

    // Constantes públicas
    DEFAULT_ERROR_TYPES,
    DEFAULT_MAX_RESETS_AT_DAYS,
    DEFAULT_PROVIDER,
    MIN_RESETS_AT_MS,
    RAW_EXCERPT_MAX_CHARS,
    PATTERN_MATCHED_MAX_CHARS,
    DETERMINISTIC_SKILLS,
    KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER,
    CODEX_USAGE_LIMIT_RESET_MS,
    // #5455 — canal de contenido (excepción acotada Anthropic-only).
    WEEKLY_LIMIT_CONTENT_ERROR_TYPE,
    WEEKLY_LIMIT_CONTENT_SOURCE,
    WEEKLY_LIMIT_CONTENT_MAX_CHARS,
    WEEKLY_LIMIT_CONTENT_MAX_BLOCKS,
    WEEKLY_LIMIT_CONTENT_MAX_DAYS,
    MIN_TTL_DAYS,
    MAX_TTL_DAYS,
    RECONCILE_HEALTHY_MAX_PCT,

    // Paths (útiles para tests)
    flagFile,
    auditLogFile,
    pipelineDir,

    // Hooks internos para tests (prefijo _)
    _writeJsonAtomic: writeJsonAtomic,
    _detectAnthropic,
    _detectOpenAI,
    _CLI_1M_CONTEXT_GLITCH_PATTERN,
    _CODEX_USAGE_LIMIT_PATTERN,
    // #5455
    _detectAnthropicContentChannel,
    _normalizeAnthropicResultContent,
    _ANTHROPIC_WEEKLY_LIMIT_CONTENT_PATTERN,
};
