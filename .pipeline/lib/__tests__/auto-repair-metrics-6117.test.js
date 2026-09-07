'use strict';

// =============================================================================
// auto-repair-metrics-6117.test.js — Unit del módulo de métrica + detector de
// repetición de auto-reparaciones (#6117).
//
// Cubre CA-5 (repetición notificada), CA-6 (contador por tipo) y CA-7 (dato
// consultable), más los requisitos de seguridad SEC-3 (la firma es sólo el
// tipo), SEC-4 (fail-open hacia notificar) y SEC-6 (whitelist estricta).
//
// Todo el módulo es I/O sobre un JSONL, así que los tests usan un tmpdir real
// vía la inyección `deps.file` — no hay mocks de `fs`. Lo que se afirma es lo
// que queda escrito en disco.
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const autoRepair = require('../metrics/auto-repair');

// --- Arnés -------------------------------------------------------------------

let _tmpSeq = 0;
/** Crea un JSONL aislado por test. `Math.random` a propósito NO: seq determinista. */
function tmpFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `auto-repair-6117-${process.pid}-${_tmpSeq++}-`));
    return path.join(dir, 'auto-repair.jsonl');
}

/** Lee y parsea todas las líneas del JSONL. */
function readLines(file) {
    return fs.readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
}

const T0 = Date.parse('2026-08-18T12:00:00.000Z');
const MIN = 60000;

// --- CA-6 · el contador y su shape ------------------------------------------

test('una reparación exitosa persiste una línea con tipo, issues, count y timestamp', () => {
    const file = tmpFile();
    const r = autoRepair.recordAutoRepair(
        { tipo: 'convergencia_aditiva', issues: [5724, 5882] },
        { file, now: () => T0 },
    );

    assert.equal(r.ok, true);
    const lines = readLines(file);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].tipo, 'convergencia_aditiva');
    assert.deepEqual(lines[0].issues, [5724, 5882]);
    assert.equal(lines[0].count, 2);
    assert.equal(lines[0].timestamp, '2026-08-18T12:00:00.000Z');
});

test('SEC-6: cada línea tiene EXACTAMENTE los campos de la whitelist, ni uno más', () => {
    const file = tmpFile();
    // Se pasan campos de más a propósito: son el `probe` y el resultado del
    // mutador que el caller tiene a mano. Un spread los filtraría al store que
    // el dashboard expone sin autenticación.
    autoRepair.recordAutoRepair({
        tipo: 'convergencia_aditiva',
        issues: [1],
        allowlist: [1, 2, 3],
        reason: 'gate_rejected: /home/secreto/config.yaml',
        token: 'AKIAIOSFODNN7EXAMPLE',
        probe: { waves_allowlist: [9, 9, 9] },
    }, { file, now: () => T0 });

    const [rec] = readLines(file);
    assert.deepEqual(Object.keys(rec).sort(), [...autoRepair.WHITELIST].sort());
    // Verificación directa de que nada del payload extra sobrevivió.
    const crudo = fs.readFileSync(file, 'utf8');
    assert.ok(!crudo.includes('AKIA'), 'no debe filtrarse el token');
    assert.ok(!crudo.includes('secreto'), 'no debe filtrarse el path');
    assert.ok(!crudo.includes('waves_allowlist'), 'no debe filtrarse el probe');
});

test('SEC-6: un tipo fuera del enum se persiste como desconocido, no crudo', () => {
    const file = tmpFile();
    autoRepair.recordAutoRepair(
        { tipo: 'inyectado\nFAKE-LOG-LINE', issues: [1] },
        { file, now: () => T0 },
    );
    const [rec] = readLines(file);
    assert.equal(rec.tipo, 'desconocido');
    assert.ok(!fs.readFileSync(file, 'utf8').includes('FAKE-LOG-LINE'));
});

test('SEC-6: issues se coerciona a enteros positivos únicos', () => {
    const file = tmpFile();
    autoRepair.recordAutoRepair(
        { tipo: 'convergencia_aditiva', issues: [12, '13', 12, -4, 0, null, 'x', { n: 5 }, 14.5] },
        { file, now: () => T0 },
    );
    const [rec] = readLines(file);
    assert.deepEqual(rec.issues, [12, 13]);
    assert.equal(rec.count, 2);
});

test('recordAutoRepair nunca lanza aunque el destino sea inescribible', () => {
    // Un path cuyo "directorio" padre es un archivo: mkdir y append fallan.
    const file = tmpFile();
    fs.writeFileSync(file, '');
    const imposible = path.join(file, 'sub', 'auto-repair.jsonl');
    let r;
    assert.doesNotThrow(() => {
        r = autoRepair.recordAutoRepair({ tipo: 'convergencia_aditiva', issues: [1] }, { file: imposible });
    });
    assert.equal(r.ok, false);
});

// --- CA-7 · dato consultable por el dashboard -------------------------------

test('readLastAutoRepair devuelve null sobre JSONL ausente o vacío, sin lanzar', () => {
    const file = tmpFile();
    assert.equal(autoRepair.readLastAutoRepair({ file }), null, 'archivo ausente');
    fs.writeFileSync(file, '');
    assert.equal(autoRepair.readLastAutoRepair({ file }), null, 'archivo vacío');
    fs.writeFileSync(file, '\n\n  \n');
    assert.equal(autoRepair.readLastAutoRepair({ file }), null, 'sólo líneas en blanco');
});

test('readLastAutoRepair devuelve la última reparación con shape acotado', () => {
    const file = tmpFile();
    autoRepair.recordAutoRepair({ tipo: 'convergencia_aditiva', issues: [1] }, { file, now: () => T0 });
    autoRepair.recordAutoRepair(
        { tipo: 'reparacion_aditiva_wave_add', issues: [42, 43] },
        { file, now: () => T0 + MIN },
    );

    const last = autoRepair.readLastAutoRepair({ file });
    assert.deepEqual(Object.keys(last).sort(), ['issues', 'timestamp', 'tipo']);
    assert.equal(last.tipo, 'reparacion_aditiva_wave_add');
    assert.deepEqual(last.issues, [42, 43]);
    assert.equal(last.timestamp, new Date(T0 + MIN).toISOString());
});

test('readLastAutoRepair ignora una línea final truncada por un crash a mitad de append', () => {
    const file = tmpFile();
    autoRepair.recordAutoRepair({ tipo: 'convergencia_aditiva', issues: [7] }, { file, now: () => T0 });
    fs.appendFileSync(file, '{"tipo":"reparacion_aditiva_wave_add","iss');   // truncada

    const last = autoRepair.readLastAutoRepair({ file });
    assert.notEqual(last, null, 'una línea rota no puede dejar al dashboard sin dato');
    assert.equal(last.tipo, 'convergencia_aditiva');
    assert.deepEqual(last.issues, [7]);
});

// --- CA-5 · detector de repetición ------------------------------------------

test('la (N-1)-ésima repetición NO alerta y la N-ésima SÍ', () => {
    const file = tmpFile();
    const opts = { tipo: 'convergencia_aditiva', threshold: 3, windowMs: 60 * MIN };

    autoRepair.recordAutoRepair({ tipo: 'convergencia_aditiva', issues: [1] }, { file, now: () => T0 });
    let rep = autoRepair.shouldAlertRepetition({ ...opts, nowMs: T0 }, { file });
    assert.equal(rep.alert, false, '1ª reparación: sana');
    assert.equal(rep.count, 1);

    autoRepair.recordAutoRepair({ tipo: 'convergencia_aditiva', issues: [2] }, { file, now: () => T0 + MIN });
    rep = autoRepair.shouldAlertRepetition({ ...opts, nowMs: T0 + MIN }, { file });
    assert.equal(rep.alert, false, '(N-1)-ésima: todavía bajo umbral');
    assert.equal(rep.count, 2);

    autoRepair.recordAutoRepair({ tipo: 'convergencia_aditiva', issues: [3] }, { file, now: () => T0 + 2 * MIN });
    rep = autoRepair.shouldAlertRepetition({ ...opts, nowMs: T0 + 2 * MIN }, { file });
    assert.equal(rep.alert, true, 'N-ésima: alerta de anomalía recurrente');
    assert.equal(rep.count, 3);
    assert.equal(rep.motivo, 'umbral');
    // El payload lleva conteo y ventana: una alerta que no dice cuántas veces
    // ni en cuánto tiempo no es accionable.
    assert.equal(rep.threshold, 3);
    assert.equal(rep.windowMs, 60 * MIN);
});

test('SEC-3: la firma es SÓLO el tipo — sets de issues distintos suman al mismo contador', () => {
    const file = tmpFile();
    // El escenario real: una causa raíz que desarma la lista rompe issues
    // distintos en cada vuelta. Si el set de issues fuera parte de la firma,
    // nunca se alcanzaría el umbral y la causa raíz quedaría invisible.
    autoRepair.recordAutoRepair({ tipo: 'convergencia_aditiva', issues: [111] }, { file, now: () => T0 });
    autoRepair.recordAutoRepair({ tipo: 'convergencia_aditiva', issues: [222, 333] }, { file, now: () => T0 + MIN });
    autoRepair.recordAutoRepair({ tipo: 'convergencia_aditiva', issues: [444] }, { file, now: () => T0 + 2 * MIN });

    const rep = autoRepair.shouldAlertRepetition(
        { tipo: 'convergencia_aditiva', nowMs: T0 + 2 * MIN, threshold: 3, windowMs: 60 * MIN },
        { file },
    );
    assert.equal(rep.alert, true);
    assert.equal(rep.count, 3, 'los tres sets distintos cuentan para el mismo tipo');
});

test('los tipos distintos NO se mezclan entre sí', () => {
    const file = tmpFile();
    for (let i = 0; i < 5; i++) {
        autoRepair.recordAutoRepair(
            { tipo: 'reparacion_aditiva_wave_add', issues: [i + 1] },
            { file, now: () => T0 + i * MIN },
        );
    }
    const rep = autoRepair.shouldAlertRepetition(
        { tipo: 'convergencia_aditiva', nowMs: T0 + 5 * MIN, threshold: 3, windowMs: 60 * MIN },
        { file },
    );
    assert.equal(rep.alert, false);
    assert.equal(rep.count, 0, 'el otro tipo no contamina este contador');
});

test('las reparaciones fuera de la ventana no cuentan', () => {
    const file = tmpFile();
    // Tres reparaciones viejas (hace 2 h) + una reciente. Con ventana de 1 h,
    // sólo cuenta la reciente: repetir cada 2 h no es la anomalía que buscamos.
    autoRepair.recordAutoRepair({ tipo: 'convergencia_aditiva', issues: [1] }, { file, now: () => T0 - 120 * MIN });
    autoRepair.recordAutoRepair({ tipo: 'convergencia_aditiva', issues: [2] }, { file, now: () => T0 - 119 * MIN });
    autoRepair.recordAutoRepair({ tipo: 'convergencia_aditiva', issues: [3] }, { file, now: () => T0 - 118 * MIN });
    autoRepair.recordAutoRepair({ tipo: 'convergencia_aditiva', issues: [4] }, { file, now: () => T0 });

    const rep = autoRepair.shouldAlertRepetition(
        { tipo: 'convergencia_aditiva', nowMs: T0, threshold: 3, windowMs: 60 * MIN },
        { file },
    );
    assert.equal(rep.alert, false);
    assert.equal(rep.count, 1);
});

test('una config fuera de rango se clampea en vez de desactivar la alerta', () => {
    const file = tmpFile();
    for (let i = 0; i < 3; i++) {
        autoRepair.recordAutoRepair({ tipo: 'convergencia_aditiva', issues: [i] }, { file, now: () => T0 + i * MIN });
    }
    // Un threshold basura (no numérico) cae al DEFAULT 3, no al silencio: con 3
    // reparaciones sigue alertando. `0` y negativos clampean al mínimo 2, que
    // alerta antes todavía. `Infinity` NO es finito, así que también cae al
    // default en vez de clampear a la cota superior — que es lo correcto:
    // "avisame nunca" no es una configuración válida del detector.
    for (const threshold of [0, -5, NaN, 'tres', null, undefined, Infinity]) {
        const rep = autoRepair.shouldAlertRepetition(
            { tipo: 'convergencia_aditiva', nowMs: T0 + 2 * MIN, threshold, windowMs: 60 * MIN },
            { file },
        );
        assert.equal(rep.alert, true, `threshold inválido (${String(threshold)}) no puede silenciar la alerta`);
        assert.ok(rep.threshold >= 2 && rep.threshold <= 50, 'threshold clampeado al rango');
    }
    // Un threshold ENORME pero finito es la forma legítima de "avisame menos":
    // se clampea a la cota superior 50 y con 3 reparaciones efectivamente no
    // alerta. Lo que se afirma acá es que quedó ACOTADO — sin clamp, un cero de
    // más en `config.yaml` volvería el detector inalcanzable en la práctica.
    for (const threshold of [99999, 1e9]) {
        const rep = autoRepair.shouldAlertRepetition(
            { tipo: 'convergencia_aditiva', nowMs: T0 + 2 * MIN, threshold, windowMs: 60 * MIN },
            { file },
        );
        assert.equal(rep.threshold, 50, `threshold ${String(threshold)} clampeado a la cota superior`);
    }
    // Lo mismo con la ventana: nunca 0 (que anularía el conteo) ni infinita.
    for (const windowMs of [0, -1, Infinity, 'una hora', null]) {
        const rep = autoRepair.shouldAlertRepetition(
            { tipo: 'convergencia_aditiva', nowMs: T0 + 2 * MIN, threshold: 3, windowMs },
            { file },
        );
        assert.ok(rep.windowMs >= 60000 && rep.windowMs <= 86400000, 'ventana clampeada al rango');
    }
});

// --- SEC-4 · fail-open hacia notificar ---------------------------------------

test('SEC-4: JSONL corrupto ⇒ alert:true (fail-open hacia notificar), nunca false', () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{"tipo":"convergencia_aditiva"} esto no es json\n<<<basura>>>\n');
    const rep = autoRepair.shouldAlertRepetition(
        { tipo: 'convergencia_aditiva', nowMs: T0, threshold: 3, windowMs: 60 * MIN },
        { file },
    );
    assert.equal(rep.alert, true);
    assert.equal(rep.motivo, 'estado_ilegible');
});

test('SEC-4: JSONL ilegible (es un directorio) ⇒ alert:true', () => {
    // Leer un directorio como archivo da EISDIR — el equivalente portable a un
    // permiso denegado, que en Windows no se puede simular con chmod.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `auto-repair-6117-eisdir-${process.pid}-`));
    const rep = autoRepair.shouldAlertRepetition(
        { tipo: 'convergencia_aditiva', nowMs: T0, threshold: 3, windowMs: 60 * MIN },
        { file: dir },
    );
    assert.equal(rep.alert, true);
    assert.equal(rep.motivo, 'estado_ilegible');
});

test('SEC-4: un archivo AUSENTE no es estado ilegible — no hubo reparaciones todavía', () => {
    // La distinción importa: si "nunca reparé" disparara la alerta de anomalía,
    // el pipeline avisaría de una repetición inexistente en cada arranque limpio.
    const file = tmpFile();
    const rep = autoRepair.shouldAlertRepetition(
        { tipo: 'convergencia_aditiva', nowMs: T0, threshold: 3, windowMs: 60 * MIN },
        { file },
    );
    assert.equal(rep.alert, false);
    assert.equal(rep.count, 0);
    assert.equal(rep.motivo, 'bajo_umbral');
});

test('shouldAlertRepetition nunca lanza, cualesquiera sean los argumentos', () => {
    for (const args of [undefined, {}, { tipo: null }, { tipo: 'x', nowMs: 'ayer' }]) {
        assert.doesNotThrow(() => {
            const r = autoRepair.shouldAlertRepetition(args, { file: tmpFile() });
            assert.equal(typeof r.alert, 'boolean');
        });
    }
});
