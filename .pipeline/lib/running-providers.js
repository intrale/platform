'use strict';

// =============================================================================
// running-providers.js — Marker de runtime del provider EFECTIVO por agente en
// curso (#4284).
//
// Problema: el dashboard ("Ahora · En Ejecución") muestra el provider
// CONFIGURADO por skill (`resolveProvider(agentModels, skill)` →
// `skills.<skill>.provider` de agent-models.json), no el EFECTIVO con el que el
// pulpo lanzó el agente tras evaluar cuota/kill-switch/fallbacks. Con Anthropic
// apagado, un agente corre en Codex pero el dashboard sigue mostrando Claude.
//
// Solución: el pulpo persiste, best-effort en el spawn, el provider efectivo
// (`dispatchResolution.provider`) en un único archivo de runtime
// (`running-providers.json`) en la RAÍZ de `.pipeline/`. El dashboard lo lee y
// lo prioriza sobre el configurado.
//
// Modelado sobre `commander-presence.js` (mismo patrón probado):
//   - CA-5: el archivo vive en la raíz de runtime, NUNCA bajo
//     `<pipeline>/<fase>/trabajando/`. Los contadores de concurrencia del pulpo
//     (`countRunningBySkill`) solo escanean `trabajando/` → el marker no
//     consume slot ni altera el paralelismo. Se cumple por construcción.
//   - CA-7 / SEC (A02): whitelist estricta de campos. SOLO se persiste
//     `provider`/`model`/`source`/`startedAt`. Jamás keys, tokens, JWT ni el
//     objeto `dispatchResolution` completo.
//   - SEC (A03): el render del dashboard usa `textContent` (invariante de
//     `home.js`); este módulo nunca produce HTML.
//   - CA-4 / riesgo stale: `readRunningProviders` aplica TTL por `startedAt`;
//     un marker viejo (proceso muerto sin limpiar) se ignora al leer.
//   - CA-6: `clearRunningProvider` borra la entrada en `onSpawnExit`.
//   - CA-8: naming canónico — `writeRunningProvider` normaliza alias
//     (`openai`/`codex` → `openai-codex`, `gemini` → `gemini-google`) para que
//     `PROVIDER_LABELS` resuelva el label correcto.
//
// Concurrencia: read-modify-write atómico (tmp + rename). El rename es atómico
// dentro del mismo filesystem → el dashboard nunca lee un JSON parcial. Cada
// `write`/`clear` re-lee el archivo antes de escribir para no perder entradas
// de spawns concurrentes (single-writer real: el pulpo, pero defensivo).
// =============================================================================

const fs = require('fs');
const path = require('path');

// Nombre del archivo de markers. Vive en la raíz de runtime del pipeline, igual
// que `commander-presence.json` / `commander-session.json`.
const FILENAME = 'running-providers.json';

// TTL por defecto: los markers de "en curso" viven más que una presencia
// Commander (5 min) porque un agente dev puede tardar bastante. 30 min cubre el
// caso normal; si el proceso muere sin limpiar, el TTL descarta el marker stale.
const DEFAULT_TTL_MS = 30 * 60 * 1000;

// CA-7 / SEC: whitelist estricta de campos persistidos. Cualquier otro campo del
// objeto recibido se descarta — nunca se filtra material de credencial.
const ALLOWED_FIELDS = Object.freeze(['provider', 'model', 'source', 'startedAt']);

// CA-8: normalización de alias → provider-key canónica de `PROVIDER_LABELS`.
// El `dispatchResolution.provider` ya suele venir canónico (sale de
// agent-models.json), pero algún codepath (health-cron) usa alias; normalizamos
// defensivamente para que el label del dashboard resuelva bien.
const PROVIDER_ALIASES = Object.freeze({
    openai: 'openai-codex',
    codex: 'openai-codex',
    gemini: 'gemini-google',
    google: 'gemini-google',
    claude: 'anthropic',
    nvidia: 'nvidia-nim',
});

// Fuentes válidas de la decisión del router (enum cerrado, defensa en
// profundidad). Cualquier otro valor se normaliza a 'primary'.
const VALID_SOURCES = Object.freeze(new Set(['primary', 'fallback', 'forced-override']));

// Raíz por defecto del pipeline: `.pipeline/` (este módulo vive en
// `.pipeline/lib/`). Los tests inyectan un dir temporal vía `pipelineRoot`.
function defaultPipelineRoot() {
    return path.join(__dirname, '..');
}

function markersPath(pipelineRoot) {
    return path.join(pipelineRoot || defaultPipelineRoot(), FILENAME);
}

// CA-8: normaliza un provider-key crudo a su forma canónica. Tolera null/no-string.
function normalizeProvider(provider) {
    if (!provider || typeof provider !== 'string') return null;
    const trimmed = provider.trim();
    if (!trimmed) return null;
    const lower = trimmed.toLowerCase();
    return PROVIDER_ALIASES[lower] || lower;
}

function normalizeSource(source) {
    if (typeof source === 'string' && VALID_SOURCES.has(source)) return source;
    return 'primary';
}

// Lectura tolerante: archivo ausente/corrupto → objeto vacío. Nunca lanza.
function safeReadMap(filepath) {
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(filepath, 'utf8')); }
    catch { return {}; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw;
}

// Escritura atómica: temp único por proceso + rename sobre el destino. El rename
// es atómico dentro del mismo filesystem → el dashboard nunca lee JSON parcial.
function atomicWrite(filepath, obj) {
    const dir = path.dirname(filepath);
    const tmp = path.join(dir, `.${FILENAME}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, filepath);
}

// Reconstruye un record desde cero con SOLO los campos whitelisteados (SEC).
function sanitizeRecord({ provider, model, source, startedAt }) {
    const record = {};
    record.provider = normalizeProvider(provider);
    record.model = (model != null && model !== '') ? String(model) : null;
    record.source = normalizeSource(source);
    record.startedAt = typeof startedAt === 'number' ? startedAt : null;
    return record;
}

/**
 * Persiste el provider EFECTIVO de un agente en curso. Read-modify-write
 * atómico: re-lee el mapa, agrega/pisa la entrada de `key` y reescribe.
 *
 * Solo persiste campos whitelisteados (CA-7): provider/model/source/startedAt.
 * Normaliza el provider a su key canónica (CA-8).
 *
 * @param {{key: string, provider: string, model?: string, source?: string, startedAt?: number}} input
 * @param {{pipelineRoot?: string, now?: () => number}} [opts]
 * @returns {{provider: string, model: string|null, source: string, startedAt: number}|null}
 *          el record persistido, o null si faltan key/provider válidos (no lanza)
 */
function writeRunningProvider(input, opts = {}) {
    const key = input && input.key;
    if (!key || typeof key !== 'string') return null;
    const provider = normalizeProvider(input && input.provider);
    if (!provider) return null; // sin provider efectivo no hay nada que persistir

    const now = (opts.now || Date.now)();
    const startedAt = typeof input.startedAt === 'number' ? input.startedAt : now;
    const record = sanitizeRecord({
        provider,
        model: input.model,
        source: input.source,
        startedAt,
    });

    const filepath = markersPath(opts.pipelineRoot);
    const map = safeReadMap(filepath);
    map[key] = record;
    atomicWrite(filepath, map);
    return record;
}

/**
 * Limpia el marker de un agente (al terminar, éxito o error). Idempotente:
 * si la entrada no existe, es no-op. Re-lee antes de escribir para no pisar
 * entradas de spawns concurrentes (CA-6).
 *
 * @param {string} key
 * @param {{pipelineRoot?: string}} [opts]
 * @returns {boolean} true si borró una entrada, false si no había nada
 */
function clearRunningProvider(key, opts = {}) {
    if (!key || typeof key !== 'string') return false;
    const filepath = markersPath(opts.pipelineRoot);
    const map = safeReadMap(filepath);
    if (!Object.prototype.hasOwnProperty.call(map, key)) return false;
    delete map[key];
    // Si quedó vacío, dejamos el `{}` en disco (no borramos el archivo) para que
    // el patrón read-modify-write siga siendo consistente.
    atomicWrite(filepath, map);
    return true;
}

/**
 * Lee todos los markers válidos, descartando los vencidos por TTL (CA-4). NO
 * borra los stale del disco (limpieza la hace el writer en `onSpawnExit`); solo
 * los ignora en lectura. Valida la shape de cada entrada (defensa en profundidad).
 *
 * @param {{pipelineRoot?: string, ttlMs?: number, now?: () => number}} [opts]
 * @returns {Object<string, {provider: string, model: string|null, source: string, startedAt: number, durationMs: number}>}
 */
function readRunningProviders(opts = {}) {
    const filepath = markersPath(opts.pipelineRoot);
    const map = safeReadMap(filepath);
    const now = (opts.now || Date.now)();
    const ttlMs = typeof opts.ttlMs === 'number' ? opts.ttlMs : DEFAULT_TTL_MS;
    const out = {};
    for (const [key, raw] of Object.entries(map)) {
        if (!raw || typeof raw !== 'object') continue;
        const provider = normalizeProvider(raw.provider);
        if (!provider) continue;
        const startedAt = typeof raw.startedAt === 'number' ? raw.startedAt : null;
        if (startedAt === null) continue;
        const durationMs = now - startedAt;
        if (durationMs >= ttlMs) continue; // stale (CA-4)
        out[key] = {
            provider,
            model: (raw.model != null && raw.model !== '') ? String(raw.model) : null,
            source: normalizeSource(raw.source),
            startedAt,
            durationMs,
        };
    }
    return out;
}

module.exports = {
    writeRunningProvider,
    clearRunningProvider,
    readRunningProviders,
    markersPath,
    normalizeProvider,
    FILENAME,
    DEFAULT_TTL_MS,
    ALLOWED_FIELDS,
    PROVIDER_ALIASES,
};
