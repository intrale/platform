// =============================================================================
// Tests del breaker de NO-PROGRESO para rebotes infra (#6746).
//
// Cubren T1..T13 de la receta del issue. Todo corre sobre un tmpdir propio o con
// `fsImpl` inyectado: NUNCA se toca el `.pipeline/audit/` real.
//
// Nota sobre el sentido del fail-*: este detector es FAIL-OPEN (ante la duda NO
// escala). T4, T5 y T7 son los que sostienen esa garantía — RIESGO-3 dice que el
// caso caro es el falso positivo (issue sano parkeado esperando a un humano).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const noprogress = require('../infra-noprogress');

const ROOT_REPO = path.resolve(__dirname, '..', '..', '..');
const PIPELINE_REAL = path.join(ROOT_REPO, '.pipeline');

// sha256 válidos (64 hex). Distintos entre sí.
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

/** tmpdir aislado que hace de `.pipeline` para el test. */
function nuevoPipelineDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-noprogress-'));
    fs.mkdirSync(path.join(dir, 'audit'), { recursive: true });
    return dir;
}

/** Emula al Pulpo: serializa con el módulo y appendea (append-only, CA-3). */
function appendCiclo(pipelineDir, args) {
    fs.appendFileSync(
        noprogress.auditFile(pipelineDir),
        noprogress.buildRecord(args),
        { encoding: 'utf8', mode: 0o600 },
    );
}

// -----------------------------------------------------------------------------
// T1 / CA-1 — mismo diff_hash en N ciclos ⇒ escala
// -----------------------------------------------------------------------------
test('T1 · mismo diff_hash en N ciclos consecutivos hace escalar', () => {
    const dir = nuevoPipelineDir();

    // Primer ciclo: todavía no hay con qué comparar ⇒ NO escala.
    const v1 = noprogress.shouldEscalate({
        pipelineDir: dir, issue: 6746, fase: 'dev', diffHash: HASH_A, config: {},
    });
    assert.strictEqual(v1.escalar, false, 'el primer ciclo no puede escalar');
    assert.strictEqual(v1.ciclos, 1);
    assert.strictEqual(v1.max, 2);

    appendCiclo(dir, { issue: 6746, fase: 'dev', diffHash: HASH_A, reboteInfraN: 1 });

    // Segundo ciclo con el MISMO hash ⇒ escala (N cuenta el ciclo actual).
    const v2 = noprogress.shouldEscalate({
        pipelineDir: dir, issue: 6746, fase: 'dev', diffHash: HASH_A, config: {},
    });
    assert.strictEqual(v2.escalar, true);
    assert.strictEqual(v2.ciclos, 2);
    assert.strictEqual(v2.razon, 'no-progreso');
    assert.strictEqual(v2.hashCorto, HASH_A.slice(0, 12));
});

test('T1b · con noprogreso_max = 3 hace falta un ciclo más', () => {
    const dir = nuevoPipelineDir();
    const config = { circuit_breaker: { noprogreso_max: 3 } };
    appendCiclo(dir, { issue: 6746, fase: 'dev', diffHash: HASH_A, reboteInfraN: 1 });

    const v2 = noprogress.shouldEscalate({ pipelineDir: dir, issue: 6746, fase: 'dev', diffHash: HASH_A, config });
    assert.strictEqual(v2.escalar, false, 'con umbral 3 el 2do ciclo todavía no escala');
    assert.strictEqual(v2.ciclos, 2);

    appendCiclo(dir, { issue: 6746, fase: 'dev', diffHash: HASH_A, reboteInfraN: 2 });
    const v3 = noprogress.shouldEscalate({ pipelineDir: dir, issue: 6746, fase: 'dev', diffHash: HASH_A, config });
    assert.strictEqual(v3.escalar, true);
    assert.strictEqual(v3.ciclos, 3);
});

// -----------------------------------------------------------------------------
// T2 / CA-7 — diff_hash distinto ⇒ hubo progreso ⇒ NO escala
// -----------------------------------------------------------------------------
test('T2 · diff_hash distinto entre ciclos NO escala (hubo progreso)', () => {
    // Orden real del Pulpo: el gate del ciclo N lee los registros 1..N-1 y recién
    // después se appendea el registro N. Por eso el JSONL tiene sólo el ciclo previo.
    const dir = nuevoPipelineDir();
    appendCiclo(dir, { issue: 6746, fase: 'dev', diffHash: HASH_A, reboteInfraN: 1 });

    const v = noprogress.shouldEscalate({
        pipelineDir: dir, issue: 6746, fase: 'dev', diffHash: HASH_B, config: {},
    });
    assert.strictEqual(v.escalar, false, 'el diff cambió: el issue avanza, no se frena');
    assert.strictEqual(v.ciclos, 1, 'el ciclo previo tenía otro hash: no acumula');
    // Sanidad: el hash A quedó registrado pero no contamina el conteo de B.
    assert.strictEqual(
        noprogress.countSameHash({ pipelineDir: dir, issue: 6746, fase: 'dev', diffHash: HASH_B }).n,
        0,
    );
});

test('T2c · la oscilación A→B→A SÍ escala (decisión explícita, no accidente)', () => {
    // El conteo es por hash IGUAL, no por repetición consecutiva: si el issue
    // vuelve al mismo diff que ya había producido, no hubo avance neto — sólo
    // ida y vuelta. Es la lectura literal de la receta ("cuenta registros cuyo
    // diff_hash === diffHash") y la más protectora del gasto: el caso que motivó
    // el issue (#3741) quemaba ciclos exactamente así.
    const dir = nuevoPipelineDir();
    appendCiclo(dir, { issue: 6746, fase: 'dev', diffHash: HASH_A, reboteInfraN: 1 });
    appendCiclo(dir, { issue: 6746, fase: 'dev', diffHash: HASH_B, reboteInfraN: 2 });

    const v = noprogress.shouldEscalate({
        pipelineDir: dir, issue: 6746, fase: 'dev', diffHash: HASH_A, config: {},
    });
    assert.strictEqual(v.escalar, true);
    assert.strictEqual(v.ciclos, 2, 'A ya había aparecido: éste es el 2º ciclo con ese diff');
});

test('T2b · otro issue u otra fase con el mismo hash no suman', () => {
    const dir = nuevoPipelineDir();
    appendCiclo(dir, { issue: 9999, fase: 'dev', diffHash: HASH_A, reboteInfraN: 1 });
    appendCiclo(dir, { issue: 6746, fase: 'build', diffHash: HASH_A, reboteInfraN: 1 });

    const v = noprogress.shouldEscalate({
        pipelineDir: dir, issue: 6746, fase: 'dev', diffHash: HASH_A, config: {},
    });
    assert.strictEqual(v.escalar, false);
    assert.strictEqual(v.ciclos, 1);
});

// -----------------------------------------------------------------------------
// T3 / CA-2 / SEC-5 / SEC-B — el work-file del agente NO altera la decisión
// -----------------------------------------------------------------------------
test('T3 · un work-file con rebote_tipo/diff_hash_previo/rebote_numero_infra manipulados NO altera el veredicto', () => {
    const dir = nuevoPipelineDir();
    appendCiclo(dir, { issue: 6746, fase: 'dev', diffHash: HASH_A, reboteInfraN: 1 });

    const baseline = noprogress.shouldEscalate({
        pipelineDir: dir, issue: 6746, fase: 'dev', diffHash: HASH_A, config: {},
    });
    assert.strictEqual(baseline.escalar, true);

    // Un agente hostil deja un work-file en la fase con TODOS los campos que el
    // contador viejo (`rebote-counter.js`) sí lee, puestos para desactivar el
    // breaker: tipo 'codigo', contador infra en 0 y un hash previo distinto.
    const faseDir = path.join(dir, 'desarrollo', 'dev', 'procesado');
    fs.mkdirSync(faseDir, { recursive: true });
    fs.writeFileSync(path.join(faseDir, '6746.pipeline-dev'), [
        'issue: 6746',
        'fase: dev',
        'pipeline: desarrollo',
        'rebote: true',
        "rebote_tipo: codigo",
        'rebote_numero_infra: 0',
        `diff_hash_previo: ${HASH_B}`,
        'noprogreso_max: 99',
    ].join('\n'));

    const conVeneno = noprogress.shouldEscalate({
        pipelineDir: dir, issue: 6746, fase: 'dev', diffHash: HASH_A, config: {},
    });
    assert.deepStrictEqual(conVeneno, baseline, 'el veredicto sale del JSONL del Pulpo, no del work-file');

    // Y el `rebote_infra_n` del JSONL (que viene del work-file) tampoco decide:
    // dos ciclos con contadores absurdos siguen contando como dos ciclos.
    const dir2 = nuevoPipelineDir();
    appendCiclo(dir2, { issue: 6746, fase: 'dev', diffHash: HASH_A, reboteInfraN: 0 });
    appendCiclo(dir2, { issue: 6746, fase: 'dev', diffHash: HASH_A, reboteInfraN: 999 });
    assert.strictEqual(
        noprogress.countSameHash({ pipelineDir: dir2, issue: 6746, fase: 'dev', diffHash: HASH_A }).n,
        2,
    );
});

test('T3b · SEC-C.1 — el módulo no exporta ningún writer ni es invocable por CLI', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'infra-noprogress.js'), 'utf8');
    // Se analiza el CÓDIGO, no los comentarios (que justamente nombran lo que el
    // módulo no hace). Sin esto el propio encabezado haría fallar el test.
    const codigo = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

    assert.ok(!/require\.main\s*===\s*module/.test(codigo), 'no puede tener entrypoint CLI');
    assert.ok(!src.startsWith('#!'), 'no puede tener shebang');
    assert.ok(!/\b(appendFileSync|writeFileSync|createWriteStream|unlinkSync|rmSync|mkdirSync)\b/.test(codigo),
        'el módulo NO escribe en disco: el append vive en el proceso del Pulpo');
    for (const [nombre, valor] of Object.entries(noprogress)) {
        if (typeof valor !== 'function') continue;
        assert.ok(!/^(append|write|save|persist|record)[A-Z]/.test(nombre),
            `export sospechoso de escribir: ${nombre}`);
    }
});

// -----------------------------------------------------------------------------
// T4 / SEC-A — hash desconocido (known:false) NO escala ni acumula
// -----------------------------------------------------------------------------
test('T4 · hash desconocido (null) en N ciclos NO escala y no incrementa el contador', () => {
    const dir = nuevoPipelineDir();
    appendCiclo(dir, { issue: 6746, fase: 'dev', diffHash: null, reboteInfraN: 1 });
    appendCiclo(dir, { issue: 6746, fase: 'dev', diffHash: null, reboteInfraN: 2 });
    appendCiclo(dir, { issue: 6746, fase: 'dev', diffHash: null, reboteInfraN: 3 });

    // Se registró con diff_hash: null (observabilidad), pero no cuenta.
    const lineas = fs.readFileSync(noprogress.auditFile(dir), 'utf8')
        .trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(lineas.length, 3);
    assert.ok(lineas.every((r) => r.diff_hash === null), 'el hash desconocido se persiste como null');

    const v = noprogress.shouldEscalate({
        pipelineDir: dir, issue: 6746, fase: 'dev', diffHash: null, config: {},
    });
    assert.strictEqual(v.escalar, false);
    assert.strictEqual(v.razon, 'hash-desconocido');
    assert.strictEqual(v.ciclos, 0);

    // Y si en el ciclo siguiente el hash SÍ se conoce, los nulls previos no suman.
    const v2 = noprogress.shouldEscalate({
        pipelineDir: dir, issue: 6746, fase: 'dev', diffHash: HASH_A, config: {},
    });
    assert.strictEqual(v2.escalar, false);
    assert.strictEqual(v2.ciclos, 1);
});

test('T4b · un hash con forma inválida se trata como desconocido', () => {
    const dir = nuevoPipelineDir();
    for (const malo of ['', 'no-es-un-hash', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 123, {}]) {
        const v = noprogress.shouldEscalate({
            pipelineDir: dir, issue: 6746, fase: 'dev', diffHash: malo, config: {},
        });
        assert.strictEqual(v.escalar, false, `hash inválido ${JSON.stringify(malo)} no puede escalar`);
        assert.strictEqual(v.razon, 'hash-desconocido');
    }
});

// -----------------------------------------------------------------------------
// T5 / CA-PO-1 — fases sin worktree propio no participan
// -----------------------------------------------------------------------------
test('T5 · una fase sin worktree propio del issue NUNCA escala', () => {
    const dir = nuevoPipelineDir();
    for (const fase of ['validacion', 'analisis', 'criterios', '', undefined]) {
        appendCiclo(dir, { issue: 6746, fase: fase || 'validacion', diffHash: HASH_A, reboteInfraN: 1 });
        appendCiclo(dir, { issue: 6746, fase: fase || 'validacion', diffHash: HASH_A, reboteInfraN: 2 });
        const v = noprogress.shouldEscalate({
            pipelineDir: dir, issue: 6746, fase, diffHash: HASH_A, config: {},
        });
        assert.strictEqual(v.escalar, false, `fase ${fase} no corre en worktree del issue`);
        assert.strictEqual(v.razon, 'fase-sin-worktree-propio');
    }
});

test('T5b · las fases que SÍ corren en el worktree del issue participan', () => {
    for (const fase of ['dev', 'build', 'verificacion', 'linteo', 'aprobacion', 'entrega']) {
        const dir = nuevoPipelineDir();
        appendCiclo(dir, { issue: 6746, fase, diffHash: HASH_A, reboteInfraN: 1 });
        const v = noprogress.shouldEscalate({
            pipelineDir: dir, issue: 6746, fase, diffHash: HASH_A, config: {},
        });
        assert.strictEqual(v.escalar, true, `la fase ${fase} debe participar del breaker`);
    }
});

// -----------------------------------------------------------------------------
// T6 / SEC-D / CA-PO-3 — el reset corta el episodio SIN borrar el archivo
// -----------------------------------------------------------------------------
test('T6 · un registro {kind:"reset"} corta el episodio y el breaker vuelve a armarse', () => {
    const dir = nuevoPipelineDir();
    appendCiclo(dir, { issue: 6746, fase: 'dev', diffHash: HASH_A, reboteInfraN: 1 });
    assert.strictEqual(
        noprogress.shouldEscalate({ pipelineDir: dir, issue: 6746, fase: 'dev', diffHash: HASH_A, config: {} }).escalar,
        true,
    );

    // El Pulpo archiva por needs-human ⇒ marca el corte (append-only, no borra).
    const antes = fs.readFileSync(noprogress.auditFile(dir), 'utf8');
    appendCiclo(dir, { issue: 6746, fase: 'dev', diffHash: null, kind: 'reset' });
    const despues = fs.readFileSync(noprogress.auditFile(dir), 'utf8');
    assert.ok(despues.startsWith(antes), 'append-only: el historial previo sigue intacto');

    const post = noprogress.shouldEscalate({
        pipelineDir: dir, issue: 6746, fase: 'dev', diffHash: HASH_A, config: {},
    });
    assert.strictEqual(post.escalar, false, 'tras el reset el contador arranca de cero');
    assert.strictEqual(post.ciclos, 1);

    // Y si el no-progreso se repite, escala OTRA VEZ.
    appendCiclo(dir, { issue: 6746, fase: 'dev', diffHash: HASH_A, reboteInfraN: 1 });
    assert.strictEqual(
        noprogress.shouldEscalate({ pipelineDir: dir, issue: 6746, fase: 'dev', diffHash: HASH_A, config: {} }).escalar,
        true,
        'el 2º episodio también escala',
    );
});

test('T6b · el reset de otro issue/fase no corta el episodio propio', () => {
    const dir = nuevoPipelineDir();
    appendCiclo(dir, { issue: 6746, fase: 'dev', diffHash: HASH_A, reboteInfraN: 1 });
    appendCiclo(dir, { issue: 9999, fase: 'dev', diffHash: null, kind: 'reset' });
    appendCiclo(dir, { issue: 6746, fase: 'build', diffHash: null, kind: 'reset' });

    assert.strictEqual(
        noprogress.shouldEscalate({ pipelineDir: dir, issue: 6746, fase: 'dev', diffHash: HASH_A, config: {} }).escalar,
        true,
    );
});

test('T6c · CA-PO-3 — el flag de dedup PROPIO existe y el corte del JSONL es append-only', () => {
    const src = fs.readFileSync(path.join(PIPELINE_REAL, 'pulpo.js'), 'utf8');
    assert.ok(/\.\$\{issue\}\.noprogreso-notified/.test(src),
        'el breaker usa un flag propio, no `.needs-human-notified` (RIESGO-5 / #6755)');
    assert.ok(/appendInfraNoprogressRecord\(\{\s*issue,\s*fase,\s*diffHash:\s*null,\s*kind:\s*'reset'/.test(src),
        'el corte de episodio se marca con un registro reset, no borrando el JSONL');

    // REGRESIÓN del rebote de `review` (#6746, fase aprobacion): antes el bloque
    // de escalado hacía `writeFileSync(flag)` y, quince líneas más abajo, un
    // `unlinkSync` del MISMO path en el mismo tick síncrono. El dedup no existía.
    // El flag ya no puede borrarse en el bloque de escalado: se limpia recién
    // cuando el issue reentra (`limpiarNoprogresoNotices` desde el intake).
    const bloqueEscalado = src.slice(
        src.indexOf('if (causaEscalado) {'),
        src.indexOf('// #2405 CA-4 — Mover archivos actuales a `archivado/`'),
    )
        // Se analiza el CÓDIGO, no los comentarios: éstos nombran justamente el
        // `unlinkSync` que ya NO está (mismo criterio que T3b).
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    assert.ok(bloqueEscalado.length > 500, 'se localizó el bloque de escalado');
    assert.ok(!/unlinkSync/.test(bloqueEscalado),
        'el bloque de escalado NO puede borrar el flag que acaba de reclamar');
    assert.ok(!/writeFileSync\([^)]*(needsHumanFlag|noprogreso-notified)/.test(bloqueEscalado),
        'el flag se escribe en el claim atómico, no al final del bloque');
    // El único borrado vive en la limpieza de reentrada.
    assert.ok(/function limpiarNoprogresoNotices\([\s\S]{0,900}?unlinkSync\(noprogresoNoticeFlag/.test(src),
        'la limpieza del flag vive en `limpiarNoprogresoNotices`');
    assert.ok(/if \(reentro\) \{[\s\S]{0,200}?limpiarNoprogresoNotices\(/.test(src),
        'el intake limpia el flag cuando el issue reentra al pipeline');
});

// -----------------------------------------------------------------------------
// T7 / SEC-E / CA-UX-6 — degradación: ilegible o desbordado ⇒ NO escala
// -----------------------------------------------------------------------------
test('T7 · JSONL ilegible ⇒ escalar:false + degraded:true (fail-OPEN, no fail-closed)', () => {
    const fsRoto = {
        existsSync: () => true,
        readFileSync: () => { throw new Error('EACCES'); },
    };
    const v = noprogress.shouldEscalate({
        pipelineDir: '/no/importa', issue: 6746, fase: 'dev', diffHash: HASH_A, config: {}, fsImpl: fsRoto,
    });
    assert.strictEqual(v.escalar, false, 'no poder leer NO puede escalar (RIESGO-4)');
    assert.strictEqual(v.degraded, true);
    assert.strictEqual(v.razon, 'jsonl-ilegible');
    assert.strictEqual(v.ciclos, 0);
});

test('T7b · JSONL con más de MAX_LINES líneas ⇒ degraded, sin colgar el tick', () => {
    const gigante = `${JSON.stringify({ issue: 6746, fase: 'dev', diff_hash: HASH_A, rebote_infra_n: 1 })}\n`
        .repeat(noprogress.MAX_LINES + 1);
    const fsGrande = { existsSync: () => true, readFileSync: () => gigante };
    const v = noprogress.shouldEscalate({
        pipelineDir: '/no/importa', issue: 6746, fase: 'dev', diffHash: HASH_A, config: {}, fsImpl: fsGrande,
    });
    assert.strictEqual(v.escalar, false);
    assert.strictEqual(v.degraded, true);
});

test('T7c · archivo inexistente ⇒ 0 ciclos y NO degradado (es el caso normal del 1er ciclo)', () => {
    const dir = nuevoPipelineDir();
    const r = noprogress.countSameHash({ pipelineDir: dir, issue: 6746, fase: 'dev', diffHash: HASH_A });
    assert.deepStrictEqual(r, { n: 0, degraded: false });
});

test('T7d · CA-UX-6 — el Pulpo avisa por log cuando el breaker queda degradado', () => {
    const src = fs.readFileSync(path.join(PIPELINE_REAL, 'pulpo.js'), 'utf8');
    assert.ok(/infra-noprogress DEGRADADO/.test(src), 'el operador tiene que enterarse de la degradación');
    assert.ok(/noProgreso\s*=\s*\{\s*escalar:\s*false\s*\}/.test(src),
        'un fallo del módulo deja el veredicto en NO escalar');
});

// -----------------------------------------------------------------------------
// T8 / CA-PO-2 — clamp de noprogreso_max
// -----------------------------------------------------------------------------
test('T8 · resolveNoprogresoMax hace clamp fail-closed', () => {
    const cb = (v) => ({ circuit_breaker: { noprogreso_max: v } });
    for (const invalido of [0, -1, 1, NaN, Infinity, -Infinity, '2', '99', 2.5, null, undefined, true, [], {}]) {
        assert.strictEqual(
            noprogress.resolveNoprogresoMax(cb(invalido)), 2,
            `valor inválido ${JSON.stringify(invalido)} debe caer al default 2`,
        );
    }
    assert.strictEqual(noprogress.resolveNoprogresoMax(cb(99)), 10, 'cota superior sana');
    assert.strictEqual(noprogress.resolveNoprogresoMax(cb(10)), 10);
    assert.strictEqual(noprogress.resolveNoprogresoMax(cb(5)), 5);
    assert.strictEqual(noprogress.resolveNoprogresoMax(cb(2)), 2);
    // Config ausente / rota en cualquier nivel ⇒ default.
    assert.strictEqual(noprogress.resolveNoprogresoMax(undefined), 2);
    assert.strictEqual(noprogress.resolveNoprogresoMax(null), 2);
    assert.strictEqual(noprogress.resolveNoprogresoMax({}), 2);
    assert.strictEqual(noprogress.resolveNoprogresoMax({ circuit_breaker: null }), 2);
    assert.strictEqual(noprogress.DEFAULT_NOPROGRESO_MAX, 2);
    assert.strictEqual(noprogress.MIN_NOPROGRESO_MAX, 2);
    assert.strictEqual(noprogress.MAX_NOPROGRESO_MAX, 10);
});

// -----------------------------------------------------------------------------
// T9 / CA-3 / SEC-C.2-3 / SEC-F — forma exacta del registro
// -----------------------------------------------------------------------------
test('T9 · buildRecord emite una sola línea con los campos whitelisteados', () => {
    const linea = noprogress.buildRecord({
        issue: '6746', fase: 'dev', diffHash: HASH_A, reboteInfraN: 3, now: 0,
    });
    assert.ok(linea.endsWith('\n'), 'la línea trae su propio \\n (un solo append)');
    assert.strictEqual(linea.indexOf('\n'), linea.length - 1, 'exactamente una línea');

    const rec = JSON.parse(linea);
    assert.deepStrictEqual(Object.keys(rec).sort(), ['diff_hash', 'fase', 'issue', 'rebote_infra_n', 'ts']);
    assert.strictEqual(rec.issue, 6746);
    assert.strictEqual(typeof rec.issue, 'number');
    assert.strictEqual(rec.fase, 'dev');
    assert.strictEqual(rec.diff_hash, HASH_A);
    assert.strictEqual(rec.rebote_infra_n, 3);
    assert.strictEqual(rec.ts, '1970-01-01T00:00:00.000Z');
});

test('T9b · SEC-F — claves extra (texto libre incluido) se descartan', () => {
    const rec = JSON.parse(noprogress.buildRecord({
        issue: 6746, fase: 'dev', diffHash: HASH_A, reboteInfraN: 1,
        motivo: 'AKIAIOSFODNN7EXAMPLE token secreto',
        stdout: 'log entero del agente',
        __proto__: { polucion: true },
    }));
    assert.strictEqual(rec.motivo, undefined);
    assert.strictEqual(rec.stdout, undefined);
    assert.strictEqual(rec.polucion, undefined);
    assert.deepStrictEqual(Object.keys(rec).sort(), ['diff_hash', 'fase', 'issue', 'rebote_infra_n', 'ts']);
});

test('T9c · RIESGO-7 — un \\n en `fase` no puede forjar un registro', () => {
    const faseHostil = `dev"}\n{"issue":6746,"fase":"dev","diff_hash":"${HASH_A}","rebote_infra_n":0}`;
    const linea = noprogress.buildRecord({ issue: 6746, fase: faseHostil, diffHash: HASH_A });
    assert.strictEqual(linea.indexOf('\n'), linea.length - 1, 'sigue siendo UNA sola línea');
    const rec = JSON.parse(linea);
    assert.ok(/^[a-z_-]*$/i.test(rec.fase), 'la fase queda reducida a [a-z_-]');
    assert.ok(!rec.fase.includes('"'));
    assert.ok(!rec.fase.includes('\n'));
    assert.ok(!/[0-9{}:,]/.test(rec.fase), 'nada de la estructura JSON forjada sobrevive');
    assert.notStrictEqual(rec.fase, 'dev', 'y tampoco se hace pasar por la fase real');

    // El registro forjado NO se materializa en el conteo.
    const dir = nuevoPipelineDir();
    fs.appendFileSync(noprogress.auditFile(dir), linea);
    assert.strictEqual(
        noprogress.countSameHash({ pipelineDir: dir, issue: 6746, fase: 'dev', diffHash: HASH_A }).n,
        0,
    );
});

test('T9d · el registro de reset lleva kind y ningún campo de más', () => {
    const rec = JSON.parse(noprogress.buildRecord({ issue: 6746, fase: 'dev', diffHash: null, kind: 'reset' }));
    assert.deepStrictEqual(Object.keys(rec).sort(), ['diff_hash', 'fase', 'issue', 'kind', 'rebote_infra_n', 'ts']);
    assert.strictEqual(rec.kind, 'reset');
    assert.strictEqual(rec.diff_hash, null);
    // Un `kind` arbitrario NO se propaga (whitelist estricta).
    const otro = JSON.parse(noprogress.buildRecord({ issue: 6746, fase: 'dev', diffHash: null, kind: 'borrar-todo' }));
    assert.strictEqual(otro.kind, undefined);
});

// -----------------------------------------------------------------------------
// T10 / SEC-C.4 — el lector tolera basura y sigue contando
// -----------------------------------------------------------------------------
test('T10 · líneas corruptas o con forma inválida se descartan y el resto sigue contando', () => {
    const dir = nuevoPipelineDir();
    const file = noprogress.auditFile(dir);
    fs.writeFileSync(file, [
        'esto no es json',
        '{"json":"incompleto"',
        'null',
        '[]',
        '"soy un string"',
        JSON.stringify({ issue: '6746', fase: 'dev', diff_hash: HASH_A }),        // issue string ⇒ descarta
        JSON.stringify({ issue: 6746, fase: 42, diff_hash: HASH_A }),             // fase no string ⇒ descarta
        JSON.stringify({ issue: 6746, fase: 'dev', diff_hash: 'corto' }),         // hash inválido ⇒ descarta
        JSON.stringify({ issue: 6746, fase: 'dev', diff_hash: null }),            // desconocido ⇒ no cuenta
        JSON.stringify({ issue: 6746.5, fase: 'dev', diff_hash: HASH_A }),        // issue no entero ⇒ descarta
        '',
        '   ',
        JSON.stringify({ issue: 6746, fase: 'dev', diff_hash: HASH_A, rebote_infra_n: 1 }), // ✅ cuenta
        JSON.stringify({ issue: 6746, fase: 'dev', diff_hash: HASH_A, rebote_infra_n: 2 }), // ✅ cuenta
    ].join('\n') + '\n');

    const r = noprogress.countSameHash({ pipelineDir: dir, issue: 6746, fase: 'dev', diffHash: HASH_A });
    assert.deepStrictEqual(r, { n: 2, degraded: false }, 'la basura no ciega ni dispara el breaker');
});

// -----------------------------------------------------------------------------
// T11 / RIESGO-3 — issue no numérico: tira y no escribe
// -----------------------------------------------------------------------------
test('T11 · buildRecord rechaza issues no numéricos y no produce línea', () => {
    const dir = nuevoPipelineDir();
    const file = noprogress.auditFile(dir);
    // Nota: `' 6746 '` NO va acá — el trim es intencional y lo cubre T11b.
    for (const malo of ['6746; rm -rf /', '../', '../../etc/passwd', 0, '0', null, undefined, '', 'abc', '-1', '6.7', '0x1A', {}, []]) {
        assert.throws(
            () => appendCiclo(dir, { issue: malo, fase: 'dev', diffHash: HASH_A }),
            /issue invalido/,
            `issue ${JSON.stringify(malo)} debe ser rechazado`,
        );
    }
    assert.strictEqual(fs.existsSync(file), false, 'ninguna entrada inválida llegó a escribir');

    // El lector aplica el mismo criterio y no explota.
    for (const malo of ['6746; rm -rf /', '../', 0, null]) {
        assert.deepStrictEqual(
            noprogress.countSameHash({ pipelineDir: dir, issue: malo, fase: 'dev', diffHash: HASH_A }),
            { n: 0, degraded: false },
        );
    }
});

test('T11c · las guardas defensivas de los helpers aguantan entradas vacías', () => {
    // `auditFile` sin directorio: no puede tirar (lo llama el Pulpo en un catch).
    assert.strictEqual(noprogress.auditFile(undefined), path.join('audit', 'infra-noprogress.jsonl'));
    assert.strictEqual(noprogress.auditFile(''), path.join('audit', 'infra-noprogress.jsonl'));

    // `normalizeFase` con nullish ⇒ string vacía, nunca 'null'/'undefined'
    // (si devolviera 'null' dos fases ausentes distintas colisionarían).
    assert.strictEqual(noprogress.normalizeFase(null), '');
    assert.strictEqual(noprogress.normalizeFase(undefined), '');
    assert.strictEqual(noprogress.normalizeFase(0), '');
    assert.strictEqual(noprogress.normalizeFase('dev'), 'dev');

    // `countSameHash` llamado DIRECTO con un hash inválido (shouldEscalate lo
    // filtra antes, pero el lector no puede depender de su caller).
    const dir = nuevoPipelineDir();
    appendCiclo(dir, { issue: 6746, fase: 'dev', diffHash: HASH_A, reboteInfraN: 1 });
    for (const malo of [null, undefined, '', 'corto', 42]) {
        assert.deepStrictEqual(
            noprogress.countSameHash({ pipelineDir: dir, issue: 6746, fase: 'dev', diffHash: malo }),
            { n: 0, degraded: false },
        );
    }
    // Y sin argumentos tampoco explota.
    assert.deepStrictEqual(noprogress.countSameHash(), { n: 0, degraded: false });
    assert.strictEqual(noprogress.shouldEscalate().escalar, false);
});

test('T11b · issue numérico con espacios alrededor se normaliza', () => {
    const rec = JSON.parse(noprogress.buildRecord({ issue: ' 6746 ', fase: 'dev', diffHash: HASH_A }));
    assert.strictEqual(rec.issue, 6746);
});

// -----------------------------------------------------------------------------
// T12 / CA-PO-5 — sin rebote infra no hay escrituras ni cambios de umbral
// -----------------------------------------------------------------------------
test('T12 · el Pulpo sólo appendea en el carril infra y no toca los umbrales existentes', () => {
    const src = fs.readFileSync(path.join(PIPELINE_REAL, 'pulpo.js'), 'utf8');

    // Los dos appends del ciclo viven bajo el gate del carril infra / dentro del
    // bloque de escalado: un issue sin rebote infra no escribe una sola línea.
    const llamadas = src.match(/appendInfraNoprogressRecord\(/g) || [];
    assert.strictEqual(llamadas.length, 3, 'definición + append del ciclo + append del reset');

    // #6745 — el append del ciclo se gatea por `esInfraFinal`, NO por
    // `esReboteDeInfra`: un rebote degradado infra→código sale de esta fase
    // hacia `dev`, así que no es "reintento sin progreso en la misma fase" y no
    // debe acumular. Además `nuevoReboteInfraNumero` sólo incrementa cuando
    // `esInfraFinal`, con lo que registrar el caso degradado guardaría un
    // contador que no avanzó. Fail-open hacia NO escalar (RIESGO-3).
    assert.ok(/const esInfraFinal = esReboteDeInfra && !degradadoACodigo;/.test(src),
        'esInfraFinal sigue siendo el carril infra que NO se degradó a código');
    assert.ok(/if \(esInfraFinal\) \{[\s\S]{0,1400}?appendInfraNoprogressRecord\(\{[\s\S]{0,200}?reboteInfraN/.test(src),
        'el append del ciclo está gateado por esInfraFinal');
    assert.ok(!/if \(esReboteDeInfra\) \{[\s\S]{0,1400}?appendInfraNoprogressRecord\(\{[\s\S]{0,200}?reboteInfraN/.test(src),
        'el append del ciclo NO puede quedar gateado por esReboteDeInfra: registraría el rebote degradado');
    assert.ok(/if \(esReboteDeInfra\) \{[\s\S]{0,1600}?infraNoprogress\.shouldEscalate\(/.test(src),
        'el veredicto sólo se calcula (y se paga computeDiffHash) en el carril infra');

    // Umbrales preexistentes intactos (el breaker sólo puede APRETAR, SEC-E).
    assert.ok(/infra_escalate_threshold\)\s*\|\|\s*5/.test(src), 'INFRA_ESCALATE_THRESHOLD sigue en 5');
    assert.ok(/connectivityState\.MAX_REBOTES_INFRA\s*\|\|\s*20/.test(src), 'MAX_REBOTES_INFRA sigue en 20');

    // Append-only (CA-3): el audit trail nunca se reescribe.
    assert.ok(/appendFileSync\([\s\S]{0,160}buildRecord/.test(src), 'se usa appendFileSync');
    assert.ok(!/writeFileSync\([^)]*infra-noprogress/.test(src), 'nunca writeFileSync sobre el audit');

    // CA-5: el hash se persiste en AMBOS carriles — ningún gate lo condiciona.
    // Ni el `if (!esReboteDeInfra)` original ni el `if (!esInfraFinal)` que trajo
    // #6745, del que CA-5 es superconjunto.
    assert.ok(!/if \(!esReboteDeInfra\) \{\s*\n\s*try \{\s*\n\s*const dh = convergence\.computeDiffHash/.test(src),
        'el gate `if (!esReboteDeInfra)` sobre diff_hash_previo debe estar abierto');
    assert.ok(!/if \(!esInfraFinal\) \{\s*\n\s*try \{\s*\n\s*const dh = convergence\.computeDiffHash/.test(src),
        'el gate `if (!esInfraFinal)` sobre diff_hash_previo debe estar abierto (CA-5)');
    assert.ok(/if \(dh && dh\.hash\) yamlOut\.diff_hash_previo = dh\.hash;/.test(src));
});

// -----------------------------------------------------------------------------
// T12c / CA-PO-5 — CA-5 no puede contaminar el detector de convergencia de #4160
// -----------------------------------------------------------------------------
test('T12c · escribir diff_hash_previo en el carril infra NO altera el diffHashPrevio de convergencia', () => {
    // Es la regresión más cara de CA-5: si `contarRebotes` leyera el hash de las
    // entradas infra, el auto-promote por convergencia (#4160) empezaría a
    // comparar contra un hash que no es el del ciclo de código anterior.
    const { contarRebotes } = require('../rebote-counter');

    const archivos = {
        'procesado': {
            // Entrada INFRA — ahora sí trae diff_hash_previo (novedad de CA-5).
            '6746.pipeline-dev': {
                rebote_tipo: 'infra', rebote_numero_infra: 2, diff_hash_previo: HASH_B,
            },
            // Entrada de CÓDIGO — la única que puede aportar el hash.
            '6746.tester': {
                rebote_tipo: 'codigo', rebote_numero: 1, diff_hash_previo: HASH_A,
                motivo_rechazo: 'falta cobertura',
            },
        },
    };
    const fakeFs = { readdirSync: (dir) => Object.keys(archivos[path.basename(dir)] || {}) };
    const fakeFasePath = () => 'X';
    const fakeReadYaml = (p) => (archivos[path.basename(path.dirname(p))] || {})[path.basename(p)];

    const r = contarRebotes({
        fs: fakeFs, fasePath: fakeFasePath, readYamlSafe: fakeReadYaml,
        pipeline: 'desarrollo', faseRechazo: 'dev', issue: 6746,
    });
    assert.strictEqual(r.diffHashPrevio, HASH_A, 'el hash sale de la entrada de código, no de la infra');
    assert.notStrictEqual(r.diffHashPrevio, HASH_B, 'el hash del carril infra NO se filtra a convergencia');
    assert.strictEqual(r.reboteCount, 1);
    assert.strictEqual(r.reboteInfraCount, 2);

    // Y con SÓLO entradas infra el hash previo queda en null, como antes de CA-5.
    delete archivos.procesado['6746.tester'];
    const soloInfra = contarRebotes({
        fs: fakeFs, fasePath: fakeFasePath, readYamlSafe: fakeReadYaml,
        pipeline: 'desarrollo', faseRechazo: 'dev', issue: 6746,
    });
    assert.strictEqual(soloInfra.diffHashPrevio, null);
});

// -----------------------------------------------------------------------------
// T12b / CA-UX-1..5, CA-UX-7 — textos del escalado, y no-regresión de la rama vieja
// -----------------------------------------------------------------------------
test('T12b · la rama noprogreso explica la causa correcta y la rama infra queda intacta', () => {
    const src = fs.readFileSync(path.join(PIPELINE_REAL, 'pulpo.js'), 'utf8');

    // CA-UX-1/3 — el operador tiene que leer QUÉ pasó y con qué evidencia.
    assert.ok(/el resultado no cambió: el diff es idéntico en todos los ciclos/.test(src));
    assert.ok(/Mismo diff en \$\{noProgreso\.ciclos\} ciclos — hash \$\{noProgreso\.hashCorto\}/.test(src),
        'CA-UX-3: hash corto + cantidad de ciclos visibles');
    assert.ok(/circuit_breaker\.noprogreso_max\\`\s*=\s*\$\{noProgreso\.max\}/.test(src),
        'el umbral se nombra para que el operador sepa dónde tocarlo');

    // CA-UX-2 — las 3 acciones son las de "el reintento no mueve nada", NO las
    // de "revisá el host": ese consejo acá manda al operador al lugar equivocado.
    assert.ok(/Si la acción pedida vive en otra fase/.test(src));
    assert.ok(/Si el arreglo no depende del agente que corre/.test(src));
    assert.ok(/el reintento no toca el entorno, así que este breaker no lo diagnostica/.test(src));

    // CA-UX-4 — se avisa que el destrabe resetea TAMBIÉN el historial de no-progreso.
    assert.ok(/se resetean el contador de rebotes \*\*y el historial de no-progreso\*\*/.test(src));

    // CA-UX-5 — Telegram sin jerga de módulo.
    const tg = src.match(/reintentó \$\{noProgreso\.ciclos\} veces sin progreso[^`]*/);
    assert.ok(tg, 'debe existir el Telegram de la rama noprogreso');
    assert.ok(!/infra-noprogress|shouldEscalate|JSONL/.test(tg[0]), 'sin nombres de módulo en el mensaje al operador');

    // CA-UX-7 — sólo los emojis ya usados.
    const emojisNuevos = (src.match(/reintentó \$\{noProgreso\.ciclos\}[\s\S]{0,200}/) || [''])[0]
        .match(/[\u{1F300}-\u{1FAFF}]/gu) || [];
    assert.deepStrictEqual([...new Set(emojisNuevos)], ['🚨']);

    // NO-REGRESIÓN — la rama `infra_threshold` conserva sus textos originales.
    assert.ok(/falló por un problema de infraestructura que no puede resolver automáticamente/.test(src));
    assert.ok(/por una causa clasificada como infra persistente \(threshold: \$\{INFRA_ESCALATE_THRESHOLD\} rebotes\)/.test(src));
    assert.ok(/Si es un problema del entorno\*\* — revisá/.test(src));
    assert.ok(/\$\{reboteInfraCount \+ 1\} rebotes por infra\. Requiere intervención humana/.test(src));
});

// -----------------------------------------------------------------------------
// T13 / RIESGO-1 — config.yaml real + schema
// -----------------------------------------------------------------------------
test('T13 · la config real resuelve y valida con noprogreso_max', () => {
    const resolver = require('../config-resolver');
    const { validateConfig } = require('../config-schema');

    // `resolve` valida el schema internamente: si `noprogreso_max` no estuviera
    // registrada, el Pulpo NO arrancaría (additionalProperties: false).
    const cfg = resolver.resolve({ pipelineDir: PIPELINE_REAL, reload: true });
    const v = validateConfig(cfg);
    assert.strictEqual(v.valid, true, `config real inválida: ${JSON.stringify((v.errors || []).slice(0, 3))}`);
    assert.strictEqual(cfg.circuit_breaker.noprogreso_max, 2);
    assert.strictEqual(noprogress.resolveNoprogresoMax(cfg), 2);
});

test('T13b · el schema sigue siendo estricto y acota noprogreso_max a [2,10]', () => {
    const { validateConfig } = require('../config-schema');
    const resolver = require('../config-resolver');
    const base = resolver.resolve({ pipelineDir: PIPELINE_REAL, reload: true });
    const con = (v) => validateConfig({
        ...base,
        circuit_breaker: { ...base.circuit_breaker, noprogreso_max: v },
    }).valid;

    assert.strictEqual(con(2), true);
    assert.strictEqual(con(10), true);
    assert.strictEqual(con(1), false, 'minimum 2');
    assert.strictEqual(con(11), false, 'maximum 10');
    assert.strictEqual(con('2'), false, 'debe ser integer, no string');

    // additionalProperties: false sigue vivo — una clave nueva sin registrar
    // rompe el arranque, que es exactamente lo que RIESGO-1 advierte.
    const conClaveNueva = validateConfig({
        ...base,
        circuit_breaker: { ...base.circuit_breaker, clave_no_registrada: 1 },
    });
    assert.strictEqual(conClaveNueva.valid, false);
});
