// =============================================================================
// wave-desync-realign.test.js — Regresión del incidente 2026-07-01 (#4350).
//
// Escenario: la ola activa declara #4255/#4300, pero la allowlist quedó
// apuntando SOLO a #4030 (cerrado). El pipeline quedó congelado porque el único
// habilitado era un issue cerrado/inexistente como pendiente.
//
// Estos tests cubren el CAMINO DE REALINEACIÓN a nivel de módulos (la función
// `realignAllowlistToActiveWave` vive embebida en pulpo.js, que monta el daemon
// al cargar; igual que planner-sizing-allowlist-promote.test.js combinamos un
// test estructural del source con tests de comportamiento que replican la misma
// composición de módulos que ejecuta el wire-up).
//
// Ejecutar: node --test .pipeline/lib/__tests__/wave-desync-realign.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const PULPO_SRC = fs.readFileSync(path.join(REPO_ROOT, '.pipeline', 'pulpo.js'), 'utf8');

function setupTmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desync-realign-'));
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    for (const m of ['../desync-detector', '../waves', '../partial-pause', '../allowlist-recursive-promote', '../notify-telegram']) {
        try { delete require.cache[require.resolve(m)]; } catch {}
    }
    const desync = require('../desync-detector');
    const waves = require('../waves');
    const partialPause = require('../partial-pause');
    const recursivePromote = require('../allowlist-recursive-promote');
    waves.invalidateCache();
    return { dir, desync, waves, partialPause, recursivePromote };
}

function teardownTmp(dir) {
    delete process.env.PIPELINE_DIR_OVERRIDE;
    delete process.env.PARTIAL_PAUSE_STRICT_AUTH;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function seedWaves(dir, { activeIssues, dependencies = [] }) {
    fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify({
        version: '1.0',
        meta: { updated_at: '2026-07-01T00:00:00.000Z', updated_by: 't', source: 't' },
        active_wave: { number: 82, name: 'Ola 8.2', issues: activeIssues },
        planned_waves: [],
        archived_waves: [],
        dependencies,
    }, null, 2));
}

function seedPartial(dir, allowed) {
    fs.writeFileSync(path.join(dir, '.partial-pause.json'), JSON.stringify({
        allowed_issues: allowed,
        created_at: '2026-07-01T00:00:00.000Z',
        source: 'test-seed',
    }, null, 2));
}

// Réplica EXACTA de la composición que ejecuta pulpo.realignAllowlistToActiveWave.
function realign({ waves, partialPause, recursivePromote, desyncResult, isClosed }) {
    const active = waves.getActiveWave();
    if (!active || !Array.isArray(active.issues)) return { ok: false, reason: 'no_active_wave' };
    const seed = active.issues
        .filter((i) => i && i.status !== 'completed')
        .map((i) => Number(i.number))
        .filter((n) => Number.isInteger(n) && n > 0);
    const getDeps = (n) => { try { return waves.getBlockingIssues(n); } catch { return []; } };
    const expanded = recursivePromote.expandRecursiveOpenIssues({ seedIssues: seed, isClosed, getDeps });
    if (expanded.length === 0) return { ok: false, reason: 'empty_expansion' };
    const res = partialPause.setPartialPause(expanded, {
        source: 'wave-promote:realign',
        authorizedBy: 'wave-promote',
        justification: `Realineación reductiva a ola ${active.number} (#4350). ` +
            `extras_removidos=${JSON.stringify(desyncResult.added)} faltantes_repuestos=${JSON.stringify(desyncResult.removed)}`,
    });
    if (res && res.rejected) return { ok: false, reason: 'gate_rejected' };
    return { ok: true, allowlist: expanded };
}

// ─── Test estructural del wire-up en pulpo.js ──────────────────────────────

test('#4350 estructural: pulpo.js tiene realignAllowlistToActiveWave + evaluación boot/periódica', () => {
    assert.match(PULPO_SRC, /function realignAllowlistToActiveWave\(/);
    assert.match(PULPO_SRC, /function evaluateDesyncAndMaybeRealign\(/);
    assert.match(PULPO_SRC, /evaluateDesyncAndMaybeRealign\('boot'\)/);
    assert.match(PULPO_SRC, /evaluateDesyncAndMaybeRealign\('periodic'\)/);
    // Usa el gate auditado con authorizedBy wave-promote.
    assert.match(PULPO_SRC, /authorizedBy:\s*'wave-promote'/);
    // Realinea SOLO si es reductivo.
    assert.match(PULPO_SRC, /resoluble_reductivo/);
});

// ─── Regresión de comportamiento ───────────────────────────────────────────

test('#4350 regresión 2026-07-01: ola #4255/#4300 + allowlist #4030(cerrado) → realinea, pipeline NO congelado', () => {
    const { dir, desync, waves, partialPause, recursivePromote } = setupTmp();
    process.env.PARTIAL_PAUSE_STRICT_AUTH = '1'; // gate estricto: prueba que wave-promote sí puede remover
    try {
        seedWaves(dir, { activeIssues: [{ number: 4255 }, { number: 4300 }] });
        seedPartial(dir, [4030]);
        const isClosed = (n) => (n === 4030 ? true : false);

        // 1. Clasificación: reductivo (el único extra 4030 está cerrado).
        const d = desync.detectDesync({ skipFlag: true, skipAlert: true, isClosed });
        assert.equal(d.desync, true);
        assert.equal(d.classification, 'resoluble_reductivo');

        // 2. Realineación reductiva.
        const r = realign({ waves, partialPause, recursivePromote, desyncResult: d, isClosed });
        assert.equal(r.ok, true);
        assert.deepEqual(r.allowlist, [4255, 4300]);

        // 3. La allowlist en disco = ola activa, sin el cerrado. Pipeline vivo.
        const partial = JSON.parse(fs.readFileSync(path.join(dir, '.partial-pause.json'), 'utf8'));
        assert.deepEqual(partial.allowed_issues.sort((a, b) => a - b), [4255, 4300]);
        assert.equal(partial.allowed_issues.includes(4030), false);
        assert.ok(partial.allowed_issues.length > 0, 'allowlist no debe quedar vacía (pipeline no congelado)');

        // 4. Post-realineo NO hay desync.
        const d2 = desync.detectDesync({ skipFlag: true, skipAlert: true, isClosed });
        assert.equal(d2.desync, false);
    } finally { teardownTmp(dir); }
});

test('#4350 realineo incluye deps recursivos abiertos de la ola', () => {
    const { dir, desync, waves, partialPause, recursivePromote } = setupTmp();
    try {
        // 4255 bloqueado por 4200 (abierto). El realineo debe habilitar 4200 también.
        seedWaves(dir, {
            activeIssues: [{ number: 4255 }, { number: 4300 }],
            dependencies: [{ blocked: 4255, blocker: 4200 }],
        });
        seedPartial(dir, [4030]);
        const isClosed = (n) => (n === 4030 ? true : false);
        const d = desync.detectDesync({ skipFlag: true, skipAlert: true, isClosed });
        assert.equal(d.classification, 'resoluble_reductivo');
        const r = realign({ waves, partialPause, recursivePromote, desyncResult: d, isClosed });
        assert.deepEqual(r.allowlist, [4200, 4255, 4300]);
    } finally { teardownTmp(dir); }
});

test('#4350 ambiguo (issue abierto ajeno) NO se realinea', () => {
    const { dir, desync } = setupTmp();
    try {
        seedWaves(dir, { activeIssues: [{ number: 4255 }, { number: 4300 }] });
        seedPartial(dir, [9999]); // abierto y ajeno a la ola
        const isClosed = (n) => false;
        const d = desync.detectDesync({ skipFlag: true, skipAlert: true, isClosed });
        assert.equal(d.desync, true);
        assert.equal(d.classification, 'ambiguo');
        // El pulpo NO invoca realign en ambiguo → la allowlist queda intacta,
        // se instala human-block (verificado por el camino ambiguo del detector).
    } finally { teardownTmp(dir); }
});

test('#4350 fail-safe SEC-4: extra con estado INDETERMINADO → ambiguo, no se realinea', () => {
    const { dir, desync } = setupTmp();
    try {
        seedWaves(dir, { activeIssues: [{ number: 4255 }] });
        seedPartial(dir, [4030]);
        const isClosed = (n) => undefined; // GitHub caído / cache sin resolver
        const d = desync.detectDesync({ skipFlag: true, skipAlert: true, isClosed });
        assert.equal(d.desync, true);
        assert.equal(d.classification, 'ambiguo', 'indeterminado no debe habilitar remoción a ciegas');
    } finally { teardownTmp(dir); }
});
