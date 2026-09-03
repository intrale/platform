'use strict';

// =============================================================================
// Tests de la superficie OPERACIONAL de `operator-absence-policy` (#5460).
//
// El archivo es aparte de `operator-absence-policy.test.js` a propósito: ese
// cubre la escalera de gates de lifecycle (`resolveAbsenceDecision`), que tiene
// una rama de auto-proceed. Esta superficie NO la tiene, y mezclarlas invita a
// que un refactor "unifique" las dos políticas — que es exactamente el fail-open
// que hay que impedir.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const policy = require('../operator-absence-policy');

const T0 = Date.parse('2026-08-28T10:00:00.000Z');

function tmpdir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'absence-op-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

// =============================================================================
// La decisión es SIEMPRE fail-closed
// =============================================================================

test('las cuatro causas del enum resuelven fail-closed y conservan el fallback', () => {
    for (const causa of policy.OPERATIONAL_ABSENCE_CAUSES) {
        const d = policy.resolveOperationalAbsence({ causa });
        assert.equal(d.decision, 'fail-closed', `causa: ${causa}`);
        assert.equal(d.causa, causa);
        assert.equal(d.conserva_fallback, true);
        assert.equal(d.needs_human, true);
    }
});

test('NINGUNA entrada produce auto-proceed — ni siquiera una que lo pida literal', () => {
    const hostiles = [
        'auto-proceed', 'auto_proceed', '', null, undefined, 0, {}, [],
        { toString: () => 'timeout' }, 'TIMEOUT; auto-proceed',
    ];
    for (const causa of hostiles) {
        const d = policy.resolveOperationalAbsence({ causa });
        assert.equal(d.decision, 'fail-closed', `causa: ${JSON.stringify(causa)}`);
        assert.notEqual(d.decision, 'auto-proceed');
    }
});

test('la decisión es inmutable: un consumidor no puede degradarla a auto-proceed', () => {
    const d = policy.resolveOperationalAbsence({ causa: 'timeout' });
    assert.throws(() => { 'use strict'; d.decision = 'auto-proceed'; }, TypeError);
    assert.equal(d.decision, 'fail-closed');
});

// =============================================================================
// Saneo de la causa — enum cerrado
// =============================================================================

test('la causa se normaliza (mayúsculas, guiones, espacios) contra el enum', () => {
    assert.equal(policy.sanitizeOperationalCause('TIMEOUT'), 'timeout');
    assert.equal(policy.sanitizeOperationalCause('  Telegram-Ausente '), 'telegram_ausente');
    assert.equal(policy.sanitizeOperationalCause('allowlist vacia'), 'allowlist_vacia');
    assert.equal(policy.sanitizeOperationalCause('estado indeterminado'), 'estado_indeterminado');
});

test('una causa fuera del enum colapsa y NUNCA propaga el valor original', () => {
    const hostil = 'ENOENT: C:\\Users\\Administrator\\.aws\\credentials (chat 987654321)';
    const causa = policy.sanitizeOperationalCause(hostil);
    assert.equal(causa, policy.OPERATIONAL_ABSENCE_UNKNOWN_CAUSE);
    assert.equal(causa.includes('Administrator'), false);
    assert.equal(causa.includes('987654321'), false);
});

test('tipos no-string colapsan a la causa desconocida (fail-closed)', () => {
    for (const v of [null, undefined, 42, {}, [], true, Symbol('x')]) {
        assert.equal(policy.sanitizeOperationalCause(v), policy.OPERATIONAL_ABSENCE_UNKNOWN_CAUSE);
    }
});

// =============================================================================
// Saneo de la referencia al runbook
// =============================================================================

test('acepta un path relativo del repo, con o sin ancla', () => {
    assert.equal(policy.sanitizeRunbookRef('docs/operacion-pipeline.md'), 'docs/operacion-pipeline.md');
    assert.equal(
        policy.sanitizeRunbookRef('docs/operacion-pipeline.md#corte-fallback-vault'),
        'docs/operacion-pipeline.md#corte-fallback-vault'
    );
});

test('rechaza absolutos, traversal y basura: degrada al runbook default', () => {
    const malos = [
        '/etc/passwd', 'C:\\Users\\Administrator\\secrets.json', '../../.aws/credentials',
        'docs/../../../etc/shadow', '', '   ', 'docs/a b.md', 'http://evil.tld/x',
        null, undefined, 42, {},
    ];
    for (const m of malos) {
        assert.equal(policy.sanitizeRunbookRef(m), policy.OPERATIONAL_ABSENCE_RUNBOOK,
            `valor: ${JSON.stringify(m)}`);
    }
});

// =============================================================================
// Señal local — exactamente cuatro claves
// =============================================================================

test('la señal tiene EXACTAMENTE cuatro claves, siempre', () => {
    const s = policy.buildOperationalAbsenceSignal({ causa: 'timeout', now: T0 });
    assert.deepEqual(Object.keys(s).sort(), ['causa', 'estado', 'runbook', 'timestamp']);
    assert.equal(s.estado, policy.OPERATIONAL_ABSENCE_STATE);
    assert.equal(s.timestamp, '2026-08-28T10:00:00.000Z');
});

test('un `now` inválido no rompe la señal ni deja el timestamp vacío', () => {
    for (const bad of ['no es fecha', NaN, {}, Infinity]) {
        const s = policy.buildOperationalAbsenceSignal({ causa: 'timeout', now: bad });
        assert.equal(typeof s.timestamp, 'string');
        assert.ok(s.timestamp.length > 0, `now: ${String(bad)}`);
    }
});

test('la escritura es atómica y no deja temporales', (t) => {
    const dir = tmpdir(t);
    const signalPath = path.join(dir, 'anidado', 'vault-cut-absence.json');

    const res = policy.writeOperationalAbsenceSignal({
        signalPath, causa: 'allowlist_vacia', runbook: 'docs/operacion-pipeline.md', now: T0,
    });

    assert.equal(res.ok, true);
    const written = JSON.parse(fs.readFileSync(signalPath, 'utf8'));
    assert.deepEqual(written, {
        estado: 'fallback_conservado',
        timestamp: '2026-08-28T10:00:00.000Z',
        causa: 'allowlist_vacia',
        runbook: 'docs/operacion-pipeline.md',
    });
    const sobrantes = fs.readdirSync(path.dirname(signalPath)).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(sobrantes, []);
});

test('escribir dos veces sobreescribe: la señal refleja el ÚLTIMO estado', (t) => {
    const dir = tmpdir(t);
    const signalPath = path.join(dir, 'signal.json');
    policy.writeOperationalAbsenceSignal({ signalPath, causa: 'telegram_ausente', now: T0 });
    policy.writeOperationalAbsenceSignal({ signalPath, causa: 'timeout', now: T0 + 1000 });
    const s = JSON.parse(fs.readFileSync(signalPath, 'utf8'));
    assert.equal(s.causa, 'timeout');
    assert.equal(s.timestamp, '2026-08-28T10:00:01.000Z');
});

test('un fallo de escritura no lanza y no filtra el path en el error', () => {
    const fsImpl = {
        mkdirSync: () => {},
        writeFileSync: () => { throw new Error('EACCES: C:\\Users\\Administrator\\secret'); },
        renameSync: () => {},
        unlinkSync: () => {},
    };
    const res = policy.writeOperationalAbsenceSignal({
        signalPath: '/x/y.json', causa: 'timeout', fsImpl,
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'signal_write_failed');
    assert.equal(JSON.stringify(res).includes('Administrator'), false);
});

test('un signalPath inválido devuelve error tipado sin tocar disco', () => {
    for (const p of ['', '   ', null, undefined, 42]) {
        const res = policy.writeOperationalAbsenceSignal({ signalPath: p, causa: 'timeout' });
        assert.equal(res.ok, false);
        assert.equal(res.error, 'signal_path_invalido');
    }
});

// =============================================================================
// Copy
// =============================================================================

test('el mensaje dice explícitamente que la conservación es intencional', () => {
    const msg = policy.buildOperationalAbsenceMessage({ causa: 'timeout' });
    assert.match(msg, /el fallback se conserva/);
    assert.match(msg, /intencional/);
    assert.match(msg, /needs-human/);
    assert.match(msg, /Runbook:/);
});

test('el mensaje traduce cada causa del enum y no deja "undefined"', () => {
    const causas = [...policy.OPERATIONAL_ABSENCE_CAUSES, policy.OPERATIONAL_ABSENCE_UNKNOWN_CAUSE];
    for (const causa of causas) {
        const msg = policy.buildOperationalAbsenceMessage({ causa });
        assert.equal(msg.includes('undefined'), false, `causa: ${causa}`);
    }
});

test('el mensaje no filtra la causa cruda ni el runbook hostil', () => {
    const msg = policy.buildOperationalAbsenceMessage({
        causa: 'chat 987654321 en DESKTOP-TOTQAUE',
        runbook: '/etc/passwd',
    });
    assert.equal(msg.includes('987654321'), false);
    assert.equal(msg.includes('DESKTOP-TOTQAUE'), false);
    assert.equal(msg.includes('/etc/passwd'), false);
});

test('notifyOperationalAbsence acepta un send inyectado y no toca la cola', () => {
    const enviados = [];
    const res = policy.notifyOperationalAbsence(
        { causa: 'timeout' },
        ({ text }) => { enviados.push(text); return { ok: true }; }
    );
    assert.equal(res.ok, true);
    assert.equal(enviados.length, 1);
    assert.match(enviados[0], /el fallback se conserva/);
});

// =============================================================================
// Aislamiento respecto de la política de lifecycle
// =============================================================================

test('la superficie operacional NO reutiliza los REASONS de los gates', () => {
    const d = policy.resolveOperationalAbsence({ causa: 'timeout' });
    for (const reason of Object.values(policy.REASONS)) {
        assert.notEqual(d.causa, reason);
    }
});

test('las causas operacionales y las decisiones de gate son vocabularios disjuntos', () => {
    for (const causa of policy.OPERATIONAL_ABSENCE_CAUSES) {
        assert.equal(policy.DECISIONS.includes(causa), false);
        assert.equal(policy.NON_DELEGABLE_GATES.includes(causa), false);
    }
});
