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
// SCHEMA del archivo `.pipeline/quota-exhausted.json` (post-#3077):
//   {
//     exhausted: true,
//     provider: "anthropic",                        // (opcional, default 'anthropic' para backward-compat)
//     model: "claude-opus-4-7",                     // (opcional, informativo)
//     resets_at: "2026-05-12T00:00:00.000Z",        // ISO8601, dentro de [now+5min, now+maxDays]
//     detected_at: "2026-05-05T03:14:22.123Z",      // ISO8601 del momento de detección
//     pattern_matched: "usage_limit_error"          // valor de error_type del CLI
//   }
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
        // Reservados para futuras extensiones documentadas
        'plan_max_reset_required',
    ]),
    'openai-codex': Object.freeze([
        // Externos (CLI codex / OpenAI)
        'insufficient_quota',
        'billing_hard_limit_reached',
        'tokens_exhausted',
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
    cerebras: Object.freeze([
        'rate_limit_exceeded',
        'quota_exceeded',
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
 */
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
        fs.renameSync(tmp, filepath);
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
    // Anthropic + OpenAI (`sk-...`, 20+ chars opacos)
    /\bsk-[A-Za-z0-9_\-]{16,}\b/g,
    // Anthropic específico (`sk-ant-...`)
    /\bsk-ant-[A-Za-z0-9_\-]{16,}\b/g,
    // Google API keys (`AIza...`, 35 chars en total)
    /\bAIza[0-9A-Za-z_\-]{30,}\b/g,
    // Google OAuth tokens (`ya29...`)
    /\bya29\.[0-9A-Za-z_\-]{20,}\b/g,
    // Bearer token genérico (más permisivo: cualquier token opaco después de Bearer)
    /\bBearer\s+[A-Za-z0-9_\-\.]{16,}/gi,
    // JWT (3 segmentos base64url separados por puntos)
    /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g,
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
 * Valida el shape del flag persistido. Devuelve `null` si no es válido.
 * No matchea por substring — solo valida tipos y rangos.
 *
 * #3077 CA-14: campo `provider` es opcional para backward-compat. Si no
 * está presente, se asume `anthropic` (único provider activo antes de #3077).
 * Análogamente, `model` es opcional/informativo.
 */
function validateFlagShape(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.exhausted !== true) return null;
    if (typeof parsed.resets_at !== 'string') return null;
    if (typeof parsed.detected_at !== 'string') return null;
    if (typeof parsed.pattern_matched !== 'string') return null;
    if (!Number.isFinite(Date.parse(parsed.resets_at))) return null;
    if (!Number.isFinite(Date.parse(parsed.detected_at))) return null;
    // #3077: provider es opcional pero si está, debe ser string no vacío.
    if (parsed.provider !== undefined) {
        if (typeof parsed.provider !== 'string' || parsed.provider.length === 0) return null;
    }
    // model análogo: opcional, si está debe ser string.
    if (parsed.model !== undefined) {
        if (typeof parsed.model !== 'string') return null;
    }
    return parsed;
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

    const valid = validateFlagShape(parsed);
    if (!valid) {
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

    // Backward-compat: provider opcional → default 'anthropic'.
    const provider = valid.provider || DEFAULT_PROVIDER;
    const model = valid.model || null;

    const resetsAtMs = Date.parse(valid.resets_at);
    if (now >= resetsAtMs) {
        // CA-7 del issue padre: drenado natural post-reset.
        try { fs.unlinkSync(file); } catch {}
        if (auditEnabled) {
            appendAudit({
                event: 'drained_post_reset',
                provider,
                model,
                error_type: valid.pattern_matched,
                raw_excerpt: `resets_at=${valid.resets_at}`,
                flag_set: false,
            });
        }
        return { exhausted: false, reason: 'expired', provider, model };
    }

    return {
        exhausted: true,
        provider,
        model,
        resets_at: valid.resets_at,
        detected_at: valid.detected_at,
        pattern_matched: valid.pattern_matched,
        resets_at_ms: resetsAtMs,
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

    // #3077 CA-8: si pasaron provider, validar scope antes de borrar.
    if (callerProvider) {
        // Leer el flag actual sin disparar audit ni drenado por fecha.
        try {
            const raw = fs.readFileSync(file, 'utf8');
            const parsed = JSON.parse(raw);
            const flagProvider = (parsed && parsed.provider) || DEFAULT_PROVIDER;
            if (flagProvider !== callerProvider) {
                if (auditEnabled) {
                    appendAudit({
                        event: 'clear_skipped_provider_mismatch',
                        provider: callerProvider,
                        model: opts.model || null,
                        error_type: null,
                        raw_excerpt: `flag_provider=${flagProvider} caller_provider=${callerProvider}`,
                        flag_set: true,
                    });
                }
                return false;
            }
        } catch (e) {
            // ENOENT / parse_error → caer al unlink (idempotente).
            if (e && e.code !== 'ENOENT') {
                // No-op para otros errores.
            }
        }
    }

    let existed = false;
    try {
        fs.unlinkSync(file);
        existed = true;
    } catch (e) {
        if (e && e.code !== 'ENOENT') {
            // No-op: best-effort
        }
    }
    if (existed && auditEnabled) {
        appendAudit({
            event: opts.event || 'cleared',
            provider: callerProvider,
            model: opts.model || null,
            error_type: null,
            raw_excerpt: opts.reason || 'manual_or_post_success',
            flag_set: false,
        });
    }
    return existed;
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
    const cap = capResetsAt(opts.resetsAt, { maxDays: opts.maxDays, now });
    const payload = {
        exhausted: true,
        provider,
        ...(model ? { model } : {}),
        resets_at: cap.iso,
        detected_at: new Date(now).toISOString(),
        pattern_matched: errorType,
    };
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

function _detectAnthropic(evt, allowlist) {
    if (!evt || typeof evt !== 'object') return { matched: false };
    if (evt.type !== 'result') return { matched: false };
    if (evt.is_error !== true) return { matched: false };
    const errorType = typeof evt.error_type === 'string' ? evt.error_type : null;
    if (!errorType) return { matched: false };
    if (!allowlist.includes(errorType)) return { matched: false };

    // #3506: subcase del glitch del CLI con 1M context. Si el mensaje
    // estructural lo identifica, marcamos `cliGlitch: true` y NO matched —
    // el caller debe inspeccionar el flag y aplicar política propia
    // (retry sin contaminar el flag global de quota).
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
 * Soportamos ambos shapes para tolerancia. PROHIBIDO matchear por substring
 * sobre texto libre. PROHIBIDO matchear contra campos controlados por el
 * modelo (canal de contenido).
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
    // #3077 CA-7: si el caller pasó provider, requerir match exacto.
    if (opts.provider) {
        return flag.provider === opts.provider;
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

    // Helpers expuestos para integración con pulpo.js
    capResetsAt,
    sanitizeRawExcerpt,
    validateFlagShape,

    // Constantes públicas
    DEFAULT_ERROR_TYPES,
    DEFAULT_MAX_RESETS_AT_DAYS,
    DEFAULT_PROVIDER,
    MIN_RESETS_AT_MS,
    RAW_EXCERPT_MAX_CHARS,
    PATTERN_MATCHED_MAX_CHARS,
    DETERMINISTIC_SKILLS,
    KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER,

    // Paths (útiles para tests)
    flagFile,
    auditLogFile,
    pipelineDir,

    // Hooks internos para tests (prefijo _)
    _writeJsonAtomic: writeJsonAtomic,
    _detectAnthropic,
    _detectOpenAI,
    _CLI_1M_CONTEXT_GLITCH_PATTERN,
};
