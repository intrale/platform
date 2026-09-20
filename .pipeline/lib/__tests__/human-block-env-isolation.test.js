// #7456 — Test de aislamiento de `lib/human-block.js` (T-1, SEC-HB-6).
//
// Reproduce el harness que el PO de #7439 corrió el 20/09/2026 a la 01:05 ART
// (`PIPELINE_DIR_OVERRIDE = mkdtemp(...)` y recién después `require`) y que,
// con la versión anterior del módulo, dejó markers sintéticos de #7113/#7114,
// órdenes reales de `needs-human` y recordatorios en la instalación PRODUCTIVA.
//
// Arma DOS directorios efímeros:
//   - PROD: "productivo simulado", con un work-file real sembrado en
//     `desarrollo/validacion/trabajando/7113.intake`, la cola del servicio-github
//     vacía y el estado del recordatorio. Se toma un snapshot recursivo
//     (nombres + tamaños + mtimes) antes y después de cada escenario: tiene que
//     ser IDÉNTICO.
//   - TMP: el dir de pruebas que declara el harness.
//
// El módulo NUNCA tiene forma de llegar a PROD por su cuenta (la resolución es
// por llamada vía `write-target`); la prueba es NEGATIVA: verifica que nada del
// flujo (marker, sidecar, orden de GitHub, estado del recordatorio, work-file
// movido) aterriza fuera de TMP, y que sin ambiente declarado el módulo se
// niega a escribir en vez de caer al productivo.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Fixtures ────────────────────────────────────────────────────────────────
const PROD = fs.mkdtempSync(path.join(os.tmpdir(), 'hb7456-prod-'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hb7456-tmp-'));
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'hb7456-project-'));
// `trace.appendEvent` (fuera de alcance, #7462) escribe en CLAUDE_PROJECT_DIR/.claude.
fs.mkdirSync(path.join(PROJECT, '.claude'), { recursive: true });

const PROD_PIPELINE = path.join(PROD, '.pipeline');
const TMP_PIPELINE = path.join(TMP, '.pipeline');
const WORKFILE_PROD = path.join(PROD_PIPELINE, 'desarrollo', 'validacion', 'trabajando', '7113.intake');

function sembrarProd() {
    fs.mkdirSync(path.dirname(WORKFILE_PROD), { recursive: true });
    fs.writeFileSync(WORKFILE_PROD, 'issue: 7113\nfase: validacion\npipeline: desarrollo\n');
    fs.mkdirSync(path.join(PROD_PIPELINE, 'servicios', 'github', 'pendiente'), { recursive: true });
    fs.mkdirSync(path.join(PROD_PIPELINE, 'definicion', 'validacion', 'bloqueado-humano'), { recursive: true });
    fs.writeFileSync(path.join(PROD_PIPELINE, 'human-block-reminder-state.json'), '{"issues":{}}\n');
}

/** Snapshot recursivo: path relativo + tamaño + mtime de cada entrada. */
function snapshot(root) {
    const out = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            const st = fs.statSync(p);
            out.push(`${path.relative(root, p)}|${e.isDirectory() ? 'd' : st.size}|${st.mtimeMs}`);
            if (e.isDirectory()) walk(p);
        }
    };
    walk(root);
    return out.sort();
}

function listarRecursivo(root) {
    return snapshot(root).map((l) => l.split('|')[0]);
}

// El harness real del PO: override ANTES del require. Se replica igual aunque
// el módulo ya resuelva por llamada — es el escenario que se quiere cubrir.
// SEC-9 (D-4 de la receta): `PIPELINE_REPO_ROOT` heredado del runner anularía
// el override; se borra. `CLAUDE_PROJECT_DIR` alimenta `trace.LOG_FILE`.
// Claves LITERALES (no `process.env[k]`): `test-env-lint` exige que cada
// escritura de env sea resoluble estáticamente.
const ENV_ORIGINAL = {
    PIPELINE_ENV: process.env.PIPELINE_ENV,
    PIPELINE_AMBIENTE: process.env.PIPELINE_AMBIENTE,
    PIPELINE_DIR_OVERRIDE: process.env.PIPELINE_DIR_OVERRIDE,
    PIPELINE_REPO_ROOT: process.env.PIPELINE_REPO_ROOT,
    PIPELINE_STATE_DIR: process.env.PIPELINE_STATE_DIR,
    CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
};

function sinAmbiente() {
    delete process.env.PIPELINE_ENV;
    delete process.env.PIPELINE_AMBIENTE;
    delete process.env.PIPELINE_DIR_OVERRIDE;
    delete process.env.PIPELINE_REPO_ROOT;
    delete process.env.PIPELINE_STATE_DIR;
    process.env.CLAUDE_PROJECT_DIR = PROJECT;
}
function declararPruebas() {
    sinAmbiente();
    process.env.PIPELINE_DIR_OVERRIDE = TMP_PIPELINE;
}
function restaurarEnv() {
    // Un `set` por variable, literal, para que el lint pueda resolverlas.
    if (ENV_ORIGINAL.PIPELINE_ENV === undefined) delete process.env.PIPELINE_ENV; else process.env.PIPELINE_ENV = ENV_ORIGINAL.PIPELINE_ENV;
    if (ENV_ORIGINAL.PIPELINE_AMBIENTE === undefined) delete process.env.PIPELINE_AMBIENTE; else process.env.PIPELINE_AMBIENTE = ENV_ORIGINAL.PIPELINE_AMBIENTE;
    if (ENV_ORIGINAL.PIPELINE_DIR_OVERRIDE === undefined) delete process.env.PIPELINE_DIR_OVERRIDE; else process.env.PIPELINE_DIR_OVERRIDE = ENV_ORIGINAL.PIPELINE_DIR_OVERRIDE;
    if (ENV_ORIGINAL.PIPELINE_REPO_ROOT === undefined) delete process.env.PIPELINE_REPO_ROOT; else process.env.PIPELINE_REPO_ROOT = ENV_ORIGINAL.PIPELINE_REPO_ROOT;
    if (ENV_ORIGINAL.PIPELINE_STATE_DIR === undefined) delete process.env.PIPELINE_STATE_DIR; else process.env.PIPELINE_STATE_DIR = ENV_ORIGINAL.PIPELINE_STATE_DIR;
    if (ENV_ORIGINAL.CLAUDE_PROJECT_DIR === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = ENV_ORIGINAL.CLAUDE_PROJECT_DIR;
}

sembrarProd();
declararPruebas();
delete require.cache[require.resolve('../traceability')];
delete require.cache[require.resolve('../human-block')];
const hb = require('../human-block');
const reminder = require('../human-block-reminder');
const writeTarget = require('../write-target');
const writePointsScan = require('../write-points-scan');

const BLOQUEO_7113 = {
    issue: 7113, skill: 'intake', phase: 'validacion', pipeline: 'definicion',
    reason: 'x', question: 'y?',
};

// ── Escenario 1: harness con ambiente de pruebas declarado ───────────────────
test('E1 · harness con PIPELINE_DIR_OVERRIDE: marker, sidecar, orden GitHub y recordatorio quedan bajo TMP; PROD intacto', () => {
    declararPruebas();
    const antes = snapshot(PROD);

    // (a) Igual que el PO: `moveFromActive: false` → marker sintético.
    const r1 = hb.reportHumanBlock({ ...BLOQUEO_7113, moveFromActive: false });
    assert.ok(r1.marker_path.startsWith(TMP_PIPELINE + path.sep),
        `marker fuera de TMP: ${r1.marker_path}`);
    assert.ok(fs.existsSync(r1.marker_path), 'marker no existe bajo TMP');
    assert.ok(fs.existsSync(hb.reasonFilePath(r1.marker_path)), '.reason.json no existe bajo TMP');

    const colaTmp = path.join(TMP_PIPELINE, 'servicios', 'github', 'pendiente');
    const ordenes = fs.readdirSync(colaTmp).filter((f) => f.startsWith('7113-needs-human-block-'));
    assert.equal(ordenes.length, 1, 'la orden de label needs-human debe encolarse UNA vez bajo TMP');
    const orden = JSON.parse(fs.readFileSync(path.join(colaTmp, ordenes[0]), 'utf8'));
    assert.deepEqual(orden, { action: 'label', issue: 7113, label: 'needs-human' });

    // (b) Segunda corrida SIN `moveFromActive: false` (default: mueve el work-file
    //     activo). Con lectura y escritura sobre la misma raíz (SEC-HB-1) el
    //     work-file de PROD no puede ser "encontrado" y sacado del pipeline.
    const r2 = hb.reportHumanBlock({ ...BLOQUEO_7113, issue: 7114, skill: 'po' });
    assert.ok(r2.marker_path.startsWith(TMP_PIPELINE + path.sep));
    assert.ok(fs.existsSync(WORKFILE_PROD), 'el work-file real de PROD fue movido por el harness (SEC-HB-1)');

    // (c) El recordatorio escribe su estado bajo el pipelineDir que recibe.
    const enviados = [];
    const tick = reminder.runReminderTick({
        pipelineDir: TMP_PIPELINE,
        listBlocked: () => hb.listBlockedIssues(),
        sendTelegram: (texto) => enviados.push(texto),
        now: new Date(Date.now() + 7 * 3600000),
    });
    assert.equal(tick.error, undefined, `tick con error: ${tick.error}`);
    assert.ok(fs.existsSync(path.join(TMP_PIPELINE, 'human-block-reminder-state.json')),
        'estado del recordatorio no quedó bajo TMP');

    // (d) `listBlockedIssues` ve SOLO lo de TMP.
    const issues = hb.listBlockedIssues().map((b) => b.issue).sort();
    assert.deepEqual(issues, [7113, 7114]);

    // (e) PROD idéntico byte a byte en nombres/tamaños/mtimes.
    assert.deepEqual(snapshot(PROD), antes, 'PROD cambió durante el harness');
    assert.equal(fs.readFileSync(path.join(PROD_PIPELINE, 'human-block-reminder-state.json'), 'utf8'), '{"issues":{}}\n');
    assert.deepEqual(fs.readdirSync(path.join(PROD_PIPELINE, 'servicios', 'github', 'pendiente')), []);
    assert.deepEqual(fs.readdirSync(path.join(PROD_PIPELINE, 'definicion', 'validacion', 'bloqueado-humano')), []);

    // (f) /unblock del mismo harness también queda confinado a TMP.
    const u = hb.unblockIssue({ issue: 7113 });
    assert.equal(u.ok, true, JSON.stringify(u));
    assert.ok(fs.existsSync(path.join(TMP_PIPELINE, 'definicion', 'validacion', 'pendiente', '7113.intake')));
    assert.deepEqual(snapshot(PROD), antes, 'PROD cambió durante /unblock');
});

// ── Escenario 2: sin ambiente declarado → fail-closed ────────────────────────
test('E2 · sin PIPELINE_ENV/PIPELINE_AMBIENTE/PIPELINE_DIR_OVERRIDE el módulo lanza EscrituraBloqueadaError y no escribe', () => {
    sinAmbiente();
    const antesProd = snapshot(PROD);
    const antesTmp = snapshot(TMP);

    assert.throws(() => hb.reportHumanBlock({ ...BLOQUEO_7113, issue: 7115 }), writeTarget.esBloqueo);
    // SEC-HB-3: el encolador NO devuelve `false` (best-effort) — lanza.
    assert.throws(() => hb.enqueueNeedsHumanLabel(7115), writeTarget.esBloqueo);
    assert.throws(() => hb.enqueueGithub('comment', { issue: 7115, body: 'x' }), writeTarget.esBloqueo);
    // Las lecturas del mismo flujo también fallan ruidoso (SEC-HB-1: nunca
    // "leer productivo" en silencio).
    assert.throws(() => hb.listBlockedIssues(), writeTarget.esBloqueo);
    assert.throws(() => hb.markersRoot(), writeTarget.esBloqueo);
    assert.throws(() => hb.ghQueueDir(), writeTarget.esBloqueo);
    assert.throws(() => hb.auditRoot(), writeTarget.esBloqueo);
    // El cache de títulos es SÓLO lectura: `safe*` → null, nunca lanza.
    assert.equal(hb.titleCacheDir(), null);
    // `deps.auditDir` es inyección de tests, no bypass: sólo alcanza al audit.
    assert.equal(hb.auditRoot({ auditDir: path.join(TMP, 'audit-x') }), path.join(TMP, 'audit-x'));

    const err = (() => { try { hb.reportHumanBlock({ ...BLOQUEO_7113, issue: 7115 }); } catch (e) { return e; } })();
    assert.equal(err.code, 'PIPELINE_ESCRITURA_BLOQUEADA');
    assert.match(err.message, /^\[pipeline-env\] escritura bloqueada: canal=estado destino=<pipeline>\/<fase>\/bloqueado-humano/m);
    assert.equal(err.message.split('\n').length, 3, 'mensaje de tres líneas de write-target');

    assert.deepEqual(snapshot(PROD), antesProd, 'PROD cambió sin ambiente declarado');
    assert.deepEqual(snapshot(TMP), antesTmp, 'TMP cambió sin ambiente declarado');
    declararPruebas();
});

// ── Escenario 3: confinamiento de segmentos (SEC-HB-2) ───────────────────────
test('E3 · skill/phase/pipeline con traversal o fuera de la whitelist → throw, cero archivos nuevos', () => {
    declararPruebas();
    const antesProd = listarRecursivo(PROD);
    const antesTmp = listarRecursivo(TMP);

    const casos = [
        { ...BLOQUEO_7113, issue: 7116, skill: '../../x' },
        { ...BLOQUEO_7113, issue: 7116, phase: 'validacion/../../dev' },
        { ...BLOQUEO_7113, issue: 7116, phase: 'validacion\\..\\dev' },
        { ...BLOQUEO_7113, issue: 7116, pipeline: 'otro' },
        { ...BLOQUEO_7113, issue: 7116, skill: 'Intake' },
        { ...BLOQUEO_7113, issue: 7116, skill: '.hidden' },
    ];
    for (const c of casos) {
        assert.throws(() => hb.reportHumanBlock(c), /\[human-block\] (skill|phase|pipeline) inválido/, JSON.stringify(c));
    }
    // `/unblock` con target_phase hostil tampoco arma un path fuera de la raíz.
    hb.reportHumanBlock({ ...BLOQUEO_7113, issue: 7117, moveFromActive: false });
    assert.throws(() => hb.unblockIssue({ issue: 7117, target_phase: '../../fuera' }), /\[human-block\] target_phase inválido/);
    assert.ok(fs.existsSync(path.join(TMP_PIPELINE, 'definicion', 'validacion', 'bloqueado-humano', '7117.intake')),
        'un target_phase inválido no debe mover el marker');
    hb.dismissBlockedIssue({ issue: 7117, reason: 'limpieza del test' });

    assert.deepEqual(listarRecursivo(PROD), antesProd);
    const nuevosTmp = listarRecursivo(TMP).filter((p) => !antesTmp.includes(p));
    assert.ok(!nuevosTmp.some((p) => p.includes('7116')), `archivos de 7116 en TMP: ${nuevosTmp}`);
    assert.ok(!nuevosTmp.some((p) => p.includes('fuera') || p.includes('..')), `path hostil en TMP: ${nuevosTmp}`);
});

// ── Escenario 4: guardrail del módulo (reemplaza al fix del escáner, D-2) ────
test('E4 · el fuente no fija el directorio de escritura en una const de módulo y el inventario declara sus canales', () => {
    const fuente = fs.readFileSync(path.join(__dirname, '..', 'human-block.js'), 'utf8');
    assert.ok(!/\btrace\.REPO_ROOT\b/.test(fuente), 'human-block.js volvió a usar trace.REPO_ROOT como destino de escritura');
    assert.ok(!/^const (PIPELINE_DIR|GH_QUEUE_DIR)\s*=/m.test(fuente), 'const de módulo PIPELINE_DIR/GH_QUEUE_DIR reintroducida');
    assert.ok(!/PIPELINE_DIR =/.test(fuente), 'CA-1: `grep "PIPELINE_DIR ="` debe ser vacío');
    assert.equal(hb.PIPELINE_DIR, undefined, 'PIPELINE_DIR no debe exportarse');

    const inventario = writePointsScan.leerInventario(path.join(__dirname, '..', '..'));
    const puntos = inventario.filter((p) => p.modulo === 'lib/human-block.js');
    assert.ok(puntos.length >= 3, `inventario con ${puntos.length} puntos de human-block.js (esperaba ≥3)`);
    for (const p of puntos) {
        assert.ok(['migrado', 'safe'].includes(p.estado), `${p.funcion}: estado ${p.estado}`);
    }
    const canales = new Set(puntos.map((p) => p.canal));
    for (const c of ['estado', 'colas', 'logs']) assert.ok(canales.has(c), `canal ${c} no declarado en el inventario`);
    // El escáner en vivo coincide con el JSON (nada escapó al inventario).
    const vivo = writePointsScan.escanearModulo(path.join(__dirname, '..', 'human-block.js'));
    assert.deepEqual(
        vivo.puntos.map((p) => p.funcion).sort(),
        puntos.map((p) => p.funcion).sort(),
        'el escáner ve puntos distintos a los del inventario para human-block.js');
    assert.ok(vivo.puntos.every((p) => p.estado === 'migrado' && !p.inmune));
});

// ── Escenario 5: `gh` no se invoca — la orden queda como archivo en la cola ──
test('E5 · human-block no spawnea `gh`: la orden queda en la cola como archivo (documentación ejecutable)', () => {
    declararPruebas();
    const cp = require('child_process');
    const spawns = [];
    const orig = { spawnSync: cp.spawnSync, execSync: cp.execSync, execFileSync: cp.execFileSync, spawn: cp.spawn, exec: cp.exec, execFile: cp.execFile };
    for (const k of Object.keys(orig)) {
        cp[k] = (...args) => { spawns.push(String(args[0])); return orig[k].apply(cp, args); };
    }
    try {
        hb.reportHumanBlock({ ...BLOQUEO_7113, issue: 7118, moveFromActive: false });
        hb.enqueueGithub('comment', { issue: 7118, body: 'hola' });
    } finally {
        Object.assign(cp, orig);
    }
    assert.ok(!spawns.some((s) => /\bgh(\.exe)?\b/.test(s)), `human-block invocó gh: ${spawns}`);
    const cola = fs.readdirSync(path.join(TMP_PIPELINE, 'servicios', 'github', 'pendiente'));
    assert.ok(cola.some((f) => f.startsWith('7118-needs-human-block-')));
    assert.ok(cola.some((f) => f.startsWith('7118-comment-hb-')));
});

test.after(() => {
    restaurarEnv();
    for (const d of [PROD, TMP, PROJECT]) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});
