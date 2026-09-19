'use strict';

/**
 * #7112 · CA-1 / SEC-15 — inventario de puntos de escritura.
 *
 * 1. Completitud: el grep estructural (`write-points-scan`) menos el JSON es ∅,
 *    y al revés: el JSON no tiene entradas fantasma. Si un módulo de `lib/` o
 *    de la raíz empieza a escribir bajo un path derivado de `__dirname` /
 *    `process.env.PIPELINE_*` sin estar listado, este test falla y dice qué
 *    agregar (`node lib/write-points-scan.js --sync`).
 * 2. Coherencia: un punto que el JSON declara `migrado`/`safe` tiene que serlo
 *    también para el escáner (no se puede "migrar" editando el JSON).
 * 3. Esquema: `canal ∈ {colas, logs, estado, pausa}`, `estado` válido, `tier ∈ {1,2,3}`.
 * 4. Tier 1 y Tier 2 sin `pendiente` en la raíz productiva: los módulos que
 *    derramaron el 08/09 quedaron migrados (CA-2).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scan = require('../write-points-scan');

const PIPELINE_DIR = path.resolve(__dirname, '..', '..');

test('el inventario lib/write-points.json existe y tiene el esquema esperado', () => {
    const puntos = scan.leerInventario(PIPELINE_DIR);
    assert.ok(puntos.length > 0, 'write-points.json vacío o ausente');
    const canales = new Set(['colas', 'logs', 'estado', 'pausa']);
    for (const e of puntos) {
        assert.ok(typeof e.modulo === 'string' && e.modulo, `modulo inválido en ${JSON.stringify(e)}`);
        assert.ok(typeof e.funcion === 'string' && e.funcion, `funcion inválida en ${scan.clave(e)}`);
        assert.ok(canales.has(e.canal), `canal inválido "${e.canal}" en ${scan.clave(e)}`);
        assert.ok(scan.ESTADOS.includes(e.estado), `estado inválido "${e.estado}" en ${scan.clave(e)}`);
        assert.ok([1, 2, 3].includes(e.tier), `tier inválido "${e.tier}" en ${scan.clave(e)}`);
        assert.ok(typeof e.destino === 'string' && e.destino, `destino vacío en ${scan.clave(e)}`);
    }
});

test('completitud: grep estructural − JSON = ∅ y JSON − grep = ∅', () => {
    const escaneo = scan.escanear(PIPELINE_DIR);
    const json = scan.leerInventario(PIPELINE_DIR);
    const enEscaneo = new Set(escaneo.map(scan.clave));
    const enJson = new Set(json.map(scan.clave));
    const faltan = [...enEscaneo].filter((k) => !enJson.has(k));
    const sobran = [...enJson].filter((k) => !enEscaneo.has(k));
    assert.deepStrictEqual(faltan, [],
        `puntos de escritura sin inventariar (correr: node lib/write-points-scan.js --sync):\n  ${faltan.join('\n  ')}`);
    assert.deepStrictEqual(sobran, [],
        `entradas del inventario que ya no existen en el código (correr --sync):\n  ${sobran.join('\n  ')}`);
});

test('coherencia: lo que el JSON declara migrado/safe lo es también para el escáner', () => {
    const porClave = new Map(scan.escanear(PIPELINE_DIR).map((e) => [scan.clave(e), e]));
    const incoherentes = [];
    for (const e of scan.leerInventario(PIPELINE_DIR)) {
        const real = porClave.get(scan.clave(e));
        if (!real) continue; // lo reporta el test de completitud
        if ((e.estado === 'migrado' || e.estado === 'safe') && real.estado !== e.estado) {
            incoherentes.push(`${scan.clave(e)}: JSON=${e.estado} escáner=${real.estado} (${real.via})`);
        }
        if (scan.ESTADOS_CURADOS.includes(e.estado) && real.estado !== 'pendiente') {
            incoherentes.push(`${scan.clave(e)}: JSON=${e.estado} pero el escáner lo ve ${real.estado}`);
        }
    }
    assert.deepStrictEqual(incoherentes, [], `estados incoherentes:\n  ${incoherentes.join('\n  ')}`);
});

// CA-2 bullet 4 / D-1 del PO: un `__dirname` crudo en una ruta de escritura es
// INMUNE a cualquier override — el dir efímero del runner (CA-4) no lo cubre y
// desde el repo principal escribe al `.pipeline` productivo. No hay goteo para
// estos: o se migran al envoltorio (`writeDir`/`safeWriteDir`) o se curan como
// `lectura`/`externo` con `nota` (falso positivo del heurístico).
test('CA-2 bullet 4: ningún punto inmune (__dirname crudo) queda pendiente', () => {
    const inmunes = scan.leerInventario(PIPELINE_DIR)
        .filter((e) => e.inmune === true && e.estado === 'pendiente')
        .map((e) => `${scan.clave(e)} (L${e.linea})`);
    assert.deepStrictEqual(inmunes, [],
        `__dirname crudo en ruta de escritura (inmune a todo override): migrar a lib/write-target o curar como lectura/externo con nota:\n  ${inmunes.join('\n  ')}`);
});

// La regla anterior se evalúa contra el JSON versionado; ésta contra el código
// real, para que "migrar editando el JSON" tampoco alcance.
test('CA-2 bullet 4: el escáner tampoco encuentra inmunes que el JSON no haya curado', () => {
    const porClave = new Map(scan.leerInventario(PIPELINE_DIR).map((e) => [scan.clave(e), e]));
    const sinCurar = scan.escanear(PIPELINE_DIR)
        .filter((e) => e.inmune && e.estado === 'pendiente')
        .filter((e) => {
            const j = porClave.get(scan.clave(e));
            return !j || !scan.ESTADOS_CURADOS.includes(j.estado) || !j.nota;
        })
        .map((e) => `${scan.clave(e)} (L${e.linea})`);
    assert.deepStrictEqual(sinCurar, [], `inmunes sin migrar ni curar (lectura/externo + nota):\n  ${sinCurar.join('\n  ')}`);
});

test('CA-2: Tier 1 y Tier 2 no tienen puntos pendientes', () => {
    const pendientes = scan.leerInventario(PIPELINE_DIR)
        .filter((e) => e.tier <= 2 && e.estado === 'pendiente')
        .map((e) => `${scan.clave(e)} (L${e.linea}, ${e.via})`);
    assert.deepStrictEqual(pendientes, [], `Tier 1/2 con resolución ad-hoc:\n  ${pendientes.join('\n  ')}`);
});

// ── Escáner sobre fixtures ──────────────────────────────────────────────────

function fixture(archivos) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wps-7112-'));
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    for (const [rel, src] of Object.entries(archivos)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), src);
    }
    return dir;
}

test('escáner: detecta familia F (función por llamada con process.env.PIPELINE_*) como pendiente', () => {
    const dir = fixture({
        'lib/a.js': [
            "const fs = require('fs'); const path = require('path');",
            'function pipelineDir() {',
            '    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;',
            "    return path.join(__dirname, '..');",
            '}',
            "function queueDir() { return path.join(pipelineDir(), 'servicios', 'x'); }",
            "function push(m) { fs.writeFileSync(path.join(queueDir(), 'm.json'), m); }",
            'module.exports = { push };',
        ].join('\n'),
    });
    try {
        const r = scan.escanear(dir);
        assert.deepStrictEqual(r.map((e) => [e.modulo, e.funcion, e.estado]), [['lib/a.js', 'pipelineDir', 'pendiente']]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('escáner: const de módulo con __dirname crudo que alimenta una escritura es pendiente e inmune', () => {
    const dir = fixture({
        'b.js': [
            "const fs = require('fs'); const path = require('path');",
            "const LOG_DIR = path.join(__dirname, 'logs');",
            "const ASSETS = path.join(__dirname, 'assets');",
            "function log(m) { fs.appendFileSync(path.join(LOG_DIR, 'x.log'), m); }",
            "function css() { return fs.readFileSync(path.join(ASSETS, 'a.css')); }",
        ].join('\n'),
    });
    try {
        const r = scan.escanear(dir);
        assert.deepStrictEqual(r.map((e) => [e.funcion, e.estado, e.inmune]), [['LOG_DIR', 'pendiente', true]]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('escáner: writeTarget.writeDir es migrado, safeWriteDir es safe, y un módulo que sólo lee queda fuera', () => {
    const dir = fixture({
        'lib/c.js': [
            "const fs = require('fs'); const path = require('path');",
            "const writeTarget = require('./write-target');",
            "function pipelineDir() { return writeTarget.writeDir(process.env, { canal: 'pausa', destino: '.paused' }); }",
            "function crashDir() { return writeTarget.safeWriteDir(process.env, { canal: 'logs', destino: 'logs/' }); }",
            "function pause() { fs.writeFileSync(path.join(pipelineDir(), '.paused'), ''); }",
            "function crash(e) { const d = crashDir(); if (d) fs.appendFileSync(path.join(d, 'crash.log'), String(e)); }",
        ].join('\n'),
        'lib/d.js': [
            "const fs = require('fs'); const path = require('path');",
            "const CFG = path.join(__dirname, '..', 'config.yaml');",
            "module.exports = () => fs.readFileSync(CFG, 'utf8');",
        ].join('\n'),
    });
    try {
        const r = scan.escanear(dir).map((e) => [e.modulo, e.funcion, e.estado]);
        assert.deepStrictEqual(r, [['lib/c.js', 'pipelineDir', 'migrado'], ['lib/c.js', 'crashDir', 'safe']]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('sincronizar conserva canal/destino/tier/nota curados y el estado lectura', () => {
    const dir = fixture({
        'lib/e.js': [
            "const fs = require('fs'); const path = require('path');",
            "function pipelineDir() { return process.env.PIPELINE_DIR_OVERRIDE || path.join(__dirname, '..'); }",
            "function save(s) { fs.writeFileSync(path.join(pipelineDir(), 'estado.json'), s); }",
        ].join('\n'),
    });
    try {
        const previo = [{ modulo: 'lib/e.js', funcion: 'pipelineDir', canal: 'pausa', destino: 'x/.paused', tier: 1, nota: 'curado', estado: 'lectura', linea: 99 }];
        const [e] = scan.sincronizar(dir, previo);
        assert.strictEqual(e.canal, 'pausa');
        assert.strictEqual(e.destino, 'x/.paused');
        assert.strictEqual(e.tier, 1);
        assert.strictEqual(e.nota, 'curado');
        assert.strictEqual(e.estado, 'lectura');
        assert.strictEqual(e.linea, 2, 'la línea se actualiza desde el escaneo');
        const [nuevo] = scan.sincronizar(dir, []);
        assert.strictEqual(nuevo.estado, 'pendiente');
        assert.strictEqual(nuevo.tier, 3);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
