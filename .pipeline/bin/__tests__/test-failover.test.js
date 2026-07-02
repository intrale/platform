// =============================================================================
// test-failover.test.js — Smoke del failover reproducible (#4404 D5 · RS-4).
//
// Corre `test-failover.sh` de verdad (Git Bash) y verifica:
//   (1) los 3 casos loguean `Failover <primario> → <fallback>` con formato
//       idéntico + timestamp ISO-8601 (CA-E.3 / UX G-1..G-3);
//   (2) un crash con la credencial enmascarada dispara el trap y restaura (RS-4.2);
//   (3) la salida no contiene patrones de credencial (RS-4.4);
//   (4) el archivo canónico de secrets nunca se modifica (RS-4.1).
//
// Si `bash` no está disponible, los tests se saltan (no fallan): el script es
// Git-Bash-only por diseño y el entorno CI del pipeline lo tiene.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '..', 'test-failover.sh');
const SKILLS = ['backend-dev', 'pipeline-dev', 'android-dev'];

function bashAvailable() {
    try {
        const r = spawnSync('bash', ['--version'], { encoding: 'utf8' });
        return r.status === 0;
    } catch { return false; }
}

function runScript(extraEnv = {}) {
    return spawnSync('bash', [SCRIPT], {
        encoding: 'utf8',
        env: { ...process.env, ...extraEnv },
    });
}

const HAS_BASH = bashAvailable();
const skipOpts = HAS_BASH ? {} : { skip: 'bash no disponible en este entorno' };

// Línea canónica: `[<skill>] Failover <primario> → <fallback>  <ISO-8601>`
const FAILOVER_RE = /^\[([a-z0-9-]+)\] Failover (\S+) → (\S+)\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})$/;

test('#4404 · los 3 casos loguean Failover A → B con formato idéntico', skipOpts, () => {
    const r = runScript();
    assert.equal(r.status, 0, `script debe salir 0. stderr: ${r.stderr}`);

    const lines = r.stdout.split(/\r?\n/);
    const matches = lines.map((l) => l.match(FAILOVER_RE)).filter(Boolean);

    assert.equal(matches.length, 3, `deben loguearse 3 líneas de failover, hubo ${matches.length}`);

    const skillsSeen = matches.map((m) => m[1]);
    for (const s of SKILLS) {
        assert.ok(skillsSeen.includes(s), `falta el caso de ${s}`);
    }
    // Formato idéntico: mismo primario y mismo fallback declarado en los 3.
    for (const m of matches) {
        assert.equal(m[2], 'anthropic', 'el primario debe ser anthropic en los 3 casos');
        assert.equal(m[3], 'openai-codex', 'el fallback declarado (índice 0) es openai-codex');
    }
    // Cierre tranquilizador por caso (G-3).
    for (const s of SKILLS) {
        assert.ok(r.stdout.includes(`[${s}] ✔ primario restaurado`), `falta cierre de ${s}`);
    }
});

test('#4404 · RS-4.2: crash con credencial enmascarada dispara el trap y restaura', skipOpts, () => {
    const r = runScript({ FAILOVER_TEST_CRASH_AFTER_MASK: '1' });
    // El crash simulado sale != 0 (SIGTERM → 143), pero el trap DEBE haber corrido.
    assert.notEqual(r.status, 0, 'un crash simulado no debe salir 0');
    assert.ok(
        r.stdout.includes('[failover] trap: credenciales restauradas'),
        'el trap de restauración debe ejecutarse aún con crash mid-masking',
    );
});

test('#4404 · RS-4.4: la evidencia no contiene patrones de credencial', skipOpts, () => {
    const r = runScript();
    const secretRe = /(sk-[a-z0-9]|api[_-]?key\s*[:=]|eyJ[A-Za-z0-9_-]{6}|AKIA[0-9A-Z]{10}|nvapi-|csk_)/i;
    assert.ok(!secretRe.test(r.stdout), 'la salida no debe contener valores de credencial');
});

test('#4404 · RS-4.1: el archivo canónico de secrets nunca se modifica', skipOpts, () => {
    const canonical = path.join(os.homedir(), '.claude', 'secrets', 'credentials.json');
    let before = null;
    try {
        const s = fs.statSync(canonical);
        before = { size: s.size, mtimeMs: s.mtimeMs };
    } catch {
        // No existe en este entorno → el script tampoco lo toca; nada que comparar.
        return;
    }
    runScript();
    const after = fs.statSync(canonical);
    assert.equal(after.size, before.size, 'el tamaño del archivo canónico no debe cambiar');
    assert.equal(after.mtimeMs, before.mtimeMs, 'el mtime del archivo canónico no debe cambiar');
});
