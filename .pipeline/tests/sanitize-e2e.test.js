// =============================================================================
// sanitize-e2e.test.js — Test E2E de integridad (#2334 / CA1 final)
//
// Fixture: inyecta secretos realistas vía `process.env` en sub-ejecución, no
// hardcoded. La sub-ejecución:
//   1) Lee secretos desde env (como haría un agente real que lee config).
//   2) Los loggea por varios paths del pipeline que existen en producción:
//      - `console.log` post-install de `sanitize-console`
//      - writer de `createLogFileWriter` (agent log sanitizado)
//      - crash handler con `sanitize()` directo
//      - `sanitizeTelegramPayload` → buffer de body
//      - `sanitizeGithubPayload` → buffer de body
//      - `sanitizeDrivePayload` → buffer de args
//   3) Escribe todo a un directorio `PIPELINE_STATE_DIR/logs/` y `reports/`.
//
// Al terminar, el test corre el grep del CA1:
//   grep -rE '(AKIA|ghp_|eyJ|AIza|1//0)' <dir>   → 0 matches
// y `toString` de los mensajes/comentarios inspecciona que los placeholders
// estén visibles.
// =============================================================================
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PIPELINE = path.resolve(__dirname, '..');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
async function runAll() {
    let passed = 0; let failed = 0;
    for (const t of tests) {
        try {
            await t.fn();
            passed++;
            console.log(`  ✓ ${t.name}`);
        } catch (e) {
            failed++;
            console.log(`  ✗ ${t.name}`);
            console.log(`     ${e && e.stack || e.message}`);
        }
    }
    console.log(`\n${passed} passed, ${failed} failed (${tests.length} total)`);
    if (failed > 0) process.exit(1);
}

// ---------------------------------------------------------------------------
// Búsqueda recursiva por patrones (equivalente al `grep -rE` del CA1)
// ---------------------------------------------------------------------------
function* walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* walk(p);
        else yield p;
    }
}

const CA1_PATTERNS = /(AKIA|ghp_|eyJ|AIza|1\/\/0)/;

function scanDirForSecrets(dir) {
    const hits = [];
    for (const file of walk(dir)) {
        let content;
        try { content = fs.readFileSync(file, 'utf8'); }
        catch { continue; } // binary / unreadable → skip
        const m = content.match(CA1_PATTERNS);
        if (m) {
            // captura línea(s) completas donde matchea
            const lines = content.split(/\r?\n/).filter(l => CA1_PATTERNS.test(l));
            hits.push({ file, match: m[0], lines });
        }
    }
    return hits;
}

// =============================================================================
// Caso principal: secretos por env → múltiples paths de write → 0 matches
// =============================================================================

test('E2E: secretos inyectados por env no quedan en logs/reports', async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'san-e2e-'));
    const logsDir = path.join(sandbox, 'logs');
    const reportsDir = path.join(sandbox, 'reports');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(reportsDir, { recursive: true });

    // Secretos realistas (inyectados por env, no hardcoded en el script).
    const env = {
        TEST_AWS: 'AKIAIOSFODNN7EXAMPLE',
        TEST_GH: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaXX',
        TEST_JWT: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc123_xyz',
        TEST_GOOGLE: 'AIzaSyA-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        TEST_GOOGLE_REFRESH: '1//0gAbcdefghijklmnopqrstuvwxyz_-AAAABBBBCCCCDDDDE',
        TEST_SANDBOX: sandbox,
    };

    const fixturePath = path.join(PIPELINE, 'tests', '__fixtures__', 'e2e-emit-secrets.js');
    assert.ok(fs.existsSync(fixturePath), `fixture missing: ${fixturePath}`);

    const res = spawnSync(process.execPath, [fixturePath], {
        encoding: 'utf8',
        timeout: 30000,
        windowsHide: true,
        env: { ...process.env, ...env },
    });

    if (res.status !== 0) {
        throw new Error(`fixture exit ${res.status}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    }

    // También capturamos stdout del proceso a un archivo del sandbox: simula
    // el fd inheritance de pulpo.
    fs.writeFileSync(path.join(logsDir, 'fixture-stdout.log'), res.stdout);
    fs.writeFileSync(path.join(logsDir, 'fixture-stderr.log'), res.stderr);

    // --- Assertions CA1: 0 matches de patrones crudos ---
    const hits = scanDirForSecrets(sandbox);
    if (hits.length > 0) {
        const detail = hits.map(h => `  ${h.file}: matched ${h.match}\n    ${h.lines.slice(0, 2).join('\n    ')}`).join('\n');
        throw new Error(`CA1 falló: ${hits.length} file(s) con secreto crudo:\n${detail}`);
    }

    // --- Assertions visuales: placeholders sí presentes ---
    const allContent = [...walk(sandbox)]
        .map(f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } })
        .join('\n');
    assert.ok(allContent.includes('[REDACTED:AWS_ACCESS_KEY]'), 'placeholder AWS no visible');
    assert.ok(allContent.includes('[REDACTED:JWT]'), 'placeholder JWT no visible');
    assert.ok(allContent.includes('[REDACTED:GITHUB_TOKEN]'), 'placeholder GitHub no visible');
});

runAll();
