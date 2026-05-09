// =============================================================================
// Tests agent-models-change-alert.js — #3087 (U2 multi-provider · épico #3065)
//
// Cobertura H-1..H-10 del CA-PO consolidado:
//   H-1  cambio de provider
//   H-2  cambio de model_override (cross-MODELO puro)
//   H-3  literal `sk-test12345...` en el JSON → output sanitiza, audit flag
//   H-4  3 commits en 5 min → 1 mensaje consolidado
//   H-5  activity-log vacío → "sin baseline"
//   H-6  activity-log con N=1 → disclaimer baseline corta
//   H-7  modelo no en MODEL_PRICING → "no disponible (modelo no en pricing table)"
//   H-8  co-commit con application.conf → flag warning + audit co_commit_sensitive
//   H-9  idempotencia con last_notified_sha (reinicio entre commits)
//   H-10 (cobertura via opts del cron — no se simula rama, se cubre en buildBucket)
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const alert = require('../agent-models-change-alert');

// -----------------------------------------------------------------------------
// Helpers de fixtures
// -----------------------------------------------------------------------------

function tmpDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function rmr(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

/**
 * Crea un fake execFile compatible con la firma de execFileSync que retorna
 * resultados predefinidos para `git log` y `git show`.
 */
function makeFakeGit({ commits, blobs }) {
    return function fakeExec(cmd, args, opts) {
        if (cmd !== 'git') throw new Error(`fake git: cmd inesperado ${cmd}`);
        const subcmd = args[0];
        if (subcmd === 'log') {
            // Reconstruimos el output de --pretty=format:%x1f%H%x1e%cI%x1e%P
            const out = commits.map((c) => {
                const header = `\x1f${c.sha}\x1e${c.ts}\x1e${(c.parents || []).join(' ')}`;
                const fileLines = (c.files || []).join('\n');
                return fileLines.length > 0 ? `${header}\n${fileLines}` : header;
            }).join('\n');
            return out;
        }
        if (subcmd === 'show') {
            const ref = args[1] || '';
            const m = ref.match(/^([^:]+):/);
            if (!m) throw new Error(`fake git show ref inesperado: ${ref}`);
            const sha = m[1];
            const blob = blobs[sha];
            if (blob == null) {
                const e = new Error(`fake git: no blob para ${sha}`);
                e.status = 128;
                throw e;
            }
            return typeof blob === 'string' ? blob : JSON.stringify(blob);
        }
        if (subcmd === 'rev-parse') {
            return 'HEAD-FAKE\n';
        }
        throw new Error(`fake git: subcmd no soportado ${subcmd}`);
    };
}

function baseConfig(overrides) {
    const cfg = {
        default_provider: 'anthropic',
        providers: {
            anthropic: {
                launcher: 'claude',
                model: 'claude-opus-4-7',
                spawn_args_template: ['-p', '{user_prompt}'],
            },
            'openai-codex': {
                launcher: 'codex',
                model: 'gpt-5-codex',
                spawn_args_template: ['{script_path}'],
            },
            deterministic: {
                launcher: 'node',
                model: 'deterministic',
                spawn_args_template: ['{script_path}'],
            },
        },
        skills: {
            'backend-dev': { provider: 'anthropic' },
            ux: { provider: 'anthropic' },
            qa: { provider: 'anthropic' },
            tester: { provider: 'deterministic' },
        },
    };
    return Object.assign({}, cfg, overrides || {});
}

function activityLogFile(skill, sessions) {
    // Construye un activity-log.jsonl con N sesiones del skill, con timestamps
    // recientes para que pasen el cutoff de 30 días.
    const lines = [];
    const now = Date.now();
    for (let i = 0; i < sessions; i++) {
        lines.push(JSON.stringify({
            event: 'session:end',
            skill,
            ts: new Date(now - i * 60000).toISOString(),
            tokens_in: 8000,
            tokens_out: 2000,
            cache_read: 0,
            cache_write: 0,
            model: 'claude-opus-4-7',
        }));
    }
    return lines.join('\n') + '\n';
}

// -----------------------------------------------------------------------------
// parseGitLogOutput — función pura
// -----------------------------------------------------------------------------

test('parseGitLogOutput parsea bloques con sha + ts + parents + files', () => {
    const raw = '\x1faaaa\x1e2026-05-08T10:00:00Z\x1ebbbb\n.pipeline/agent-models.json\n\x1fcccc\x1e2026-05-08T10:01:00Z\x1eaaaa\n.pipeline/agent-models.json\nusers/src/main/resources/application.conf';
    const got = alert.parseGitLogOutput(raw);
    assert.equal(got.length, 2);
    assert.equal(got[0].sha, 'aaaa');
    assert.deepEqual(got[0].parents, ['bbbb']);
    assert.deepEqual(got[0].files, ['.pipeline/agent-models.json']);
    assert.equal(got[1].sha, 'cccc');
    assert.deepEqual(got[1].files, [
        '.pipeline/agent-models.json',
        'users/src/main/resources/application.conf',
    ]);
});

test('parseGitLogOutput tolera entrada vacía', () => {
    assert.deepEqual(alert.parseGitLogOutput(''), []);
    assert.deepEqual(alert.parseGitLogOutput(null), []);
    assert.deepEqual(alert.parseGitLogOutput(undefined), []);
});

// -----------------------------------------------------------------------------
// diffSkills + allowlistedFieldsForDiff — H-1, H-2 + CA-S1/B-1
// -----------------------------------------------------------------------------

test('H-1 · diffSkills detecta cambio de provider y NO incluye claves prohibidas', () => {
    const fromCfg = baseConfig();
    const toCfg = baseConfig();
    toCfg.skills['backend-dev'] = { provider: 'openai-codex' };

    const fromView = require('../agent-models').allowlistedFieldsForDiff(fromCfg);
    const toView = require('../agent-models').allowlistedFieldsForDiff(toCfg);
    const changes = alert.diffSkills(fromView, toView);

    const change = changes.find((c) => c.skill === 'backend-dev');
    assert.ok(change, 'change para backend-dev presente');
    assert.equal(change.kind, 'modified');
    assert.ok(change.changes.provider, 'cambio de provider detectado');
    assert.equal(change.changes.provider.from, 'anthropic');
    assert.equal(change.changes.provider.to, 'openai-codex');

    // Allowlist enforcement: ninguna clave prohibida en el output.
    const prohibited = ['credentials_env', 'spawn_args_template', 'permissions_mode'];
    for (const key of prohibited) {
        assert.ok(!Object.prototype.hasOwnProperty.call(change.changes, key),
            `clave prohibida "${key}" NO debe aparecer en el diff`);
    }
});

test('H-2 · diffSkills detecta cambio de model_override (cross-MODELO puro)', () => {
    const fromCfg = baseConfig();
    const toCfg = baseConfig();
    toCfg.skills['backend-dev'] = { provider: 'anthropic', model_override: 'claude-sonnet-4-6' };

    const am = require('../agent-models');
    const fromView = am.allowlistedFieldsForDiff(fromCfg);
    const toView = am.allowlistedFieldsForDiff(toCfg);
    const changes = alert.diffSkills(fromView, toView);
    const change = changes.find((c) => c.skill === 'backend-dev');
    assert.ok(change);
    assert.ok(change.changes.model_override, 'model_override cambió');
    assert.equal(change.changes.model_override.from, null);
    assert.equal(change.changes.model_override.to, 'claude-sonnet-4-6');
    // model resuelto también cambió.
    assert.ok(change.changes.model);
    assert.equal(change.changes.model.from, 'claude-opus-4-7');
    assert.equal(change.changes.model.to, 'claude-sonnet-4-6');
});

// -----------------------------------------------------------------------------
// estimateCostPerSession + renderCostLine — H-5, H-6, H-7
// -----------------------------------------------------------------------------

test('H-5 · activity-log vacío → renderCostLine dice "sin baseline"', () => {
    const dir = tmpDir('alert-h5');
    const logFile = path.join(dir, 'activity-log.jsonl');
    fs.writeFileSync(logFile, '');
    try {
        const cost = alert.renderCostLine('backend-dev', 'claude-opus-4-7', 'claude-sonnet-4-6', { logFile });
        assert.equal(cost.severity, 'unknown');
        assert.match(cost.line, /sin baseline/);
    } finally { rmr(dir); }
});

test('H-6 · N=1 sesión → disclaimer baseline corta', () => {
    const dir = tmpDir('alert-h6');
    const logFile = path.join(dir, 'activity-log.jsonl');
    fs.writeFileSync(logFile, activityLogFile('backend-dev', 1));
    try {
        const cost = alert.renderCostLine('backend-dev', 'claude-opus-4-7', 'claude-sonnet-4-6', { logFile });
        assert.match(cost.line, /\$\d+\.\d{4} → \$\d+\.\d{4}/);
        assert.ok(cost.secondLine, 'secondLine debería tener disclaimer');
        assert.match(cost.secondLine, /baseline corta/);
        assert.match(cost.secondLine, /N=1/);
    } finally { rmr(dir); }
});

test('H-6b · N=10 sesiones → SIN disclaimer baseline corta', () => {
    const dir = tmpDir('alert-h6b');
    const logFile = path.join(dir, 'activity-log.jsonl');
    fs.writeFileSync(logFile, activityLogFile('backend-dev', 10));
    try {
        const cost = alert.renderCostLine('backend-dev', 'claude-opus-4-7', 'claude-sonnet-4-6', { logFile });
        assert.equal(cost.secondLine, null, 'sin disclaimer cuando N >= 5');
    } finally { rmr(dir); }
});

test('H-7 · modelo NO en MODEL_PRICING → "no disponible (modelo no en pricing table)"', () => {
    const dir = tmpDir('alert-h7');
    const logFile = path.join(dir, 'activity-log.jsonl');
    fs.writeFileSync(logFile, activityLogFile('backend-dev', 10));
    try {
        // gpt-5-codex no está en MODEL_PRICING (solo Anthropic + deterministic).
        const cost = alert.renderCostLine('backend-dev', 'claude-opus-4-7', 'gpt-5-codex', { logFile });
        assert.equal(cost.severity, 'unknown');
        assert.match(cost.line, /no disponible \(modelo no en pricing table\)/);
        // No mostrar $0.00 ni +/-∞%.
        assert.ok(!/\$0\.00/.test(cost.line));
        assert.ok(!/\+∞|-∞|Infinity/.test(cost.line));
    } finally { rmr(dir); }
});

test('renderCostLine · ahorro >50% → severity savings', () => {
    const dir = tmpDir('alert-savings');
    const logFile = path.join(dir, 'activity-log.jsonl');
    fs.writeFileSync(logFile, activityLogFile('ux', 10));
    try {
        // opus → haiku: del orden de 80% de ahorro.
        const cost = alert.renderCostLine('ux', 'claude-opus-4-7', 'claude-haiku-4-5', { logFile });
        assert.equal(cost.severity, 'savings');
        assert.match(cost.line, /-\d+%/);
    } finally { rmr(dir); }
});

test('renderCostLine · aumento >50% → severity increase', () => {
    const dir = tmpDir('alert-incr');
    const logFile = path.join(dir, 'activity-log.jsonl');
    fs.writeFileSync(logFile, activityLogFile('ux', 10));
    try {
        const cost = alert.renderCostLine('ux', 'claude-haiku-4-5', 'claude-opus-4-7', { logFile });
        assert.equal(cost.severity, 'increase');
        assert.match(cost.line, /\+\d+%/);
    } finally { rmr(dir); }
});

// -----------------------------------------------------------------------------
// detectSensitiveCoCommit — H-8 (parte 1)
// -----------------------------------------------------------------------------

test('H-8 · detectSensitiveCoCommit detecta application.conf', () => {
    assert.equal(alert.detectSensitiveCoCommit(['users/src/main/resources/application.conf']), true);
    assert.equal(alert.detectSensitiveCoCommit(['.env']), true);
    assert.equal(alert.detectSensitiveCoCommit(['.env.production']), true);
    assert.equal(alert.detectSensitiveCoCommit(['.aws/credentials']), true);
    assert.equal(alert.detectSensitiveCoCommit(['secrets.yaml']), true);
    assert.equal(alert.detectSensitiveCoCommit(['.pipeline/agent-models.json']), false);
    assert.equal(alert.detectSensitiveCoCommit(['README.md']), false);
});

// -----------------------------------------------------------------------------
// consolidateWindow — H-4
// -----------------------------------------------------------------------------

test('H-4 · 3 commits dentro de 5min consolidan en 1 ventana', () => {
    const t0 = Date.parse('2026-05-08T10:00:00Z');
    const commits = [
        { sha: 'a', ts: new Date(t0).toISOString() },
        { sha: 'b', ts: new Date(t0 + 60000).toISOString() },     // +1min
        { sha: 'c', ts: new Date(t0 + 240000).toISOString() },    // +4min
    ];
    const windows = alert.consolidateWindow(commits);
    assert.equal(windows.length, 1, 'todos en una sola ventana');
    assert.equal(windows[0].length, 3);
});

test('H-4b · commits separados por >5min → ventanas distintas', () => {
    const t0 = Date.parse('2026-05-08T10:00:00Z');
    const commits = [
        { sha: 'a', ts: new Date(t0).toISOString() },
        { sha: 'b', ts: new Date(t0 + 600000).toISOString() }, // +10min
    ];
    const windows = alert.consolidateWindow(commits);
    assert.equal(windows.length, 2);
});

// -----------------------------------------------------------------------------
// buildBucket + formatTelegramMessage — H-1, H-2 integrados
// -----------------------------------------------------------------------------

test('H-1 integrado · cambio provider → mensaje single-change con prefijo correcto', () => {
    const dir = tmpDir('alert-h1-int');
    const logFile = path.join(dir, 'activity-log.jsonl');
    fs.writeFileSync(logFile, activityLogFile('backend-dev', 10));

    const fromCfg = baseConfig();
    const toCfg = baseConfig();
    toCfg.skills['backend-dev'] = { provider: 'openai-codex' };
    const fakeExec = makeFakeGit({
        commits: [
            { sha: 'aaaa', ts: '2026-05-08T10:00:00Z', parents: ['bbbb'], files: ['.pipeline/agent-models.json'] },
        ],
        blobs: { aaaa: toCfg, bbbb: fromCfg },
    });

    try {
        const commits = alert.detectChanges(null, 'aaaa', { execFile: fakeExec, cwd: dir });
        // En este test usamos rango simple que le pasa max-count=1 y devuelve aaaa.
        // Ajustamos para que el primer commit tenga el parent.
        commits[0].parents = ['bbbb'];
        const bucket = alert.buildBucket(commits, { execFile: fakeExec, cwd: dir, logFile });
        assert.ok(bucket);
        const msg = alert.formatTelegramMessage(bucket);

        // El "/" no es un especial MdV2, así que NO va escapado.
        assert.match(msg, /🔄 Cambio de provider\/model commiteado/, 'prefijo single-change');
        assert.match(msg, /backend\\-dev/, 'skill mencionado (escapeMdV2)');
        // gpt-5-codex no está en MODEL_PRICING → debe decir "no disponible (modelo no en pricing table)".
        // Los paréntesis están escapados en MdV2 → buscamos el texto interior sin paren.
        assert.match(msg, /no disponible.*modelo no en pricing table/);
    } finally { rmr(dir); }
});

test('H-2 integrado · cambio model_override → mensaje con costos visibles', () => {
    const dir = tmpDir('alert-h2-int');
    const logFile = path.join(dir, 'activity-log.jsonl');
    fs.writeFileSync(logFile, activityLogFile('backend-dev', 10));

    const fromCfg = baseConfig();
    const toCfg = baseConfig();
    toCfg.skills['backend-dev'] = { provider: 'anthropic', model_override: 'claude-haiku-4-5' };

    const fakeExec = makeFakeGit({
        commits: [
            { sha: 'aaaa', ts: '2026-05-08T10:00:00Z', parents: ['bbbb'], files: ['.pipeline/agent-models.json'] },
        ],
        blobs: { aaaa: toCfg, bbbb: fromCfg },
    });

    try {
        const commits = [{ sha: 'aaaa', ts: '2026-05-08T10:00:00Z', parents: ['bbbb'], files: ['.pipeline/agent-models.json'] }];
        const bucket = alert.buildBucket(commits, { execFile: fakeExec, cwd: dir, logFile });
        assert.ok(bucket);
        assert.equal(bucket.commitCount, 1);
        // El skill debería aparecer como cambiado (model: opus → haiku).
        const change = bucket.changes.find((c) => c.skill === 'backend-dev');
        assert.ok(change);
        assert.ok(change.costRender);
        assert.match(change.costRender.line, /\$\d+\.\d{4} → \$\d+\.\d{4}/);
        assert.equal(change.costRender.severity, 'savings');

        const msg = alert.formatTelegramMessage(bucket);
        assert.match(msg, /backend\\-dev/);
        // En MdV2: "$" no es especial → NO escapado. "." sí lo es → escapado a "\.".
        assert.match(msg, /\$\d+\\\.\d{4}/, 'costo USD con punto escapado MdV2');
    } finally { rmr(dir); }
});

// -----------------------------------------------------------------------------
// Sanitización de inputs sensibles — H-3
// -----------------------------------------------------------------------------

test('H-3 · valor con `sk-...` mal puesto en el JSON → output sanitiza', () => {
    // Simulamos un toCfg con un model_override que contiene un secret típico.
    // Esto NO es un caso real (el schema rechazaría, pero el sanitizer es defensa
    // en profundidad).
    const fromCfg = baseConfig();
    const toCfg = baseConfig();
    toCfg.skills['backend-dev'] = {
        provider: 'anthropic',
        model_override: 'sk-test-1234567890abcdef1234567890abcdef',
    };

    const fakeExec = makeFakeGit({
        commits: [
            { sha: 'aaaa', ts: '2026-05-08T10:00:00Z', parents: ['bbbb'], files: ['.pipeline/agent-models.json'] },
        ],
        blobs: { aaaa: toCfg, bbbb: fromCfg },
    });

    const dir = tmpDir('alert-h3');
    try {
        const commits = [{ sha: 'aaaa', ts: '2026-05-08T10:00:00Z', parents: ['bbbb'], files: ['.pipeline/agent-models.json'] }];
        const bucket = alert.buildBucket(commits, { execFile: fakeExec, cwd: dir });
        assert.ok(bucket);
        const msg = alert.formatTelegramMessage(bucket);
        // El sanitizer debe redactar la cadena `sk-...`. Verificamos que no aparezca
        // textual el secret completo en el mensaje sanitizado.
        assert.ok(!msg.includes('sk-test-1234567890abcdef1234567890abcdef'),
            'sk-token NO debe aparecer crudo en el mensaje');
    } finally { rmr(dir); }
});

// -----------------------------------------------------------------------------
// Co-commit con archivos sensibles — H-8 (parte 2)
// -----------------------------------------------------------------------------

test('H-8 integrado · co-commit con application.conf → flag warning + audit', () => {
    const dir = tmpDir('alert-h8');
    const pipelineDir = path.join(dir, '.pipeline');
    fs.mkdirSync(pipelineDir, { recursive: true });
    const logFile = path.join(dir, 'activity-log.jsonl');
    fs.writeFileSync(logFile, activityLogFile('ux', 10));

    const fromCfg = baseConfig();
    const toCfg = baseConfig();
    toCfg.skills['ux'] = { provider: 'anthropic', model_override: 'claude-sonnet-4-6' };

    const fakeExec = makeFakeGit({
        commits: [{
            sha: 'aaaa', ts: '2026-05-08T10:00:00Z', parents: ['bbbb'],
            files: ['.pipeline/agent-models.json', 'users/src/main/resources/application.conf'],
        }],
        blobs: { aaaa: toCfg, bbbb: fromCfg },
    });

    try {
        const result = alert.sendAlert('bbbb', 'aaaa', {
            execFile: fakeExec,
            cwd: dir,
            pipelineDir,
            logFile,
            now: () => 1746710400000,
        });
        assert.ok(result.ok);
        assert.equal(result.alerts.length, 1);
        assert.equal(result.alerts[0].coCommitSensitive, true);

        // Mensaje debe contener la línea de Atención (asteriscos escapados via MdV2).
        assert.match(result.alerts[0].text, /🚨 \*Atención\*.*credenciales/s);

        // Audit log con co_commit_sensitive: true.
        const auditFile = alert.auditFilePath(pipelineDir);
        const auditRaw = fs.readFileSync(auditFile, 'utf8');
        const auditLine = auditRaw.trim().split('\n').pop();
        const auditEvt = JSON.parse(auditLine);
        assert.equal(auditEvt.co_commit_sensitive, true);
        assert.deepEqual(auditEvt.skills_affected, ['ux']);
    } finally { rmr(dir); }
});

// -----------------------------------------------------------------------------
// Idempotencia con last_notified_sha — H-9
// -----------------------------------------------------------------------------

test('H-9 · readLastNotifiedSha y persistLastNotifiedSha son idempotentes', () => {
    const dir = tmpDir('alert-h9');
    try {
        // Estado inicial: sin archivo.
        assert.equal(alert.readLastNotifiedSha(dir), null);
        // Persistir y releer.
        alert.persistLastNotifiedSha(dir, 'sha-1');
        assert.equal(alert.readLastNotifiedSha(dir), 'sha-1');
        // Sobrescribir.
        alert.persistLastNotifiedSha(dir, 'sha-2');
        assert.equal(alert.readLastNotifiedSha(dir), 'sha-2');
    } finally { rmr(dir); }
});

test('H-9b · sendAlert persiste last_notified_sha al éxito', () => {
    const dir = tmpDir('alert-h9b');
    const pipelineDir = path.join(dir, '.pipeline');
    fs.mkdirSync(pipelineDir, { recursive: true });
    const logFile = path.join(dir, 'activity-log.jsonl');
    fs.writeFileSync(logFile, activityLogFile('ux', 10));

    const fromCfg = baseConfig();
    const toCfg = baseConfig();
    toCfg.skills['ux'] = { provider: 'anthropic', model_override: 'claude-sonnet-4-6' };

    const fakeExec = makeFakeGit({
        commits: [{ sha: 'aaaa', ts: '2026-05-08T10:00:00Z', parents: ['bbbb'], files: ['.pipeline/agent-models.json'] }],
        blobs: { aaaa: toCfg, bbbb: fromCfg },
    });

    try {
        const result = alert.sendAlert('bbbb', 'aaaa', {
            execFile: fakeExec,
            cwd: dir,
            pipelineDir,
            logFile,
        });
        assert.ok(result.ok);
        assert.equal(alert.readLastNotifiedSha(pipelineDir), 'aaaa', 'cursor avanza al headSha');
    } finally { rmr(dir); }
});

// -----------------------------------------------------------------------------
// Audit log estructura — CA-S7 / F-1
// -----------------------------------------------------------------------------

test('auditAppend agrega líneas válidas con campos obligatorios', () => {
    const dir = tmpDir('alert-audit');
    try {
        alert.auditAppend(dir, {
            ts: '2026-05-08T10:00:00.000Z',
            first_sha: 'aaaa',
            last_sha: 'aaaa',
            commit_count: 1,
            from_state_hash: 'deadbeef',
            to_state_hash: 'cafebabe',
            skills_affected: ['ux'],
            co_commit_sensitive: false,
            sensitive_input_detected: false,
            queue_file: null,
        });
        const file = alert.auditFilePath(dir);
        assert.ok(fs.existsSync(file));
        const raw = fs.readFileSync(file, 'utf8');
        const evt = JSON.parse(raw.trim());
        // Campos obligatorios CA-S7.
        for (const key of [
            'ts', 'first_sha', 'last_sha', 'from_state_hash', 'to_state_hash',
            'skills_affected', 'co_commit_sensitive', 'sensitive_input_detected',
        ]) {
            assert.ok(Object.prototype.hasOwnProperty.call(evt, key), `falta campo ${key}`);
        }
    } finally { rmr(dir); }
});

// -----------------------------------------------------------------------------
// generateNarrationScript — CA-D
// -----------------------------------------------------------------------------

test('CA-D · narración single-change abre informal y menciona dirección de costo', () => {
    const bucket = {
        commitCount: 1,
        coCommitSensitive: false,
        changes: [{
            skill: 'ux',
            kind: 'modified',
            changes: { model_override: { from: null, to: 'claude-haiku-4-5' } },
            costRender: { line: '...', secondLine: null, severity: 'savings' },
        }],
    };
    const text = alert.generateNarrationScript(bucket);
    assert.match(text, /Mirá|Loco/, 'apertura natural rioplatense');
    assert.match(text, /ux/);
    assert.match(text, /baja/, 'menciona dirección del costo');
});

test('CA-D-3 · narración consolidada NO lee cada cambio', () => {
    const bucket = {
        commitCount: 3,
        coCommitSensitive: false,
        changes: [
            { skill: 'a', changes: {}, costRender: null },
            { skill: 'b', changes: {}, costRender: null },
            { skill: 'c', changes: {}, costRender: null },
        ],
    };
    const text = alert.generateNarrationScript(bucket);
    assert.match(text, /3 skills/);
    assert.match(text, /desglose en el mensaje/);
});

test('CA-D-4 · co-commit sensible abre con advertencia ANTES del costo', () => {
    const bucket = {
        commitCount: 1,
        coCommitSensitive: true,
        changes: [{
            skill: 'ux',
            kind: 'modified',
            changes: { model_override: { from: null, to: 'claude-haiku-4-5' } },
            costRender: { line: '...', secondLine: null, severity: 'savings' },
        }],
    };
    const text = alert.generateNarrationScript(bucket);
    assert.match(text, /^Ojo Leito/, 'apertura con advertencia');
    assert.match(text, /credenciales/);
});

// -----------------------------------------------------------------------------
// Helpers de formato — escapeMdV2 / safeSkillName
// -----------------------------------------------------------------------------

test('escapeMdV2 escapa todos los caracteres especiales de MarkdownV2', () => {
    const specials = '_*[]()~`>#+-=|{}.!\\';
    const out = alert.escapeMdV2(specials);
    for (const ch of specials) {
        assert.ok(out.includes('\\' + ch), `falta escape de "${ch}"`);
    }
});

test('safeSkillName filtra basura y permite skills limpios', () => {
    assert.equal(alert.safeSkillName('backend-dev'), 'backend-dev');
    assert.equal(alert.safeSkillName('android_dev_42'), 'android_dev_42');
    assert.equal(alert.safeSkillName('C:\\foo\\bar'), '[skill_invalid]');
    assert.equal(alert.safeSkillName(''), '[skill_invalid]');
    assert.equal(alert.safeSkillName(null), '[skill_invalid]');
    assert.equal(alert.safeSkillName(123), '[skill_invalid]');
});
