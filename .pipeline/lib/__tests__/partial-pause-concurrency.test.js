// =============================================================================
// partial-pause-concurrency.test.js — Tests de concurrencia con N workers
// sobre .partial-pause.json. Issue #3518 CA-8.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');

const WORKER_SCRIPT = path.join(__dirname, 'fixtures', 'partial-pause-concurrency-worker.js');

function setupTmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-conc-test-'));
}

function rmrf(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function forkWorker(dir, issuesCsv, id) {
    return new Promise((resolve) => {
        const env = {
            ...process.env,
            PIPELINE_DIR_OVERRIDE: dir,
            WORKER_ISSUES_CSV: issuesCsv,
            WORKER_ID: id,
        };
        const child = fork(WORKER_SCRIPT, [], {
            env,
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        let stderr = '';
        child.stderr.on('data', (c) => { stderr += c.toString(); });
        child.on('exit', (code) => resolve({ code, stderr, id }));
    });
}

test('CA-8: 10 workers escriben distintas allowlists — JSON final válido + sin tmp/lock residual', async () => {
    const dir = setupTmp();
    try {
        const N = 10;
        const promises = [];
        for (let i = 0; i < N; i++) {
            // Cada worker setea una lista única.
            const csv = `${1000 + i},${2000 + i}`;
            promises.push(forkWorker(dir, csv, `w${i}`));
        }
        const results = await Promise.all(promises);

        // Al menos un worker debe haber tenido éxito (escribió el archivo final).
        const successful = results.filter((r) => r.code === 0).length;
        assert.ok(successful >= 1, `expected at least 1 successful, got ${successful}`);

        // El archivo final debe ser JSON válido (no truncado).
        const partialPath = path.join(dir, '.partial-pause.json');
        assert.equal(fs.existsSync(partialPath), true);
        const raw = fs.readFileSync(partialPath, 'utf8');
        let parsed;
        assert.doesNotThrow(() => { parsed = JSON.parse(raw); }, 'JSON parseable');
        assert.ok(Array.isArray(parsed.allowed_issues));
        assert.equal(parsed.allowed_issues.length, 2, 'allowlist tiene exactamente los 2 issues del último write');

        // Sin tmp/lock residual.
        assert.equal(fs.existsSync(partialPath + '.tmp'), false, 'tmp residual');
        assert.equal(fs.existsSync(partialPath + '.lock'), false, 'lock residual');
    } finally { rmrf(dir); }
});

test('CA-8: workers concurrentes con misma allowlist — todos producen el mismo resultado', async () => {
    const dir = setupTmp();
    try {
        const N = 8;
        const promises = [];
        for (let i = 0; i < N; i++) {
            promises.push(forkWorker(dir, '100,200,300', `w${i}`));
        }
        const results = await Promise.all(promises);
        // Todos deben haber tenido éxito (no hay conflict semántico).
        for (const r of results) {
            assert.equal(r.code, 0, `worker ${r.id} falló: ${r.stderr}`);
        }
        const partial = JSON.parse(fs.readFileSync(path.join(dir, '.partial-pause.json'), 'utf8'));
        assert.deepEqual(partial.allowed_issues.sort((a, b) => a - b), [100, 200, 300]);
    } finally { rmrf(dir); }
});
