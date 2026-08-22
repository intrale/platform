// =============================================================================
// agent-models-rw.js — Lectura/escritura segura de `agent-models.json` desde
// la UI del dashboard (#3177).
//
// Garantías de este módulo:
//   - Write atómico (tempfile + rename) para que el pulpo nunca lea un JSON
//     parcialmente escrito durante un spawn.
//   - Lock file simple (advisory; el pulpo NO toma este lock — es solo entre
//     escritores potenciales del dashboard, ej. dos PUT concurrentes).
//   - Backup pre-save en `.pipeline/audit/agent-models-backups/<ISO-ts>.json`
//     con retention policy de N backups (default 30).
//   - Validación con `agent-models-validate.js` ANTES de escribir. Si el
//     payload nuevo no valida, lanza con la lista de errores sin tocar el
//     archivo en disco.
//   - Diff computado contra el current state (sin librerías externas) para
//     mostrar al operador "vas a cambiar X agentes" antes del save.
//
// NO incluye:
//   - File watcher para hot-reload del pulpo. Esa pieza vive en una recomendación
//     separada (#3188). Para esta versión el operador hace `Reload pipeline`
//     manual desde la UI (que delega en restart.js).
//   - Migración de schema. El schema ya tiene `fallbacks` opcional desde #3177.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const validator = require('../agent-models-validate');

const PIPELINE_ROOT = process.env.PIPELINE_STATE_DIR
    || path.resolve(__dirname, '..', '..');
const DEFAULT_JSON_PATH = path.join(PIPELINE_ROOT, 'agent-models.json');
const DEFAULT_BACKUP_DIR = path.join(PIPELINE_ROOT, 'audit', 'agent-models-backups');
const DEFAULT_LOCK_PATH = path.join(PIPELINE_ROOT, '.agent-models.lock');

const DEFAULT_BACKUP_RETENTION = 30;
const LOCK_STALE_MS = 30_000; // 30s — un PUT decente no tarda más

// -----------------------------------------------------------------------------
// acquireLock — lock cooperativo basado en archivo + PID + timestamp.
//
// Reglas:
//   - Si el lock NO existe, lo creamos con `{ pid, started_at }`.
//   - Si existe y el PID está vivo + el timestamp es < LOCK_STALE_MS, fail.
//   - Si existe pero el holder está muerto o stale, lo robamos (overwrite).
//
// Devuelve un release fn que el caller debe ejecutar en try/finally.
// -----------------------------------------------------------------------------
function acquireLock({ lockPath = DEFAULT_LOCK_PATH, fsImpl = fs, now = Date.now() } = {}) {
    const lockDir = path.dirname(lockPath);
    if (!fsImpl.existsSync(lockDir)) {
        fsImpl.mkdirSync(lockDir, { recursive: true });
    }

    // Intentamos crear el lock atómicamente (wx = fail si existe).
    const payload = JSON.stringify({ pid: process.pid, started_at: now }) + '\n';
    try {
        fsImpl.writeFileSync(lockPath, payload, { flag: 'wx' });
        return makeReleaseFn(lockPath, fsImpl);
    } catch (e) {
        if (e.code !== 'EEXIST') throw e;
    }

    // Lock existe — chequeo de staleness y holder vivo.
    let holder;
    try {
        holder = JSON.parse(fsImpl.readFileSync(lockPath, 'utf8'));
    } catch {
        // Lock corrupto → lo robamos.
        fsImpl.writeFileSync(lockPath, payload);
        return makeReleaseFn(lockPath, fsImpl);
    }
    const age = now - (Number(holder.started_at) || 0);
    const holderAlive = holder.pid && holder.pid !== process.pid && isPidAlive(holder.pid);
    if (holderAlive && age < LOCK_STALE_MS) {
        const err = new Error(`[agent-models-rw] lock ocupado por pid=${holder.pid} (age=${age}ms). Reintentar.`);
        err.code = 'ELOCKED';
        err.holder = holder;
        throw err;
    }
    // Stale → robamos.
    fsImpl.writeFileSync(lockPath, payload);
    return makeReleaseFn(lockPath, fsImpl);
}

function makeReleaseFn(lockPath, fsImpl) {
    let released = false;
    return function release() {
        if (released) return;
        released = true;
        try { fsImpl.unlinkSync(lockPath); } catch { /* ya borrado */ }
    };
}

function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM'; // proceso existe pero no podemos señalarlo
    }
}

// -----------------------------------------------------------------------------
// readConfig — lee el JSON canónico del disco y lo devuelve parseado.
// No valida — el caller hace `validate()` aparte si necesita el resultado.
// -----------------------------------------------------------------------------
function readConfig({ jsonPath = DEFAULT_JSON_PATH, fsImpl = fs } = {}) {
    const raw = fsImpl.readFileSync(jsonPath, 'utf8');
    return JSON.parse(raw);
}

// -----------------------------------------------------------------------------
// writeConfig — write atómico con backup + validación previa.
//
// Pasos:
//   1. Validar `newConfig` con agent-models-validate (boot fail-fast equivalente).
//      Si falla → throw con `errors[]`. NO tocamos disco.
//   2. Adquirir lock (acquireLock).
//   3. Backup del archivo actual a `audit/agent-models-backups/<ISO>.json`.
//   4. Escribir a tempfile en el mismo directorio.
//   5. fs.renameSync(tempfile, jsonPath) — atómico en POSIX y NTFS.
//   6. Aplicar retention policy: borrar backups viejos manteniendo los últimos N.
//   7. Liberar lock.
// -----------------------------------------------------------------------------
function writeConfig({
    newConfig,
    jsonPath = DEFAULT_JSON_PATH,
    backupDir = DEFAULT_BACKUP_DIR,
    lockPath = DEFAULT_LOCK_PATH,
    schemaPath,
    retention = DEFAULT_BACKUP_RETENTION,
    fsImpl = fs,
    now = Date.now(),
} = {}) {
    if (!newConfig || typeof newConfig !== 'object' || Array.isArray(newConfig)) {
        throw new Error('[agent-models-rw] writeConfig: "newConfig" debe ser objeto.');
    }

    // 1. Validar antes de tocar disco.
    const tempValidationDir = fsImpl.mkdtempSync(path.join(os.tmpdir(), 'amrw-'));
    const tempValidationPath = path.join(tempValidationDir, 'agent-models.json');
    fsImpl.writeFileSync(tempValidationPath, JSON.stringify(newConfig, null, 2));
    const validation = validator.validate(tempValidationPath, schemaPath ? { schemaPath } : {});
    try { fsImpl.unlinkSync(tempValidationPath); } catch {}
    try { fsImpl.rmdirSync(tempValidationDir); } catch {}
    if (!validation.ok) {
        const err = new Error('[agent-models-rw] validation failed: ' + validation.errors.map(e => e.message).join('; '));
        err.errors = validation.errors;
        err.exitCode = validation.exitCode;
        throw err;
    }

    // 2. Lock.
    const release = acquireLock({ lockPath, fsImpl, now });
    let backupPath = null;
    try {
        // 3. Backup pre-save (si el archivo existe).
        if (fsImpl.existsSync(jsonPath)) {
            if (!fsImpl.existsSync(backupDir)) {
                fsImpl.mkdirSync(backupDir, { recursive: true });
            }
            const ts = new Date(now).toISOString().replace(/[:.]/g, '-');
            backupPath = path.join(backupDir, `agent-models.${ts}.json`);
            fsImpl.copyFileSync(jsonPath, backupPath);
        }

        // 4. Write atómico via tempfile.
        const dir = path.dirname(jsonPath);
        const base = path.basename(jsonPath);
        const tempPath = path.join(dir, `.${base}.tmp.${process.pid}.${now}`);
        fsImpl.writeFileSync(tempPath, JSON.stringify(newConfig, null, 2) + '\n', 'utf8');
        fsImpl.renameSync(tempPath, jsonPath);

        // 5. Retention.
        try { applyBackupRetention({ backupDir, retention, fsImpl }); } catch { /* no critical */ }

        return { ok: true, backupPath };
    } finally {
        release();
    }
}

function applyBackupRetention({ backupDir, retention, fsImpl }) {
    if (!fsImpl.existsSync(backupDir)) return;
    const files = fsImpl.readdirSync(backupDir)
        .filter(f => f.startsWith('agent-models.') && f.endsWith('.json'))
        .sort(); // ISO timestamp → orden lex == orden cronológico
    while (files.length > retention) {
        const oldest = files.shift();
        try { fsImpl.unlinkSync(path.join(backupDir, oldest)); } catch {}
    }
}

// -----------------------------------------------------------------------------
// computeDiff — compara `current` vs `next` y devuelve un resumen de cambios
// orientado a UI. NO usamos JSON Patch para no agregar deps; el formato es
// específico para mostrar al operador "vas a cambiar 3 agentes: guru, qa, ux".
// -----------------------------------------------------------------------------
function computeDiff(current, next) {
    const diff = {
        skillsAdded: [],
        skillsRemoved: [],
        skillsChanged: [],
        providersAdded: [],
        providersRemoved: [],
        providersChanged: [],
        defaultProviderChanged: null,
    };
    if (!current || !next) return diff;

    if (current.default_provider !== next.default_provider) {
        diff.defaultProviderChanged = {
            before: current.default_provider || null,
            after: next.default_provider || null,
        };
    }

    const curSkills = current.skills || {};
    const nextSkills = next.skills || {};
    const allSkillKeys = new Set([...Object.keys(curSkills), ...Object.keys(nextSkills)]);
    for (const name of allSkillKeys) {
        const before = curSkills[name];
        const after = nextSkills[name];
        if (!before && after) {
            diff.skillsAdded.push({ name, provider: after.provider });
            continue;
        }
        if (before && !after) {
            diff.skillsRemoved.push({ name, oldProvider: before.provider });
            continue;
        }
        const fieldDiff = {};
        if (before.provider !== after.provider) fieldDiff.provider = { before: before.provider, after: after.provider };
        if (before.model_override !== after.model_override) {
            if (before.model_override || after.model_override) {
                fieldDiff.model_override = { before: before.model_override || null, after: after.model_override || null };
            }
        }
        const bf = Array.isArray(before.fallbacks) ? before.fallbacks : [];
        const af = Array.isArray(after.fallbacks) ? after.fallbacks : [];
        if (JSON.stringify(bf) !== JSON.stringify(af)) {
            fieldDiff.fallbacks = { before: bf, after: af };
        }
        if (Object.keys(fieldDiff).length > 0) {
            diff.skillsChanged.push({ name, before, after, diff: fieldDiff });
        }
    }

    const curProviders = current.providers || {};
    const nextProviders = next.providers || {};
    const allProviderKeys = new Set([...Object.keys(curProviders), ...Object.keys(nextProviders)]);
    for (const name of allProviderKeys) {
        const before = curProviders[name];
        const after = nextProviders[name];
        if (!before && after) { diff.providersAdded.push(name); continue; }
        if (before && !after) { diff.providersRemoved.push(name); continue; }
        const fields = [];
        for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
            if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) fields.push(k);
        }
        if (fields.length > 0) {
            diff.providersChanged.push({ name, fields });
        }
    }
    return diff;
}

function summarizeDiff(diff) {
    const lines = [];
    if (diff.defaultProviderChanged) {
        lines.push(`Default provider: ${diff.defaultProviderChanged.before || '(vacío)'} → ${diff.defaultProviderChanged.after || '(vacío)'}`);
    }
    for (const s of diff.skillsAdded) lines.push(`+ skill ${s.name} → ${s.provider}`);
    for (const s of diff.skillsRemoved) lines.push(`- skill ${s.name} (era ${s.oldProvider})`);
    for (const s of diff.skillsChanged) {
        const parts = [];
        if (s.diff.provider) parts.push(`provider ${s.diff.provider.before} → ${s.diff.provider.after}`);
        if (s.diff.model_override) parts.push(`model_override ${s.diff.model_override.before || '(default)'} → ${s.diff.model_override.after || '(default)'}`);
        if (s.diff.fallbacks) parts.push(`fallbacks [${s.diff.fallbacks.before.join(',')}] → [${s.diff.fallbacks.after.join(',')}]`);
        lines.push(`~ skill ${s.name}: ${parts.join(' | ')}`);
    }
    for (const p of diff.providersAdded) lines.push(`+ provider ${p}`);
    for (const p of diff.providersRemoved) lines.push(`- provider ${p}`);
    for (const p of diff.providersChanged) lines.push(`~ provider ${p.name}: campos [${p.fields.join(', ')}]`);
    if (lines.length === 0) lines.push('(sin cambios)');
    return lines;
}

module.exports = {
    DEFAULT_JSON_PATH,
    DEFAULT_BACKUP_DIR,
    DEFAULT_LOCK_PATH,
    DEFAULT_BACKUP_RETENTION,
    readConfig,
    writeConfig,
    acquireLock,
    computeDiff,
    summarizeDiff,
    applyBackupRetention,
    isPidAlive,
};
