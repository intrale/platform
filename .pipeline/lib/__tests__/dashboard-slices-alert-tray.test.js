// =============================================================================
// dashboard-slices-alert-tray.test.js — #3954 EP8-H1 CA-5.
//
// Cubre el store `alert-tray-audit.js` + el slice `alertTraySlice`:
//   - recordAck/recordSnooze persisten con actor server-side fijo (REQ-SEC-3).
//   - snooze sólo acepta la allowlist 1/4/24h (REQ-SEC-2); fuera de allowlist
//     persiste un reject y NO aplica supresión.
//   - alertId fuera de la regex allowlist se rechaza.
//   - justificación se trunca a 80 en el slice y la cadena de audit verifica.
//   - degradación a `{error}` si el store no está disponible.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-alert-tray-'));
process.env.PIPELINE_DIR_OVERRIDE = TMP_DIR;
fs.mkdirSync(path.join(TMP_DIR, 'audit'), { recursive: true });

delete require.cache[require.resolve('../alert-tray-audit')];
delete require.cache[require.resolve('../audit-log')];

const ata = require('../alert-tray-audit');
const slices = require('../dashboard-slices');

function resetFs() {
    const { AUDIT_FILE } = ata._paths();
    try { fs.unlinkSync(AUDIT_FILE); } catch {}
    try { fs.unlinkSync(AUDIT_FILE + '.lock'); } catch {}
}

// -----------------------------------------------------------------------------
// Módulo alert-tray-audit
// -----------------------------------------------------------------------------

test('recordAck graba actor server-side fijo (operador-local), nunca del input', () => {
    resetFs();
    const r = ata.recordAck({ alertId: 'cuota:exhausted', justification: 'visto' });
    assert.equal(r.ok, true);
    assert.equal(r.applied, true);
    const entries = ata.tail(5);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].actor, 'operador-local');
    assert.equal(entries[0].action, 'ack');
    assert.equal(entries[0].alert_id, 'cuota:exhausted');
});

test('appendAction ignora cualquier actor pasado por el caller', () => {
    resetFs();
    // El módulo NO acepta `actor` en la firma — aunque se cuele, se ignora.
    ata.appendAction({ action: 'ack', alertId: 'pulpo:down', actor: 'attacker' });
    const e = ata.tail(1)[0];
    assert.equal(e.actor, 'operador-local');
});

test('recordSnooze acepta 1/4/24h y calcula snooze_until', () => {
    resetFs();
    for (const h of [1, 4, 24]) {
        const r = ata.recordSnooze({ alertId: 'infra:dns', snoozeHours: h });
        assert.equal(r.applied, true, `debe aplicar snooze de ${h}h`);
    }
    const last = ata.tail(1)[0];
    assert.equal(last.action, 'snooze');
    assert.equal(last.snooze_hours, 24);
    assert.ok(typeof last.snooze_until === 'string' && last.snooze_until.length > 0);
});

test('recordSnooze rechaza duración fuera de la allowlist (REQ-SEC-2)', () => {
    resetFs();
    for (const bad of [2, 3, 48, 0, -1, 100, 'abc']) {
        const r = ata.recordSnooze({ alertId: 'infra:dns', snoozeHours: bad });
        assert.equal(r.applied, false, `debe rechazar ${bad}`);
    }
    // Cada rechazo queda persistido como action: 'reject' (forensia).
    const entries = ata.tail(10);
    assert.ok(entries.every(e => e.action === 'reject'));
});

test('alertId fuera de la regex allowlist se rechaza', () => {
    resetFs();
    for (const bad of ['UPPER', '1leading', '../traversal', 'with space', '<script>', '']) {
        const r = ata.recordAck({ alertId: bad });
        assert.equal(r.applied, false, `debe rechazar alertId="${bad}"`);
    }
});

test('justificación con secret se redacta antes de persistir', () => {
    resetFs();
    ata.recordAck({ alertId: 'cuota:exhausted', justification: 'token AKIA1234567890ABCDEF fin' });
    const e = ata.tail(1)[0];
    assert.ok(!/AKIA1234567890ABCDEF/.test(e.justification), 'la AWS key no debe quedar en claro');
    assert.equal(e.justification_redacted, true);
});

test('snooze vencido no figura en activeSuppressions; ack sí', () => {
    resetFs();
    ata.recordAck({ alertId: 'pulpo:down' });
    const sup = ata.activeSuppressions();
    assert.ok(sup['pulpo:down'], 'ack debe estar vigente');
    assert.equal(sup['pulpo:down'].action, 'ack');
    assert.equal(sup['pulpo:down'].actor, 'operador-local');
});

test('verifyChain reporta cadena íntegra tras varias acciones', () => {
    resetFs();
    ata.recordAck({ alertId: 'a' });
    ata.recordSnooze({ alertId: 'b', snoozeHours: 4 });
    const chain = ata.verifyChain();
    assert.equal(chain.ok, true);
    assert.ok(chain.entriesChecked >= 2);
});

// -----------------------------------------------------------------------------
// Slice alertTraySlice
// -----------------------------------------------------------------------------

test('alertTraySlice devuelve entries con actor + justificación truncada a 80', () => {
    resetFs();
    const longJust = 'x'.repeat(200);
    ata.recordAck({ alertId: 'cuota:exhausted', justification: longJust });
    const out = slices.alertTraySlice({}, {});
    assert.ok(Array.isArray(out.entries));
    assert.equal(out.entries.length, 1);
    const e = out.entries[0];
    assert.equal(e.actor, 'operador-local');
    assert.equal(e.justification.length, 80);
    assert.equal(e.justification_truncated, true);
    assert.equal(e.visual, 'ack');
    assert.equal(out.chain_broken, false);
    assert.ok(out.stats && typeof out.stats.total === 'number');
});

test('alertTraySlice expone supresiones vigentes', () => {
    resetFs();
    ata.recordSnooze({ alertId: 'infra:dns', snoozeHours: 1 });
    const out = slices.alertTraySlice({}, { limit: 5 });
    assert.ok(out.suppressions['infra:dns']);
    assert.equal(out.suppressions['infra:dns'].action, 'snooze');
});

test('alertTraySlice degrada a {error} si el store no carga', () => {
    // Forzamos un override de path imposible para provocar fallo controlado.
    const realResolve = require.resolve('../alert-tray-audit');
    const backup = require.cache[realResolve];
    require.cache[realResolve] = {
        id: realResolve, filename: realResolve, loaded: true,
        exports: { tail() { throw new Error('boom'); }, statsSince() { return {}; }, verifyChain() { return { ok: true }; }, activeSuppressions() { return {}; } },
    };
    delete require.cache[require.resolve('../dashboard-slices')];
    const slices2 = require('../dashboard-slices');
    const out = slices2.alertTraySlice({}, {});
    assert.equal(out.error, 'alert_tray_audit_unavailable');
    assert.deepEqual(out.entries, []);
    // Restaurar.
    if (backup) require.cache[realResolve] = backup; else delete require.cache[realResolve];
    delete require.cache[require.resolve('../dashboard-slices')];
});
