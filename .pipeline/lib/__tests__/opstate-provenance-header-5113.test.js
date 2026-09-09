'use strict';
//
// #5113 · CA-UX1 — "Procedencia visible".
//
// El operador tiene que poder responder "¿de dónde sale el estado que estoy
// mirando?" desde el tablero. Hoy la respuesta oficial es greppear un YAML:
// válido para un ingeniero con una terminal abierta, inútil para el operador
// que mira el dashboard a las 3 AM en medio de una ventana de cutover.
//
// Este archivo fija el MAPEO CERRADO del mockup 60 (§4): cada condición
// verificable tiene un y sólo un chip. Y fija lo que el CA declara como
// evidencia dura: el chip sale del flag EFECTIVO DEL RUNTIME, no del valor del
// YAML — son cosas distintas cuando hay override por env, que es justamente
// cuando el operador más necesita que el cartel no le mienta.
//
const test = require('node:test');
const assert = require('node:assert/strict');
const slices = require('../dashboard-slices');
const backend = require('../operational-state-backend');
// #6258 — `process.env` se aísla con el helper, nunca a mano: restaura el
// entorno pase lo que pase, incluso si el assert de adentro tira.
const { withEnv } = require('../test-helpers/with-env');

const { resolveOpstateProvenance } = slices;

// ─── El mapeo cerrado del mockup 60 §4 ───────────────────────────────────────

test('CA-UX1: flag de cutover OFF ⇒ chip "filesystem local", sin alerta', () => {
    const p = resolveOpstateProvenance({ mode: 'fs', source: 'config', degraded: false, cutoverWindow: false });
    assert.equal(p.state, 'fs');
    assert.equal(p.symbol, '#');
    assert.match(p.label, /filesystem local/i);
    assert.equal(p.alertable, false);
    // Es el estado esperado del 100% de los días: no compite por atención.
    assert.equal(p.tone, 'neutral');
});

test('CA-UX1: flag ON + sonda en verde ⇒ chip "externo · en línea", sin alerta', () => {
    const p = resolveOpstateProvenance({ mode: 'remote', source: 'config', degraded: false, cutoverWindow: false });
    assert.equal(p.state, 'remote_ok');
    assert.match(p.label, /externo/i);
    assert.match(p.label, /en línea/i);
    assert.equal(p.tone, 'ok');
    assert.equal(p.alertable, false);
});

test('CA-UX1: ventana de cutover abierta ⇒ chip "cutover en curso", alertable', () => {
    const p = resolveOpstateProvenance({ mode: 'remote', source: 'config', degraded: false, cutoverWindow: true });
    assert.equal(p.state, 'cutover');
    assert.equal(p.symbol, '~');
    assert.match(p.label, /cutover en curso/i);
    assert.equal(p.tone, 'warn');
    assert.equal(p.alertable, true);
});

test('CA-UX1: flag ON + store sin responder ⇒ chip "sin respuesta", ALERTABLE con acción', () => {
    const p = resolveOpstateProvenance({ mode: 'remote', source: 'config', degraded: true, cutoverWindow: false });
    assert.equal(p.state, 'remote_down');
    assert.equal(p.symbol, '!');
    assert.match(p.label, /sin respuesta/i);
    assert.equal(p.tone, 'bad');
    assert.equal(p.alertable, true);
    // CA-UX5 — el síntoma nombra la acción: qué está frenado y cómo se vuelve.
    assert.match(p.detail, /DENEGADO/i);
    assert.match(p.detail, /durable: false/);
    // Y deja explícito que NO hubo degradación silenciosa al filesystem.
    assert.match(p.detail, /no degrada a FS/i);
});

test('CA-UX1: la degradación GANA sobre la ventana de cutover (un chip por estado)', () => {
    // El mockup exige "cada estado tiene un y sólo un chip". Cuando las dos
    // condiciones coexisten —el store se cae DURANTE el cutover, que es
    // exactamente cuando más probable es— lo que el operador necesita leer no
    // es "estoy migrando" sino "el dispatch está denegado y el rollback es acá".
    const p = resolveOpstateProvenance({ mode: 'remote', degraded: true, cutoverWindow: true });
    assert.equal(p.state, 'remote_down');
    assert.equal(p.alertable, true);
});

test('CA-UX1: en modo filesystem un rastro viejo de degradación NO pinta el chip de caído', () => {
    // En `fs` el estado sale del disco local: una falla del store no frena
    // nada. Pintar "sin respuesta" acá sería una alerta falsa.
    const p = resolveOpstateProvenance({ mode: 'fs', degraded: true, cutoverWindow: false });
    assert.equal(p.state, 'fs');
    assert.equal(p.alertable, false);
});

test('CA-UX1: los cuatro estados son distinguibles SIN color (regla de diseño 1)', () => {
    const casos = [
        { mode: 'fs', degraded: false, cutoverWindow: false },
        { mode: 'remote', degraded: false, cutoverWindow: false },
        { mode: 'remote', degraded: false, cutoverWindow: true },
        { mode: 'remote', degraded: true, cutoverWindow: false },
    ].map(resolveOpstateProvenance);

    assert.equal(new Set(casos.map((c) => c.state)).size, 4, 'los 4 estados son distintos');
    assert.equal(new Set(casos.map((c) => c.symbol)).size, 4, 'cada estado tiene su símbolo');
    assert.equal(new Set(casos.map((c) => c.label)).size, 4, 'cada estado tiene su etiqueta textual');
    for (const c of casos) {
        assert.ok(c.symbol && c.symbol.length > 0, 'ningún estado se codifica sólo por color');
        assert.ok(c.label && c.label.length > 0);
    }
});

test('CA-UX1: entrada inválida degrada al estado conocido (filesystem), nunca rompe el header', () => {
    for (const basura of [null, undefined, 'remote', 42, [], {}]) {
        const p = resolveOpstateProvenance(basura);
        assert.equal(p.state, 'fs', `entrada: ${JSON.stringify(basura)}`);
        assert.equal(p.alertable, false);
    }
});

// ─── El flag EFECTIVO del runtime, no el YAML ────────────────────────────────

test('CA-UX1: el chip sale del flag EFECTIVO del runtime — un override por env se ve', () => {
    // Ésta es la evidencia central del CA. El YAML dice `durable: false` (es el
    // default versionado y este worktree no lo cambia), pero el runtime puede
    // estar corriendo en remoto por variable de entorno. Si el chip leyera el
    // archivo, mostraría "filesystem local" con el pipeline operando contra el
    // store externo: el cartel mintiendo en la peor ventana posible.
    try {
        withEnv({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
            backend.invalidateConfigCache();
            const desc = backend.describeMode();
            assert.equal(desc.mode, 'remote', 'el runtime quedó en remoto por env');
            assert.equal(desc.source, 'env', 'y la procedencia del flag es la variable, no el archivo');

            const p = resolveOpstateProvenance({ ...desc, cutoverWindow: false });
            assert.equal(p.state, 'remote_ok');
            assert.equal(p.source, 'env');
        });

        // Y el camino inverso: forzar filesystem con el env en '0'.
        withEnv({ PIPELINE_OPSTATE_DURABLE: '0' }, () => {
            backend.invalidateConfigCache();
            const descFs = backend.describeMode();
            assert.equal(descFs.mode, 'fs');
            assert.equal(resolveOpstateProvenance({ ...descFs }).state, 'fs');
        });
    } finally {
        // El caché de config se pobló bajo el env forzado: invalidarlo acá evita
        // que el modo se filtre a los tests que corren después en este proceso.
        backend.invalidateConfigCache();
        backend.clearDegradation();
    }
});

test('CA-UX1: `source` viaja al chip para que el operador distinga env de config', () => {
    assert.equal(resolveOpstateProvenance({ mode: 'remote', source: 'env' }).source, 'env');
    assert.equal(resolveOpstateProvenance({ mode: 'remote', source: 'config' }).source, 'config');
    // Cualquier otro valor cae en el conocido: no se inventan procedencias.
    assert.equal(resolveOpstateProvenance({ mode: 'remote', source: 'vaya-a-saber' }).source, 'config');
});

test('CA-UX1: el chip es DISPLAY-ONLY — no expone nada que permita mutar el flag', () => {
    // Regla de diseño 3: el chip informa, no muta. El dashboard nunca cambia el
    // flag de cutover desde la UI (coherente con D-5: el store es sustrato, no
    // API de mutación).
    const p = resolveOpstateProvenance({ mode: 'remote', degraded: true });
    for (const k of Object.keys(p)) {
        assert.ok(
            ['state', 'symbol', 'label', 'detail', 'tone', 'alertable', 'source'].includes(k),
            `campo inesperado en el payload del chip: ${k}`,
        );
    }
});

// ─── El chip llega al payload del header ─────────────────────────────────────

test('CA-UX1: headerSlice publica `opstate` (el chip tiene productor, no es markup huérfano)', (t) => {
    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opstate-header-5113-'));
    t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ } });

    const slice = slices.headerSlice(
        { procesos: {}, issueMatrix: {}, activeWave: null },
        { PIPELINE: tmp },
    );

    assert.ok(slice.opstate, 'el slice del header publica la procedencia');
    assert.equal(typeof slice.opstate.label, 'string');
    assert.equal(typeof slice.opstate.symbol, 'string');
    assert.ok(['fs', 'remote_ok', 'cutover', 'remote_down'].includes(slice.opstate.state));
    // Con el flag apagado (default versionado) el tablero dice filesystem.
    assert.equal(slice.opstate.state, 'fs');
    // Y no rompió nada del payload histórico del header.
    assert.equal(typeof slice.mode, 'string');
    assert.ok(Array.isArray(slice.allowedIssues));
    assert.ok(slice.counts);
});

// ─── El WIRING real: de la config al chip (rebote rev-5) ─────────────────────
//
// Los tests de arriba le pasan `cutoverWindow` a mano a la funcion PURA, que
// esta bien y siempre lo estuvo. El defecto vivia en la OTRA mitad: el lector
// de la config (`readOpstateRuntime`) preguntaba por `resolve({}).config`, una
// forma que el resolver no devuelve — el documento viene directo. `cfg` quedaba
// en `{}` SIEMPRE y el chip "cutover en curso" era inalcanzable por
// construccion, con los 10 tests puros en verde.
//
// De ahi que estos tests ejerciten `readOpstateRuntime` y `headerSlice` con la
// ventana declarada abierta, y no el mapeo puro: un CA que exige los cuatro
// estados del mockup no se puede dar por cubierto sin recorrer el camino que
// los produce en produccion.

const configResolver = require('../config-resolver');

/** Sustituye `resolve` del resolver YA CACHEADO (misma referencia que ve el
 *  dashboard) y devuelve el restaurador. */
function conConfig(doc, fn) {
    const original = configResolver.resolve;
    configResolver.resolve = () => doc;
    try { return fn(); } finally { configResolver.resolve = original; }
}

test('CA-UX1 (wiring): `kernel.cutover_window: true` en la config ⇒ el runtime declara la ventana abierta', () => {
    const rt = conConfig({ kernel: { cutover_window: true } }, () => slices.readOpstateRuntime());
    assert.equal(rt.cutoverWindow, true,
        'el lector no vio la ventana declarada: el chip de cutover queda inalcanzable');
});

test('CA-UX1 (wiring): sin la clave en la config ⇒ no hay ventana declarada', () => {
    assert.equal(conConfig({ kernel: {} }, () => slices.readOpstateRuntime()).cutoverWindow, false);
    assert.equal(conConfig({}, () => slices.readOpstateRuntime()).cutoverWindow, false);
    // Estricto con `=== true`, igual que el flag de cutover: nada de coercion.
    assert.equal(conConfig({ kernel: { cutover_window: 'true' } }, () => slices.readOpstateRuntime()).cutoverWindow, false);
    assert.equal(conConfig({ kernel: { cutover_window: 1 } }, () => slices.readOpstateRuntime()).cutoverWindow, false);
});

test('CA-UX1 (wiring): config ilegible ⇒ el runtime no explota y degrada a "sin ventana"', () => {
    const original = configResolver.resolve;
    configResolver.resolve = () => { throw new Error('config rota'); };
    try {
        const rt = slices.readOpstateRuntime();
        assert.equal(rt.cutoverWindow, false);
        assert.equal(typeof rt.mode, 'string', 'un cartel roto no puede tumbar el header');
    } finally { configResolver.resolve = original; }
});

test('CA-UX1 (E2E): con la ventana de cutover abierta, `headerSlice` publica el chip "cutover en curso"', (t) => {
    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opstate-header-cutover-5113-'));
    t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ } });

    const slice = conConfig({ kernel: { cutover_window: true } }, () => slices.headerSlice(
        { procesos: {}, issueMatrix: {}, activeWave: null },
        { PIPELINE: tmp },
    ));

    // Este es EL assert del rebote: es el estado que estaba inalcanzable.
    assert.equal(slice.opstate.state, 'cutover',
        'la ventana de cutover esta declarada abierta y el tablero sigue diciendo otra cosa');
    assert.equal(slice.opstate.symbol, '~');
    assert.equal(slice.opstate.alertable, true);
});

test('CA-UX1 (E2E): los CUATRO estados del mockup 60 son alcanzables desde `headerSlice`', (t) => {
    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opstate-header-4estados-5113-'));
    t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ } });

    const render = (doc, env) => withEnv(env, () => conConfig(doc, () => slices.headerSlice(
        { procesos: {}, issueMatrix: {}, activeWave: null }, { PIPELINE: tmp },
    ).opstate.state));

    const sinVentana = { kernel: {} };
    assert.equal(render(sinVentana, { PIPELINE_OPSTATE_DURABLE: '0' }), 'fs');
    assert.equal(render({ kernel: { cutover_window: true } }, { PIPELINE_OPSTATE_DURABLE: '0' }), 'cutover');

    backend.clearDegradation();
    assert.equal(render(sinVentana, { PIPELINE_OPSTATE_DURABLE: '1' }), 'remote_ok');

    // La degradacion se produce como en produccion: una lectura remota real que
    // falla. Marcarla a mano probaria el cartel, no el camino que lo enciende.
    const { createFakeSyncDynamoDriver } = require('./fixtures/fake-sync-dynamo-driver');
    backend._setDriverForTests({
        driver: createFakeSyncDynamoDriver({ failWith: new Error('ETIMEDOUT (test)') }),
        spec: { type: 'dynamodb_table', tableName: 'tabla-fake', keys: [] },
        projectId: 'intrale-platform',
        instanceId: 'intrale-platform',
        atomicUpdate: true,
    });
    try {
        const lectura = withEnv({ PIPELINE_OPSTATE_DURABLE: '1' },
            () => backend.readKeyWithVersion(backend.KEYS.WAVES));
        assert.equal(lectura.degraded, true, 'la lectura fallida no marco degradacion');
        assert.equal(render(sinVentana, { PIPELINE_OPSTATE_DURABLE: '1' }), 'remote_down');
    } finally {
        backend._setDriverForTests(null);
        backend.clearDegradation();
        backend.invalidateConfigCache();
    }
});
