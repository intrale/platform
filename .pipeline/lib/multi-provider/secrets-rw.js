// =============================================================================
// secrets-rw.js — Lectura/escritura segura de API keys del dashboard (#3177).
//
// Fuente única de verdad (post-#3311 + #3313):
//   - Canonical: ~/.claude/secrets/credentials.json (nested, dot-path).
//   - Legacy:    ~/.claude/secrets/telegram-config.json (flat keys).
//
// Reglas:
//   - LECTURA: lee del canonical primero. Si canonical NO existe, cae al legacy
//     (modo degradado) y emite WARN. Si ambos existen, gana el canonical.
//   - ESCRITURA (rotateKey): SIEMPRE al canonical, jamás al legacy. Si el
//     canonical no existe, se crea con `mkdir -p` + write atómico inicial.
//   - Backup naming alineado al archivo escrito: `credentials.<ts>.json`.
//   - applyBackupRetention filtra por el nuevo prefijo (no acumula indefinido).
//   - Defensas (OWASP A02 / A07): placeholder regex, length ≥ 20, control chars,
//     masking 6+****+4, fingerprint SHA-256 truncado a 16, atomic write 0600.
//   - Anthropic queda con `editable:false` — Claude Code usa OAuth/MAX.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const CANONICAL_PATH = path.join(os.homedir(), '.claude', 'secrets', 'credentials.json');
const LEGACY_PATH = path.join(os.homedir(), '.claude', 'secrets', 'telegram-config.json');

// Retro-compat: export del path principal con el nombre que usaba la implementación
// pre-#3313. Ahora apunta al canonical, no al legacy. Quienes importaban
// HOME_SECRETS para enviar overrides en tests siguen funcionando.
const HOME_SECRETS = CANONICAL_PATH;

const DEFAULT_BACKUP_DIR = path.join(os.homedir(), '.claude', 'secrets', 'backups');
const DEFAULT_BACKUP_RETENTION = 30;
const BACKUP_PREFIX = 'credentials.';

// Lista canónica de keys gestionables vía UI.
//
// Cada entry expone:
//   - provider       identificador externo (URL, audit log, UI)
//   - label          texto humano mostrado en la UI
//   - editable       false → la UI muestra read-only (ej. anthropic)
//   - dotPath        ubicación en credentials.json (canonical, nested)
//   - legacyField    ubicación en telegram-config.json (legacy, flat) — solo lectura
//   - reason         por qué `editable:false` (si aplica)
//   - free_tier_notes nota mostrada en la UI para providers free
//
// IMPORTANTE — asimetría documentada:
//   El provider 'gemini-google' resuelve contra `providers.google.api_key` en el
//   canonical (alineado con credentials.js:ENV_MAPPING:41). NO usar
//   `providers.gemini-google.api_key`. El alias se mantiene en el `provider` id
//   para no romper la UI ni el audit log post-rotación.
const MANAGED_KEYS = Object.freeze([
    {
        provider: 'anthropic',
        label: 'Anthropic',
        editable: false,
        dotPath: 'providers.anthropic.api_key',
        legacyField: 'anthropic_api_key',
        reason: 'Claude Code usa OAuth / MAX login; rotar acá puede confundir el child env.',
    },
    {
        provider: 'openai',
        label: 'OpenAI / Codex',
        editable: true,
        dotPath: 'providers.openai.api_key',
        legacyField: 'openai_api_key',
    },
    {
        provider: 'elevenlabs',
        label: 'ElevenLabs',
        editable: true,
        dotPath: 'multimedia.elevenlabs_api_key',
        legacyField: 'elevenlabs_api_key',
    },
    {
        provider: 'groq',
        label: 'Groq',
        editable: true,
        dotPath: 'providers.groq.api_key',
        legacyField: 'groq_api_key',
        free_tier_notes: 'RPM 30 / RPD 14400 (free) — ver docs/pipeline/multi-provider.md §8.',
    },
    {
        // Provider id mantiene 'gemini-google' (UI/audit log). El dot-path
        // resuelve contra 'google' por convención de credentials.js (#3311).
        provider: 'gemini-google',
        label: 'Gemini (Google AI Studio)',
        editable: true,
        dotPath: 'providers.google.api_key',
        legacyField: 'gemini_google_api_key',
        free_tier_notes: 'RPM 15 / RPD 1500 / TPM 1M (free) — ver docs/pipeline/multi-provider.md §8.',
    },
    {
        provider: 'cerebras',
        label: 'Cerebras',
        editable: true,
        dotPath: 'providers.cerebras.api_key',
        legacyField: 'cerebras_api_key',
        free_tier_notes: 'RPM 30 / TPM 60K (free) — ver docs/pipeline/multi-provider.md §8.',
    },
    {
        // CA-3 (#3313): NVIDIA NIM se suma. Key vive solo en el canonical
        // (no había entry en telegram-config.json), por eso legacyField=null.
        provider: 'nvidia',
        label: 'NVIDIA NIM',
        editable: true,
        dotPath: 'providers.nvidia.api_key',
        legacyField: null,
        free_tier_notes: 'Free tier (nvapi-*) — ver docs/pipeline/multi-provider.md §8.',
    },
]);

const PLACEHOLDER_RE = /(REVOKED|PLACEHOLDER|MOVED|EXAMPLE|REPLACE|CHANGE_ME)/i;

function isPlaceholder(value) {
    if (typeof value !== 'string' || !value.trim()) return true;
    return PLACEHOLDER_RE.test(value);
}

function maskValue(value) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    if (trimmed.length < 12) return '****';
    return `${trimmed.slice(0, 6)}****${trimmed.slice(-4)}`;
}

function fingerprint(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

function tryReadJson(file, fsImpl = fs) {
    if (!fsImpl.existsSync(file)) return null;
    try {
        return JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function getNested(obj, dotPath) {
    if (!obj || typeof obj !== 'object' || !dotPath) return undefined;
    return dotPath.split('.').reduce(
        (acc, k) => (acc && typeof acc === 'object') ? acc[k] : undefined,
        obj
    );
}

function setNested(obj, dotPath, value) {
    if (!obj || typeof obj !== 'object' || !dotPath) return;
    const parts = dotPath.split('.');
    let cursor = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const k = parts[i];
        if (cursor[k] === null || typeof cursor[k] !== 'object') {
            cursor[k] = {};
        }
        cursor = cursor[k];
    }
    cursor[parts[parts.length - 1]] = value;
}

// Retro-compat shape: la respuesta API expone `jsonField` (consumido por
// audit-log y por scripts externos que vinieron del shape pre-#3313).
// Lo derivamos del `legacyField` cuando existe; si no, usamos el leaf del
// dot-path como string flat (ej. 'api_key'). La UI NO lo consume (#3313 CA-6).
function legacyShapeField(spec) {
    if (spec.legacyField) return spec.legacyField;
    const leaf = spec.dotPath.split('.').pop();
    return leaf;
}

// -----------------------------------------------------------------------------
// Lectura: canonical → fallback legacy → WARN.
// -----------------------------------------------------------------------------

/**
 * Carga el árbol de secrets eligiendo source (canonical | legacy | none) y
 * emite WARN cuando se cae al legacy. Mantener un solo loader unificado para
 * que `listKeys` y `getRawKey` no diverjan.
 *
 * El `source` se infiere por el SHAPE del archivo, no por el path. Esto cubre:
 *   - canonical real (credentials.json nested) → source='canonical'.
 *   - archivo legacy real (telegram-config.json flat) → source='legacy'.
 *   - tests/migraciones manuales que ponen shape flat en un path con nombre
 *     "credentials.json" → se trata como legacy (con WARN) y se resuelve por
 *     flat field. Defense in depth contra operadores que pasen archivos
 *     equivocados al loader.
 *
 * @returns {{source: 'canonical'|'legacy'|'none', data: object|null}}
 */
function detectShape(data) {
    if (!data || typeof data !== 'object') return 'none';
    // Nested si hay rama `providers` (object) o `multimedia` (object) o
    // `telegram` (object) — todas las raíces canónicas declaradas por
    // credentials.js. Cualquier estructura distinta cae a "flat".
    const looksNested =
        (data.providers && typeof data.providers === 'object') ||
        (data.multimedia && typeof data.multimedia === 'object') ||
        (data.telegram && typeof data.telegram === 'object');
    if (looksNested) return 'canonical';
    // Vacío → tratamos como canonical (sin keys, todos absent). No queremos
    // un `{}` accidentalmente clasificado como legacy.
    if (Object.keys(data).length === 0) return 'canonical';
    return 'legacy';
}

function loadSecretsTree({ canonicalPath = CANONICAL_PATH, legacyPath = LEGACY_PATH, fsImpl = fs, logger } = {}) {
    const log = typeof logger === 'function' ? logger : (msg) => { try { process.stderr.write(msg + '\n'); } catch {} };

    if (fsImpl.existsSync(canonicalPath)) {
        const data = tryReadJson(canonicalPath, fsImpl);
        if (data) {
            const shape = detectShape(data);
            if (shape === 'canonical') return { source: 'canonical', data };
            // Archivo con shape legacy en path canonical (tests / migración
            // manual). Resolvemos por flat field y avisamos.
            log(`[secrets-rw] WARN: ${canonicalPath} tiene shape flat (legacy); resolviendo por flat fields. Considerar migración al nested canonical.`);
            return { source: 'legacy', data };
        }
        // Canonical existe pero rompió parse → intentamos fallback con WARN extra.
        log(`[secrets-rw] WARN: canonical ${canonicalPath} no parsea; intentando legacy.`);
    }

    if (fsImpl.existsSync(legacyPath)) {
        const data = tryReadJson(legacyPath, fsImpl);
        if (data) {
            log(`[secrets-rw] WARN: falling back to legacy telegram-config.json — migrate to credentials.json (ver docs/runbooks/credential-rotation.md)`);
            return { source: 'legacy', data };
        }
    }

    return { source: 'none', data: null };
}

/**
 * Resuelve el valor crudo de un spec en un árbol cargado por `loadSecretsTree`.
 * - source='canonical' → usa `spec.dotPath` (nested).
 * - source='legacy'    → usa `spec.legacyField` (flat). Si no hay legacyField
 *   (ej. nvidia) devuelve undefined porque el provider no existía en el legacy.
 */
function resolveValueFromTree(spec, tree) {
    if (!tree || !tree.data) return undefined;
    if (tree.source === 'canonical') return getNested(tree.data, spec.dotPath);
    if (tree.source === 'legacy') {
        if (!spec.legacyField) return undefined;
        return tree.data[spec.legacyField];
    }
    return undefined;
}

function listKeys({
    canonicalPath = CANONICAL_PATH,
    legacyPath = LEGACY_PATH,
    fsImpl = fs,
    logger,
    // Retro-compat: si el llamador pasa `secretsPath` lo tratamos como
    // canonical override. Mantiene la firma vieja `listKeys({ secretsPath })`
    // de los tests pre-#3313.
    secretsPath,
} = {}) {
    const effCanonical = secretsPath || canonicalPath;
    const tree = loadSecretsTree({ canonicalPath: effCanonical, legacyPath, fsImpl, logger });
    return MANAGED_KEYS.map(spec => {
        const raw = resolveValueFromTree(spec, tree);
        let status;
        if (typeof raw !== 'string' || !raw.trim()) status = 'absent';
        else if (isPlaceholder(raw)) status = 'placeholder';
        else status = 'present';

        return {
            provider: spec.provider,
            // Retro-compat: shape de la respuesta API mantiene `jsonField`.
            // La UI no lo consume, pero scripts/audit-log sí. Derivado, NO
            // implica que el módulo escriba contra él.
            jsonField: legacyShapeField(spec),
            dotPath: spec.dotPath,
            legacyField: spec.legacyField || null,
            label: spec.label,
            editable: spec.editable,
            reason: spec.reason || null,
            free_tier_notes: spec.free_tier_notes || null,
            source: tree.source, // 'canonical' | 'legacy' | 'none'
            status,
            masked: status === 'present' ? maskValue(raw) : null,
            fingerprint: status === 'present' ? fingerprint(raw) : null,
        };
    });
}

// -----------------------------------------------------------------------------
// Escritura: SIEMPRE al canonical. Backup naming alineado al archivo escrito.
// -----------------------------------------------------------------------------

function rotateKey({
    provider,
    newValue,
    canonicalPath = CANONICAL_PATH,
    backupDir = DEFAULT_BACKUP_DIR,
    retention = DEFAULT_BACKUP_RETENTION,
    fsImpl = fs,
    now = Date.now(),
    // Retro-compat: tests viejos pasan `secretsPath` esperando que sea el
    // archivo escrito. Lo aceptamos como override del canonical.
    secretsPath,
} = {}) {
    const targetPath = secretsPath || canonicalPath;

    const spec = MANAGED_KEYS.find(k => k.provider === provider);
    if (!spec) {
        throw new Error(`[secrets-rw] provider '${provider}' no está gestionado por la UI. Válidos: ${MANAGED_KEYS.map(k => k.provider).join(', ')}.`);
    }
    if (!spec.editable) {
        throw new Error(`[secrets-rw] provider '${provider}' no es editable vía UI: ${spec.reason || 'flag editable=false'}.`);
    }
    if (typeof newValue !== 'string' || !newValue.trim()) {
        throw new Error('[secrets-rw] rotateKey: "newValue" requerido (string no vacío).');
    }
    if (/[\r\n\t\0]/.test(newValue)) {
        throw new Error('[secrets-rw] rotateKey: "newValue" no puede contener whitespace de control (\\r, \\n, \\t, \\0).');
    }
    if (isPlaceholder(newValue)) {
        throw new Error('[secrets-rw] rotateKey: "newValue" parece placeholder (REVOKED/EXAMPLE/etc.). Rechazado.');
    }
    if (newValue.length < 20) {
        throw new Error('[secrets-rw] rotateKey: "newValue" demasiado corto (< 20 chars). Sospechoso.');
    }

    // mkdir -p del directorio del canonical (si recién se está creando el
    // archivo post-migración, garantizamos que el árbol existe).
    const dir = path.dirname(targetPath);
    if (!fsImpl.existsSync(dir)) fsImpl.mkdirSync(dir, { recursive: true });

    // Estado actual del canonical (si existe). Si no, partimos de objeto vacío
    // — JAMÁS leemos del legacy para "heredar" valores porque eso reabriría el
    // drift que cerramos con #3313.
    const current = tryReadJson(targetPath, fsImpl) || {};

    // Backup pre-save SOLO si el canonical ya existía. Nombre alineado al
    // archivo operativo (#3313 guard-rail #2).
    let backupPath = null;
    if (fsImpl.existsSync(targetPath)) {
        if (!fsImpl.existsSync(backupDir)) fsImpl.mkdirSync(backupDir, { recursive: true });
        const ts = new Date(now).toISOString().replace(/[:.]/g, '-');
        backupPath = path.join(backupDir, `${BACKUP_PREFIX}${ts}.json`);
        fsImpl.copyFileSync(targetPath, backupPath);
        try { fsImpl.chmodSync(backupPath, 0o600); } catch { /* Windows: best-effort */ }
    }

    // Set nested + escritura atómica.
    setNested(current, spec.dotPath, newValue.trim());
    const tmpPath = `${targetPath}.tmp.${process.pid}.${now}`;
    fsImpl.writeFileSync(tmpPath, JSON.stringify(current, null, 2) + '\n', { mode: 0o600 });
    fsImpl.renameSync(tmpPath, targetPath);
    try { fsImpl.chmodSync(targetPath, 0o600); } catch { /* Windows: best-effort */ }

    applyBackupRetention({ backupDir, retention, fsImpl });

    return {
        ok: true,
        provider: spec.provider,
        // Retro-compat: `jsonField` en la respuesta. Derivado de legacyField o
        // del leaf del dot-path. NO refleja escritura al legacy.
        jsonField: legacyShapeField(spec),
        dotPath: spec.dotPath,
        fingerprint: fingerprint(newValue.trim()),
        backupPath,
        canonicalPath: targetPath,
    };
}

function applyBackupRetention({ backupDir, retention, fsImpl }) {
    if (!fsImpl.existsSync(backupDir)) return;
    const files = fsImpl.readdirSync(backupDir)
        .filter(f => f.startsWith(BACKUP_PREFIX) && f.endsWith('.json'))
        .sort();
    while (files.length > retention) {
        const oldest = files.shift();
        try { fsImpl.unlinkSync(path.join(backupDir, oldest)); } catch {}
    }
}

// -----------------------------------------------------------------------------
// Helper para consumidores del pulpo: lee la key raw resolviendo canonical→legacy.
// -----------------------------------------------------------------------------

function getRawKey({
    provider,
    canonicalPath = CANONICAL_PATH,
    legacyPath = LEGACY_PATH,
    fsImpl = fs,
    logger,
    // Retro-compat: `secretsPath` override = canonical override.
    secretsPath,
} = {}) {
    const spec = MANAGED_KEYS.find(k => k.provider === provider);
    if (!spec) return null;
    const tree = loadSecretsTree({
        canonicalPath: secretsPath || canonicalPath,
        legacyPath,
        fsImpl,
        logger,
    });
    const raw = resolveValueFromTree(spec, tree);
    if (!raw || typeof raw !== 'string' || !raw.trim() || isPlaceholder(raw)) return null;
    return raw;
}

module.exports = {
    HOME_SECRETS,          // retro-compat (apunta al canonical post-#3313)
    CANONICAL_PATH,
    LEGACY_PATH,
    DEFAULT_BACKUP_DIR,
    DEFAULT_BACKUP_RETENTION,
    BACKUP_PREFIX,
    MANAGED_KEYS,
    listKeys,
    rotateKey,
    getRawKey,
    maskValue,
    fingerprint,
    isPlaceholder,
    // Exportados para tests: paridad MANAGED_KEYS↔ENV_MAPPING y resolución.
    loadSecretsTree,
    resolveValueFromTree,
    getNested,
    setNested,
    legacyShapeField,
};
