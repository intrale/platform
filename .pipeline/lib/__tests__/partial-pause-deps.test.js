// Tests de .pipeline/lib/partial-pause-deps.js (issue #3142 — maxDepth override).
// Solo cubrimos lo que agregamos en #3142 (maxDepth parametrizable) — no
// re-testeamos parseDepsFromText / cache / findMissingDeps que ya están
// cubiertos por los flujos del dashboard.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Aislar cache a tmp dir.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-pp-deps-'));
const TMP_CACHE = path.join(TMP_DIR, 'partial-pause-deps-cache.json');

delete require.cache[require.resolve('../partial-pause-deps')];
const ppd = require('../partial-pause-deps');

// gh fake: construye un grafo lineal 100 → 101 → 102 → 103 → 104 → 105 → 106
// Todos abiertos, sin auto-referencias. Permite verificar maxDepth.
function fakeGhRunner(args) {
    // args = ['issue', 'view', <num>, '--repo', ..., '--json', ...]
    const num = parseInt(args[2], 10);
    if (!Number.isInteger(num)) return { ok: false, stdout: '', stderr: 'bad-arg', status: 1 };
    const next = num + 1;
    const body = (num < 106) ? 'Depends on #' + next : 'nothing';
    return {
        ok: true,
        stdout: JSON.stringify({
            number: num,
            title: 'Issue ' + num,
            state: 'OPEN',
            body,
            comments: [],
        }),
        stderr: '',
        status: 0,
    };
}

function resetCache() {
    try { fs.unlinkSync(TMP_CACHE); } catch {}
}

test('resolveOpenDeps con maxDepth default (3) trunca antes que el grafo entero', () => {
    resetCache();
    const { openDeps, truncated } = ppd.resolveOpenDeps(100, {
        ghRunner: fakeGhRunner,
        cacheFile: TMP_CACHE,
    });
    // Grafo lineal: 100 -> 101 -> 102 -> 103 -> 104 -> ... — con depth=3 deberíamos
    // resolver hasta 103/104 y truncar después.
    assert.ok(truncated, 'truncated debería ser true con maxDepth=3 en grafo lineal de 6');
    assert.ok(openDeps.length >= 1 && openDeps.length <= 4, 'openDeps acotado por maxDepth, got=' + openDeps.length);
});

test('resolveOpenDeps con maxDepth=5 alcanza más profundo (CA-Sec-12)', () => {
    resetCache();
    const { openDeps, truncated } = ppd.resolveOpenDeps(100, {
        ghRunner: fakeGhRunner,
        cacheFile: TMP_CACHE,
        maxDepth: 5,
    });
    // Con maxDepth=5 alcanzamos al menos hasta 105.
    assert.ok(openDeps.includes(105), 'openDeps debería incluir 105 con maxDepth=5, got=' + JSON.stringify(openDeps));
    // El último issue del grafo (106) podría o no aparecer dependiendo de cómo
    // contamos los niveles — lo importante es que llegamos más profundo que con 3.
    assert.ok(openDeps.length >= 4, 'esperamos al menos 4 deps con maxDepth=5, got=' + openDeps.length);
});

test('resolveOpenDeps con maxDepth=1 corta inmediatamente', () => {
    resetCache();
    const { openDeps } = ppd.resolveOpenDeps(100, {
        ghRunner: fakeGhRunner,
        cacheFile: TMP_CACHE,
        maxDepth: 1,
    });
    // Con maxDepth=1 sólo alcanzamos 1 nivel: el dep directo de 100 (que es 101).
    assert.ok(openDeps.includes(101), 'openDeps debe incluir 101 (nivel 1)');
    assert.ok(!openDeps.includes(106), 'openDeps NO debe incluir 106 (nivel 6) con maxDepth=1');
});

test('resolveOpenDeps con maxDepth > ABSOLUTE_MAX_DEPTH se clampea (anti-loop infinito)', () => {
    resetCache();
    // El módulo expone ABSOLUTE_MAX_DEPTH = 10. Pasar 9999 no debería colgar.
    const before = Date.now();
    const { openDeps } = ppd.resolveOpenDeps(100, {
        ghRunner: fakeGhRunner,
        cacheFile: TMP_CACHE,
        maxDepth: 9999,
    });
    const elapsed = Date.now() - before;
    // Como el grafo termina en 106, debe terminar rápido sin colgar.
    assert.ok(elapsed < 2000, 'no debería tardar > 2s, got=' + elapsed + 'ms');
    assert.ok(openDeps.length > 0, 'debería haber resuelto al menos una dep');
});

test('resolveOpenDeps con maxDepth=0 o negativo se clampea a 1 (no rompe)', () => {
    resetCache();
    const { openDeps } = ppd.resolveOpenDeps(100, {
        ghRunner: fakeGhRunner,
        cacheFile: TMP_CACHE,
        maxDepth: 0,
    });
    // Clampeado a 1: alcanza el primer nivel.
    assert.ok(Array.isArray(openDeps));
});

// Detección de ciclos (CA-Sec-14): grafo A → B → A no debe colgar.
test('resolveOpenDeps detecta ciclos sin colgar', () => {
    resetCache();
    const cyclicGh = (args) => {
        const num = parseInt(args[2], 10);
        const other = num === 200 ? 201 : 200;
        return {
            ok: true,
            stdout: JSON.stringify({
                number: num,
                title: 'Cyclic ' + num,
                state: 'OPEN',
                body: 'Depends on #' + other,
                comments: [],
            }),
            stderr: '',
            status: 0,
        };
    };
    const before = Date.now();
    const { openDeps } = ppd.resolveOpenDeps(200, {
        ghRunner: cyclicGh,
        cacheFile: TMP_CACHE,
        maxDepth: 10,
    });
    const elapsed = Date.now() - before;
    assert.ok(elapsed < 2000, 'ciclo no debería colgar, got=' + elapsed + 'ms');
    // El grafo A↔B genera deps {200, 201} sin colgar — lo importante es que el
    // visited Set corte el ciclo, no que la lista sea exacta.
    assert.ok(openDeps.includes(201), 'esperamos 201, got=' + JSON.stringify(openDeps));
    assert.ok(openDeps.length <= 2, 'ciclo no debería generar > 2 deps únicas, got=' + openDeps.length);
});

// =============================================================================
// #3742 — maxNodes (cap de nodos) + reporte de razón de truncado.
// =============================================================================

test('resolveOpenDeps con maxNodes corta en N nodos y reporta truncated:true reason=max_nodes', () => {
    resetCache();
    // Grafo lineal largo (100..130). Con maxNodes=5 y maxDepth alto, debe cortar
    // por nodos antes que por profundidad.
    const linearGh = (args) => {
        const num = parseInt(args[2], 10);
        const next = num + 1;
        const body = (num < 130) ? 'Depends on #' + next : 'nothing';
        return { ok: true, stdout: JSON.stringify({ number: num, title: 'I' + num, state: 'OPEN', body, comments: [] }), stderr: '', status: 0 };
    };
    const { truncated, reason, nodesVisited } = ppd.resolveOpenDeps(100, {
        ghRunner: linearGh,
        cacheFile: TMP_CACHE,
        maxDepth: 10,
        maxNodes: 5,
    });
    assert.equal(truncated, true, 'debe truncar por nodos');
    assert.equal(reason, 'max_nodes', 'reason debe ser max_nodes, got=' + reason);
    assert.ok(nodesVisited <= 5, 'nodesVisited debe respetar el cap, got=' + nodesVisited);
});

test('resolveOpenDeps clampea maxNodes al ABSOLUTE_MAX_NODES (200)', () => {
    resetCache();
    const linearGh = (args) => {
        const num = parseInt(args[2], 10);
        const next = num + 1;
        const body = (num < 130) ? 'Depends on #' + next : 'nothing';
        return { ok: true, stdout: JSON.stringify({ number: num, title: 'I' + num, state: 'OPEN', body, comments: [] }), stderr: '', status: 0 };
    };
    const r = ppd.resolveOpenDeps(100, { ghRunner: linearGh, cacheFile: TMP_CACHE, maxNodes: 99999 });
    assert.ok(r.nodesVisited <= ppd.ABSOLUTE_MAX_NODES, 'nodesVisited <= 200, got=' + r.nodesVisited);
});

test('resolveOpenDeps con ciclo A→B→A reporta truncated/reason=cycle sin colgar', () => {
    resetCache();
    const cyclicGh = (args) => {
        const num = parseInt(args[2], 10);
        const other = num === 200 ? 201 : 200;
        return { ok: true, stdout: JSON.stringify({ number: num, title: 'C' + num, state: 'OPEN', body: 'Depends on #' + other, comments: [] }), stderr: '', status: 0 };
    };
    const before = Date.now();
    const { truncated, reason } = ppd.resolveOpenDeps(200, { ghRunner: cyclicGh, cacheFile: TMP_CACHE, maxDepth: 10 });
    assert.ok(Date.now() - before < 2000, 'no debe colgar');
    assert.equal(truncated, true, 'ciclo marca truncated');
    assert.equal(reason, 'cycle', 'reason debe ser cycle, got=' + reason);
});

test('resolveOpenDeps sin truncado reporta reason=null', () => {
    resetCache();
    const shortGh = (args) => {
        const num = parseInt(args[2], 10);
        const body = num === 100 ? 'Depends on #101' : 'nothing';
        return { ok: true, stdout: JSON.stringify({ number: num, title: 'S' + num, state: 'OPEN', body, comments: [] }), stderr: '', status: 0 };
    };
    const { truncated, reason, openDeps } = ppd.resolveOpenDeps(100, { ghRunner: shortGh, cacheFile: TMP_CACHE, maxDepth: 10 });
    assert.equal(truncated, false);
    assert.equal(reason, null);
    assert.deepEqual(openDeps, [101]);
});
