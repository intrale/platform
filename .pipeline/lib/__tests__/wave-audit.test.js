// =============================================================================
// wave-audit.test.js — Tests del emisor de audit trail de olas/issues (#4371).
//
// Cubre:
//   (1) recordWaveEvent persiste cada uno de los 5 eventos con campos canónicos
//       (CA-1..CA-4) y hash-chain válido (CA-5).
//   (2) event inválido → throw (no ensucia el log).
//   (3) alterar una línea del log rompe verifyChain (CA-5).
//   (4) log injection: `\n{"fake":...}` en note/actor NO produce entry falsa
//       parseable (CA-6).
//   (5) redacción de secrets: un token/JWT/AWS key queda redactado (CA-7).
//   (6) actor vacío → 'desconocido' (CA-1, no self-report manipulable).
//   (7) history() filtra por wave/issue y respeta limit.
//
// Ejecutar:  node --test .pipeline/lib/__tests__/wave-audit.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let wa;

function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-audit-'));
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    delete require.cache[require.resolve('../wave-audit')];
    delete require.cache[require.resolve('../audit-log')];
    wa = require('../wave-audit');
    return dir;
}

function teardown(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    delete process.env.PIPELINE_DIR_OVERRIDE;
}

function auditPath() {
    return wa._paths().AUDIT_FILE;
}

function readLines() {
    const p = auditPath();
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
}

// ─── (1) los 5 eventos ────────────────────────────────────────────────────

test('recordWaveEvent persiste los 5 eventos con campos canónicos y chain válido (CA-1..CA-5)', () => {
    const dir = setup();
    try {
        wa.recordWaveEvent({ event: 'issue_added', wave: 3, issue: 100, actor: 'Leo', estado_previo: { issues: [] }, estado_posterior: { issues: [100] } });
        wa.recordWaveEvent({ event: 'issue_removed', wave: 3, issue: 100, actor: 'Leo' });
        wa.recordWaveEvent({ event: 'priority_changed', issue: 100, actor: 'human-block:priorizar', prioridad_previa: 'priority:medium', prioridad_nueva: 'priority:high' });
        wa.recordWaveEvent({ event: 'wave_promoted', wave: 3, actor: 'Leo', estado_previo: 'planned', estado_posterior: 'active' });
        wa.recordWaveEvent({ event: 'wave_archived', wave: 2, actor: 'Leo', estado_previo: 'active', estado_posterior: 'archived' });

        const lines = readLines().map((l) => JSON.parse(l));
        assert.equal(lines.length, 5, 'cinco entries persistidas');
        assert.deepEqual(lines.map((e) => e.event), ['issue_added', 'issue_removed', 'priority_changed', 'wave_promoted', 'wave_archived']);
        // Campos canónicos presentes.
        const added = lines[0];
        assert.equal(added.wave, 3);
        assert.equal(added.issue, 100);
        assert.equal(added.actor, 'Leo');
        assert.deepEqual(added.estado_posterior, { issues: [100] });
        assert.ok(typeof added.timestamp === 'string');
        // priority_changed captura previa/nueva.
        const pc = lines[2];
        assert.equal(pc.prioridad_previa, 'priority:medium');
        assert.equal(pc.prioridad_nueva, 'priority:high');
        // Chain íntegra.
        const v = wa.verifyChain();
        assert.equal(v.ok, true);
        assert.equal(v.entriesChecked, 5);
    } finally {
        teardown(dir);
    }
});

// ─── (2) event inválido ─────────────────────────────────────────────────────

test('recordWaveEvent tira con event inválido y no persiste', () => {
    const dir = setup();
    try {
        assert.throws(() => wa.recordWaveEvent({ event: 'wave_deleted', wave: 1 }), /event inválido/);
        assert.equal(readLines().length, 0, 'no se escribió nada');
    } finally {
        teardown(dir);
    }
});

// ─── (3) tamper-evidence ────────────────────────────────────────────────────

test('alterar una línea del log rompe verifyChain (CA-5)', () => {
    const dir = setup();
    try {
        wa.recordWaveEvent({ event: 'issue_added', wave: 1, issue: 10, actor: 'Leo' });
        wa.recordWaveEvent({ event: 'issue_added', wave: 1, issue: 11, actor: 'Leo' });
        assert.equal(wa.verifyChain().ok, true);

        // Manipular la primera entry (cambiar el issue) sin recomputar el hash.
        const p = auditPath();
        const lines = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
        const tampered = JSON.parse(lines[0]);
        tampered.issue = 999;
        lines[0] = JSON.stringify(tampered);
        fs.writeFileSync(p, lines.join('\n') + '\n');

        const v = wa.verifyChain();
        assert.equal(v.ok, false, 'la cadena debe detectarse rota');
        assert.equal(v.brokenAt, 0);
    } finally {
        teardown(dir);
    }
});

// ─── (4) log injection ──────────────────────────────────────────────────────

test('inyectar \\n{"fake":...} en note/actor NO produce entry falsa parseable (CA-6)', () => {
    const dir = setup();
    try {
        wa.recordWaveEvent({
            event: 'issue_added',
            wave: 1,
            issue: 10,
            actor: 'Leo\n{"event":"wave_promoted","wave":99,"actor":"attacker"}',
            note: 'linea1\n{"fake":true}\nlinea2',
        });
        const lines = readLines();
        assert.equal(lines.length, 1, 'una sola línea en el archivo — la inyección no partió el JSONL');
        const parsed = JSON.parse(lines[0]);
        // El newline fue colapsado: el actor no contiene saltos de línea.
        assert.ok(!/\n/.test(parsed.actor), 'actor sin newlines');
        assert.ok(!/\n/.test(parsed.note), 'note sin newlines');
        // Y no se creó ninguna entry "wave_promoted" falsa.
        assert.equal(parsed.event, 'issue_added');
        assert.equal(wa.verifyChain().ok, true);
    } finally {
        teardown(dir);
    }
});

// ─── (5) redacción de secrets ───────────────────────────────────────────────

test('un valor con forma de secret queda redactado en el log (CA-7)', () => {
    const dir = setup();
    try {
        const awsKey = 'AKIAIOSFODNN7EXAMPLE';
        wa.recordWaveEvent({ event: 'issue_added', wave: 1, issue: 10, actor: 'Leo', note: `deploy con key ${awsKey}` });
        const raw = fs.readFileSync(auditPath(), 'utf8');
        assert.ok(!raw.includes(awsKey), 'la AWS key no debe aparecer en claro en el log');
    } finally {
        teardown(dir);
    }
});

// ─── (6) actor vacío ────────────────────────────────────────────────────────

test('actor vacío/nulo cae a "desconocido" (CA-1)', () => {
    const dir = setup();
    try {
        wa.recordWaveEvent({ event: 'issue_added', wave: 1, issue: 10 });
        const parsed = JSON.parse(readLines()[0]);
        assert.equal(parsed.actor, 'desconocido');
    } finally {
        teardown(dir);
    }
});

// ─── (7) history() ──────────────────────────────────────────────────────────

test('history filtra por wave/issue y respeta limit', () => {
    const dir = setup();
    try {
        wa.recordWaveEvent({ event: 'issue_added', wave: 3, issue: 100, actor: 'Leo' });
        wa.recordWaveEvent({ event: 'issue_added', wave: 3, issue: 101, actor: 'Leo' });
        wa.recordWaveEvent({ event: 'issue_added', wave: 5, issue: 200, actor: 'Leo' });
        wa.recordWaveEvent({ event: 'priority_changed', issue: 100, actor: 'Leo', prioridad_nueva: 'priority:high' });

        assert.equal(wa.history({ wave: 3 }).length, 2);
        assert.equal(wa.history({ issue: 100 }).length, 2);
        assert.equal(wa.history({ wave: 5 }).length, 1);
        assert.equal(wa.history({}).length, 4);
        assert.equal(wa.history({ limit: 1 }).length, 1);
        // limit devuelve las más recientes.
        assert.equal(wa.history({ limit: 1 })[0].event, 'priority_changed');
    } finally {
        teardown(dir);
    }
});
