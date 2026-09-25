// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';
// #7631 — Rollout fail-closed del gate `authorship` (CA-6 / S8) + evaluador
// completo (`evaluateAuthorship`) + copy de UX.

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const R = require('../authorship/rollout');
const { evaluateAuthorship } = require('../authorship');
const copy = require('../authorship/copy');
const { appendChained } = require('../audit-log');
const HD = require('../authorship/human-direction');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'authorship-ro-'));
after(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} });
let seq = 0;
const tmp = (name) => path.join(tmpRoot, `${++seq}-${name}`);

const cfg = (authorship) => ({ authorship });

// ── resolveAuthorshipMode ──────────────────────────────────────────────────

test('bloque ausente, gate_mode foo o tipos inválidos → dry-run sin marcador y enforce con marcador', () => {
    const invalidos = [
        null, {}, cfg(undefined), cfg('x'), cfg([]),
        cfg({ enabled: true, gate_mode: 'foo' }),
        cfg({ enabled: true, gate_mode: 3 }),
        cfg({ enabled: 'si', gate_mode: 'dry-run' }),
        cfg({ enabled: true, gate_mode: 'dry-run', go_live_date: 5 }),
        cfg({ enabled: true, gate_mode: 'OFF' }),
    ];
    for (const c of invalidos) {
        assert.strictEqual(R.resolveAuthorshipMode(c).mode, 'dry-run', JSON.stringify(c));
        assert.strictEqual(R.resolveAuthorshipMode(c, { enforceSeen: true }).mode, 'enforce', JSON.stringify(c));
    }
});

test('off sólo si está escrito literal; enabled:false no apaga', () => {
    assert.strictEqual(R.resolveAuthorshipMode(cfg({ enabled: true, gate_mode: 'off' })).mode, 'off');
    const r = R.resolveAuthorshipMode(cfg({ enabled: false, gate_mode: 'dry-run' }));
    assert.strictEqual(r.mode, 'dry-run');
    assert.ok(r.warnings.some((w) => /enabled=false/.test(w)));
    assert.strictEqual(R.resolveAuthorshipMode(cfg({ enabled: false, gate_mode: 'enforce' })).mode, 'enforce');
});

test('PR anterior a go_live_date → grandfathered; posterior, sin fecha o ilegible → se evalúa', () => {
    const c = cfg({ enabled: true, gate_mode: 'enforce', go_live_date: '2026-09-23T00:00:00Z' });
    assert.strictEqual(R.resolveAuthorshipMode(c, { prCreatedAt: '2026-09-01T00:00:00Z' }).grandfathered, true);
    assert.strictEqual(R.resolveAuthorshipMode(c, { prCreatedAt: '2026-09-24T00:00:00Z' }).grandfathered, false);
    assert.strictEqual(R.resolveAuthorshipMode(c, { prCreatedAt: null }).grandfathered, false);
    assert.strictEqual(R.resolveAuthorshipMode(c, { prCreatedAt: 'basura' }).grandfathered, false);
    const bad = R.resolveAuthorshipMode(cfg({ enabled: true, gate_mode: 'enforce', go_live_date: 'no-fecha' }), { prCreatedAt: '2020-01-01T00:00:00Z' });
    assert.strictEqual(bad.grandfathered, false);
    assert.ok(bad.warnings.length);
    assert.strictEqual(R.resolveAuthorshipMode(cfg({ enabled: true, gate_mode: 'dry-run', go_live_date: null })).mode, 'dry-run');
});

test('marcador enforce-seen: se escribe una vez y leer con error se trata como visto', () => {
    const m = tmp('marker');
    assert.strictEqual(R.readEnforceSeen(m), false);
    assert.strictEqual(R.markEnforceSeen(m), true);
    assert.strictEqual(R.readEnforceSeen(m), true);
    assert.strictEqual(R.markEnforceSeen(m), true);
    assert.strictEqual(R.readEnforceSeen(m, { existsSync: () => { throw new Error('x'); } }), true);
    assert.strictEqual(R.markEnforceSeen(m, { existsSync: () => false, mkdirSync: () => { throw new Error('ro'); } }), false);
});

// ── evaluateAuthorship ─────────────────────────────────────────────────────

const SHA = 'd'.repeat(40);
function signedAudit() {
    const f = tmp('audit.jsonl');
    appendChained({
        file: f, lockMaxMs: 0,
        entry: {
            type: 'approval_channel_signature', gate: 'aceptacion', issue: 7631, verdict: 'signed',
            anchor_kind: 'commit-sha', anchor_value: SHA, signed_by: '555', channel: 'telegram',
            at: '2026-09-23T17:00:00.000Z',
        },
    });
    return f;
}
const identity = { [HD.identityKey('555')]: 'leitolarreta' };
const now = () => Date.parse('2026-09-23T18:00:00.500Z');

function run(mode, extra = {}) {
    return evaluateAuthorship({
        issue: 7631, headSha: SHA, now,
        config: cfg({ enabled: true, gate_mode: mode, identity_map: extra.identity || {} }),
        auditFile: extra.auditFile || tmp('vacio.jsonl'),
        logFiles: [tmp('no-log.jsonl')],
        markerFile: extra.markerFile || tmp('marker'),
        prCreatedAt: extra.prCreatedAt || null,
    });
}

test('dry-run sin firma → pasa con "none; <ISO>; missing" y pide aviso', () => {
    const r = run('dry-run');
    assert.strictEqual(r.decision, 'pass');
    assert.strictEqual(r.humanLine, 'none; 2026-09-23T18:00:00Z; missing');
    assert.strictEqual(r.aiLine, 'unknown');
    assert.strictEqual(r.notice, true);
    assert.strictEqual(r.reason, 'missing');
});

test('enforce sin firma → bloquea y deja el marcador enforce-seen', () => {
    const marker = tmp('marker');
    const r = run('enforce', { markerFile: marker });
    assert.strictEqual(r.decision, 'block');
    assert.strictEqual(r.reason, 'missing');
    assert.ok(fs.existsSync(marker));
    // Con el marcador puesto, una config rota ya no puede bajar a dry-run.
    const r2 = evaluateAuthorship({ issue: 7631, headSha: SHA, config: null, auditFile: tmp('x'), logFiles: [], markerFile: marker, now });
    assert.strictEqual(r2.mode, 'enforce');
    assert.strictEqual(r2.decision, 'block');
});

test('enforce con firma mapeada → pasa con la línea firmada', () => {
    const r = run('enforce', { auditFile: signedAudit(), identity });
    assert.strictEqual(r.decision, 'pass');
    assert.match(r.humanLine, /^leitolarreta; 2026-09-23T17:00:00.000Z; gate2:sha256:[0-9a-f]{64}$/);
    assert.strictEqual(r.notice, false);
});

test('enforce con firma de GATE 2 sobre otro sha → anchor-mismatch bloquea; dry-run avisa', () => {
    const audit = signedAudit();
    const base = { issue: 7631, headSha: 'e'.repeat(40), now, auditFile: audit, logFiles: [] };
    const enf = evaluateAuthorship({ ...base, markerFile: tmp('m'), config: cfg({ enabled: true, gate_mode: 'enforce', identity_map: identity }) });
    assert.strictEqual(enf.decision, 'block');
    assert.strictEqual(enf.reason, 'anchor-mismatch');
    const dry = evaluateAuthorship({ ...base, markerFile: tmp('m'), config: cfg({ enabled: true, gate_mode: 'dry-run', identity_map: identity }) });
    assert.strictEqual(dry.decision, 'pass');
    assert.strictEqual(dry.notice, true);
    assert.match(dry.humanLine, /; anchor-mismatch$/);
});

test('off explícito o PR grandfathered → pasa sin líneas', () => {
    const off = run('off');
    assert.strictEqual(off.decision, 'pass');
    assert.strictEqual(off.humanLine, null);
    const gf = evaluateAuthorship({
        issue: 7631, headSha: SHA, now, auditFile: tmp('a'), logFiles: [], markerFile: tmp('m'),
        config: cfg({ enabled: true, gate_mode: 'enforce', go_live_date: '2026-09-23T00:00:00Z' }),
        prCreatedAt: '2026-09-01T00:00:00Z',
    });
    assert.strictEqual(gf.decision, 'pass');
    assert.strictEqual(gf.grandfathered, true);
});

test('identity_map con claves que no son sha256 se ignora (unmapped)', () => {
    const r = run('enforce', { auditFile: signedAudit(), identity: { 555: 'leitolarreta', [HD.identityKey('555')]: 7 } });
    assert.strictEqual(r.reason, 'unmapped');
});

test('excepción inesperada → missing: bloquea en enforce, avisa en dry-run', () => {
    const boom = { existsSync: (p) => { if (String(p).includes('marker')) return false; throw new Error('boom'); } };
    const base = { issue: 7631, headSha: SHA, now, auditFile: tmp('a'), logFiles: [], markerFile: tmp('marker'), fsImpl: boom };
    const dry = evaluateAuthorship({ ...base, config: cfg({ enabled: true, gate_mode: 'dry-run' }) });
    assert.strictEqual(dry.decision, 'pass');
    assert.strictEqual(dry.reason, 'chain-broken');
    // Un fs que revienta en todo + config ausente: readEnforceSeen con error
    // se asume visto ⇒ modo estricto enforce ⇒ bloquea.
    const allBoom = { existsSync: () => { throw new Error('boom'); } };
    const enf = evaluateAuthorship({ ...base, fsImpl: allBoom, config: null });
    assert.strictEqual(enf.mode, 'enforce');
    assert.strictEqual(enf.decision, 'block');
    assert.strictEqual(enf.reason, 'chain-broken');
    // Excepción en el propio evaluador (config con getter que revienta): cae al
    // catch global como missing.
    const trap = {};
    Object.defineProperty(trap, 'authorship', { get() { throw new Error('trap'); } });
    const g1 = evaluateAuthorship({ ...base, fsImpl: undefined, markerFile: tmp('m-nuevo'), config: trap });
    assert.strictEqual(g1.decision, 'pass');
    assert.strictEqual(g1.reason, 'missing');
    assert.strictEqual(g1.notice, true);
    assert.match(g1.humanLine, /^none; .*; missing$/);
    const seen = tmp('m-visto');
    fs.writeFileSync(seen, 'x');
    const g2 = evaluateAuthorship({ ...base, fsImpl: undefined, markerFile: seen, config: trap });
    assert.strictEqual(g2.decision, 'block');
});

// ── copy (UX-1 / UX-2 / UX-3) ──────────────────────────────────────────────

test('comentario de dry-run: veredicto primero, texto por motivo y sin datos del audit', () => {
    for (const reason of ['missing', 'chain-broken', 'anchor-mismatch', 'unmapped']) {
        const body = copy.buildDryRunComment(7631, reason);
        const lines = body.split('\n');
        assert.strictEqual(lines[0], `<!-- authorship-dryrun issue=7631 reason=${reason} -->`);
        assert.match(lines[1], /^⚠ \*\*Autoría: este cambio se integra sin firma registrada del operador\.\*\*$/);
        assert.ok(body.includes(copy.REASON_COPY[reason]));
        assert.ok(body.includes(`\`${reason}\``));
    }
    assert.ok(copy.buildDryRunComment(7631, 'inyeccion<script>').includes('reason=missing'));
    assert.ok(copy.buildDryRunMarker('x', 'missing').includes('issue=0'));
    assert.match(copy.describeBlockReason('unmapped'), /no está dada de alta como aprobador.*motivo técnico: unmapped/);
});

test('ancla del body: se eliminan anclas falsas y líneas Intrale-* y queda sólo la del código al final', () => {
    const lines = { humanLine: 'none; 2026-09-23T18:00:00Z; missing', aiLine: 'unknown' };
    const llmBody = [
        '## Resumen', 'algo',
        '<!-- authorship-anchor issue=7631 -->',
        'Intrale-Human-Direction: leitolarreta; 2026-01-01T00:00:00Z; gate2:sha256:' + 'f'.repeat(64),
        '<!-- /authorship-anchor -->',
        'Intrale​-Issue： #1',
        '<!-- authorship-anchor​ issue=1 -->',
        'sin cierre: todo esto cae',
    ].join('\n');
    const out = copy.applyAnchorToBody(llmBody, 7631, lines);
    assert.strictEqual((out.match(/authorship-anchor issue=/g) || []).length, 1);
    assert.ok(!out.includes('leitolarreta'));
    assert.ok(!out.includes('sin cierre'));
    assert.ok(out.startsWith('## Resumen\nalgo\n\n<!-- authorship-anchor issue=7631 -->'));
    assert.ok(out.includes('Intrale-Human-Direction: none; 2026-09-23T18:00:00Z; missing'));
    assert.ok(out.trimEnd().endsWith('<!-- /authorship-anchor -->'));
    // Idempotente: aplicarlo sobre su propia salida no cambia nada.
    assert.strictEqual(copy.applyAnchorToBody(out, 7631, lines), out);
    assert.ok(copy.applyAnchorToBody('', 7631, lines).startsWith('<!-- authorship-anchor issue=7631 -->'));
    assert.strictEqual(copy.stripAnchorBlocks('a <!-- authorship-anchor --> <!-- /authorship-anchor --> b\nc\n<!-- /authorship-anchor -->'), 'c');
});

// ── Rebote #7631: freno falso en PR #7651 ──────────────────────────────────
// El delivery leyó la config de `main` (sin bloque `authorship`) y el destino
// del marcador enforce-seen no se pudo resolver (write-target bloqueado). Eso
// se trataba como "enforce ya visto" ⇒ bloqueaba en modo de prueba.

test('regresión #7651: destino del marcador no resoluble cuenta como NO visto', () => {
    assert.strictEqual(R.readEnforceSeen(undefined, undefined, { resolveDefault: () => null }), false);
    assert.strictEqual(R.readEnforceSeen(undefined, undefined, { resolveDefault: () => { throw new Error('bloqueado'); } }), false);
});

test('regresión #7651: modo de prueba + sin firma + marcador no resoluble ⇒ merge permitido con aviso', () => {
    const base = { issue: 7631, headSha: 'a'.repeat(40), auditFile: tmp('sin-audit'), logFiles: [], markerResolver: () => null };
    for (const config of [null, cfg(undefined), cfg({ enabled: true, gate_mode: 'dry-run', identity_map: {} })]) {
        const r = evaluateAuthorship({ ...base, config });
        assert.strictEqual(r.mode, 'dry-run', JSON.stringify(config));
        assert.strictEqual(r.decision, 'pass', JSON.stringify(config));
        assert.strictEqual(r.notice, true);
        assert.strictEqual(r.reason, 'missing');
        assert.match(r.humanLine, /^none; .+; missing$/);
    }
    // `enforce` explícito sigue bloqueando aunque el marcador no se resuelva.
    const enf = evaluateAuthorship({ ...base, markerFile: tmp('m-enf'), config: cfg({ enabled: true, gate_mode: 'enforce' }) });
    assert.strictEqual(enf.decision, 'block');
});

test('config real: identity_map mapea al operador leitolarreta con clave sha256', () => {
    const yaml = require('js-yaml');
    const real = yaml.load(fs.readFileSync(path.join(__dirname, '..', '..', 'config.yaml'), 'utf8'));
    const map = real.authorship.identity_map || {};
    const logins = Object.values(map);
    assert.ok(logins.includes('leitolarreta'), 'identity_map debe incluir al operador');
    for (const k of Object.keys(map)) assert.match(k, /^sha256:[0-9a-f]{64}$/);
    assert.strictEqual(real.authorship.gate_mode, 'dry-run');
});
