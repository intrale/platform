// =============================================================================
// secrets-rw.js — Lectura/escritura segura de API keys (#3177 / #3313).
//
// Fuente única de verdad: `~/.claude/secrets/credentials.json` (canonical,
// estructura nested introducida por #3311). Fallback de SOLO LECTURA a
// `~/.claude/secrets/telegram-config.json` (legacy, flat keys) para casos
// donde el canonical todavía no fue creado.
//
// Reglas de seguridad (OWASP A02 — Cryptographic Failures + A07):
//   - GET nunca devuelve la key completa. Sólo metadata: provider, status
//     (present/absent/placeholder), masked preview (primeros 6 + últimos 4),
//     fingerprint SHA-256 (primeros 16 chars).
//   - PUT rota la key en disco con write atómico + backup pre-save.
//   - Anthropic key NO se edita por UI (Claude Code usa OAuth — guru Opción A).
//     La API la lista pero con flag `editable: false`.
//   - El archivo en disco tiene permisos 0600 después de cada write (best-effort
//     en Windows: setFileSecurity no es trivial sin nativos, en POSIX usa chmod).
//
// Estructura canonical esperada (alineada con .pipeline/lib/credentials.js):
//   {
//     "telegram":   { "bot_token": "...", "chat_id": "..." },
//     "providers":  {
//       "anthropic": { "api_key": "..." },
//       "openai":    { "api_key": "..." },
//       "google":    { "api_key": "..." },        // mapea al provider 'gemini-google'
//       "cerebras":  { "api_key": "..." },
//       "nvidia":    { "api_key": "..." }
//     },
//     "multimedia": { "elevenlabs_api_key": "..." }
//   }
//
// Estructura legacy (solo lectura, deprecada):
//   { "openai_api_key": "...", ... }  // flat
//
// Groq fue descontinuado en #3353 (mayo 2026): si aparece en el JSON, se
// ignora silenciosamente porque ya no está en MANAGED_KEYS.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const HOME_CANONICAL = path.join(os.homedir(), '.claude', 'secrets', 'credentials.json');
const HOME_LEGACY = path.join(os.homedir(), '.claude', 'secrets', 'telegram-config.json');
const DEFAULT_BACKUP_DIR = path.join(os.homedir(), '.claude', 'secrets', 'backups');
const DEFAULT_BACKUP_RETENTION = 30;

// Lista canónica de keys gestionables vía UI. Anthropic está pero `editable:false`.
//
// `canonicalPath` = dot-path en credentials.json (estructura nested).
// `legacyField`   = flat key en telegram-config.json (solo lectura, para
// compat hacia atrás mientras el canonical todavía no existe).
//
// Los 4 free providers (#3260 + #3243 — hardening de free providers, ola N+5)
// entran al mismo flujo de masking + fingerprint SHA-256 + atomic write 0600 +
// backup 30d + audit chain (SR-1 de security). La lista crece editando este
// array, sin código nuevo.
const MANAGED_KEYS = Object.freeze([
    {
        provider: 'anthropic',
        label: 'Anthropic',
        editable: false,
        reason: 'Claude Code usa OAuth / MAX login; rotar acá puede confundir el child env.',
        canonicalPath: 'providers.anthropic.api_key',
        legacyField: 'anthropic_api_key',
        // El pipeline lo usa vía Claude Code CLI (OAuth/MAX), NO vía API key.
        // El health-cron valida la CLI, no pinea la key (sería un falso rojo).
        auth_mode: 'oauth',
        cli_binary: 'claude',
    },
    {
        provider: 'openai',
        label: 'OpenAI / Codex',
        editable: true,
        canonicalPath: 'providers.openai.api_key',
        legacyField: 'openai_api_key',
        // Codex CLI autentica vía `codex login` (ChatGPT Plus OAuth), NO por
        // OPENAI_API_KEY. El health valida la CLI, no la key (falso rojo 403).
        auth_mode: 'oauth',
        cli_binary: 'codex',
    },
    {
        provider: 'elevenlabs',
        label: 'ElevenLabs',
        editable: true,
        canonicalPath: 'multimedia.elevenlabs_api_key',
        legacyField: 'elevenlabs_api_key',
    },
    {
        provider: 'gemini-google',
        label: 'Gemini (Google AI Studio)',
        editable: true,
        // En el credentials.json canónico vive bajo `providers.google` (alineado
        // con credentials.js → GEMINI_API_KEY). En la UI seguimos llamándolo
        // 'gemini-google' para diferenciarlo de Vertex AI.
        canonicalPath: 'providers.google.api_key',
        legacyField: 'gemini_google_api_key',
        free_tier_notes: 'RPM 15 / RPD 1500 / TPM 1M (free) — ver docs/pipeline/multi-provider.md §8.',
    },
    {
        provider: 'cerebras',
        label: 'Cerebras',
        editable: true,
        canonicalPath: 'providers.cerebras.api_key',
        legacyField: 'cerebras_api_key',
        free_tier_notes: 'RPM 30 / TPM 60K (free) — ver docs/pipeline/multi-provider.md §8.',
    },
    {
        // #3243 — NVIDIA NIM, 4to free provider del multi-provider. Mismo
        // flujo de masking + atomic write 0600 + backup chain que el resto.
        // Free tier sin RPM/RPD publicado por NVIDIA — observación pendiente
        // del cron de health (ver docs/pipeline/multi-provider.md §8).
        // En credentials.json canónico vive bajo `providers.nvidia` (alineado
        // con credentials.js → NVIDIA_NIM_API_KEY). En la UI seguimos llamándolo
        // 'nvidia-nim' para diferenciarlo de Triton / on-prem NIM.
        provider: 'nvidia-nim',
        label: 'NVIDIA NIM',
        editable: true,
        canonicalPath: 'providers.nvidia.api_key',
        legacyField: 'nvidia_nim_api_key',
        free_tier_notes: 'Free tier sin RPM/RPD/MOQ públicos — ver docs/pipeline/multi-provider.md §8.',
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
    return dotPath.split('.').reduce(
        (acc, k) => (acc && typeof acc === 'object') ? acc[k] : undefined,
        obj
    );
}

function setNested(obj, dotPath, value) {
    const parts = dotPath.split('.');
    const last = parts.pop();
    let cur = obj;
    for (const p of parts) {
        if (cur[p] === null || cur[p] === undefined || typeof cur[p] !== 'object') {
            cur[p] = {};
        }
        cur = cur[p];
    }
    cur[last] = value;
    return obj;
}

// Detecta el formato del JSON cargado. Si tiene alguna de las claves canónicas
// top-level → 'canonical'; en cualquier otro caso → 'legacy' (incluso si está
// vacío o no tiene ninguna key conocida, asumimos legacy por defensa, porque
// si está vacío sin tener providers/multimedia no podemos asumir intent).
function detectFormat(data) {
    if (!data || typeof data !== 'object') return 'canonical';
    if (data.providers !== undefined || data.multimedia !== undefined || data.telegram !== undefined) {
        return 'canonical';
    }
    // Si tiene alguna flat key conocida → legacy.
    for (const spec of MANAGED_KEYS) {
        if (Object.prototype.hasOwnProperty.call(data, spec.legacyField)) return 'legacy';
    }
    // Vacío o desconocido: asumimos canonical (caso de archivo recién creado).
    return 'canonical';
}

function readKeyFromData(spec, data, format) {
    if (!data) return undefined;
    if (format === 'legacy') return data[spec.legacyField];
    return getNested(data, spec.canonicalPath);
}

// Resuelve qué archivo abrir y devuelve {data, format, path}. Si `secretsPath`
// es explícito, usa ese; sino, intenta canonical y luego legacy.
function loadSource({ secretsPath, fsImpl = fs } = {}) {
    if (secretsPath) {
        const data = tryReadJson(secretsPath, fsImpl);
        return { data, format: detectFormat(data), path: secretsPath };
    }
    if (fsImpl.existsSync(HOME_CANONICAL)) {
        const data = tryReadJson(HOME_CANONICAL, fsImpl);
        return { data: data || {}, format: 'canonical', path: HOME_CANONICAL };
    }
    if (fsImpl.existsSync(HOME_LEGACY)) {
        const data = tryReadJson(HOME_LEGACY, fsImpl);
        return { data: data || {}, format: 'legacy', path: HOME_LEGACY };
    }
    return { data: null, format: 'canonical', path: HOME_CANONICAL };
}

function listKeys({ secretsPath, fsImpl = fs } = {}) {
    const { data, format } = loadSource({ secretsPath, fsImpl });
    return MANAGED_KEYS.map(spec => {
        const raw = readKeyFromData(spec, data, format);
        let status;
        if (typeof raw !== 'string' || !raw.trim()) status = 'absent';
        else if (isPlaceholder(raw)) status = 'placeholder';
        else status = 'present';

        return {
            provider: spec.provider,
            jsonField: spec.legacyField, // Compat: la UI/log ya consumen `jsonField`. Mantenemos el alias.
            canonicalPath: spec.canonicalPath,
            label: spec.label,
            editable: spec.editable,
            reason: spec.reason || null,
            free_tier_notes: spec.free_tier_notes || null,
            status,
            masked: status === 'present' ? maskValue(raw) : null,
            fingerprint: status === 'present' ? fingerprint(raw) : null,
        };
    });
}

function rotateKey({
    provider,
    newValue,
    secretsPath,
    backupDir = DEFAULT_BACKUP_DIR,
    retention = DEFAULT_BACKUP_RETENTION,
    fsImpl = fs,
    now = Date.now(),
} = {}) {
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

    // Escritura: por defecto el archivo destino es el canonical. Si el caller
    // pasa `secretsPath`, se respeta. El formato escrito preserva el formato
    // detectado del archivo existente (si es legacy y existe, mantenemos flat
    // para no romper consumidores legacy; si no existe o es canonical,
    // escribimos canonical nested).
    const targetPath = secretsPath || HOME_CANONICAL;
    const dir = path.dirname(targetPath);
    if (!fsImpl.existsSync(dir)) fsImpl.mkdirSync(dir, { recursive: true });

    let current = {};
    let format = 'canonical';
    if (fsImpl.existsSync(targetPath)) {
        current = tryReadJson(targetPath, fsImpl) || {};
        format = detectFormat(current);
    }

    let backupPath = null;
    if (fsImpl.existsSync(targetPath)) {
        if (!fsImpl.existsSync(backupDir)) fsImpl.mkdirSync(backupDir, { recursive: true });
        const ts = new Date(now).toISOString().replace(/[:.]/g, '-');
        const basename = path.basename(targetPath, '.json');
        backupPath = path.join(backupDir, `${basename}.${ts}.json`);
        fsImpl.copyFileSync(targetPath, backupPath);
        try { fsImpl.chmodSync(backupPath, 0o600); } catch { /* Windows: best-effort */ }
    }

    const trimmed = newValue.trim();
    const updated = JSON.parse(JSON.stringify(current));
    if (format === 'legacy') {
        updated[spec.legacyField] = trimmed;
    } else {
        setNested(updated, spec.canonicalPath, trimmed);
    }

    const tmpPath = `${targetPath}.tmp.${process.pid}.${now}`;
    fsImpl.writeFileSync(tmpPath, JSON.stringify(updated, null, 2) + '\n', { mode: 0o600 });
    fsImpl.renameSync(tmpPath, targetPath);
    try { fsImpl.chmodSync(targetPath, 0o600); } catch { /* Windows: best-effort */ }

    applyBackupRetention({ backupDir, retention, fsImpl, basename: path.basename(targetPath, '.json') });

    return {
        ok: true,
        jsonField: spec.legacyField,
        canonicalPath: spec.canonicalPath,
        provider: spec.provider,
        format,
        targetPath,
        fingerprint: fingerprint(trimmed),
        backupPath,
    };
}

function applyBackupRetention({ backupDir, retention, fsImpl, basename }) {
    if (!fsImpl.existsSync(backupDir)) return;
    const prefix = `${basename}.`;
    const files = fsImpl.readdirSync(backupDir)
        .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
        .sort();
    while (files.length > retention) {
        const oldest = files.shift();
        try { fsImpl.unlinkSync(path.join(backupDir, oldest)); } catch {}
    }
}

function getRawKey({ provider, secretsPath, fsImpl = fs } = {}) {
    const spec = MANAGED_KEYS.find(k => k.provider === provider);
    if (!spec) return null;
    const { data, format } = loadSource({ secretsPath, fsImpl });
    const raw = readKeyFromData(spec, data, format);
    if (!raw || typeof raw !== 'string' || !raw.trim() || isPlaceholder(raw)) return null;
    return raw;
}

module.exports = {
    HOME_CANONICAL,
    HOME_LEGACY,
    // Compat hacia atrás: módulos que importaban `HOME_SECRETS` siguen funcionando
    // — apunta al canonical, que es el nuevo destino.
    HOME_SECRETS: HOME_CANONICAL,
    DEFAULT_BACKUP_DIR,
    DEFAULT_BACKUP_RETENTION,
    MANAGED_KEYS,
    listKeys,
    rotateKey,
    getRawKey,
    maskValue,
    fingerprint,
    isPlaceholder,
    // Helpers expuestos para tests y consumidores internos:
    detectFormat,
    getNested,
    setNested,
};
