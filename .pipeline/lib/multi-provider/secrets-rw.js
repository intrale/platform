// =============================================================================
// secrets-rw.js — Lectura/escritura segura de API keys en
// `~/.claude/secrets/telegram-config.json` desde la UI del dashboard (#3177).
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
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const HOME_SECRETS = path.join(os.homedir(), '.claude', 'secrets', 'telegram-config.json');
const DEFAULT_BACKUP_DIR = path.join(os.homedir(), '.claude', 'secrets', 'backups');
const DEFAULT_BACKUP_RETENTION = 30;

// Lista canónica de keys gestionables vía UI. Anthropic está pero `editable:false`.
//
// Los 3 free providers (#3260 — hardening de free providers, ola N+5) entran al
// mismo flujo de masking + fingerprint SHA-256 + atomic write 0600 + backup
// 30d + audit chain (SR-1 de security). NVIDIA-NIM se sumará cuando mergee
// #3243 — la lista crece editando este array, sin código nuevo.
const MANAGED_KEYS = Object.freeze([
    {
        jsonField: 'anthropic_api_key',
        provider: 'anthropic',
        label: 'Anthropic',
        editable: false,
        reason: 'Claude Code usa OAuth / MAX login; rotar acá puede confundir el child env.',
    },
    {
        jsonField: 'openai_api_key',
        provider: 'openai',
        label: 'OpenAI / Codex',
        editable: true,
    },
    {
        jsonField: 'elevenlabs_api_key',
        provider: 'elevenlabs',
        label: 'ElevenLabs',
        editable: true,
    },
    {
        jsonField: 'groq_api_key',
        provider: 'groq',
        label: 'Groq',
        editable: true,
        free_tier_notes: 'RPM 30 / RPD 14400 (free) — ver docs/pipeline/multi-provider.md §8.',
    },
    {
        jsonField: 'gemini_google_api_key',
        provider: 'gemini-google',
        label: 'Gemini (Google AI Studio)',
        editable: true,
        free_tier_notes: 'RPM 15 / RPD 1500 / TPM 1M (free) — ver docs/pipeline/multi-provider.md §8.',
    },
    {
        jsonField: 'cerebras_api_key',
        provider: 'cerebras',
        label: 'Cerebras',
        editable: true,
        free_tier_notes: 'RPM 30 / TPM 60K (free) — ver docs/pipeline/multi-provider.md §8.',
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

function listKeys({ secretsPath = HOME_SECRETS, fsImpl = fs } = {}) {
    const json = tryReadJson(secretsPath, fsImpl) || {};
    return MANAGED_KEYS.map(spec => {
        const raw = json[spec.jsonField];
        let status;
        if (typeof raw !== 'string' || !raw.trim()) status = 'absent';
        else if (isPlaceholder(raw)) status = 'placeholder';
        else status = 'present';

        return {
            provider: spec.provider,
            jsonField: spec.jsonField,
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
    secretsPath = HOME_SECRETS,
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

    const dir = path.dirname(secretsPath);
    if (!fsImpl.existsSync(dir)) fsImpl.mkdirSync(dir, { recursive: true });
    const current = tryReadJson(secretsPath, fsImpl) || {};

    let backupPath = null;
    if (fsImpl.existsSync(secretsPath)) {
        if (!fsImpl.existsSync(backupDir)) fsImpl.mkdirSync(backupDir, { recursive: true });
        const ts = new Date(now).toISOString().replace(/[:.]/g, '-');
        backupPath = path.join(backupDir, `telegram-config.${ts}.json`);
        fsImpl.copyFileSync(secretsPath, backupPath);
        try { fsImpl.chmodSync(backupPath, 0o600); } catch { /* Windows: best-effort */ }
    }

    const updated = { ...current, [spec.jsonField]: newValue.trim() };
    const tmpPath = `${secretsPath}.tmp.${process.pid}.${now}`;
    fsImpl.writeFileSync(tmpPath, JSON.stringify(updated, null, 2) + '\n', { mode: 0o600 });
    fsImpl.renameSync(tmpPath, secretsPath);
    try { fsImpl.chmodSync(secretsPath, 0o600); } catch { /* Windows: best-effort */ }

    applyBackupRetention({ backupDir, retention, fsImpl });

    return {
        ok: true,
        jsonField: spec.jsonField,
        provider: spec.provider,
        fingerprint: fingerprint(newValue.trim()),
        backupPath,
    };
}

function applyBackupRetention({ backupDir, retention, fsImpl }) {
    if (!fsImpl.existsSync(backupDir)) return;
    const files = fsImpl.readdirSync(backupDir)
        .filter(f => f.startsWith('telegram-config.') && f.endsWith('.json'))
        .sort();
    while (files.length > retention) {
        const oldest = files.shift();
        try { fsImpl.unlinkSync(path.join(backupDir, oldest)); } catch {}
    }
}

function getRawKey({ provider, secretsPath = HOME_SECRETS, fsImpl = fs } = {}) {
    const spec = MANAGED_KEYS.find(k => k.provider === provider);
    if (!spec) return null;
    const json = tryReadJson(secretsPath, fsImpl) || {};
    const raw = json[spec.jsonField];
    if (!raw || typeof raw !== 'string' || !raw.trim() || isPlaceholder(raw)) return null;
    return raw;
}

module.exports = {
    HOME_SECRETS,
    DEFAULT_BACKUP_DIR,
    DEFAULT_BACKUP_RETENTION,
    MANAGED_KEYS,
    listKeys,
    rotateKey,
    getRawKey,
    maskValue,
    fingerprint,
    isPlaceholder,
};
