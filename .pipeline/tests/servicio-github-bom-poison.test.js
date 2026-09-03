// =============================================================================
// servicio-github-bom-poison.test.js — #6274
//
// Regresión del incidente 2026-08-28 → 2026-08-31: cuatro jobs
// `qa-<issue>-passed.json` quedaron atascados en `pendiente/` durante DÍAS.
//
// Cadena causal observada en `.pipeline/logs/svc-github.log`:
//
//   1. El job venía con BOM UTF-8 (`EF BB BF`) al frente. `JSON.parse` lo
//      rechaza con `Unexpected token`.
//   2. El worker lo movía a `trabajando/`, fallaba el parse y caía al catch.
//   3. El catch intentaba contarle un reintento... releyendo y parseando el
//      MISMO archivo, que volvía a fallar por el mismo BOM.
//   4. El fallback devolvía el archivo a `pendiente/` SIN tocar `retries`.
//   5. Cada 10s, idéntico. `MAX_RETRIES` era inalcanzable por construcción:
//      incrementar el contador exigía parsear lo que no se podía parsear.
//
// Efecto de producto: el label `qa:passed` nunca se aplicó, el `qa:failed`
// viejo quedó vigente y el merge de esos issues quedó bloqueado en silencio.
//
// Se cubren las dos mitades del arreglo:
//   A) el BOM se descarta en la lectura y el job se procesa normal;
//   B) un payload REALMENTE ilegible termina en `fallido/` en vez de rebotar
//      para siempre (corte del bucle de poison message).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PIPELINE = path.resolve(__dirname, '..');

/**
 * Deja `contenido` crudo como job en `pendiente/` y corre el worker real.
 * El contenido se escribe como bytes tal cual para poder inyectar el BOM.
 *
 * @param {string} nombre     - nombre del archivo de job.
 * @param {Buffer|string} contenido - bytes exactos del job.
 * @param {number} pasadas    - cuántas veces se corre `processQueue`.
 */
function correrCrudo(nombre, contenido, { pasadas = 1 } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), '6274-cola-'));
    for (const sub of ['pendiente', 'trabajando', 'listo', 'fallido']) {
        fs.mkdirSync(path.join(dir, 'servicios', 'github', sub), { recursive: true });
    }
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'servicios', 'github', 'pendiente', nombre), contenido);

    const salidaPath = path.join(dir, 'observado.json');
    const script = `
      process.env.PIPELINE_STATE_DIR = ${JSON.stringify(dir)};
      const fs = require('fs');
      const svc = require(${JSON.stringify(path.join(PIPELINE, 'servicio-github.js'))});
      const observado = { editIssue: [], createLabel: [], comment: [] };
      const ghClient = {
        editIssue: (issue, opts) => { observado.editIssue.push({ issue, opts }); return { ok: true }; },
        createLabel: (name) => { observado.createLabel.push(name); return { created: true }; },
        listLabels: () => [],
        createIssue: (opts) => ({ number: 10000 }),
        commentIssue: (issue, body) => { observado.comment.push({ issue, body }); },
        getIssueLabels: () => [],
      };
      for (let i = 0; i < ${pasadas}; i++) {
        try { svc.processQueue({ ghClient }); } catch (e) { observado.error = e.message; }
      }
      fs.writeFileSync(${JSON.stringify(salidaPath)}, JSON.stringify(observado));
    `;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(r.status, 0, `worker fallo: ${r.stderr}`);

    const leerDir = (sub) => fs.readdirSync(path.join(dir, 'servicios', 'github', sub))
        .filter((f) => f.endsWith('.json'));

    return {
        observado: JSON.parse(fs.readFileSync(salidaPath, 'utf8')),
        pendiente: leerDir('pendiente'),
        trabajando: leerDir('trabajando'),
        listo: leerDir('listo'),
        fallido: leerDir('fallido'),
        dir,
    };
}

const BOM = '﻿';

// -----------------------------------------------------------------------------
// A) El BOM ya no bloquea el job
// -----------------------------------------------------------------------------

test('#6274 un job con BOM UTF-8 se procesa y aplica el label en vez de atascarse', () => {
    // Bytes EXACTOS del job real que quedó atascado (qa-6274-passed.json).
    const job = BOM + JSON.stringify({ action: 'label', issue: 6274, label: 'qa:passed' });
    const r = correrCrudo('qa-6274-passed.json', job);

    assert.strictEqual(r.observado.editIssue.length, 1,
        'el label debe aplicarse: el BOM es basura de encoding, no un payload distinto');
    assert.strictEqual(r.observado.editIssue[0].issue, 6274);
    assert.deepStrictEqual(r.pendiente, [], 'no debe quedar rebotando en pendiente/');
    assert.deepStrictEqual(r.trabajando, [], 'no debe quedar huérfano en trabajando/');
    assert.deepStrictEqual(r.listo, ['qa-6274-passed.json'], 'debe cerrar en listo/');
});

test('#6274 el BOM no altera el payload: los campos llegan intactos al worker', () => {
    const job = BOM + JSON.stringify({ action: 'label', issue: 4808, label: 'qa:passed' });
    const r = correrCrudo('qa-4808-passed.json', job);

    const procesada = JSON.parse(fs.readFileSync(
        path.join(r.dir, 'servicios', 'github', 'listo', 'qa-4808-passed.json'), 'utf8'));
    assert.strictEqual(procesada.action, 'label');
    assert.strictEqual(procesada.issue, 4808);
    assert.strictEqual(procesada.label, 'qa:passed');
});

test('#6274 un job sin BOM sigue funcionando igual (no regresión)', () => {
    const job = JSON.stringify({ action: 'label', issue: 1234, label: 'qa:passed' });
    const r = correrCrudo('qa-1234-passed.json', job);

    assert.strictEqual(r.observado.editIssue.length, 1);
    assert.deepStrictEqual(r.listo, ['qa-1234-passed.json']);
});

// -----------------------------------------------------------------------------
// B) Poison message: lo ilegible termina en fallido/, no en un bucle eterno
// -----------------------------------------------------------------------------

test('#6274 un payload ilegible va a fallido/ y NO rebota a pendiente/', () => {
    const r = correrCrudo('roto.json', '{esto no es json valido');

    assert.deepStrictEqual(r.fallido, ['roto.json'],
        'un job que no se puede parsear ni para contarle un reintento debe morir en fallido/');
    assert.deepStrictEqual(r.pendiente, [],
        'el bug original lo devolvia a pendiente/ para reintentarlo eternamente');
    assert.deepStrictEqual(r.trabajando, []);
});

test('#6274 el job ilegible preserva el contenido crudo y la causa para el humano', () => {
    const r = correrCrudo('roto.json', '{esto no es json valido');

    const caido = JSON.parse(fs.readFileSync(
        path.join(r.dir, 'servicios', 'github', 'fallido', 'roto.json'), 'utf8'));
    assert.strictEqual(caido.unparseable, true);
    assert.strictEqual(caido.raw, '{esto no es json valido',
        'el contenido original no se pierde: es lo unico que permite diagnosticar');
    assert.ok(caido.error, 'debe registrar la causa');
    assert.ok(caido.failed_at, 'debe registrar cuando murio');
});

test('#6274 el bucle corta: tras varias pasadas el ilegible no sigue reencolado', () => {
    // El corazón del incidente: 3 pasadas equivalen a 30s de servicio real.
    // Antes del arreglo el archivo seguía en `pendiente/` indefinidamente,
    // fallando idéntico en cada vuelta y sin llegar nunca a `fallido/`.
    const r = correrCrudo('roto.json', '{roto', { pasadas: 3 });

    assert.deepStrictEqual(r.pendiente, [], 'no puede seguir vivo en la cola tras N pasadas');
    assert.deepStrictEqual(r.fallido, ['roto.json'], 'debe haber terminado en fallido/');
});
