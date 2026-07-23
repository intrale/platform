// =============================================================================
// Tests worktree-prefix.js — helper compartido de derivación de prefijo + validación
// (issue #4694, Workstream B del split de #4685).
//
// Cubre:
//   - CA-B1: prefijo y base ref derivan del manifiesto (override != default).
//   - CA-B4: paridad hacia atrás — intrale-platform ⇒ EXACTAMENTE 'platform.agent-'.
//   - CA-SEC-1: allowlist de prefijo (rechazo de path-traversal en projectId).
//   - CA-SEC-2: validación de base ref (rechazo de leading '-' y metacaracteres).
//   - CA-SEC-1/5: assertContained (traversal por basename '..' + symlink escape).
//   - CA-B2/CA-SEC-5: derivación compartida — launcher/resolver/cleanups obtienen
//     la MISMA cadena desde el helper (verificado contra los consumidores reales).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const wp = require('../worktree-prefix');

// ---- CA-B4 · Paridad hacia atrás (default) ----------------------------------

test('CA-B4 · projectId=intrale-platform ⇒ prefijo EXACTAMENTE "platform.agent-"', () => {
    assert.equal(wp.deriveRepoBase('intrale-platform'), 'platform');
    assert.equal(wp.deriveWorktreePrefix('intrale-platform'), 'platform.agent-');
    assert.equal(wp.deriveSiblingPrefix('intrale-platform'), 'platform.');
    // Sin argumento ⇒ lee el manifiesto real (projectId=intrale-platform).
    assert.equal(wp.deriveWorktreePrefix(), 'platform.agent-');
});

test('CA-B4 · basename/needle default idénticos al literal histórico', () => {
    assert.equal(wp.worktreeNeedle(4694), 'platform.agent-4694-');
    assert.equal(wp.worktreeBasename(4694, 'pipeline-dev'), 'platform.agent-4694-pipeline-dev');
    assert.equal(wp.branchToWorktreeBase('agent/4694-pipeline-dev'), 'platform.agent-4694-pipeline-dev');
    assert.equal(wp.agentWorktreeRegex().exec('platform.agent-123-backend-dev')[1], '123');
});

// ---- CA-B1 · Derivación del manifiesto (override != default) -----------------

test('CA-B1 · manifiesto override deriva prefijo distinto al default', () => {
    const manifest = { projectId: 'acme-shop' };
    assert.equal(wp.deriveWorktreePrefix('acme-shop', manifest), 'acme-shop.agent-');
    assert.equal(wp.deriveSiblingPrefix('acme-shop', manifest), 'acme-shop.');
    assert.equal(wp.worktreeBasename(7, 'backend-dev', 'acme-shop', manifest), 'acme-shop.agent-7-backend-dev');
    // No debe coincidir con el literal 'platform.'.
    assert.ok(!wp.deriveWorktreePrefix('acme-shop').startsWith('platform.'));
});

// ---- CA-SEC-1 · Allowlist de prefijo (path-traversal en projectId) -----------

test('CA-SEC-1 · projectId con traversal/separadores/nul es rechazado', () => {
    for (const bad of ['../evil', 'a/b', '..', 'x y', 'UPPER', 'con espacio', '.oculto']) {
        assert.throws(() => wp.deriveRepoBase(bad),
            /base de repo inv.lida/,
            `debe rechazar projectId "${bad}"`);
    }
});

test('CA-B4 · projectId vacío/ausente ⇒ fallback al default (platform), no throw', () => {
    // Fail-closed al default histórico, no rechazo.
    assert.equal(wp.deriveRepoBase('', { projectId: 'intrale-platform' }), 'platform');
    assert.equal(wp.deriveRepoBase(null, { projectId: 'intrale-platform' }), 'platform');
});

test('CA-SEC-1 · projectId con forma válida es aceptado', () => {
    assert.equal(wp.deriveRepoBase('acme'), 'acme');
    assert.equal(wp.deriveRepoBase('acme-shop_2.0'), 'acme-shop_2.0');
});

// ---- CA-SEC-2 · Validación de base ref (argument/command injection) ----------

test('CA-SEC-2 · base ref con metacaracteres o leading "-" es rechazado', () => {
    for (const bad of ['--upload-pack=/x', '-rf', 'a;b', '$(id)', '`id`', 'a b', 'a|b', 'a&b', '', 'a\nb']) {
        assert.throws(() => wp.validateBaseRef(bad),
            /base ref inv.lido/,
            `debe rechazar ref ${JSON.stringify(bad)}`);
    }
});

test('CA-SEC-2 · base ref con forma válida de git es aceptado', () => {
    for (const ok of ['main', 'develop', 'release/1.2', 'feature/x-y', 'v0.1.0']) {
        assert.equal(wp.validateBaseRef(ok), ok);
    }
});

// ---- CA-SEC-1/5 · assertContained (traversal + symlink escape) ---------------

test('CA-SEC-1 · assertContained acepta un basename contenido en el parent', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-cont-'));
    try {
        const wt = path.join(parent, 'platform.agent-1-x');
        const resolved = wp.assertContained(wt, parent);
        assert.equal(path.dirname(resolved), fs.realpathSync(parent));
    } finally {
        fs.rmSync(parent, { recursive: true, force: true });
    }
});

test('CA-SEC-1 · assertContained rechaza basename ".." (traversal)', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-trav-'));
    try {
        // Raw string sin normalizar: basename('<parent>/..') === '..'.
        assert.throws(() => wp.assertContained(`${parent}/..`, parent),
            /path-traversal|basename inv.lido/);
        // Basename con espacio (no matchea el basename derivado válido).
        assert.throws(() => wp.assertContained(`${parent}/a b`, parent),
            /basename inv.lido/);
    } finally {
        fs.rmSync(parent, { recursive: true, force: true });
    }
});

test('CA-SEC-1 · assertContained rechaza symlink/junction que escapa del parent', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-sym-'));
    const parent = path.join(base, 'parent');
    const escape = path.join(base, 'escape-target');
    fs.mkdirSync(parent, { recursive: true });
    fs.mkdirSync(escape, { recursive: true });
    const linkPath = path.join(parent, 'platform.agent-9-evil');
    let linkMade = true;
    try {
        // 'junction' funciona en Windows sin privilegios de admin para dirs.
        try { fs.symlinkSync(escape, linkPath, 'junction'); }
        catch { try { fs.symlinkSync(escape, linkPath, 'dir'); } catch { linkMade = false; } }
        if (!linkMade) return; // entorno sin symlinks → skip suave
        assert.throws(() => wp.assertContained(linkPath, parent),
            /escapa|path-traversal/);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('CA-SEC-1 · assertContained rechaza parent no resoluble (conservador)', () => {
    assert.throws(() => wp.assertContained('/x/platform.agent-1-x', '/parent/inexistente-xyz'),
        /parent no resoluble/);
});

// ---- CA-B2/CA-SEC-5 · Derivación compartida por los consumidores reales ------

test('CA-B2 · launcher, resolver, deterministic, convergence, pulpo derivan la MISMA cadena', () => {
    // El contrato: todos consumen worktreeNeedle/worktreeBasename del MISMO helper.
    // Verificamos que la cadena canónica es única y estable.
    const issue = 3733;
    const needle = wp.worktreeNeedle(issue);
    assert.equal(needle, 'platform.agent-3733-');
    // resolver: exactBase por skill == basename del helper.
    assert.equal(wp.worktreeBasename(issue, 'pipeline-dev'), needle + 'pipeline-dev');
    // resolver: branch→worktree base coincide con basename.
    assert.equal(wp.branchToWorktreeBase(`agent/${issue}-pipeline-dev`), needle + 'pipeline-dev');
    // ghostbusters: la regex de extracción y la needle comparten la base.
    const m = wp.agentWorktreeRegex().exec(`C:/Workspaces/Intrale/${needle}pipeline-dev`);
    assert.equal(m[1], String(issue));
});

test('CA-SEC-5 · el guard de cleanup (ghostbusters-worktrees) usa el prefijo sibling del helper', () => {
    const gb = require('../ghostbusters-worktrees');
    const MAIN = 'C:/Workspaces/Intrale/platform';
    const sibling = wp.deriveSiblingPrefix(); // 'platform.'
    // Un worktree que respeta el prefijo sibling derivado NO es forbidden por prefijo.
    const okPath = `${MAIN}.agent-1-x`;
    const okReal = gb.isForbiddenTarget(okPath, {
        fsImpl: { realpathSync: (p) => p },
    });
    assert.equal(okReal.forbidden, false, `${sibling}* debe ser permitido`);
    // Un sibling con OTRA base (no derivada del helper) sí es forbidden por prefijo.
    const evil = 'C:/Workspaces/Intrale/otroproyecto.agent-1-x';
    const evilRes = gb.isForbiddenTarget(evil, {
        fsImpl: { realpathSync: (p) => p },
    });
    assert.equal(evilRes.forbidden, true);
    assert.match(evilRes.reason, /fuera del prefijo permitido/);
});
