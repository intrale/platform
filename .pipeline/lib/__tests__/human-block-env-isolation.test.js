'use strict';

/**
 * #7456 · T-1 — AISLAMIENTO DE AMBIENTE DE `lib/human-block.js` (SEC-HB-6).
 *
 * Reproduce el harness del PO del 20/09 (`/tmp/po-7439-check.js`): un agente
 * declara `PIPELINE_DIR_OVERRIDE` a un tmp ANTES de requerir `human-block` y
 * ejercita `reportHumanBlock`. Hasta #7456 el módulo fijaba su `.pipeline` al
 * `require` (const de módulo sobre la raíz del repo que devuelve `traceability`)
 * y escribía en la instalación PRODUCTIVA: markers `7113.intake` / `7114.po`,
 * órdenes de label `needs-human` reales, aviso a Telegram y recordatorios cada
 * 6 h, ~7 h de freno hasta que el operador destrabó a mano.
 *
 * Escenarios (CA-7 del PO):
 *   1. CA-2 · override declarado → todo bajo `TMP`; `PROD` simulado idéntico
 *      antes/después (nombres + mtimes + tamaños) y el work-file sembrado en
 *      `PROD` NO se movió (SEC-HB-1: lectura y escritura resuelven la MISMA
 *      raíz en la misma llamada). Incluye el estado del recordatorio (D-3).
 *   2. CA-3 · sin ambiente → `EscrituraBloqueadaError` (`esBloqueo`), las tres
 *      líneas `[pipeline-env]` en stderr, y `enqueueNeedsHumanLabel` /
 *      `enqueueGithub` LANZAN en vez de devolver `false` (SEC-HB-3).
 *   3. CA-4 · traversal en `skill` / `phase` / `pipeline` / `target_phase` →
 *      throw, cero archivos nuevos en `TMP` y `PROD` (SEC-HB-2).
 *   4. CA-1 + CA-6 · guardrail del módulo: el fuente no vuelve a la const de
 *      módulo y el inventario `write-points.json` lo lista con canal declarado
 *      (única red para este archivo mientras #7460 siga abierto, D-2).
 *   5. `gh` NO se invoca: la orden queda como archivo en la cola (assert
 *      documental sobre `child_process`).
 *   6. CA-8 · Gherkin 3: con ambiente declarado el flujo productivo es el de
 *      siempre (`reportHumanBlock` → `unblockIssue` mueve el marker a
 *      `pendiente/`; la orden `remove-label` se encola).
 *
 * `PROD` es un `.pipeline` SIMULADO bajo `CLAUDE_PROJECT_DIR`: es exactamente
 * la raíz que el módulo viejo habría resuelto vía `traceability.REPO_ROOT`, así
 * que el test falla si alguien vuelve a la const de módulo. Además se comprueba
 * que el `.pipeline` real del repo no gana ningún archivo `7113.*`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const ISSUE = 7113;
const LIB_DIR = path.resolve(__dirname, '..');
const REAL_PIPELINE_DIR = path.resolve(LIB_DIR, '..');

// ── Fixtures ────────────────────────────────────────────────────────────────

// PROD simulado: `CLAUDE_PROJECT_DIR` apunta acá, así `traceability.REPO_ROOT`
// (y por tanto la const de módulo del código viejo) resolvería a `PROD`.
const PROD_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hb7456-prod-'));
const PROD = path.join(PROD_ROOT, '.pipeline');
// TMP: el dir de pruebas que declara el harness.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hb7456-tmp-'));
const TMP = path.join(TMP_ROOT, '.pipeline');

function sembrarProd() {
    fs.mkdirSync(path.join(PROD_ROOT, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(PROD, 'desarrollo', 'validacion', 'trabajando'), { recursive: true });
    fs.mkdirSync(path.join(PROD, 'desarrollo', 'validacion', 'bloqueado-humano'), { recursive: true });
    fs.mkdirSync(path.join(PROD, 'definicion', 'validacion', 'bloqueado-humano'), { recursive: true });
    fs.mkdirSync(path.join(PROD, 'servicios', 'github', 'pendiente'), { recursive: true });
    fs.mkdirSync(path.join(PROD, 'audit'), { recursive: true });
    // SEC-HB-1: work-file REAL en vuelo. Si la lectura resolviera PROD y la
    // escritura TMP, `reportHumanBlock` lo renombraría hacia el tmp.
    fs.writeFileSync(path.join(PROD, 'desarrollo', 'validacion', 'trabajando', `${ISSUE}.intake`), `issue: ${ISSUE}\n`);
    fs.writeFileSync(path.join(PROD, 'human-block-reminder-state.json'), JSON.stringify({ version: 1, issues: {} }));
}
sembrarProd();
fs.mkdirSync(TMP, { recursive: true });

/** Snapshot recursivo: ruta relativa → `size|mtimeMs`. */
function snapshot(root) {
    const out = {};
    const walk = (dir) => {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const abs = path.join(dir, e.name);
            const rel = path.relative(root, abs).split(path.sep).join('/');
            if (e.isDirectory()) { out[rel + '/'] = 'dir'; walk(abs); }
            else { const st = fs.statSync(abs); out[rel] = `${st.size}|${st.mtimeMs}`; }
        }
    };
    walk(root);
    return out;
}

/** Archivos `7113.*` en los destinos del `.pipeline` REAL del repo (para no ensuciar producción). */
function realProdMarkers() {
    const out = [];
    for (const pipeline of ['desarrollo', 'definicion']) {
        let phases = [];
        try { phases = fs.readdirSync(path.join(REAL_PIPELINE_DIR, pipeline)); } catch { continue; }
        for (const phase of phases) {
            let files = [];
            try { files = fs.readdirSync(path.join(REAL_PIPELINE_DIR, pipeline, phase, 'bloqueado-humano')); } catch { continue; }
            for (const f of files) if (f.startsWith(`${ISSUE}.`)) out.push(`${pipeline}/${phase}/${f}`);
        }
    }
    let cola = [];
    try { cola = fs.readdirSync(path.join(REAL_PIPELINE_DIR, 'servicios', 'github', 'pendiente')); } catch { cola = []; }
    for (const f of cola) if (f.startsWith(`${ISSUE}-`)) out.push(`servicios/github/pendiente/${f}`);
    return out.sort();
}
const REAL_ANTES = realProdMarkers();

// ── Entorno: patrón D-4 (CLAUDE_PROJECT_DIR + PIPELINE_DIR_OVERRIDE, SIN PIPELINE_REPO_ROOT) ──

const { withEnv } = require('../test-helpers/with-env');

// Variables que gobiernan la resolución de ambiente: se BORRAN todas (undefined
// = ausente, D-6258-5) y sólo se reponen las que pide cada escenario. Va por el
// helper canónico `withEnv` (#6258): claves estáticas, snapshot/restore exacto.
const ENV_LIMPIO = Object.freeze({
    PIPELINE_AMBIENTE: undefined,
    PIPELINE_ENV: undefined,
    PIPELINE_DIR_OVERRIDE: undefined,
    PIPELINE_STATE_DIR: undefined,
    PIPELINE_REPO_ROOT: undefined,
    PIPELINE_ALLOW_PROD_SIDE_EFFECTS: undefined,
});

function conEnv(vars, fn, opts) {
    return withEnv({ ...ENV_LIMPIO, ...vars }, fn, opts);
}

/** Captura `process.stderr.write` mientras corre `fn`. */
function capturarStderr(fn) {
    const lineas = [];
    const orig = process.stderr.write;
    process.stderr.write = (chunk) => { lineas.push(String(chunk)); return true; };
    try { fn(); } finally { process.stderr.write = orig; }
    return lineas.join('');
}

// El harness del PO: env ANTES del require. `traceability` congela REPO_ROOT al
// cargarse → se carga fresco apuntando a PROD_ROOT.
process.env.CLAUDE_PROJECT_DIR = PROD_ROOT;
delete process.env.PIPELINE_REPO_ROOT;
process.env.PIPELINE_DIR_OVERRIDE = TMP;
delete require.cache[require.resolve('../traceability')];
delete require.cache[require.resolve('../human-block')];
const trace = require('../traceability');
const hb = require('../human-block');
const writeTarget = require('../write-target');
const reminder = require('../human-block-reminder');
const scan = require('../write-points-scan');

assert.equal(trace.REPO_ROOT, PROD_ROOT, 'precondición: traceability resuelve al PROD simulado (así el módulo viejo habría escrito ahí)');

const OPTS = { issue: ISSUE, skill: 'intake', phase: 'validacion', pipeline: 'definicion', reason: 'x', question: 'y?' };

// ── Escenario 1 · CA-2 ──────────────────────────────────────────────────────

test('CA-2 · harness con PIPELINE_DIR_OVERRIDE: marker, sidecar, orden github y estado del recordatorio bajo TMP; PROD intacto', () => {
    const antes = snapshot(PROD);
    conEnv({ PIPELINE_DIR_OVERRIDE: TMP }, () => {
        // (a) como el harness del PO: marker sintético.
        const r1 = hb.reportHumanBlock({ ...OPTS, moveFromActive: false });
        assert.equal(r1.marker_path, path.join(TMP, 'definicion', 'validacion', 'bloqueado-humano', `${ISSUE}.intake`));
        assert.ok(fs.existsSync(r1.marker_path), 'marker bajo TMP');
        assert.ok(fs.existsSync(hb.reasonFilePath(r1.marker_path)), '.reason.json bajo TMP');
        const meta = JSON.parse(fs.readFileSync(hb.reasonFilePath(r1.marker_path), 'utf8'));
        assert.equal(meta.synthetic, true);

        // (b) default `moveFromActive` (mueve el work-file activo si lo hay):
        // en TMP no hay ninguno; en PROD hay uno y NO tiene que tocarse.
        const r2 = hb.reportHumanBlock({ ...OPTS, skill: 'po' });
        assert.ok(r2.marker_path.startsWith(TMP + path.sep), `marker bajo TMP: ${r2.marker_path}`);

        // (c) la orden `label needs-human` está en la cola de TMP.
        const cola = fs.readdirSync(path.join(TMP, 'servicios', 'github', 'pendiente'));
        const ordenes = cola.filter((f) => f.startsWith(`${ISSUE}-needs-human-block-`));
        assert.ok(ordenes.length >= 2, `órdenes de label bajo TMP: ${cola.join(', ')}`);
        const orden = JSON.parse(fs.readFileSync(path.join(TMP, 'servicios', 'github', 'pendiente', ordenes[0]), 'utf8'));
        assert.deepEqual(orden, { action: 'label', issue: ISSUE, label: 'needs-human' });

        // (d) el recordatorio (D-3) persiste su estado en el dir que le pasa el
        // llamador migrado (`pulpo.js::PIPELINE()`), acá TMP.
        const enviados = [];
        const tick = reminder.runReminderTick({
            pipelineDir: TMP,
            listBlocked: () => hb.listBlockedIssues(),
            sendTelegram: (texto) => enviados.push(texto),
            now: new Date(Date.now() + 8 * 3600 * 1000),
        });
        assert.equal(tick.sent, true, JSON.stringify(tick));
        assert.equal(enviados.length, 1);
        assert.ok(fs.existsSync(path.join(TMP, reminder.STATE_FILENAME)), 'estado del recordatorio bajo TMP');

        // (e) las lecturas ven lo mismo que las escrituras (SEC-HB-1).
        assert.ok(hb.listBlockedIssues().some((b) => b.issue === ISSUE && b.skill === 'intake'));
        assert.ok(hb.findBlockedMarker(ISSUE).file.startsWith(TMP + path.sep));
    });
    assert.deepEqual(snapshot(PROD), antes, 'PROD simulado: ningún archivo nuevo ni modificado');
    assert.ok(fs.existsSync(path.join(PROD, 'desarrollo', 'validacion', 'trabajando', `${ISSUE}.intake`)),
        'SEC-HB-1: el work-file productivo sigue en trabajando/ (no se movió al tmp)');
    assert.equal(fs.readFileSync(path.join(PROD, 'human-block-reminder-state.json'), 'utf8'),
        JSON.stringify({ version: 1, issues: {} }), 'estado del recordatorio productivo intacto');
    assert.deepEqual(realProdMarkers(), REAL_ANTES, 'el .pipeline REAL del repo no ganó ningún 7113.*');
});

// ── Escenario 5 · `gh` no se invoca ──────────────────────────────────────────

test('la orden queda como archivo en la cola: human-block NUNCA invoca `gh` por child_process', () => {
    const llamadas = [];
    const originales = {};
    for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) {
        originales[fn] = childProcess[fn];
        childProcess[fn] = (...args) => { llamadas.push(`${fn}(${String(args[0])})`); return originales[fn].apply(childProcess, args); };
    }
    try {
        conEnv({ PIPELINE_DIR_OVERRIDE: TMP }, () => {
            hb.reportHumanBlock({ ...OPTS, skill: 'ux', moveFromActive: false });
            hb.enqueueGithub('comment', { issue: ISSUE, body: 'x' });
        });
    } finally {
        for (const [fn, orig] of Object.entries(originales)) childProcess[fn] = orig;
    }
    assert.deepEqual(llamadas.filter((c) => /\bgh\b/.test(c)), [], `human-block invocó gh: ${llamadas.join(', ')}`);
    const cola = fs.readdirSync(path.join(TMP, 'servicios', 'github', 'pendiente'));
    assert.ok(cola.some((f) => f.startsWith(`${ISSUE}-comment-hb-`)), 'la orden comment quedó encolada como archivo');
});

// ── Escenario 2 · CA-3 ──────────────────────────────────────────────────────

test('CA-3 · sin ambiente declarado: reportHumanBlock lanza EscrituraBloqueadaError, avisa por stderr y no escribe', () => {
    const antesProd = snapshot(PROD);
    const antesTmp = snapshot(TMP);
    writeTarget._resetAvisos();
    let err;
    const stderr = capturarStderr(() => {
        conEnv({}, () => {
            try { hb.reportHumanBlock({ ...OPTS, skill: 'guru', moveFromActive: false }); }
            catch (e) { err = e; }
        });
    });
    assert.ok(err, 'debía lanzar');
    assert.ok(writeTarget.esBloqueo(err), `esBloqueo: ${err && err.message}`);
    assert.equal(err.name, 'EscrituraBloqueadaError');
    const lineas = stderr.split('\n').filter((l) => l.startsWith(writeTarget.PREFIJO));
    assert.equal(lineas.length, 3, `tres líneas [pipeline-env] en stderr:\n${stderr}`);
    assert.match(lineas[0], /escritura bloqueada: canal=estado destino=<pipeline>\/<fase>\/bloqueado-humano/);
    assert.match(lineas[1], /motivo:/);
    assert.match(lineas[2], /para salir:/);
    assert.deepEqual(snapshot(PROD), antesProd, 'PROD intacto');
    assert.deepEqual(snapshot(TMP), antesTmp, 'TMP intacto (tampoco escribió ahí)');
    assert.deepEqual(realProdMarkers(), REAL_ANTES);
});

test('CA-3 / SEC-HB-3 · sin ambiente, enqueueNeedsHumanLabel y enqueueGithub LANZAN (no devuelven false)', () => {
    const antesProd = snapshot(PROD);
    conEnv({}, () => {
        assert.throws(() => hb.enqueueNeedsHumanLabel(ISSUE), writeTarget.esBloqueo);
        assert.throws(() => hb.enqueueGithub('comment', { issue: ISSUE, body: 'x' }), writeTarget.esBloqueo);
        assert.throws(() => hb.auditQuickAction({ issue: ISSUE, action: 'unblock' }), writeTarget.esBloqueo);
        assert.throws(() => hb.listBlockedIssues(), writeTarget.esBloqueo, 'las lecturas resuelven por el mismo camino');
        assert.throws(() => hb.reconcileBlockedMarkers({ issue: ISSUE }), writeTarget.esBloqueo, 'el bloqueo no se traga como "sin markers"');
    });
    assert.deepEqual(snapshot(PROD), antesProd);
});

test('sin ambiente, PIPELINE_REPO_ROOT (contexto heredado del Pulpo) NO habilita la escritura (SEC-9)', () => {
    const antesProd = snapshot(PROD);
    conEnv({ PIPELINE_REPO_ROOT: PROD_ROOT }, () => {
        assert.throws(() => hb.reportHumanBlock({ ...OPTS, moveFromActive: false }), writeTarget.esBloqueo);
    });
    assert.deepEqual(snapshot(PROD), antesProd);
});

// ── Helpers de resolución ────────────────────────────────────────────────────

test('markersRoot / ghQueueDir / auditRoot / titleCacheDir resuelven POR LLAMADA (sin cache al require)', () => {
    const OTRO = fs.mkdtempSync(path.join(os.tmpdir(), 'hb7456-otro-'));
    try {
        conEnv({ PIPELINE_DIR_OVERRIDE: TMP }, () => {
            assert.equal(hb.markersRoot(), TMP);
            assert.equal(hb.ghQueueDir(), path.join(TMP, 'servicios', 'github', 'pendiente'));
            assert.equal(hb.auditRoot(), path.join(TMP, 'audit'));
            assert.equal(hb.auditRoot({ auditDir: 'X' }), 'X', 'deps.auditDir es inyección de tests, sólo para el audit');
            assert.equal(hb.titleCacheDir(), TMP);
        });
        conEnv({ PIPELINE_DIR_OVERRIDE: OTRO }, () => {
            assert.equal(hb.markersRoot(), OTRO, 'mismo proceso, otro override: la resolución no quedó cacheada');
        });
        conEnv({}, () => {
            assert.throws(() => hb.markersRoot(), writeTarget.esBloqueo);
            assert.throws(() => hb.ghQueueDir(), writeTarget.esBloqueo);
            assert.throws(() => hb.auditRoot(), writeTarget.esBloqueo);
            assert.equal(hb.auditRoot({ auditDir: 'X' }), 'X');
            assert.equal(hb.titleCacheDir(), null, 'sólo lectura: null, nunca lanza');
        });
    } finally {
        fs.rmSync(OTRO, { recursive: true, force: true });
    }
});

test('CA-5 · sin bypass: PIPELINE_DIR ya no se exporta y no hay opts.pipelineDir / opts.force / PIPELINE_ALLOW_*', () => {
    assert.equal(hb.PIPELINE_DIR, undefined, 'la const de módulo se retiró del export');
    // Sólo CÓDIGO (sin líneas de comentario): los comentarios nombran el bypass para prohibirlo.
    const codigo = fs.readFileSync(path.join(LIB_DIR, 'human-block.js'), 'utf8')
        .split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.doesNotMatch(codigo, /opts\.pipelineDir|opts\.force|PIPELINE_ALLOW_PROD_SIDE_EFFECTS/, 'sin escape hatch propio (SEC-HB-4)');
    // El hatch de #7110 tampoco alcanza sin declaración productiva.
    const antesProd = snapshot(PROD);
    conEnv({ PIPELINE_ALLOW_PROD_SIDE_EFFECTS: '1' }, () => {
        assert.throws(() => hb.reportHumanBlock({ ...OPTS, moveFromActive: false }), writeTarget.esBloqueo);
    });
    assert.deepEqual(snapshot(PROD), antesProd);
});

// ── Escenario 3 · CA-4 (SEC-HB-2) ───────────────────────────────────────────

test('CA-4 · traversal en skill / phase / pipeline: throw explícito, cero archivos nuevos en TMP y PROD', () => {
    const antesProd = snapshot(PROD);
    const antesTmp = snapshot(TMP);
    conEnv({ PIPELINE_DIR_OVERRIDE: TMP }, () => {
        assert.throws(() => hb.reportHumanBlock({ ...OPTS, skill: '../../x', moveFromActive: false }),
            /\[human-block\] skill inválido: "\.\.\/\.\.\/x"/);
        assert.throws(() => hb.reportHumanBlock({ ...OPTS, phase: 'validacion/../../dev', moveFromActive: false }),
            /\[human-block\] phase inválido/);
        assert.throws(() => hb.reportHumanBlock({ ...OPTS, phase: 'validacion\\..\\dev', moveFromActive: false }),
            /\[human-block\] phase inválido/);
        assert.throws(() => hb.reportHumanBlock({ ...OPTS, skill: 'Intake', moveFromActive: false }),
            /\[human-block\] skill inválido/, 'mayúsculas fuera del segmento simple');
        assert.throws(() => hb.reportHumanBlock({ ...OPTS, pipeline: 'otro', moveFromActive: false }),
            /\[human-block\] pipeline inválido: "otro"/);
        assert.throws(() => hb.reportHumanBlock({ ...OPTS, pipeline: '../..', moveFromActive: false }),
            /\[human-block\] pipeline inválido/);
    });
    assert.deepEqual(snapshot(TMP), antesTmp, 'TMP sin archivos nuevos');
    assert.deepEqual(snapshot(PROD), antesProd, 'PROD sin archivos nuevos');
});

test('CA-4 · unblockIssue con target_phase con separadores o ".." lanza y no mueve nada', () => {
    conEnv({ PIPELINE_DIR_OVERRIDE: TMP }, () => {
        // Hay un marker de intake en TMP del escenario 1.
        const blocked = hb.findBlockedMarker(ISSUE);
        assert.ok(blocked, 'precondición: marker bloqueado en TMP');
        const antesTmp = snapshot(TMP);
        const antesProd = snapshot(PROD);
        for (const target of ['../dev', 'validacion/../dev', 'x\\y', '..', 'Dev']) {
            assert.throws(() => hb.unblockIssue({ issue: ISSUE, target_phase: target, guidance: 'ok' }),
                /\[human-block\] target_phase inválido/, `target_phase=${target}`);
        }
        // Marker con pipeline fuera de la whitelist (inyectado vía `opts.marker`).
        assert.throws(() => hb.unblockIssue({ issue: ISSUE, marker: { ...blocked, pipeline: '..' }, guidance: 'ok' }),
            /\[human-block\] pipeline inválido/);
        assert.deepEqual(snapshot(TMP), antesTmp, 'TMP intacto');
        assert.deepEqual(snapshot(PROD), antesProd, 'PROD intacto');
        assert.ok(fs.existsSync(blocked.file), 'el marker sigue bloqueado');
    });
});

test('validadores SEC-HB-2: assertSegmento / assertPipeline / assertConfinado (todas las ramas)', () => {
    assert.equal(hb.assertSegmento('skill', 'pipeline-dev'), 'pipeline-dev');
    assert.equal(hb.assertSegmento('phase', 'dev_2'), 'dev_2');
    for (const malo of ['', '-dev', '_x', 'a/b', 'a\\b', '..', 'a b', 'Dev', 'dev.', undefined, null]) {
        assert.throws(() => hb.assertSegmento('phase', malo), /\[human-block\] phase inválido/, `segmento=${String(malo)}`);
    }
    assert.equal(hb.assertPipeline('desarrollo'), 'desarrollo');
    assert.equal(hb.assertPipeline('definicion'), 'definicion');
    assert.throws(() => hb.assertPipeline('otro'), /pipeline inválido: "otro" \(válidos: desarrollo \| definicion\)/);
    assert.throws(() => hb.assertPipeline(undefined), /pipeline inválido/);

    const base = path.join(TMP, 'desarrollo');
    assert.equal(hb.assertConfinado(base, base), path.resolve(base), 'igual a la base: confinado');
    assert.equal(hb.assertConfinado(path.join(base, 'dev', 'pendiente'), base), path.resolve(base, 'dev', 'pendiente'));
    assert.throws(() => hb.assertConfinado(path.join(base, '..', 'definicion'), base), /destino fuera del pipelineDir resuelto/);
    assert.throws(() => hb.assertConfinado(base + '-otro', base), /destino fuera del pipelineDir resuelto/, 'prefijo de string sin separador no confina');
});

// ── Escenario 4 · guardrail del módulo (CA-1 + CA-6) ─────────────────────────

test('CA-1 · el fuente no tiene const de módulo para el dir de escritura ni usa la raíz de traceability', () => {
    const src = fs.readFileSync(path.join(LIB_DIR, 'human-block.js'), 'utf8');
    assert.doesNotMatch(src, /\btrace\.REPO_ROOT\b/, 'la raíz del repo de traceability no es destino de escritura');
    assert.doesNotMatch(src, /^const (PIPELINE_DIR|GH_QUEUE_DIR)\s*=/m, 'sin const de módulo PIPELINE_DIR / GH_QUEUE_DIR');
    assert.doesNotMatch(src, /\bPIPELINE_DIR\b\s*,\s*$/m, 'PIPELINE_DIR no figura en module.exports');
    assert.match(src, /\bconst trace = require\('\.\/traceability'\)/, 'trace se conserva (appendEvent)');
    assert.match(src, /^const PIPELINES = \['desarrollo', 'definicion'\]/m, 'PIPELINES se conserva (whitelist SEC-HB-2)');
    for (const fn of ['markersRoot', 'ghQueueDir', 'auditRoot', 'titleCacheDir']) {
        assert.equal(typeof hb[fn], 'function', `${fn} exportada`);
    }
});

test('CA-6 · write-points.json lista lib/human-block.js con ≥3 puntos migrados/safe y canales estado/colas/logs', () => {
    const entradas = scan.leerInventario(REAL_PIPELINE_DIR).filter((e) => e.modulo === 'lib/human-block.js');
    assert.ok(entradas.length >= 3, `entradas de human-block en el inventario: ${entradas.length}`);
    for (const e of entradas) {
        assert.ok(['migrado', 'safe'].includes(e.estado), `${e.funcion}: estado=${e.estado}`);
        assert.equal(e.tier, 3);
    }
    const porFuncion = Object.fromEntries(entradas.map((e) => [e.funcion, e]));
    assert.equal(porFuncion.markersRoot.canal, 'estado');
    assert.equal(porFuncion.markersRoot.destino, '<pipeline>/<fase>/bloqueado-humano');
    assert.equal(porFuncion.ghQueueDir.canal, 'colas');
    assert.equal(porFuncion.ghQueueDir.destino, 'servicios/github/pendiente');
    assert.equal(porFuncion.auditRoot.canal, 'logs');
    assert.match(porFuncion.auditRoot.destino, /^audit\//);
    // El escáner REAL ve lo mismo (no se "migró" editando el JSON).
    const real = scan.escanearModulo(path.join(LIB_DIR, 'human-block.js'));
    assert.equal(real.escribe, true);
    assert.deepEqual(real.puntos.map((p) => p.funcion).sort(), ['auditRoot', 'ghQueueDir', 'markersRoot']);
    assert.ok(real.puntos.every((p) => p.estado === 'migrado' && !p.inmune));
});

// ── Escenario 6 · CA-8 (Gherkin 3: productivo declarado, flujo de siempre) ──

test('CA-8 · con ambiente declarado el flujo reportHumanBlock → unblockIssue es el de siempre (marker a pendiente/, remove-label encolado)', () => {
    const antesProd = snapshot(PROD);
    conEnv({ PIPELINE_AMBIENTE: 'productivo', PIPELINE_DIR_OVERRIDE: TMP }, () => {
        const src = path.join(TMP, 'desarrollo', 'dev', 'trabajando', `${ISSUE}.pipeline-dev`);
        fs.mkdirSync(path.dirname(src), { recursive: true });
        fs.writeFileSync(src, `issue: ${ISSUE}\nfase: dev\n`);
        const r = hb.reportHumanBlock({ issue: ISSUE, skill: 'pipeline-dev', phase: 'dev', reason: 'r', question: 'q?' });
        assert.equal(r.pipeline, 'desarrollo');
        assert.ok(!fs.existsSync(src), 'el work-file activo de TMP se movió al bloqueo (mismo dir: SEC-HB-1)');
        assert.equal(fs.readFileSync(r.marker_path, 'utf8'), `issue: ${ISSUE}\nfase: dev\n`);

        // /unblock (commander) → unblockIssue: el marker vuelve a pendiente/.
        const u = hb.unblockIssue({ issue: ISSUE, marker: hb.listBlockedMarkers(ISSUE).find((m) => m.skill === 'pipeline-dev'), guidance: 'seguí', unlocker: 'commander:telegram' });
        assert.equal(u.ok, true, JSON.stringify(u));
        const dest = path.join(TMP, 'desarrollo', 'dev', 'pendiente', `${ISSUE}.pipeline-dev`);
        assert.ok(fs.existsSync(dest), 'marker de vuelta en pendiente/');
        assert.ok(!fs.existsSync(r.marker_path));
        assert.ok(fs.existsSync(hb.guidanceFilePath(path.dirname(dest), `${ISSUE}.pipeline-dev`)), 'guidance del humano junto al marker');

        // Botón de la alerta de Telegram → executeQuickAction: reactiva lo que
        // quede bloqueado, encola remove-label y asienta el audit bajo TMP/audit.
        hb.reportHumanBlock({ issue: ISSUE, skill: 'guru', phase: 'dev', reason: 'r', question: 'q?', moveFromActive: false });
        const q = hb.executeQuickAction({ issue: ISSUE, action: 'unblock' });
        assert.equal(q.ok, true, JSON.stringify(q));
        assert.ok(q.reactivated >= 1, 'reactivó el marker de guru (y los que quedaron de escenarios previos en TMP)');
        const audit = hb.auditQuickAction({ issue: ISSUE, action: 'unblock', from: 'test', result_status: 'ok' });
        assert.ok(audit, 'audit asentado');
        const cola = fs.readdirSync(path.join(TMP, 'servicios', 'github', 'pendiente'));
        assert.ok(cola.some((f) => f.startsWith(`${ISSUE}-remove-label-`)), `remove-label encolado: ${cola.join(', ')}`);
        const auditFiles = fs.readdirSync(path.join(TMP, 'audit')).filter((f) => f.startsWith('human-block-actions-'));
        assert.ok(auditFiles.length >= 1, 'audit de acciones rápidas bajo TMP/audit');
    });
    // Derrame RESIDUAL fuera del alcance de #7456 (documentado en la receta y
    // en #7461, OPEN): `merge-race-reclaim-ledger.js` — que `unblockIssue`
    // invoca con un unlocker manual (`clearEntry`) — sigue fijando su archivo
    // sobre `trace.REPO_ROOT` al `require`, así que escribe
    // `audit/merge-race-reclaims.json` bajo PROD. Se tolera SÓLO ese archivo:
    // cualquier otra diferencia es un derrame de human-block y falla. Cuando
    // #7461 migre el ledger, este assert sigue verde sin tocarlo.
    const RESIDUAL_7461 = new Set(['audit/merge-race-reclaims.json']);
    const despuesProd = snapshot(PROD);
    const diff = [...new Set([...Object.keys(antesProd), ...Object.keys(despuesProd)])]
        .filter((k) => antesProd[k] !== despuesProd[k]);
    assert.deepEqual(diff.filter((k) => !RESIDUAL_7461.has(k)), [],
        `PROD simulado intacto también en el flujo productivo (salvo el residual de #7461): ${diff.join(', ')}`);
    assert.deepEqual(realProdMarkers(), REAL_ANTES);
});

test.after(() => {
    fs.rmSync(PROD_ROOT, { recursive: true, force: true });
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});
