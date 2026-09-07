'use strict';

// Tests del barrido persistente de process-transitions.js (#6441).
// Archivo aparte de `process-transitions.test.js` (que cubre EP8-H7 #3960),
// siguiendo el patrón del repo de un suite por issue cuando el original ya está
// cerrado y verde.
//
// node --test .pipeline/lib/process-transitions-sweep-6441.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pt = require('./process-transitions');

function tmpPipeline() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt6441-'));
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    return dir;
}

// ===========================================================================
// recordSweep — el flanco deja de depender de la memoria del proceso.
// ===========================================================================

test('#6441: recordSweep detecta el flanco aunque el proceso que barre reinicie entre medio', () => {
    // Es el caso exacto que se perdió durante un mes: el watchdog es efímero
    // (Task Scheduler cada 2 min). Con estado en memoria sembraría en cada
    // corrida y no detectaría un solo flanco jamás.
    const dir = tmpPipeline();
    const opts = { pipelineDir: dir };

    // Corrida 1 (proceso A): siembra, y la siembra PERSISTE.
    const r1 = pt.recordSweep({ 'svc-reconciler': { alive: true } }, { ...opts, now: 1000 });
    assert.strictEqual(r1.length, 1);
    assert.strictEqual(r1[0].reason, 'seed');
    assert.strictEqual(r1[0].from, 'unknown');
    assert.strictEqual(r1[0].to, 'alive');

    // Corrida 2 (proceso B, sin ninguna memoria de A): el servicio murió.
    pt.__forTestsOnly__._resetState(); // simula el proceso nuevo
    const r2 = pt.recordSweep({ 'svc-reconciler': { alive: false } }, { ...opts, now: 2000 });
    assert.strictEqual(r2.length, 1, 'el flanco SÍ se detecta con el proceso reiniciado');
    assert.strictEqual(r2[0].from, 'alive');
    assert.strictEqual(r2[0].to, 'dead');

    // Corrida 3 (proceso C): sigue muerto, no se duplica la línea.
    pt.__forTestsOnly__._resetState();
    const r3 = pt.recordSweep({ 'svc-reconciler': { alive: false } }, { ...opts, now: 3000 });
    assert.strictEqual(r3.length, 0, 'sin flanco no se escribe');

    // Corrida 4: vuelve. Queda el 'recovered' que hoy sí aparece en el store.
    pt.__forTestsOnly__._resetState();
    const r4 = pt.recordSweep({ 'svc-reconciler': { alive: true } }, { ...opts, now: 4000 });
    assert.strictEqual(r4[0].reason, 'recovered');
});

test('#6441: la siembra PERSISTE en disco (si no, el flanco se perdería para siempre)', () => {
    // Guard de regresión del bug sutil: si la siembra fuera sólo en memoria, un
    // servicio sin historial se re-sembraría en cada corrida efímera y su
    // muerte nunca quedaría registrada.
    const dir = tmpPipeline();
    pt.recordSweep({ 'svc-drive': { alive: true } }, { pipelineDir: dir, now: 1000 });
    const prev = pt.readPrevStates({ pipelineDir: dir });
    assert.strictEqual(prev['svc-drive'], 'alive', 'la línea base quedó en disco');
});

test('#6441: readPrevStates devuelve el último estado de cada servicio', () => {
    const dir = tmpPipeline();
    const opts = { pipelineDir: dir };
    pt.recordSweep({ 'pulpo': { alive: true }, 'svc-drive': { alive: true } }, { ...opts, now: 1000 });
    pt.recordSweep({ 'pulpo': { alive: false }, 'svc-drive': { alive: true } }, { ...opts, now: 2000 });
    pt.recordSweep({ 'pulpo': { alive: true }, 'svc-drive': { alive: true } }, { ...opts, now: 3000 });

    const prev = pt.readPrevStates(opts);
    assert.strictEqual(prev['pulpo'], 'alive', 'gana la última línea, no la primera');
    assert.strictEqual(prev['svc-drive'], 'alive');
    assert.strictEqual(prev['inexistente'], undefined);
});

test('#6441: readPrevStates sobre un store inexistente devuelve vacío', () => {
    assert.deepStrictEqual(pt.readPrevStates({ pipelineDir: tmpPipeline() }), {});
});

test('#6441: recordSweep acepta booleanos además de objetos y descarta basura', () => {
    const dir = tmpPipeline();
    const rec = pt.recordSweep({ 'pulpo': true, 'svc-drive': false }, { pipelineDir: dir, now: 1000 });
    assert.strictEqual(rec.length, 2);
    assert.strictEqual(rec.find(r => r.service === 'pulpo').to, 'alive');
    assert.strictEqual(rec.find(r => r.service === 'svc-drive').to, 'dead');
    assert.deepStrictEqual(pt.recordSweep(null, { pipelineDir: dir }), []);
    assert.deepStrictEqual(pt.recordSweep('no soy un objeto', { pipelineDir: dir }), []);
});

test('#6441: la muerte registra el motivo y el último error redactado', () => {
    const dir = tmpPipeline();
    const opts = { pipelineDir: dir };
    pt.recordSweep({ 'svc-github': { alive: true } }, { ...opts, now: 1000 });
    const rec = pt.recordSweep({ 'svc-github': { alive: false } }, {
        ...opts,
        now: 2000,
        // Sin el literal "ERROR" adelante: `classifyReason` toma el PRIMER token
        // tipo E<MAYUS> y "ERROR" también matchea ese patrón (comportamiento
        // preexistente de #3960, no algo que este issue cambie).
        lastErrorFor: () => '[gh] ECONNRESET token=AKIAIOSFODNN7EXAMPLE al llamar gh api',
    });
    assert.strictEqual(rec[0].reason, 'ECONNRESET');
    assert.ok(!rec[0].lastError.includes('AKIAIOSFODNN7EXAMPLE'), 'el secret se redacta antes de persistir');
});

test('#6441: la transición queda legible por readTransitions (lo que muestra /ops)', () => {
    const dir = tmpPipeline();
    const now = Date.now();
    pt.recordSweep({ 'svc-reconciler': { alive: true } }, { pipelineDir: dir, now: now - 2000 });
    pt.recordSweep({ 'svc-reconciler': { alive: false } }, { pipelineDir: dir, now: now - 1000, lastErrorFor: () => 'EPIPE' });

    const r = pt.readTransitions('svc-reconciler', { pipelineDir: dir, now });
    assert.strictEqual(r.downCount, 1);
    assert.ok(r.summary.includes('EPIPE'));
});

// ===========================================================================
// REQ-SEC-6441-3 — validación del nombre de servicio.
// ===========================================================================

test('#6441: un service con path traversal no lee fuera de logs/', () => {
    const dir = tmpPipeline();
    // Archivo señuelo FUERA de logs/: si la interpolación no se valida, el
    // path `../secreto` lo alcanzaría.
    fs.writeFileSync(path.join(dir, 'secreto.log'), 'ERROR password=hunter2 top secret');

    assert.strictEqual(pt.readLastError('../secreto', { pipelineDir: dir }), '');
    assert.strictEqual(pt.readLastError('..\\secreto', { pipelineDir: dir }), '');
    assert.strictEqual(pt.readLastError('C:/Windows/win', { pipelineDir: dir }), '');
    assert.strictEqual(pt.readLastError('', { pipelineDir: dir }), '');
    assert.strictEqual(pt.readLastError(null, { pipelineDir: dir }), '');
});

test('#6441: un nombre válido sigue leyendo su log (la validación no rompe el caso real)', () => {
    const dir = tmpPipeline();
    fs.writeFileSync(path.join(dir, 'logs', 'svc-reconciler.log'), 'info: ok\nERROR ETIMEDOUT sincronizando\n');
    assert.ok(pt.readLastError('svc-reconciler', { pipelineDir: dir }).includes('ETIMEDOUT'));
});

test('#6441: recordSweep descarta servicios con nombre inválido', () => {
    const dir = tmpPipeline();
    const rec = pt.recordSweep(
        { '../evil': { alive: false }, 'svc-drive': { alive: false } },
        { pipelineDir: dir, now: 1000 }
    );
    assert.deepStrictEqual(rec.map(r => r.service), ['svc-drive']);
});

test('#6441: isValidServiceName acepta los nombres reales y rechaza el resto', () => {
    for (const n of ['pulpo', 'svc-reconciler', 'outbox-drain', 'listener', 'dashboard']) {
        assert.ok(pt.isValidServiceName(n), n + ' debe ser válido');
    }
    for (const n of ['../x', 'Pulpo', 'svc_drive', '-svc', 'a'.repeat(33), 'a b', 42, null, undefined]) {
        assert.ok(!pt.isValidServiceName(n), String(n) + ' NO debe ser válido');
    }
});

test('#6441: todos los componentes del registro pasan la validación', () => {
    const stale = require('./stale-services');
    for (const c of stale.COMPONENT_REGISTRY) {
        assert.ok(pt.isValidServiceName(c.name), c.name + ' quedaría descartado por el validador');
    }
});

// ===========================================================================
// REQ-SEC-6441-5 — el store no crece sin cota bajo crash-loop.
// ===========================================================================

test('#6441: bajo crash-loop el store se poda por ventana de 7 días', () => {
    const dir = tmpPipeline();
    const file = pt.storePath({ pipelineDir: dir });
    const viejo = new Date(Date.UTC(2020, 0, 1)).toISOString();
    const lineas = [];
    for (let i = 0; i < pt.ROTATE_AT_LINES + 50; i++) {
        lineas.push(JSON.stringify({ ts: viejo, service: 'svc-drive', from: 'alive', to: 'dead', reason: 'EPIPE', lastError: '' }));
    }
    fs.writeFileSync(file, lineas.join('\n') + '\n');

    const res = pt.rotateIfNeeded({ pipelineDir: dir, now: Date.now() });
    assert.strictEqual(res.rotated, true);
    const quedan = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.strictEqual(quedan.length, 0, 'todas eran de 2020: fuera de la ventana');
});

test('#6441: la poda conserva las MÁS RECIENTES cuando todas entran en la ventana', () => {
    // Crash-loop real: el crecimiento no es antigüedad sino frecuencia.
    const dir = tmpPipeline();
    const file = pt.storePath({ pipelineDir: dir });
    const now = Date.now();
    const lineas = [];
    for (let i = 0; i < pt.ROTATE_AT_LINES + 120; i++) {
        lineas.push(JSON.stringify({ ts: new Date(now - 1000).toISOString(), service: 'svc-drive', from: 'alive', to: 'dead', reason: 'EPIPE', lastError: 'n' + i }));
    }
    fs.writeFileSync(file, lineas.join('\n') + '\n');

    const res = pt.rotateIfNeeded({ pipelineDir: dir, now });
    assert.strictEqual(res.rotated, true);
    const quedan = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.strictEqual(quedan.length, pt.ROTATE_AT_LINES);
    assert.strictEqual(quedan[quedan.length - 1].lastError, 'n' + (pt.ROTATE_AT_LINES + 119));
});

test('#6441: por debajo del umbral no se toca el store', () => {
    const dir = tmpPipeline();
    pt.recordSweep({ 'pulpo': { alive: true } }, { pipelineDir: dir, now: 1000 });
    const file = pt.storePath({ pipelineDir: dir });
    const antes = fs.readFileSync(file, 'utf8');
    assert.strictEqual(pt.rotateIfNeeded({ pipelineDir: dir }).rotated, false);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), antes);
});

test('#6441: rotar un store inexistente no rompe', () => {
    assert.deepStrictEqual(pt.rotateIfNeeded({ pipelineDir: tmpPipeline() }), { rotated: false });
});

test('#6441: la poda no deja el archivo temporal tirado', () => {
    const dir = tmpPipeline();
    const file = pt.storePath({ pipelineDir: dir });
    const now = Date.now();
    const lineas = [];
    for (let i = 0; i < pt.ROTATE_AT_LINES + 10; i++) {
        lineas.push(JSON.stringify({ ts: new Date(now).toISOString(), service: 'pulpo', from: 'alive', to: 'dead', reason: 'x', lastError: '' }));
    }
    fs.writeFileSync(file, lineas.join('\n') + '\n');
    pt.rotateIfNeeded({ pipelineDir: dir, now });
    assert.ok(!fs.existsSync(file + '.tmp'), 'el tmp se renombró, no quedó suelto');
});

// ===========================================================================
// Compatibilidad: el dashboard sigue siendo un invocador válido.
// ===========================================================================

test('#6441: recordSnapshot (dashboard) sigue comportándose igual que antes', () => {
    // Si esto se rompe, la ventana /ops se queda sin transiciones.
    pt.__forTestsOnly__._resetState();
    const dir = tmpPipeline();
    const siembra = pt.recordSnapshot({ 'svc-drive': { alive: true } }, { pipelineDir: dir, now: 1000 });
    assert.strictEqual(siembra.length, 0, 'la siembra en memoria sigue sin escribir');
    const rec = pt.recordSnapshot({ 'svc-drive': { alive: false } }, { pipelineDir: dir, now: 2000 });
    assert.strictEqual(rec.length, 1);
    assert.strictEqual(rec[0].from, 'alive');
    assert.strictEqual(rec[0].to, 'dead');
});

// ===========================================================================
// Calidad del dato que ve el operador en /ops.
// ===========================================================================

test('#6441: la siembra no se cuenta como caida en "caidas 7 d"', () => {
    // outbox-drain y svc-emulador arrancan muertos por diseno: si la siembra
    // contara, el numero mentiria desde el primer barrido.
    const dir = tmpPipeline();
    const now = Date.now();
    pt.recordSweep({ 'outbox-drain': { alive: false } }, { pipelineDir: dir, now: now - 5000 });

    const r = pt.readTransitions('outbox-drain', { pipelineDir: dir, now });
    assert.strictEqual(r.downCount, 0, 'la siembra no es una caída');
    assert.match(r.summary, /: 0$/, 'el resumen que ve el operador dice cero');
    assert.strictEqual(r.transitions.length, 1, 'pero la línea sigue estando en el historial');
});

test('#6441: una caida real posterior a la siembra si se cuenta', () => {
    const dir = tmpPipeline();
    const now = Date.now();
    pt.recordSweep({ 'svc-github': { alive: true } }, { pipelineDir: dir, now: now - 3000 });
    pt.recordSweep({ 'svc-github': { alive: false } }, { pipelineDir: dir, now: now - 2000, lastErrorFor: () => 'EPIPE' });

    const r = pt.readTransitions('svc-github', { pipelineDir: dir, now });
    assert.strictEqual(r.downCount, 1);
    assert.ok(r.summary.includes('EPIPE'));
});

test('#6441: dashboard y barrido no duplican la misma muerte', () => {
    // Desde este issue hay dos escritores del store. Si los dos asentaran la
    // misma muerte, "caidas 7 d" contaria el doble.
    pt.__forTestsOnly__._resetState();
    const dir = tmpPipeline();
    const opts = { pipelineDir: dir };
    const now = Date.now();

    // El barrido siembra vivo y despues asienta la muerte.
    pt.recordSweep({ 'svc-drive': { alive: true } }, { ...opts, now: now - 4000 });
    pt.recordSweep({ 'svc-drive': { alive: false } }, { ...opts, now: now - 3000, lastErrorFor: () => 'EPIPE' });

    // El dashboard, con su memoria sembrada en vivo, ve la MISMA muerte.
    pt.recordSnapshot({ 'svc-drive': { alive: true } }, { ...opts, now: now - 3500 });
    const dup = pt.recordSnapshot({ 'svc-drive': { alive: false } }, { ...opts, now: now - 2000 });

    assert.deepStrictEqual(dup, [], 'no vuelve a escribir lo ya asentado');
    const r = pt.readTransitions('svc-drive', { ...opts, now });
    assert.strictEqual(r.downCount, 1, 'una muerte, una caida contada');
});

test('#6441: el dashboard sigue escribiendo cuando el estado en disco difiere', () => {
    // El guard anti-duplicado no puede convertirse en un silenciador: si el
    // disco dice otra cosa, la transicion se asienta igual.
    pt.__forTestsOnly__._resetState();
    const dir = tmpPipeline();
    const opts = { pipelineDir: dir };
    pt.recordSweep({ 'svc-github': { alive: true } }, { ...opts, now: 1000 });

    pt.recordSnapshot({ 'svc-github': { alive: true } }, { ...opts, now: 2000 });
    const rec = pt.recordSnapshot({ 'svc-github': { alive: false } }, { ...opts, now: 3000 });
    assert.strictEqual(rec.length, 1, 'el disco decia alive: la muerte es nueva y se escribe');
});
