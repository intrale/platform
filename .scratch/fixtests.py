# -*- coding: utf-8 -*-
import io

p = r'.pipeline/lib/__tests__/file-lock.test.js'
s = io.open(p, encoding='utf8').read()
orig = s

def sub1(old, new, label):
    global s
    assert old in s, 'no matcheo: ' + label
    assert s.count(old) == 1, 'ambiguo: ' + label
    s = s.replace(old, new, 1)

# ── 1) "PID no existe → stale": usaba un lockPath INEXISTENTE y aprobaba por el
#       fallthrough de statSync. Con #6459 "el archivo no está" ya no significa
#       "stale", así que el test se reescribe sobre un lock REAL para ejercer lo
#       que siempre quiso ejercer: PID muerto + lock viejo ⇒ stale.
OLD1 = u"""test('isStale: PID no existe → stale', () => {
    const fake = { pid: 9999999, startTime: '2026-01-01T00:00:00.000Z' };
    // PID muy alto — improbable que exista.
    const stale = lock._internal.isStale(fake, '/nope/inexistent.lock');
    assert.equal(stale, true);
});"""
NEW1 = u"""test('isStale: PID no existe (lock viejo) → stale', () => {
    const target = mkTmpFile();
    try {
        // PID muy alto — improbable que exista.
        const fake = { pid: 9999999, startTime: '2026-01-01T00:00:00.000Z' };
        fs.writeFileSync(target + '.lock', JSON.stringify(fake));
        // #6459 — el lock tiene que ser VIEJO: un lock joven no se roba ni con
        // el PID muerto (un falso negativo de isPidAlive causaría dual-hold).
        const old = (Date.now() - 90 * 1000) / 1000;
        fs.utimesSync(target + '.lock', old, old);
        assert.equal(lock._internal.isStale(fake, target + '.lock'), true);
    } finally { rmrf(target); }
});

// #6459 — El lock JOVEN de un PID reportado muerto NO se roba. `isPidAlive` es
// fail-closed pero no infalible; exigir antigüedad hace que un único falso
// "muerto" no alcance para el dual-hold.
test('#6459 isStale: PID no existe pero lock JOVEN → NO stale', () => {
    const target = mkTmpFile();
    try {
        const fake = { pid: 9999999, startTime: '2026-01-01T00:00:00.000Z' };
        fs.writeFileSync(target + '.lock', JSON.stringify(fake));
        assert.equal(lock._internal.isStale(fake, target + '.lock'), false,
            'un lock de segundos no se roba ni con el PID muerto');
    } finally { rmrf(target); }
});

// #6459 — "el lock desapareció" NO es "el lock está stale". Antes devolvía
// true y el caller hacía un unlink a ciegas que se llevaba puesto el lock que
// otro proceso acababa de crear → dual-hold → lost-update silencioso.
test('#6459 isStale: lock inexistente → NO stale (no hay nada que robar)', () => {
    const meta = { pid: process.ppid, startTime: '2026-01-01T00:00:00.000Z' };
    assert.equal(lock._internal.isStale(meta, '/nope/inexistent.lock'), false);
});

test('#6459 isPidAlive: error no concluyente (UNKNOWN) → VIVO (fail-closed)', (t) => {
    t.mock.method(process, 'kill', () => {
        throw Object.assign(new Error('unknown'), { code: 'UNKNOWN' });
    });
    try {
        assert.equal(lock._internal.isPidAlive(4242), true,
            'ante un error no concluyente hay que asumir VIVO, nunca robar el lock');
    } finally { t.mock.restoreAll(); }
});

test('#6459 isPidAlive: ESRCH → MUERTO (única prueba positiva de muerte)', (t) => {
    t.mock.method(process, 'kill', () => {
        throw Object.assign(new Error('esrch'), { code: 'ESRCH' });
    });
    try {
        assert.equal(lock._internal.isPidAlive(4242), false);
    } finally { t.mock.restoreAll(); }
});

// #6459 — remoción VERIFICADA: el unlink sólo procede si el lock sigue siendo
// el mismo que juzgamos stale.
test('#6459 removeStaleLock: NO borra si el lock cambió de dueño (TOCTOU)', () => {
    const target = mkTmpFile();
    try {
        const judged = { pid: 9999999, startTime: 'x', nonce: 'aaaaaaaaaaaaaaaa' };
        // En el disco ya hay OTRO lock: el holder liberó y un tercero lo tomó.
        const fresh = { pid: process.pid, startTime: 'y', nonce: 'bbbbbbbbbbbbbbbb' };
        fs.writeFileSync(target + '.lock', JSON.stringify(fresh));

        assert.equal(lock._internal.removeStaleLock(target + '.lock', judged), false,
            'no debe borrar el lock de otro holder');
        const after = JSON.parse(fs.readFileSync(target + '.lock', 'utf8'));
        assert.equal(after.nonce, 'bbbbbbbbbbbbbbbb', 'el lock fresco debe seguir intacto');
    } finally { rmrf(target); }
});

test('#6459 removeStaleLock: SÍ borra si la identidad coincide', () => {
    const target = mkTmpFile();
    try {
        const judged = { pid: 9999999, startTime: 'x', nonce: 'cccccccccccccccc' };
        fs.writeFileSync(target + '.lock', JSON.stringify(judged));
        assert.equal(lock._internal.removeStaleLock(target + '.lock', judged), true);
        assert.equal(fs.existsSync(target + '.lock'), false, 'el lock stale debe removerse');
    } finally { rmrf(target); }
});

test('#6459 removeStaleLock: lock ya desaparecido → false, sin tirar', () => {
    const judged = { pid: 1, startTime: 'x', nonce: 'dddddddddddddddd' };
    assert.equal(lock._internal.removeStaleLock('/nope/inexistent.lock', judged), false);
});

test('#6459 el lock lleva nonce único por adquisición', () => {
    const a = mkTmpFile();
    const b = mkTmpFile();
    try {
        let na, nb;
        lock.withLockSync(a, () => {
            na = JSON.parse(fs.readFileSync(a + '.lock', 'utf8')).nonce;
        });
        lock.withLockSync(b, () => {
            nb = JSON.parse(fs.readFileSync(b + '.lock', 'utf8')).nonce;
        });
        assert.ok(na && nb, 'ambos locks deben traer nonce');
        assert.notEqual(na, nb, 'el nonce debe ser único por adquisición');
    } finally { rmrf(a); rmrf(b); }
});"""
sub1(OLD1, NEW1, 'PID no existe')

# ── 2) "lock corrupto → stale": mismo problema, lockPath inexistente.
OLD2 = u"""test('isStale: lock corrupto → stale', () => {
    const stale = lock._internal.isStale({ _corrupt: true }, '/nope/inexistent.lock');
    assert.equal(stale, true);
});"""
NEW2 = u"""test('isStale: lock corrupto viejo → stale', () => {
    const target = mkTmpFile();
    try {
        fs.writeFileSync(target + '.lock', '');
        // #6459 — sobre un lock REAL y viejo (el path inexistente ya no
        // devuelve stale: "desapareció" != "stale").
        const old = (Date.now() - 90 * 1000) / 1000;
        fs.utimesSync(target + '.lock', old, old);
        assert.equal(lock._internal.isStale({ _corrupt: true }, target + '.lock'), true);
    } finally { rmrf(target); }
});"""
sub1(OLD2, NEW2, 'lock corrupto')

assert s != orig
io.open(p, 'w', encoding='utf8', newline='').write(s)
print('tests actualizados')
