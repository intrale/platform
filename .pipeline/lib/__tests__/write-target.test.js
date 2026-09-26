// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// #7112 — tests del envoltorio único de escritura (`lib/write-target.js`).
//
// REGLA: `env` siempre como objeto literal; nunca se muta `process.env`.
// El módulo no crea directorios ni escribe archivos: acá se afirma exactamente
// eso, más el fallo ruidoso (SEC-10), el destino del aviso (SEC-14) y el
// formato fijo de tres líneas (guideline UX 1/6).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const writeTarget = require('../write-target');
const pipelineEnv = require('../pipeline-env');
const { ENV_AMBIENTE, DEFAULT_PRODUCTIVE_DIR, MODOS } = pipelineEnv;

const PRODUCTIVO = { [ENV_AMBIENTE]: 'productivo' };

function tmpDir(tag) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `write-target-7112-${tag}-`));
}

function fakeStderr() {
    const chunks = [];
    return { write: (s) => { chunks.push(String(s)); return true; }, chunks, text: () => chunks.join('') };
}

test.beforeEach(() => writeTarget._resetAvisos());

// ─── CA-3 · default invertido: dir null ⇒ no escribe, falla ruidoso ─────────

test('CA-3 · sin declaración ni dir: writeDir lanza EscrituraBloqueadaError con código estable y NO cae a __dirname', () => {
    const stderr = fakeStderr();
    assert.throws(
        () => writeTarget.writeDir({}, { canal: 'pausa', destino: '.paused', stderr }),
        (e) => e instanceof writeTarget.EscrituraBloqueadaError
            && e.code === writeTarget.CODIGO_BLOQUEO
            && e.canal === 'pausa' && e.destino === '.paused'
            && e.modo === MODOS.PRUEBAS && e.origen === 'ninguno'
            && /sin declaración de ambiente/.test(e.motivo),
    );
    assert.ok(writeTarget.esBloqueo(new writeTarget.EscrituraBloqueadaError('x', { canal: 'pausa', destino: 'y', amb: { modo: 'pruebas' } })));
    assert.strictEqual(writeTarget.esBloqueo(new Error('otro')), false);
});

test('CA-3 · el bloqueo se avisa por stderr aunque el llamador trague la excepción (nunca mudo), una vez por canal+destino', () => {
    const stderr = fakeStderr();
    for (let i = 0; i < 3; i++) {
        try { writeTarget.writeDir({}, { canal: 'logs', destino: 'logs/pulpo.log', stderr }); } catch { /* best-effort del llamador */ }
    }
    assert.strictEqual(stderr.chunks.length, 1, 'deduplicado por (canal, destino)');
    try { writeTarget.writeDir({}, { canal: 'logs', destino: 'logs/otro.log', stderr }); } catch { /* */ }
    assert.strictEqual(stderr.chunks.length, 2, 'otro destino, otro aviso');
});

test('CA-3 · formato fijo de tres líneas: qué / por qué (motivo textual del resolvedor) / cómo salir (variable + runner)', () => {
    const amb = pipelineEnv.resolve({});
    const msg = writeTarget.formatearBloqueo({ canal: 'pausa', destino: '.paused', amb });
    const lineas = msg.split('\n');
    assert.strictEqual(lineas.length, 3);
    for (const l of lineas) assert.ok(l.startsWith(writeTarget.PREFIJO + ' '), `prefijo grepeable: ${l}`);
    assert.strictEqual(lineas[0], '[pipeline-env] escritura bloqueada: canal=pausa destino=.paused');
    assert.ok(lineas[1].includes(amb.motivo), 'la segunda línea reutiliza amb.motivo textual');
    assert.match(lineas[1], /\(modo=pruebas, dir=null, origen=ninguno\)/);
    assert.match(lineas[2], /^\[pipeline-env\] para salir: /);
    assert.match(lineas[2], /PIPELINE_AMBIENTE=productivo/, 'nombra la variable a declarar');
    assert.match(lineas[2], /scripts\/test-pipeline\.js/, 'nombra el runner a usar');
    assert.match(lineas[2], /restart\.js · watchdog\.ps1 · launch\.ps1/, 'nombra los lanzadores (UX A1)');
    assert.match(lineas[2], /npm run test:pipeline/);
    // El throw lleva exactamente el mismo texto (un solo formateador).
    try { writeTarget.writeDir({}, { canal: 'pausa', destino: '.paused', stderr: fakeStderr() }); }
    catch (e) { assert.strictEqual(e.message, msg); }
});

test('CA-3 · el mensaje del bloqueo con señal de test nombra la VARIABLE de la señal, no "node --test"', () => {
    const stderr = fakeStderr();
    try { writeTarget.writeDir({ NODE_TEST_CONTEXT: '1' }, { canal: 'colas', destino: 'servicios/telegram/pendiente', stderr }); } catch { /* */ }
    assert.match(stderr.text(), /NODE_TEST_CONTEXT/);
    assert.doesNotMatch(stderr.text(), /node --test/);
});

test('CA-3/SEC-14 · con dir null el módulo no crea ni escribe nada: el productivo y un fixture quedan intactos', () => {
    const fixture = tmpDir('intacto');
    const antes = fs.readdirSync(fixture);
    const stderr = fakeStderr();
    try { writeTarget.writeDir({}, { canal: 'estado', destino: 'state/x.json', stderr }); } catch { /* */ }
    assert.strictEqual(writeTarget.safeWriteDir({}, { canal: 'estado', destino: 'state/y.json', stderr }), null);
    assert.deepStrictEqual(fs.readdirSync(fixture), antes);
    // Estructural: el fuente no importa fs ni escribe.
    const src = fs.readFileSync(path.join(__dirname, '..', 'write-target.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(src, /require\(['"](node:)?fs['"]\)/, 'sin fs');
    assert.doesNotMatch(src, /writeFileSync|appendFileSync|mkdirSync/, 'sin escrituras');
    assert.doesNotMatch(src, /console\.(log|error|warn)/, 'el aviso va a stderr inyectable, no a console');
});

// ─── SEC-13 · por llamada ────────────────────────────────────────────────────

test('SEC-13 · resolución por llamada: el mismo módulo ya cargado devuelve el dir del env de CADA llamada', () => {
    const a = tmpDir('a');
    const b = tmpDir('b');
    assert.strictEqual(writeTarget.writeDir({ PIPELINE_DIR_OVERRIDE: a }, { canal: 'estado' }), path.resolve(a));
    assert.strictEqual(writeTarget.writeDir({ PIPELINE_DIR_OVERRIDE: b }, { canal: 'estado' }), path.resolve(b));
    assert.strictEqual(writeTarget.writePath({ PIPELINE_STATE_DIR: a }, { canal: 'logs' }, 'logs', 'x.log'), path.join(path.resolve(a), 'logs', 'x.log'));
});

test('SEC-13 · productivo declarado con libs del productivo: writeDir devuelve DEFAULT_PRODUCTIVE_DIR', () => {
    assert.strictEqual(writeTarget.writeDir(PRODUCTIVO, { canal: 'pausa', destino: '.paused' }), DEFAULT_PRODUCTIVE_DIR);
    const r = writeTarget.resolverEscritura(PRODUCTIVO, { canal: 'colas' });
    assert.strictEqual(r.bloqueo, null);
    assert.strictEqual(r.amb.modo, MODOS.PRODUCTIVO);
    assert.strictEqual(r.amb.canales.telegram.enabled, true);
});

test('SEC-9 · productivo declarado pero PIPELINE_REPO_ROOT ajeno (env de agente con libs de otro dir): bloqueo', () => {
    const otro = tmpDir('otro-repo');
    const stderr = fakeStderr();
    assert.throws(() => writeTarget.writeDir({ ...PRODUCTIVO, PIPELINE_REPO_ROOT: otro }, { canal: 'estado', stderr }), writeTarget.EscrituraBloqueadaError);
    assert.match(stderr.text(), /declaración productiva con dir no productivo \(PIPELINE_REPO_ROOT\)/);
});

test('SEC-3 · dir de pruebas dentro del productivo se bloquea (el derrame no puede repetirse por el envoltorio)', () => {
    const stderr = fakeStderr();
    assert.throws(
        () => writeTarget.writeDir({ NODE_TEST_CONTEXT: '1', PIPELINE_DIR_OVERRIDE: path.join(DEFAULT_PRODUCTIVE_DIR, 'logs') }, { canal: 'logs', stderr }),
        writeTarget.EscrituraBloqueadaError,
    );
    assert.match(stderr.text(), /apunta al productivo/);
});

test('opts.pipelineDir explícito: dir del parámetro (modo explicito), sin exigir declaración', () => {
    const d = tmpDir('explicito');
    const r = writeTarget.resolverEscritura({}, { canal: 'estado', pipelineDir: d });
    assert.strictEqual(r.dir, path.resolve(d));
    assert.strictEqual(r.amb.modo, MODOS.EXPLICITO);
    assert.strictEqual(writeTarget.writeDir({}, { canal: 'estado', pipelineDir: d }), path.resolve(d));
});

// ─── safe* ───────────────────────────────────────────────────────────────────

test('safeWriteDir · nunca lanza: null + aviso deduplicado con dir null; dir con env válido', () => {
    const stderr = fakeStderr();
    assert.strictEqual(writeTarget.safeWriteDir({}, { canal: 'logs', destino: 'logs/pulpo.log', stderr }), null);
    assert.strictEqual(writeTarget.safeWriteDir({}, { canal: 'logs', destino: 'logs/pulpo.log', stderr }), null);
    assert.strictEqual(stderr.chunks.length, 1);
    assert.match(stderr.text(), /escritura bloqueada: canal=logs destino=logs\/pulpo\.log/);
    const d = tmpDir('safe');
    assert.strictEqual(writeTarget.safeWriteDir({ PIPELINE_DIR_OVERRIDE: d }, { canal: 'logs' }), path.resolve(d));
    // canal inválido tampoco lanza en la variante safe.
    assert.strictEqual(writeTarget.safeWriteDir({ PIPELINE_DIR_OVERRIDE: d }, { canal: 'queue' }), null);
});

// ─── vocabulario ─────────────────────────────────────────────────────────────

test('vocabulario único de canales: colas | logs | estado | pausa; un canal fuera del vocabulario es error de programación', () => {
    assert.deepStrictEqual([...writeTarget.CANALES], ['colas', 'logs', 'estado', 'pausa']);
    assert.throws(() => writeTarget.writeDir(PRODUCTIVO, { canal: 'queue' }), TypeError);
    assert.throws(() => writeTarget.writeDir(PRODUCTIVO, {}), TypeError);
    assert.throws(() => writeTarget.writeDir(PRODUCTIVO, { canal: 'marker' }), /colas \| logs \| estado \| pausa/);
});

test('pureza: el fuente no lee process.env salvo como default de stderr, no nombra la variable de ambiente en literal y sólo requiere path y pipeline-env', () => {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'write-target.js'), 'utf8');
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(src, /process\.env/, 'el env llega por parámetro (SEC-13)');
    assert.doesNotMatch(raw, /PIPELINE_AMBIENTE/, 'la variable se toma de pipeline-env.ENV_AMBIENTE (CA-8 de #7110)');
    const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]).sort();
    assert.deepStrictEqual(requires, ['./pipeline-env', 'path']);
});
