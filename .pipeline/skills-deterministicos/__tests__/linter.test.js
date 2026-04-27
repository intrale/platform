// Tests unitarios de .pipeline/skills-deterministicos/linter.js (issue #2491)
// No ejecutamos git real: validamos parseArgs, heartbeat, updateMarker y
// el agregado de findings con filesystem aislado.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-linter-'));
fs.mkdirSync(path.join(TMP, '.claude', 'hooks'), { recursive: true });
fs.mkdirSync(path.join(TMP, '.pipeline', 'logs'), { recursive: true });
fs.mkdirSync(path.join(TMP, '.pipeline', 'desarrollo', 'linteo', 'trabajando'), { recursive: true });
process.env.PIPELINE_REPO_ROOT = TMP;
process.env.CLAUDE_PROJECT_DIR = TMP;

delete require.cache[require.resolve('../linter')];
const linter = require('../linter');

test('parseArgs — issue posicional', () => {
    const a = linter.parseArgs(['node', 'linter.js', '2491']);
    assert.equal(a.issue, 2491);
    assert.equal(a.base, 'origin/main');
});

test('parseArgs — --trabajando=<path> y --base=<ref>', () => {
    const a = linter.parseArgs(['node', 'x', '10', '--trabajando=/tmp/foo.linter', '--base=origin/develop']);
    assert.equal(a.trabajando, '/tmp/foo.linter');
    assert.equal(a.base, 'origin/develop');
});

test('parseArgs — fallback a PIPELINE_ISSUE y PIPELINE_TRABAJANDO', () => {
    const savedI = process.env.PIPELINE_ISSUE;
    const savedT = process.env.PIPELINE_TRABAJANDO;
    process.env.PIPELINE_ISSUE = '8888';
    process.env.PIPELINE_TRABAJANDO = '/tmp/env.linter';
    try {
        const a = linter.parseArgs(['node', 'x']);
        assert.equal(a.issue, 8888);
        assert.equal(a.trabajando, '/tmp/env.linter');
    } finally {
        if (savedI === undefined) delete process.env.PIPELINE_ISSUE; else process.env.PIPELINE_ISSUE = savedI;
        if (savedT === undefined) delete process.env.PIPELINE_TRABAJANDO; else process.env.PIPELINE_TRABAJANDO = savedT;
    }
});

test('startHeartbeat — escribe archivo con skill=linter y model=deterministic', () => {
    const hb = linter.startHeartbeat(7777);
    try {
        const hbFile = path.join(TMP, '.claude', 'hooks', 'agent-7777.heartbeat');
        assert.ok(fs.existsSync(hbFile), 'heartbeat file debe existir');
        const data = JSON.parse(fs.readFileSync(hbFile, 'utf8').trim());
        assert.equal(data.skill, 'linter');
        assert.equal(data.model, 'deterministic');
        assert.equal(data.issue, 7777);
        assert.equal(typeof data.pid, 'number');
    } finally {
        hb.stop();
    }
});

test('startHeartbeat — stop() elimina el archivo', () => {
    const hb = linter.startHeartbeat(7778);
    const hbFile = path.join(TMP, '.claude', 'hooks', 'agent-7778.heartbeat');
    assert.ok(fs.existsSync(hbFile));
    hb.stop();
    assert.ok(!fs.existsSync(hbFile));
});

test('updateMarker — actualiza YAML sin duplicar keys', () => {
    const markerPath = path.join(TMP, '.pipeline', 'desarrollo', 'linteo', 'trabajando', '999.linter');
    fs.writeFileSync(markerPath, 'issue: 999\nskill: "linter"\nresultado: "pendiente"\n');
    linter.updateMarker(markerPath, {
        resultado: 'aprobado',
        motivo: 'Linter OK',
        linter_errors: 0,
    });
    const content = fs.readFileSync(markerPath, 'utf8');
    assert.match(content, /resultado: "aprobado"/);
    assert.match(content, /motivo: "Linter OK"/);
    assert.match(content, /linter_errors: 0/);
    // No debe haber duplicado la key "resultado"
    const matches = content.match(/^resultado:/gm) || [];
    assert.equal(matches.length, 1, 'resultado debe aparecer una sola vez');
});

test('updateMarker — sin trabajandoPath no tira excepción', () => {
    assert.doesNotThrow(() => linter.updateMarker(null, { foo: 'bar' }));
    assert.doesNotThrow(() => linter.updateMarker(undefined, { foo: 'bar' }));
});

test('runAllChecks — integra static-checks sin romper con repo vacío', () => {
    // Con git no disponible / sin commits, igual debe devolver findings (branch warn + no-commits)
    // NOTA: runAllChecks llama a git real; si git falla, los helpers devuelven vacío.
    // Probamos que el shape del retorno sea correcto.
    const r = linter.runAllChecks({ issue: 1, cwd: TMP, base: 'origin/main' });
    assert.ok(Array.isArray(r.findings));
    assert.equal(typeof r.stats, 'object');
    assert.equal(typeof r.commitCount, 'number');
    assert.equal(typeof r.fileCount, 'number');
});

// Regresión #2523 rev-1: el linter debe operar sobre el worktree del agente,
// no sobre el checkout principal. Antes del fix, REPO_ROOT (calculado desde
// __dirname) apuntaba siempre al monorepo principal y `runAllChecks` recibía
// ese cwd, leyendo la rama y los commits incorrectos. Verificamos acá que el
// módulo expone tanto REPO_ROOT como WORK_DIR y que WORK_DIR se resuelve a
// partir de PIPELINE_WORKTREE / process.cwd() / fallback REPO_ROOT.
test('módulo — WORK_DIR distinto de REPO_ROOT cuando PIPELINE_WORKTREE difiere', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-linter-root-'));
    const tmpWork = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-linter-work-'));
    fs.mkdirSync(path.join(tmpRoot, '.claude', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, '.pipeline', 'logs'), { recursive: true });

    const savedRepo = process.env.PIPELINE_REPO_ROOT;
    const savedClaudeDir = process.env.CLAUDE_PROJECT_DIR;
    const savedWork = process.env.PIPELINE_WORKTREE;
    process.env.PIPELINE_REPO_ROOT = tmpRoot;
    process.env.CLAUDE_PROJECT_DIR = tmpRoot;
    process.env.PIPELINE_WORKTREE = tmpWork;

    try {
        delete require.cache[require.resolve('../linter')];
        const fresh = require('../linter');
        assert.equal(fresh.REPO_ROOT, tmpRoot, 'REPO_ROOT debe respetar PIPELINE_REPO_ROOT');
        assert.equal(fresh.WORK_DIR, tmpWork, 'WORK_DIR debe respetar PIPELINE_WORKTREE');
        assert.notEqual(fresh.REPO_ROOT, fresh.WORK_DIR, 'WORK_DIR ≠ REPO_ROOT cuando el agente corre en worktree');
    } finally {
        if (savedRepo === undefined) delete process.env.PIPELINE_REPO_ROOT; else process.env.PIPELINE_REPO_ROOT = savedRepo;
        if (savedClaudeDir === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = savedClaudeDir;
        if (savedWork === undefined) delete process.env.PIPELINE_WORKTREE; else process.env.PIPELINE_WORKTREE = savedWork;
        // Restaurar carga del módulo bajo el setup global del archivo
        delete require.cache[require.resolve('../linter')];
        require('../linter');
    }
});

test('módulo — sin PIPELINE_WORKTREE WORK_DIR cae a process.cwd()', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-linter-cwd-'));
    fs.mkdirSync(path.join(tmpRoot, '.claude', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, '.pipeline', 'logs'), { recursive: true });

    const savedRepo = process.env.PIPELINE_REPO_ROOT;
    const savedClaudeDir = process.env.CLAUDE_PROJECT_DIR;
    const savedWork = process.env.PIPELINE_WORKTREE;
    process.env.PIPELINE_REPO_ROOT = tmpRoot;
    process.env.CLAUDE_PROJECT_DIR = tmpRoot;
    delete process.env.PIPELINE_WORKTREE;

    try {
        delete require.cache[require.resolve('../linter')];
        const fresh = require('../linter');
        // Sin PIPELINE_WORKTREE, WORK_DIR debe usar process.cwd() (no REPO_ROOT).
        // Esto importa porque el pulpo ya hace `cwd: <worktree>` en el spawn.
        assert.equal(fresh.WORK_DIR, process.cwd(), 'WORK_DIR debe ser process.cwd() cuando no hay PIPELINE_WORKTREE');
    } finally {
        if (savedRepo === undefined) delete process.env.PIPELINE_REPO_ROOT; else process.env.PIPELINE_REPO_ROOT = savedRepo;
        if (savedClaudeDir === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = savedClaudeDir;
        if (savedWork !== undefined) process.env.PIPELINE_WORKTREE = savedWork;
        delete require.cache[require.resolve('../linter')];
        require('../linter');
    }
});
