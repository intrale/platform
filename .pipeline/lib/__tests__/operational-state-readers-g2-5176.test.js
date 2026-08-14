'use strict';

// =============================================================================
// #5176 · grupo 2 — Migración de los lectores de allowlist / dispatch.
//
// Riesgos verificados que fija cada test:
//
//   SEC-1 — `resolveLiveSplitChildren` aplica VIGENCIA, no sólo membresía.
//           `isIssueAllowed()` responde "¿está en la allowlist?" y NO mira
//           `expires_at`: traducir el call site a membresía pura compila, pasa
//           todos los tests de pertenencia y apaga el vencimiento en silencio.
//   SEC-1b — `authorizationTtls` NO viaja en `getDispatchState()` fuera de la
//           rama `partial_pause`: con halt total el mapa de TTLs sigue siendo
//           legible por `readDispatchAllowlist()`.
//   R7    — el halt total no vacía el contenido de la allowlist observada por
//           el diff de transición de ola ni por el render de `/allowlist`.
//   A-1   — `/allowlist` deja de mentirle al operador: un `allowed_issues` no
//           vacío NO puede rendir "allowlist vacía".
//   SEC-5 — el render distingue los tres estados: ausente / vacía / halt total.
//
// node --test .pipeline/lib/__tests__/operational-state-readers-g2-5176.test.js
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const waveResolver = require('../wave-resolver');
const commanderDet = require('../commander-deterministic');

const FUTURE = '2999-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';

function mkTmp(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmrf(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function writePartial(dir, marker) {
    fs.writeFileSync(path.join(dir, '.partial-pause.json'), JSON.stringify(marker));
}

async function allowlistReply(dir) {
    const dispatcher = commanderDet.createDispatcher({
        pipelineRoot: dir,
        logsDir: path.join(dir, 'logs'),
        rateLimit: { burst: 100, ratePerMin: 600 },
    });
    const r = await dispatcher.dispatch({ text: '/allowlist', chat_id: '1' });
    assert.equal(r.status, 'ok');
    return r.reply;
}

// ─── SEC-1 · vigencia, no sólo membresía ───────────────────────────────────

test('#5176 SEC-1 · resolveLiveSplitChildren descarta el hijo VENCIDO aunque esté en la allowlist', () => {
    const dir = mkTmp('g2-ttl-');
    try {
        writePartial(dir, {
            allowed_issues: [5109, 5176, 5179],
            authorization_ttls: {
                5176: { parent: 5109, expires_at: PAST },     // autorizado pero VENCIDO
                5179: { parent: 5109, expires_at: FUTURE },
            },
        });
        // Membresía: los dos están en `allowed_issues`. Si el call site se
        // hubiese traducido a `isIssueAllowed()`, los dos saldrían listados.
        const out = waveResolver.resolveLiveSplitChildren({ pipelineRoot: dir, parentIds: [5109] });
        assert.deepEqual(out, [5179], 'el vencido no se lista: membresía Y vigencia');
    } finally { rmrf(dir); }
});

test('#5176 SEC-1 · resolveLiveSplitChildren descarta el hijo vigente que salió de la allowlist', () => {
    const dir = mkTmp('g2-membership-');
    try {
        writePartial(dir, {
            allowed_issues: [5109, 5179],                     // 5176 ya no está
            authorization_ttls: {
                5176: { parent: 5109, expires_at: FUTURE },
                5179: { parent: 5109, expires_at: FUTURE },
            },
        });
        const out = waveResolver.resolveLiveSplitChildren({ pipelineRoot: dir, parentIds: [5109] });
        assert.deepEqual(out, [5179]);
    } finally { rmrf(dir); }
});

test('#5176 SEC-1b · con halt total el mapa de TTLs sigue siendo legible', () => {
    const dir = mkTmp('g2-ttl-halt-');
    try {
        writePartial(dir, {
            allowed_issues: [5109, 5179],
            authorization_ttls: { 5179: { parent: 5109, expires_at: FUTURE } },
        });
        fs.writeFileSync(path.join(dir, '.paused'), '');

        // `getDispatchState()` en modo `paused` ni siquiera incluye
        // `authorizationTtls`: leer los TTLs desde ahí habría vaciado el
        // tablero de motivos de bloqueo durante cada halt total.
        const deps = waveResolver.resolveBlockDependencies({ pipelineRoot: dir });
        assert.deepEqual(deps[5109], [5179]);

        const live = waveResolver.resolveLiveSplitChildren({ pipelineRoot: dir, parentIds: [5109] });
        assert.deepEqual(live, [5179]);
    } finally { rmrf(dir); }
});

test('#5176 · resolveBlockDependencies degrada a {} sin marker y sin pipelineRoot', () => {
    const dir = mkTmp('g2-deps-absent-');
    try {
        assert.deepEqual(waveResolver.resolveBlockDependencies({ pipelineRoot: dir }), {});
        fs.writeFileSync(path.join(dir, '.partial-pause.json'), '{ no es json');
        assert.deepEqual(waveResolver.resolveBlockDependencies({ pipelineRoot: dir }), {});
        assert.deepEqual(waveResolver.resolveBlockDependencies({}), {});
    } finally { rmrf(dir); }
});

test('#5176 · el resolver honra pipelineRoot y no filtra el override al entorno', () => {
    const dir = mkTmp('g2-noleak-');
    const prev = process.env.PIPELINE_DIR_OVERRIDE;
    try {
        writePartial(dir, {
            allowed_issues: [5109, 5179],
            authorization_ttls: { 5179: { parent: 5109, expires_at: FUTURE } },
        });
        waveResolver.resolveLiveSplitChildren({ pipelineRoot: dir, parentIds: [5109] });
        assert.equal(process.env.PIPELINE_DIR_OVERRIDE, prev, 'el override se restaura en finally');
    } finally {
        if (prev === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
        else process.env.PIPELINE_DIR_OVERRIDE = prev;
        rmrf(dir);
    }
});

// ─── R7 · el diff de transición de ola no se vacía por halt total ──────────

test('#5176 R7 · readAllowlistSafe conserva la allowlist bajo halt total', () => {
    const dir = mkTmp('g2-transition-');
    const prev = process.env.PIPELINE_DIR_OVERRIDE;
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    try {
        delete require.cache[require.resolve('../wave-auto-transition')];
        const wat = require('../wave-auto-transition');

        writePartial(dir, { allowed_issues: [5176, 5179] });
        assert.deepEqual(wat._internal.readAllowlistSafe(), [5176, 5179]);

        // Con halt total, `getDispatchState().allowedIssues` sería `[]` y el
        // diff `prev` vs `next` registraría en el audit una remoción total
        // seguida de un alta total que nunca ocurrieron.
        fs.writeFileSync(path.join(dir, '.paused'), '');
        assert.deepEqual(wat._internal.readAllowlistSafe(), [5176, 5179]);
    } finally {
        if (prev === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
        else process.env.PIPELINE_DIR_OVERRIDE = prev;
        rmrf(dir);
    }
});

test('#5176 · readAllowlistSafe nunca lanza y degrada a [] ante ausencia o corrupción', () => {
    const dir = mkTmp('g2-transition-absent-');
    const prev = process.env.PIPELINE_DIR_OVERRIDE;
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    try {
        delete require.cache[require.resolve('../wave-auto-transition')];
        const wat = require('../wave-auto-transition');
        assert.deepEqual(wat._internal.readAllowlistSafe(), []);
        fs.writeFileSync(path.join(dir, '.partial-pause.json'), '{ roto');
        assert.deepEqual(wat._internal.readAllowlistSafe(), []);
    } finally {
        if (prev === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
        else process.env.PIPELINE_DIR_OVERRIDE = prev;
        rmrf(dir);
    }
});

// ─── A-1 / SEC-5 · render de /allowlist en los tres modos ──────────────────

test('#5176 A-1 · /allowlist con allowed_issues no vacío NO rinde "allowlist vacía"', async () => {
    const dir = mkTmp('g2-render-issues-');
    try {
        writePartial(dir, {
            allowed_issues: [5176, 5179],
            created_at: '2026-08-14T10:00:00.000Z',
        });
        const reply = await allowlistReply(dir);
        assert.ok(!/Allowlist vacía/.test(reply), `no puede decir vacía: ${reply.slice(0, 300)}`);
        assert.ok(reply.includes('5176') && reply.includes('5179'), 'lista los issues reales');
        assert.ok(/pausa parcial activa/.test(reply));
    } finally { rmrf(dir); }
});

test('#5176 SEC-5 · /allowlist modo AUSENTE: sin marker reporta "nunca"', async () => {
    const dir = mkTmp('g2-render-absent-');
    try {
        const reply = await allowlistReply(dir);
        assert.ok(/Allowlist vacía/.test(reply));
        assert.ok(/nunca/.test(reply));
        assert.ok(!/Pausa total/.test(reply));
    } finally { rmrf(dir); }
});

test('#5176 SEC-5 · /allowlist modo VACÍA: marker presente y vacío no se confunde con ausente', async () => {
    const dir = mkTmp('g2-render-empty-');
    try {
        writePartial(dir, { allowed_issues: [], created_at: '2026-08-14T10:00:00.000Z' });
        const reply = await allowlistReply(dir);
        assert.ok(/Allowlist vacía/.test(reply));
        assert.ok(!/nunca/.test(reply), 'hay marker: la última modificación es real, no "nunca"');
        assert.ok(reply.includes('2026'), 'muestra la fecha del marker');
    } finally { rmrf(dir); }
});

test('#5176 SEC-5 / R7 · /allowlist modo HALT TOTAL: lo anuncia y NO vacía la lista', async () => {
    const dir = mkTmp('g2-render-halt-');
    try {
        writePartial(dir, { allowed_issues: [5176], created_at: '2026-08-14T10:00:00.000Z' });
        fs.writeFileSync(path.join(dir, '.paused'), '');
        const reply = await allowlistReply(dir);
        assert.ok(/Pausa total/.test(reply), 'el halt total se anuncia como caso propio');
        assert.ok(reply.includes('5176'), 'el halt total NO vacía la allowlist mostrada');
        assert.ok(!/Allowlist vacía/.test(reply));
    } finally { rmrf(dir); }
});
