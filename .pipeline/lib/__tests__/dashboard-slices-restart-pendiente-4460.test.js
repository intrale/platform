'use strict';

// Tests del restartPendienteSlice (#4460).
// node --test .pipeline/lib/__tests__/dashboard-slices-restart-pendiente-4460.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const slices = require('../dashboard-slices');
const runtimeBoot = require('../runtime-boot');
const drift = require('../operativo-drift');

// pipelineDir temporal que hace de "PIPELINE" para el marker.
function tmpPipelineDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'slice-restart-'));
}

// Repo git PRIVADO y desechable para el test de "sin drift real" (CA-2).
// #4448 (rebote rev-2): el intento previo usaba el repo real del proyecto con
// bootSha=origin/main + skipFetch. Seguía siendo flaky porque `origin/main` es
// un ref COMPARTIDO: `node --test` corre los archivos en procesos concurrentes
// y el pipeline vivo (dashboard/pulpo) fetchea `origin/main` cada ~45s. Un fetch
// externo AVANZA el ref entre el `rev-parse` (bootSha) y el `git log` interno →
// el rango bootSha..origin/main deja de estar vacío y aparece drift espurio
// (p.ej. #4479 "tocó dashboard"). skipFetch sólo silencia el fetch PROPIO del
// test, no los concurrentes. Con un repo privado en tmp, nadie más toca su
// `origin/main` → el rango es provablemente vacío, hermético de verdad.
function tmpGitRepo() {
    const cp = require('node:child_process');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-repo-'));
    const g = (args) => cp.execFileSync('git', args, {
        cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15000,
    });
    g(['init', '-q']);
    g(['config', 'user.email', 'test@intrale.local']);
    g(['config', 'user.name', 'Test']);
    g(['config', 'commit.gpgsign', 'false']);
    g(['config', 'core.autocrlf', 'false']); // evita el warning CRLF en Windows
    fs.writeFileSync(path.join(root, 'app-file.txt'), 'solo producto\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'commit inicial (solo producto)']);
    // Branch determinístico (algunos git default a `master`).
    g(['branch', '-M', 'main']);
    const head = g(['rev-parse', 'HEAD']).trim();
    // Simulamos el remote-tracking ref SIN red: origin/main == HEAD. Al no haber
    // remoto real, ningún proceso lo mueve → hermético.
    g(['update-ref', 'refs/remotes/origin/main', head]);
    return { root, head };
}

test('_sanitizeRestartItem: no propaga paths ni SHAs, recorta longitudes', () => {
    const out = slices._sanitizeRestartItem({
        issue: 4460,
        componente: '../../etc/passwd dashboard',
        motivo: 'tocó dashboard ' + 'x'.repeat(500),
    });
    assert.strictEqual(out.issue, 4460);
    assert.ok(!out.componente.includes('/'), 'componente sin slashes');
    assert.ok(out.componente.length <= 40);
    assert.ok(out.motivo.length <= 120);
});

test('_sanitizeRestartItem: issue no-entero → null', () => {
    assert.strictEqual(slices._sanitizeRestartItem({ issue: 'x', componente: 'a', motivo: 'b' }).issue, null);
    assert.strictEqual(slices._sanitizeRestartItem({ issue: -3, componente: 'a', motivo: 'b' }).issue, null);
    assert.strictEqual(slices._sanitizeRestartItem(null), null);
});

test('_sanitizeRestartItem: componente vacío tras saneo → "pipeline"', () => {
    const out = slices._sanitizeRestartItem({ issue: 1, componente: '/////', motivo: '' });
    assert.strictEqual(out.componente, 'pipeline');
});

test('restartPendienteSlice: marker ausente → unknown:true (CA-8), nunca "sin pendientes"', () => {
    const dir = tmpPipelineDir();
    const res = slices.restartPendienteSlice({}, { PIPELINE: dir, ROOT: dir });
    assert.strictEqual(res.unknown, true);
    assert.deepStrictEqual(res.items, []);
});

test('restartPendienteSlice: marker corrupto → unknown:true', () => {
    const dir = tmpPipelineDir();
    fs.writeFileSync(path.join(dir, 'runtime-boot.json'), '{ corrupto');
    const res = slices.restartPendienteSlice({}, { PIPELINE: dir, ROOT: dir });
    assert.strictEqual(res.unknown, true);
});

test('restartPendienteSlice: marker con sha hex inalcanzable → unknown:true (no miente)', () => {
    drift._clearCache();
    const dir = tmpPipelineDir();
    // marker válido (hex) pero el repoRoot real no conoce ese sha → git falla →
    // detectPendingRestart devuelve unknown:true → el slice lo propaga.
    runtimeBoot.writeBootMarker('abcdef1234567890abcdef1234567890abcdef12', { pipelineDir: dir });
    const res = slices.restartPendienteSlice({}, { PIPELINE: dir, ROOT: dir });
    assert.strictEqual(res.unknown, true);
    assert.deepStrictEqual(res.items, []);
});

test('restartPendienteSlice: sin drift real (bootSHA=origin/main en repo privado) → items:[] + unknown:false (CA-2)', () => {
    drift._clearCache();
    const dir = tmpPipelineDir();
    // Repo git PRIVADO en tmp con origin/main == HEAD. Ningún otro proceso lo
    // toca → el rango bootSha..origin/main es provablemente vacío, sin depender
    // del `origin/main` compartido del repo real (que el pipeline vivo fetchea
    // en paralelo y volvía el test flaky con drift espurio, #4448 rebote rev-1).
    let repo;
    try {
        repo = tmpGitRepo();
    } catch {
        // git no disponible en este entorno → el test de rango vacío no aplica.
        return;
    }
    runtimeBoot.writeBootMarker(repo.head, { pipelineDir: dir });
    // skipFetch:true — el repo privado no tiene remoto real; evitamos un fetch
    // inútil (fallaría best-effort igual, pero mejor no gastarlo).
    const res = slices.restartPendienteSlice({}, { PIPELINE: dir, ROOT: repo.root, skipFetch: true });
    // bootSHA == origin/main → rango vacío → sin drift, botón NO se renderiza.
    assert.strictEqual(res.unknown, false);
    assert.deepStrictEqual(res.items, []);
});
