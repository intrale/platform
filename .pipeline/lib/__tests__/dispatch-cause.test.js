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

const dc = require('../dispatch-cause');
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
    [CAUSAS.MODO_OLA, 'Modo de ejecución en olas'],
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

test('los 10 gates conocidos están cubiertos por la precedencia', () => {
    assert.strictEqual(dc.PRECEDENCIA.length, 10);
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
    // Tick 1: causa nueva ALERTABLE → alerta.
    dc.publish({ pipelineDir: dir, snapshot: snap({ gatesActivos: new Set([CAUSAS.PRESION_RECURSOS]) }), now: NOW, alert });
    assert.strictEqual(alerts.length, 1);
    // Tick 2: misma causa → sin nueva alerta, ts preservado, lastSeenTs avanza.
    dc.publish({ pipelineDir: dir, snapshot: snap({ gatesActivos: new Set([CAUSAS.PRESION_RECURSOS]) }), now: NOW + 5000, alert });
    assert.strictEqual(alerts.length, 1, 'no re-alerta una causa no-anómala persistente');
    const disk = JSON.parse(fs.readFileSync(dc.artifactPath(dir), 'utf8'));
    assert.strictEqual(disk.ts, NOW, 'ts de inicio preservado');
    assert.strictEqual(disk.lastSeenTs, NOW + 5000, 'lastSeenTs refleja el último tick');
    // Tick 3: causa distinta (también alertable) → nueva alerta + ts nuevo.
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

// =============================================================================
// #4751 — Clasificación alertable vs. silenciosa. La notificación de "cola
// ociosa" (Telegram) sólo debe emitirse por causas que ameriten intervención;
// el banner (artifact en disco) se publica SIEMPRE.
// =============================================================================

// Publica una causa y devuelve cuántas alertas Telegram se emitieron + si quedó
// el artifact (banner) en disco.
function publishAndProbe(gate, detalle) {
    const dir = tmpDir();
    const alerts = [];
    dc.publish({
        pipelineDir: dir,
        snapshot: snap({ gatesActivos: new Set([gate]), detalles: detalle ? { [gate]: detalle } : {} }),
        now: NOW,
        alert: (m) => alerts.push(m),
    });
    return { alerts, bannerPublicado: fs.existsSync(dc.artifactPath(dir)) };
}

test('CA-1/CA-4/CA-5: MODO_OLA publica banner pero NO alerta a Telegram (silenciosa)', () => {
    const { alerts, bannerPublicado } = publishAndProbe(
        CAUSAS.MODO_OLA, 'Modo de ejecución en olas — sólo se despachan los issues de la ola activa');
    assert.strictEqual(alerts.length, 0, 'modo ola NO debe alertar (estado esperado)');
    assert.strictEqual(bannerPublicado, true, 'el banner del dashboard SÍ se publica');
});

test('MODO_OLA no está en CAUSAS_ALERTABLES; su label no dice "Detenido"/"pausa parcial"', () => {
    assert.strictEqual(dc.CAUSAS_ALERTABLES.has(CAUSAS.MODO_OLA), false);
    const label = dc.LABELS[CAUSAS.MODO_OLA];
    assert.strictEqual(label, 'Modo de ejecución en olas');
    assert.doesNotMatch(label, /Detenido por humano/i);
    assert.doesNotMatch(label, /pausa parcial/i);
});

test('CA-2: PRESION_RECURSOS (saturación) SÍ alerta indicando el motivo real', () => {
    const { alerts } = publishAndProbe(CAUSAS.PRESION_RECURSOS, 'Sistema sobrecargado (presión de recursos RED)');
    assert.strictEqual(alerts.length, 1);
    assert.match(alerts[0], /Presión de recursos/);
    assert.doesNotMatch(alerts[0], /Detenido por humano/i);
});

test('CA-3: DEADLOCK y HALT_HUMANO (deadlock humano) SÍ alertan', () => {
    assert.strictEqual(publishAndProbe(CAUSAS.DEADLOCK).alerts.length, 1);
    assert.strictEqual(publishAndProbe(CAUSAS.HALT_HUMANO).alerts.length, 1);
    assert.strictEqual(publishAndProbe(CAUSAS.BLOQUEO_DEPENDENCIA).alerts.length, 1);
    assert.strictEqual(publishAndProbe(CAUSAS.CB_INFRA).alerts.length, 1);
});

test('causas transitorias esperadas NO alertan (banner sí): VENTANA/REST/COOLDOWN/SIN_AGENTES', () => {
    for (const gate of [CAUSAS.VENTANA_HORARIA, CAUSAS.REST_MODE, CAUSAS.COOLDOWN, CAUSAS.SIN_AGENTES]) {
        const { alerts, bannerPublicado } = publishAndProbe(gate);
        assert.strictEqual(alerts.length, 0, `${gate} no debe alertar`);
        assert.strictEqual(bannerPublicado, true, `${gate} debe publicar banner`);
    }
});

test('CA-7: coexistencia modo ola + saturación → gana PRESION_RECURSOS y alerta', () => {
    const dir = tmpDir();
    const alerts = [];
    const out = dc.publish({
        pipelineDir: dir,
        snapshot: snap({ gatesActivos: new Set([CAUSAS.MODO_OLA, CAUSAS.PRESION_RECURSOS]) }),
        now: NOW,
        alert: (m) => alerts.push(m),
    });
    assert.strictEqual(out.causa, CAUSAS.PRESION_RECURSOS, 'la saturación gana a MODO_OLA en PRECEDENCIA');
    assert.strictEqual(alerts.length, 1, 'y por ser alertable, emite la notificación');
});

test('CA-6: causa ausente/ilegible → anomalía SÍ alerta (fail-closed) aunque no esté en el set', () => {
    // Cola con pendientes y ningún gate conocido → ANOMALIA. No está en
    // CAUSAS_ALERTABLES, pero debe alertar igual por ser anomalía (R1).
    assert.strictEqual(dc.CAUSAS_ALERTABLES.has(CAUSAS.ANOMALIA), false);
    const { alerts } = publishAndProbe(/* sin gate → anomalía */);
    assert.strictEqual(alerts.length, 1, 'la anomalía nunca se silencia');
    assert.match(alerts[0], /ANOMAL/i);
});

// =============================================================================
// #5400 — Dimensión DURACIÓN: una causa silenciosa sostenida escala a alertable.
//
// El agujero que cierra: el 2026-08-02 el pipeline estuvo 1h33 sin despachar con
// una causa silenciosa declarada y no llegó ningún aviso. Una causa explica un
// rato de no-despacho, no lo explica para siempre.
// =============================================================================

const ESCALATE_MS = dc.DEFAULT_SILENT_ESCALATE_MS;

/** Publica la MISMA causa silenciosa dos veces, separadas por `deltaMs`. */
function publicarSostenida(gate, deltaMs, extra = {}) {
    const dir = tmpDir();
    const alerts = [];
    const comun = {
        pipelineDir: dir,
        snapshot: snap({ gatesActivos: new Set([gate]) }),
        alert: (m) => alerts.push(m),
        ...extra,
    };
    // t0: la causa aparece. Silenciosa → no alerta.
    dc.publish({ ...comun, now: NOW });
    // t0 + delta: la causa sigue vigente.
    const out = dc.publish({ ...comun, now: NOW + deltaMs });
    return { dir, alerts, out };
}

test('#5400: una causa silenciosa sostenida con elegibles esperando escala a alertable', () => {
    const { alerts, out } = publicarSostenida(CAUSAS.MODO_OLA, ESCALATE_MS + 1, {
        elegiblesEsperando: 7,
    });
    assert.strictEqual(alerts.length, 1, 'debe emitir el aviso por duración');
    assert.strictEqual(out.escaladoPorDuracion, true);
    // El aviso nombra la causa concreta y el trabajo que está esperando (CA-2).
    assert.match(alerts[0], /Modo de ejecución en olas/);
    assert.match(alerts[0], /7 elegible\(s\) esperando/);
    assert.match(alerts[0], /min sin despachar/);
});

test('#5400: por debajo del umbral la causa silenciosa sigue muda (no-regresión #4751)', () => {
    const { alerts, out } = publicarSostenida(CAUSAS.MODO_OLA, ESCALATE_MS - 60_000, {
        elegiblesEsperando: 7,
    });
    assert.strictEqual(alerts.length, 0, 'modo ola reciente no debe hacer ruido');
    assert.strictEqual(out.escaladoPorDuracion, false);
});

test('#5400: sin elegibles esperando una causa silenciosa NO escala por más vieja que sea', () => {
    // Cola legítimamente vacía de trabajo habilitado → nada que reclamar (CA-3).
    const { alerts, out } = publicarSostenida(CAUSAS.MODO_OLA, ESCALATE_MS * 10, {
        elegiblesEsperando: 0,
    });
    assert.strictEqual(alerts.length, 0);
    assert.strictEqual(out.escaladoPorDuracion, false);
});

test('#5400: un caller que no pasa los parámetros nuevos conserva la conducta de #4751', () => {
    // Aditividad estricta: sin `elegiblesEsperando` no hay escalada posible.
    const { alerts, out } = publicarSostenida(CAUSAS.MODO_OLA, ESCALATE_MS * 10);
    assert.strictEqual(alerts.length, 0);
    assert.strictEqual(out.escaladoPorDuracion, false);
});

test('#5400: la escalada por duración aplica a todas las causas silenciosas', () => {
    for (const gate of [CAUSAS.MODO_OLA, CAUSAS.VENTANA_HORARIA, CAUSAS.COOLDOWN, CAUSAS.SIN_AGENTES]) {
        const { alerts } = publicarSostenida(gate, ESCALATE_MS + 1, { elegiblesEsperando: 3 });
        assert.strictEqual(alerts.length, 1, `${gate} sostenida debe escalar`);
    }
});

test('#5400: el aviso por duración no se repite en cada ciclo: hay backoff verificable', () => {
    const dir = tmpDir();
    const alerts = [];
    const comun = {
        pipelineDir: dir,
        snapshot: snap({ gatesActivos: new Set([CAUSAS.MODO_OLA]) }),
        alert: (m) => alerts.push(m),
        elegiblesEsperando: 4,
    };
    dc.publish({ ...comun, now: NOW });                       // aparece: muda
    dc.publish({ ...comun, now: NOW + ESCALATE_MS + 1 });      // escala: 1 aviso
    assert.strictEqual(alerts.length, 1);

    // Ticks siguientes dentro del cooldown → mudos, aunque siga escalada.
    for (const delta of [60_000, 5 * 60_000, 20 * 60_000]) {
        dc.publish({ ...comun, now: NOW + ESCALATE_MS + 1 + delta });
    }
    assert.strictEqual(alerts.length, 1, 'no debe re-alertar dentro del cooldown');

    // Pasado el cooldown → re-avisa una sola vez más.
    dc.publish({ ...comun, now: NOW + ESCALATE_MS + 1 + dc.ANOMALY_REALERT_COOLDOWN_MS + 1 });
    assert.strictEqual(alerts.length, 2, 'pasado el cooldown vuelve a avisar');
});

test('#5400: una causa YA alertable no cambia de conducta por la dimensión duración', () => {
    // PRESION_RECURSOS ya alertaba en la transición; no debe duplicar avisos.
    const { alerts, out } = publicarSostenida(CAUSAS.PRESION_RECURSOS, ESCALATE_MS + 1, {
        elegiblesEsperando: 9,
    });
    assert.strictEqual(out.escaladoPorDuracion, false, 'no es una causa silenciosa');
    assert.strictEqual(alerts.length, 1, 'sólo el aviso de transición de siempre');
});

test('#5400: la causa recién declarada nunca escala en la misma pasada', () => {
    const dir = tmpDir();
    const alerts = [];
    const out = dc.publish({
        pipelineDir: dir,
        snapshot: snap({ gatesActivos: new Set([CAUSAS.MODO_OLA]) }),
        now: NOW,
        alert: (m) => alerts.push(m),
        elegiblesEsperando: 50,
    });
    assert.strictEqual(out.escaladoPorDuracion, false, 'edad 0 no puede superar el umbral');
    assert.strictEqual(alerts.length, 0);
});
