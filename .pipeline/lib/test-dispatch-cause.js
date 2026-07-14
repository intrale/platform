'use strict';

// =============================================================================
// test-dispatch-cause.js — Suite del módulo `lib/dispatch-cause.js` (#4709).
// Framework: node --test (built-in, sin dependencias).
//
// Cubre:
//   - AC-2: tabla motivo→causa para los ≥9 gates conocidos.
//   - AC-2: precedencia determinística con varios gates simultáneos.
//   - AC-3: anomalía fail-closed (pendientes + sin causa conocida).
//   - AC-1: no publica ociosidad cuando anyLaunched===true / cola vacía /
//     progreso en vuelo → resolveCause devuelve null.
//   - AC-6: whitelist de enum (writeArtifact rechaza causa inválida).
//   - AC-4/SEC-4: write atómico, transición de causa, re-alerta de anomalía,
//     fallo de escritura sin artifact stale.
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dc = require('./dispatch-cause');
const { CAUSAS } = dc;

// --- Helpers -----------------------------------------------------------------

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-cause-'));
}

function snap(overrides) {
    return Object.assign({
        anyLaunched: false,
        hayPendientes: true,
        gatesActivos: new Set(),
        detalles: {},
        progressInFlight: false,
    }, overrides);
}

const NOW = 1_720_000_000_000;

// --- AC-2: tabla motivo → causa (≥9 gates) -----------------------------------

const TABLA_GATES = [
    [CAUSAS.HALT_HUMANO, 'Detenido por humano'],
    [CAUSAS.CB_INFRA, 'Circuit breaker de infraestructura'],
    [CAUSAS.PRESION_RECURSOS, 'Presión de recursos'],
    [CAUSAS.VENTANA_HORARIA, 'Fuera de ventana horaria'],
    [CAUSAS.REST_MODE, 'Modo descanso'],
    [CAUSAS.COOLDOWN, 'En cooldown'],
    [CAUSAS.BLOQUEO_DEPENDENCIA, 'Bloqueado por dependencia'],
    [CAUSAS.DEADLOCK, 'Deadlock detectado'],
    [CAUSAS.SIN_AGENTES, 'Sin agentes disponibles'],
];

for (const [causa, labelEsperado] of TABLA_GATES) {
    test(`resolveCause mapea el gate ${causa} a su causa/label`, () => {
        const r = dc.resolveCause(snap({ gatesActivos: new Set([causa]) }), NOW);
        assert.ok(r, 'debe devolver una causa');
        assert.strictEqual(r.causa, causa);
        assert.strictEqual(r.label, labelEsperado);
        assert.strictEqual(r.anomalia, false);
        assert.strictEqual(r.ts, NOW);
    });
}

test('los 9 gates conocidos están cubiertos por la precedencia', () => {
    assert.strictEqual(dc.PRECEDENCIA.length, 9);
    for (const [causa] of TABLA_GATES) {
        assert.ok(dc.PRECEDENCIA.includes(causa), `PRECEDENCIA debe incluir ${causa}`);
    }
});

// --- AC-2: precedencia determinística ----------------------------------------

test('con varios gates activos gana el de mayor precedencia (halt sobre presión)', () => {
    const r = dc.resolveCause(snap({
        gatesActivos: new Set([CAUSAS.PRESION_RECURSOS, CAUSAS.HALT_HUMANO, CAUSAS.SIN_AGENTES]),
    }), NOW);
    assert.strictEqual(r.causa, CAUSAS.HALT_HUMANO);
});

test('precedencia: cb_infra gana sobre presión y ventana', () => {
    const r = dc.resolveCause(snap({
        gatesActivos: new Set([CAUSAS.VENTANA_HORARIA, CAUSAS.CB_INFRA, CAUSAS.PRESION_RECURSOS]),
    }), NOW);
    assert.strictEqual(r.causa, CAUSAS.CB_INFRA);
});

test('precedencia es estable ante distinto orden de inserción en el Set', () => {
    const a = dc.resolveCause(snap({ gatesActivos: new Set([CAUSAS.SIN_AGENTES, CAUSAS.COOLDOWN]) }), NOW);
    const b = dc.resolveCause(snap({ gatesActivos: new Set([CAUSAS.COOLDOWN, CAUSAS.SIN_AGENTES]) }), NOW);
    assert.strictEqual(a.causa, b.causa);
    assert.strictEqual(a.causa, CAUSAS.COOLDOWN);
});

test('detalle se propaga desde el mapa de detalles', () => {
    const r = dc.resolveCause(snap({
        gatesActivos: new Set([CAUSAS.COOLDOWN]),
        detalles: { [CAUSAS.COOLDOWN]: 'skill=tester issue=#123 penalizado' },
    }), NOW);
    assert.match(r.detalle, /skill=tester/);
});

// --- AC-3: anomalía fail-closed ----------------------------------------------

test('pendientes + sin causa conocida → anomalia_no_determinable', () => {
    const r = dc.resolveCause(snap({ gatesActivos: new Set() }), NOW);
    assert.ok(r);
    assert.strictEqual(r.causa, CAUSAS.ANOMALIA);
    assert.strictEqual(r.anomalia, true);
    assert.ok(r.detalle.length > 0, 'la anomalía nunca queda en blanco');
});

test('anomalía usa detalle explícito si se provee', () => {
    const r = dc.resolveCause(snap({ gatesActivos: new Set(), detalles: { anomalia: 'estado X inesperado' } }), NOW);
    assert.strictEqual(r.causa, CAUSAS.ANOMALIA);
    assert.match(r.detalle, /estado X/);
});

// --- AC-1: no publica ociosidad ----------------------------------------------

test('anyLaunched===true → resolveCause devuelve null (no publica ociosidad)', () => {
    assert.strictEqual(dc.resolveCause(snap({ anyLaunched: true, gatesActivos: new Set([CAUSAS.COOLDOWN]) }), NOW), null);
});

test('cola vacía → resolveCause devuelve null', () => {
    assert.strictEqual(dc.resolveCause(snap({ hayPendientes: false }), NOW), null);
});

test('progreso en vuelo sin gates → null (no es anomalía, hay agentes trabajando)', () => {
    assert.strictEqual(dc.resolveCause(snap({ progressInFlight: true, gatesActivos: new Set() }), NOW), null);
});

test('progreso en vuelo NO enmascara un gate real', () => {
    const r = dc.resolveCause(snap({ progressInFlight: true, gatesActivos: new Set([CAUSAS.VENTANA_HORARIA]) }), NOW);
    assert.strictEqual(r.causa, CAUSAS.VENTANA_HORARIA);
});

// --- AC-6: whitelist de enum -------------------------------------------------

test('writeArtifact rechaza una causa fuera del enum cerrado', () => {
    const dir = tmpDir();
    assert.throws(
        () => dc.writeArtifact(dir, { causa: 'valor_arbitrario', anomalia: false }),
        /fuera del enum/,
    );
    assert.strictEqual(fs.existsSync(dc.artifactPath(dir)), false, 'no debe dejar artifact con causa inválida');
});

test('validateCause exige anomalia boolean', () => {
    assert.throws(() => dc.validateCause({ causa: CAUSAS.COOLDOWN, anomalia: 'no' }), /anomalia/);
});

// --- AC-4 / SEC-4: publish, write atómico, transición, anti-stale ------------

test('publish escribe el artifact atómico con shape estable', () => {
    const dir = tmpDir();
    const out = dc.publish({
        pipelineDir: dir,
        snapshot: snap({ gatesActivos: new Set([CAUSAS.PRESION_RECURSOS]), detalles: { [CAUSAS.PRESION_RECURSOS]: 'RAM 92%' } }),
        now: NOW,
    });
    assert.ok(out);
    const disk = JSON.parse(fs.readFileSync(dc.artifactPath(dir), 'utf8'));
    assert.strictEqual(disk.causa, CAUSAS.PRESION_RECURSOS);
    assert.strictEqual(disk.ts, NOW);
    assert.strictEqual(disk.lastSeenTs, NOW);
    assert.strictEqual(disk.anomalia, false);
    // No debe quedar el tmp.
    const stray = fs.readdirSync(dir).filter(f => f.includes('.tmp'));
    assert.deepStrictEqual(stray, [], 'no debe quedar archivo temporal');
});

test('publish limpia el artifact cuando el ciclo despacha', () => {
    const dir = tmpDir();
    dc.publish({ pipelineDir: dir, snapshot: snap({ gatesActivos: new Set([CAUSAS.COOLDOWN]) }), now: NOW });
    assert.ok(fs.existsSync(dc.artifactPath(dir)));
    dc.publish({ pipelineDir: dir, snapshot: snap({ anyLaunched: true }), now: NOW + 1000 });
    assert.strictEqual(fs.existsSync(dc.artifactPath(dir)), false, 'debe borrar el artifact stale al despachar');
});

test('publish alerta en transición de causa y preserva ts mientras la causa persiste', () => {
    const dir = tmpDir();
    const alerts = [];
    const alert = (m) => alerts.push(m);
    // Tick 1: causa nueva → alerta.
    dc.publish({ pipelineDir: dir, snapshot: snap({ gatesActivos: new Set([CAUSAS.COOLDOWN]) }), now: NOW, alert });
    assert.strictEqual(alerts.length, 1);
    // Tick 2: misma causa → sin nueva alerta, ts preservado, lastSeenTs avanza.
    dc.publish({ pipelineDir: dir, snapshot: snap({ gatesActivos: new Set([CAUSAS.COOLDOWN]) }), now: NOW + 5000, alert });
    assert.strictEqual(alerts.length, 1, 'no re-alerta una causa no-anómala persistente');
    const disk = JSON.parse(fs.readFileSync(dc.artifactPath(dir), 'utf8'));
    assert.strictEqual(disk.ts, NOW, 'ts de inicio preservado');
    assert.strictEqual(disk.lastSeenTs, NOW + 5000, 'lastSeenTs refleja el último tick');
    // Tick 3: causa distinta → nueva alerta + ts nuevo.
    dc.publish({ pipelineDir: dir, snapshot: snap({ gatesActivos: new Set([CAUSAS.CB_INFRA]) }), now: NOW + 9000, alert });
    assert.strictEqual(alerts.length, 2);
    const disk2 = JSON.parse(fs.readFileSync(dc.artifactPath(dir), 'utf8'));
    assert.strictEqual(disk2.ts, NOW + 9000);
});

test('anomalía persistente re-alerta pasado el cooldown (no silencio permanente)', () => {
    const dir = tmpDir();
    const alerts = [];
    const alert = (m) => alerts.push(m);
    const anomalSnap = () => snap({ gatesActivos: new Set() });
    dc.publish({ pipelineDir: dir, snapshot: anomalSnap(), now: NOW, alert });
    assert.strictEqual(alerts.length, 1);
    // Dentro del cooldown → no re-alerta.
    dc.publish({ pipelineDir: dir, snapshot: anomalSnap(), now: NOW + 1000, alert });
    assert.strictEqual(alerts.length, 1);
    // Pasado el cooldown → re-alerta.
    dc.publish({ pipelineDir: dir, snapshot: anomalSnap(), now: NOW + dc.ANOMALY_REALERT_COOLDOWN_MS + 1, alert });
    assert.strictEqual(alerts.length, 2, 'la anomalía persistente debe re-alertar');
});

test('fallo de escritura → no deja artifact stale + declara anomalía (fail-closed)', () => {
    const dir = tmpDir();
    // Sembrar un artifact previo "vigente".
    dc.publish({ pipelineDir: dir, snapshot: snap({ gatesActivos: new Set([CAUSAS.COOLDOWN]) }), now: NOW });
    assert.ok(fs.existsSync(dc.artifactPath(dir)));
    // Forzar fallo de escritura: apuntar a un pipelineDir inexistente hace que
    // writeFileSync del tmp falle (ENOENT). Verificamos que se declara anomalía
    // vía alerta y que no queda stale en ESE dir.
    const badDir = path.join(dir, 'no', 'existe');
    const alerts = [];
    const out = dc.publish({
        pipelineDir: badDir,
        snapshot: snap({ gatesActivos: new Set() }),
        now: NOW + 1000,
        alert: (m) => alerts.push(m),
    });
    assert.strictEqual(out, null, 'no retorna artifact si el write falló');
    assert.strictEqual(fs.existsSync(dc.artifactPath(badDir)), false, 'no deja artifact stale');
    assert.strictEqual(alerts.length, 1, 'declara el fallo como anomalía vía alerta');
    assert.match(alerts[0], /anomal/i);
});

test('detalle con secrets se redacta antes de persistir (defensa en profundidad)', () => {
    const dir = tmpDir();
    dc.publish({
        pipelineDir: dir,
        snapshot: snap({
            gatesActivos: new Set([CAUSAS.BLOQUEO_DEPENDENCIA]),
            detalles: { [CAUSAS.BLOQUEO_DEPENDENCIA]: 'token AKIAIOSFODNN7EXAMPLE en config' },
        }),
        now: NOW,
    });
    const disk = JSON.parse(fs.readFileSync(dc.artifactPath(dir), 'utf8'));
    assert.doesNotMatch(disk.detalle, /AKIAIOSFODNN7EXAMPLE/, 'el AWS key debe estar redactado');
});

// Nota de seguridad XSS: el escape de `detalle` (payload <img src=x onerror=...>)
// es responsabilidad del RENDER en el dashboard (`escapeHtmlText`/`escapeHtmlAttr`
// de lib/escape-html.js), no de este módulo. El módulo persiste el string tal
// cual (redactado); el test de escape vive junto al render del dashboard.
test('el módulo NO altera caracteres HTML del detalle (el escape es del render)', () => {
    const dir = tmpDir();
    const payload = '<img src=x onerror=alert(1)>';
    dc.publish({
        pipelineDir: dir,
        snapshot: snap({ gatesActivos: new Set([CAUSAS.DEADLOCK]), detalles: { [CAUSAS.DEADLOCK]: payload } }),
        now: NOW,
    });
    const disk = JSON.parse(fs.readFileSync(dc.artifactPath(dir), 'utf8'));
    // El string se guarda literal (el render lo escapará); acá sólo confirmamos
    // que el módulo no lo "sanea a medias" (que sería un falso sentido de seguridad).
    assert.ok(disk.detalle.includes('<img'), 'el módulo persiste el detalle literal; el escape es del render');
});
