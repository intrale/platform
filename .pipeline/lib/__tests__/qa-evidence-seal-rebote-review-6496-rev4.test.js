'use strict';

// =============================================================================
// #6496 rev-4 — Guardianes del RECHAZO DE `review` sobre el PR #6669 @ b44bf3e2e.
//
// La review confirmó cerrados los 4 puntos de rev-2 y encontró 4 defectos nuevos,
// re-verificados sin cambios el 2026-08-31 contra el mismo HEAD. Un test por
// defecto: si el fix se revierte, acá se prende en rojo.
//
//   D1 [BLOQUEANTE · CA-12] `skills-deterministicos/delivery.js` — el fix de rev-3
//        agregó `retractPrGate` SÓLO al segundo gate (el de antes del merge). El
//        primer gate corre en la Fase 1, donde `prNumber` todavía es `null`, así
//        que retornaba sin retractar nada: un PR abierto de una corrida anterior
//        se quedaba con `qa:passed` sobre un HEAD que nadie verificó, y
//        `hasQaGate` lee los labels del PR como autoridad de merge.
//   D2 [BLOQUEANTE · CA-12] `qa-evidence-seal.js` — `requeueVerification` encolaba
//        sólo `qa:pending` para el issue. `qa:skipped` es la MISMA autoridad de
//        merge y el reconciliador no lo conoce (`GATE_LABELS` = passed/failed/
//        pending), así que quedaban los dos vivos a la vez: el pre-check seguía
//        en verde y `buildPrGatePropagation` caía en `labels_de_gate_en_conflicto`
//        de forma permanente.
//   D3 [BLOQUEANTE · A04] fail-open silencioso — si el enqueue de la reparación
//        lanzaba (ENOSPC/EACCES: `dropfile-writer` los re-lanza a propósito),
//        quedaban stamp y contador escritos y CERO órdenes en la cola. Nadie leía
//        `reparacionOk`, así que el contrato `veredicto_caduco` se emitía igual,
//        el Pulpo archivaba los work-files con `cancelado_por: 'veredicto-caduco'`
//        y el issue desaparecía del pipeline sin rebote, sin escalada y sin
//        re-verificación encolada.
//   D4 [BLOQUEANTE · CA-10] `pulpo.js` — el drenador exigía
//        `intentos > 0 && intentos <= MAX_SEAL_REQUEUES` sin mirar `corrupto`.
//        `readSealRetries` devuelve `{intentos: MAX_SEAL_REQUEUES, corrupto:true}`
//        para todo contador ilegible, o sea `2`, que satisface la condición: el
//        estado que CA-10 define como AGOTADO pasaba como procedencia válida.
//
// Ningún test escribe en GitHub: todo va contra directorios de `os.tmpdir()`.
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const yaml = require('js-yaml');

const seal = require('../qa-evidence-seal');
const freshnessGate = require('../delivery/freshness-gate');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI_DELIVERY = path.join(REPO_ROOT, '.pipeline', 'delivery.js');
const SKILL_DELIVERY = path.join(REPO_ROOT, '.pipeline', 'skills-deterministicos', 'delivery.js');
const PULPO_JS = path.join(REPO_ROOT, '.pipeline', 'pulpo.js');

const HEAD_FALSO = 'a'.repeat(40);
const HEAD_SELLADO = 'b'.repeat(40);
const HEAD_ACTUAL = 'c'.repeat(40);

// Issues FUERA del rango vivo del repo (lección de rev-1: un fixture con número
// real termina escribiendo en un issue público).
const ISSUE_SKIPPED = 999620;
const ISSUE_SKIPPED_ESC = 999621;
const ISSUE_FAILOPEN = 999622;
const ISSUE_CORRUPTO = 999623;

const REPO_INEXISTENTE = 'intrale/no-existe-test-999620';

function tmpDir(prefijo) {
    return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefijo));
}

function crearEstado() {
    const dir = tmpDir('seal-rev4-state-');
    for (const fase of ['verificacion', 'entrega']) {
        for (const sub of ['procesado', 'pendiente', 'trabajando', 'listo', 'archivado']) {
            fs.mkdirSync(path.join(dir, 'desarrollo', fase, sub), { recursive: true });
        }
    }
    fs.mkdirSync(path.join(dir, 'servicios', 'github', 'pendiente'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    return dir;
}

function escribirVeredicto(estado, issue, data) {
    fs.writeFileSync(
        path.join(estado, 'desarrollo', 'verificacion', 'procesado', `${issue}.qa`),
        yaml.dump(data, { lineWidth: -1 }),
    );
}

function ordenesGithub(estado) {
    const dir = path.join(estado, 'servicios', 'github', 'pendiente');
    let files;
    try { files = fs.readdirSync(dir); } catch { return []; }
    return files.filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

function sembrarContador(estado, issue, contenido) {
    const file = seal.sealRetriesPath(estado, issue);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contenido);
}

/** Worktree real, parado en `agent/<issue>-…` y adelantado sobre origin/main. */
function crearWorktree(issue) {
    const dir = tmpDir('seal-rev4-wt-');
    const branch = `agent/${issue}-pipeline-dev`;
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
    execFileSync('git', ['init', '-q', '-b', 'main', dir], { encoding: 'utf8', windowsHide: true });
    git('config', 'user.email', 'pipeline@intrale.test');
    git('config', 'user.name', 'pipeline');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'uno');
    git('add', '.');
    git('commit', '-q', '-m', 'commit inicial');

    const remoto = tmpDir('seal-rev4-remote-');
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', remoto], { windowsHide: true });
    git('remote', 'add', 'origin', remoto);
    git('push', '-q', 'origin', 'main');

    git('checkout', '-q', '-b', branch);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'dos');
    git('add', '.');
    git('commit', '-q', '-m', 'feat: cambio por delante de main');

    return { dir, remoto, branch, git, head: git('rev-parse', 'HEAD').trim() };
}

function refsDelRemoto(wt) {
    return execFileSync('git', ['-C', wt.remoto, 'for-each-ref', '--format=%(refname) %(objectname)'],
        { encoding: 'utf8', windowsHide: true }).trim();
}

function correrCli(wt, estado, args) {
    return spawnSync(process.execPath, [CLI_DELIVERY, ...args], {
        cwd: wt.dir, encoding: 'utf8', windowsHide: true, timeout: 90000,
        env: {
            ...process.env,
            PIPELINE_REPO_ROOT: path.dirname(estado),
            PIPELINE_STATE_DIR: estado,
            GH_REPO: REPO_INEXISTENTE,
            DEBUG: '',
        },
    });
}

/**
 * Bloquea TODA escritura en la cola de `servicios/github` dejando `pendiente`
 * como ARCHIVO en vez de directorio: el `fs.mkdirSync` de `enqueueJsonOrder`
 * lanza ENOTDIR/EEXIST, que es exactamente lo que `dropfile-writer` re-lanza
 * ante ENOSPC/EACCES en el host real.
 */
function romperColaGithub(estado) {
    const dir = path.join(estado, 'servicios', 'github', 'pendiente');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, 'no soy un directorio');
}

// ---------------------------------------------------------------------------
// D1 — el primer gate también retracta el gate del PR
// ---------------------------------------------------------------------------

/** Recorta el bloque `if (gate3.caduco) { … }` del PRIMER gate del skill. */
function bloqueGate1() {
    const src = fs.readFileSync(SKILL_DELIVERY, 'utf8');
    const pos = src.indexOf('const gate3 = freshnessGate.evaluateFreshnessGate(');
    assert.ok(pos > 0, 'el skill determinístico tiene que evaluar el primer gate');
    const posMerge = src.indexOf('const gate3Merge = freshnessGate.evaluateFreshnessGate(');
    assert.ok(posMerge > pos, 'el segundo gate va después del primero');
    return { src, bloque: src.slice(pos, posMerge), pos, posMerge };
}

test('D1: el primer gate RETRACTA el gate del PR abierto antes de retornar', () => {
    // El defecto: `retractPrGate` estaba sólo en el gate del merge. El primer
    // gate corre en la Fase 1 —`prNumber` es `null` hasta la Fase 4— así que
    // retornaba sin poder retractar nada, y un PR abierto de una corrida previa
    // conservaba `qa:passed` sobre un HEAD que nadie verificó.
    const { bloque } = bloqueGate1();
    assert.ok(bloque.includes('freshnessGate.retractPrGate('),
        'el primer gate tiene que retractar el gate del PR, igual que el del merge');
    assert.ok(bloque.includes('findExistingPR(branch'),
        'y tiene que resolver el PR abierto DE LA RAMA: en Fase 1 `prNumber` todavía es null');
});

test('D1: la retractacion del primer gate no puede depender de prNumber', () => {
    // GUARDIÁN del modo de fallo exacto: usar `prNumber` acá es un no-op
    // silencioso, porque en Fase 1 vale `null`. Si alguien "simplifica" el fix
    // reusando la variable, este test lo caza.
    const { src, bloque, pos } = bloqueGate1();
    const posRetract = bloque.indexOf('freshnessGate.retractPrGate(');
    const llamada = bloque.slice(posRetract, posRetract + 300);
    assert.ok(/prNumber:\s*prAbierto\.number/.test(llamada),
        'el PR se resuelve en el momento, no se lee de `prNumber` (null en Fase 1)');

    // Y el orden real del archivo confirma por qué: la resolución de `prNumber`
    // vive DESPUÉS de todo este bloque.
    const posPrNumberResuelto = src.indexOf('prNumber = pr.number;');
    assert.ok(posPrNumberResuelto > pos,
        'precondición del defecto: `prNumber` recién se resuelve después del primer gate');
});

test('D1: retractPrGateLabels baja las DOS mitades del gate del PR', () => {
    // Lo que el primer gate encola ahora. `qa:skipped` va explícito porque el
    // reconciliador no lo conoce y `hasQaGate` lo acepta igual que `qa:passed`.
    const estado = crearEstado();
    const r = seal.retractPrGateLabels({
        pipelineDir: estado, prNumber: 999699, prLabels: ['qa:passed', 'qa:skipped', 'area:pipeline'],
    });
    assert.strictEqual(r.ok, true);
    const acciones = ordenesGithub(estado).map((o) => `${o.action} ${o.label}`);
    assert.ok(acciones.includes('label qa:pending'), 'sube el gate cerrado');
    assert.ok(acciones.includes('remove-label qa:skipped'), 'baja el label que abre el gate');
});

// ---------------------------------------------------------------------------
// D2 — `qa:skipped` se retracta del ISSUE, en las DOS ramas
// ---------------------------------------------------------------------------

test('D2: un veredicto caduco no deja qa:skipped vivo en el issue (re-encolado)', () => {
    // `qa:skipped` es la misma autoridad de merge que `qa:passed`: el pre-check
    // de CLAUDE.md hace `grep -E "qa:passed|qa:skipped"`. Dejarlo vivo mantenía
    // el verde sobre un HEAD que nadie verificó.
    const estado = crearEstado();
    const r = seal.requeueVerification({
        pipelineDir: estado, issue: ISSUE_SKIPPED, motivo: 'head-desincronizado',
        headSellado: HEAD_SELLADO, headActual: HEAD_ACTUAL,
    });
    assert.strictEqual(r.escalado, false, 'precondición: primera caducidad, rama de re-encolado');

    const acciones = ordenesGithub(estado)
        .filter((o) => o.issue === ISSUE_SKIPPED && o.target !== 'pr')
        .map((o) => `${o.action} ${o.label}`);
    assert.ok(acciones.includes('label qa:pending'), 'el gate del issue se degrada');
    assert.ok(acciones.includes('remove-label qa:skipped'),
        'y `qa:skipped` se retracta: si no, queda dando verde en el pre-check');
});

test('D2: qa:skipped tambien se retracta en la rama de ESCALADA', () => {
    // La rama de escalada es la que se llega con el contador agotado (o corrupto,
    // CA-10 — donde ni siquiera hubo un re-encolado previo que bajara el label).
    const estado = crearEstado();
    sembrarContador(estado, ISSUE_SKIPPED_ESC, JSON.stringify({
        intentos: seal.MAX_SEAL_REQUEUES, ultimo_motivo: 'head-desincronizado', ts: '2026-08-31T00:00:00Z',
    }));

    const r = seal.requeueVerification({
        pipelineDir: estado, issue: ISSUE_SKIPPED_ESC, motivo: 'head-desincronizado',
        headSellado: HEAD_SELLADO, headActual: HEAD_ACTUAL,
    });
    assert.strictEqual(r.escalado, true, 'precondición: contador agotado ⇒ escala');

    const acciones = ordenesGithub(estado)
        .filter((o) => o.issue === ISSUE_SKIPPED_ESC && o.target !== 'pr')
        .map((o) => `${o.action} ${o.label}`);
    assert.ok(acciones.includes('label qa:pending'), 'la escalada también degrada el gate');
    assert.ok(acciones.includes('remove-label qa:skipped'),
        'la escalada también retracta `qa:skipped`: es el camino del contador corrupto');
    assert.ok(acciones.includes('label needs-human'), 'y escala a humano');
});

test('D2: qa:pending + qa:skipped vivos a la vez es el deadlock que esto evita', () => {
    // Documenta la consecuencia: `qa:pending` es blocking y `qa:skipped` es
    // passing, así que la propagación al PR caía en conflicto de forma permanente.
    const src = fs.readFileSync(SKILL_DELIVERY, 'utf8');
    assert.match(src, /QA_LABELS_OK = new Set\(\['qa:passed', 'qa:skipped'\]\)/,
        'precondición: `qa:skipped` abre el gate igual que `qa:passed`');
    assert.match(src, /QA_GATE_BLOCKING = new Set\(\['qa:failed', 'qa:pending'\]\)/,
        'precondición: `qa:pending` lo bloquea');
    const reconciler = fs.readFileSync(path.join(REPO_ROOT, '.pipeline', 'lib', 'gate-label-reconciler.js'), 'utf8');
    assert.ok(!/GATE_LABELS = \[[^\]]*qa:skipped/.test(reconciler),
        'precondición: el reconciliador NO conoce `qa:skipped`, por eso hace falta el remove explícito');
});

// ---------------------------------------------------------------------------
// D3 — sin reparación encolada NO se afirma "esto se repara solo"
// ---------------------------------------------------------------------------

test('D3: si el enqueue de la reparacion falla, no queda stamp que corrobore el flag', () => {
    // El orden de escrituras importaba: con el stamp PRIMERO, un fallo del último
    // enqueue dejaba stamp + contador y cero órdenes. `isStaleVerdictRejection`
    // corroboraba igual y el Pulpo archivaba el issue sin rebote ni escalada.
    const estado = crearEstado();
    romperColaGithub(estado);

    assert.throws(() => seal.requeueVerification({
        pipelineDir: estado, issue: ISSUE_FAILOPEN, motivo: 'head-desincronizado',
        headSellado: HEAD_SELLADO, headActual: HEAD_ACTUAL,
    }), 'con la cola rota el enqueue tiene que propagar, no tragarse el error');

    assert.strictEqual(fs.existsSync(seal.staleStampPath(estado, ISSUE_FAILOPEN)), false,
        'sin órdenes encoladas no puede quedar el testigo que corrobora el caduco');
});

test('D3: evaluateFreshnessGate expone reparacionOk:false cuando la reparacion lanza', () => {
    const estado = crearEstado();
    escribirVeredicto(estado, ISSUE_FAILOPEN, {
        resultado: 'aprobado', sello: { version: 1, head: HEAD_FALSO, artefactos: [] },
    });
    const wt = crearWorktree(ISSUE_FAILOPEN);

    const sealFake = {
        ...seal,
        requeueVerification() { throw new Error('ENOSPC simulado'); },
    };
    const gate = freshnessGate.evaluateFreshnessGate({
        pipelineDir: estado, issue: ISSUE_FAILOPEN, cwd: wt.dir, seal: sealFake,
    });

    assert.strictEqual(gate.caduco, true, 'sigue frenando: lo que no se puede es integrar');
    assert.strictEqual(gate.reparacionOk, false, 'pero la reparación NO quedó encolada');
    assert.match(String(gate.reparacionError), /ENOSPC simulado/);
});

test('D3: los dos orquestadores CONSULTAN reparacionOk', () => {
    // El defecto literal del review: el campo existía y ninguna de las dos
    // fronteras lo leía, así que el contrato `veredicto_caduco` salía igual.
    for (const archivo of [SKILL_DELIVERY, CLI_DELIVERY]) {
        const src = fs.readFileSync(archivo, 'utf8');
        assert.ok(/reparacionOk/.test(src),
            `${path.basename(archivo)} tiene que gatear el contrato en reparacionOk`);
    }
});

test('D3: el CLI con la cola rota sale 1, sin contrato de caduco y sin tocar el remoto', () => {
    // End-to-end del fail-open: veredicto caduco + cola de órdenes inescribible.
    // Antes salía 0 con `veredicto_caduco`, que el Pulpo lee como "ya se está
    // reparando" — y no se estaba reparando nada.
    const wt = crearWorktree(ISSUE_FAILOPEN);
    const estado = crearEstado();
    escribirVeredicto(estado, ISSUE_FAILOPEN, {
        resultado: 'aprobado', sello: { version: 1, head: HEAD_FALSO, artefactos: [] },
    });
    romperColaGithub(estado);

    const antes = refsDelRemoto(wt);
    const res = correrCli(wt, estado, ['--issue', String(ISSUE_FAILOPEN), '--description', 'x']);

    assert.strictEqual(res.status, 1,
        'sin reparación encolada esto es un rechazo normal, no una auto-reparación');
    assert.ok(!/"estado":"veredicto_caduco"/.test(res.stdout || ''),
        'no se emite el contrato que afirma que la reparación está encolada');
    assert.match(`${res.stderr || ''}`, /reparaci[oó]n NO qued[oó] encolada/i);
    assert.strictEqual(refsDelRemoto(wt), antes, 'el remoto no se movió');
});

// ---------------------------------------------------------------------------
// D4 — el contador corrupto no es procedencia válida para el drenador
// ---------------------------------------------------------------------------

// `PIPELINE` es un const de módulo del Pulpo que se resuelve UNA sola vez desde
// `PIPELINE_DIR_OVERRIDE`, así que el estado del drainer es compartido.
const ESTADO_PULPO = crearEstado();
let pulpoCache = null;
function requirePulpo() {
    if (pulpoCache) return pulpoCache;
    const helpers = require('./_test-helpers');
    helpers.seedPipelineConfig(ESTADO_PULPO);
    helpers.seedRealProductManifest(ESTADO_PULPO);
    process.env.PIPELINE_DIR_OVERRIDE = ESTADO_PULPO;
    process.env.PULPO_NO_AUTOSTART = '1';
    pulpoCache = require('../../pulpo.js');
    return pulpoCache;
}

const CONFIG_QA = { pipelines: { desarrollo: { skills_por_fase: { verificacion: ['qa'] } } } };

function drenar() {
    const comentarios = [];
    requirePulpo().drenarRequeueVerificacion(CONFIG_QA, {
        comentar: (issue, body) => comentarios.push({ issue, body }),
    });
    return comentarios;
}

function encolarOrdenCruda(payload, nombre) {
    const dir = path.join(ESTADO_PULPO, ...seal.REQUEUE_QUEUE_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, nombre);
    fs.writeFileSync(file, JSON.stringify(payload));
    return file;
}

function existeWorkFile(issue, sub) {
    return fs.existsSync(path.join(ESTADO_PULPO, 'desarrollo', 'verificacion', sub, `${issue}.qa`));
}

test('D4: readSealRetries lee un contador corrupto como AGOTADO, no como cero', () => {
    // Precondición del defecto: el valor que devuelve —`MAX_SEAL_REQUEUES`—
    // satisface `>0 && <=MAX`, que era toda la validación del drenador.
    const estado = crearEstado();
    sembrarContador(estado, ISSUE_CORRUPTO, '{{{esto no es json');
    const r = seal.readSealRetries({ pipelineDir: estado, issue: ISSUE_CORRUPTO });
    assert.strictEqual(r.intentos, seal.MAX_SEAL_REQUEUES, 'CA-10: corrupto ⇒ agotado');
    assert.strictEqual(r.corrupto, true, 'y queda marcado como corrupto');
    assert.ok(r.intentos > 0 && r.intentos <= seal.MAX_SEAL_REQUEUES,
        'precondición: por eso el chequeo viejo lo aceptaba como procedencia válida');
});

test('D4: una orden respaldada por un contador CORRUPTO se descarta sin re-encolar', () => {
    // El estado que CA-10 define como agotado pasaba como procedencia válida, y
    // contradecía a `requeueVerification`, que con contador corrupto ESCALA en
    // vez de encolar: el drenador honraba órdenes que el productor jamás habría
    // emitido. `writeSealRetries` es un `writeFileSync` pelado, así que un crash
    // a mitad de escritura alcanza para llegar acá.
    sembrarContador(ESTADO_PULPO, ISSUE_CORRUPTO, '{{{contador truncado por un crash');

    const ordenPath = encolarOrdenCruda({
        tipo: seal.REQUEUE_TYPE,
        issue: ISSUE_CORRUPTO,
        motivo: 'head-desincronizado',
        head_sellado: HEAD_SELLADO,
        head_actual: HEAD_ACTUAL,
        intentos: 1,
    }, `${ISSUE_CORRUPTO}-contador-corrupto.json`);

    drenar();

    for (const sub of ['pendiente', 'trabajando', 'listo', 'procesado']) {
        assert.strictEqual(existeWorkFile(ISSUE_CORRUPTO, sub), false,
            `un contador corrupto no puede materializar nada en ${sub}/`);
    }
    assert.strictEqual(fs.existsSync(ordenPath), false, 'la orden se consume igual, no queda en bucle');
});

test('D4: el drenador mira `corrupto`, no sólo el rango del contador', () => {
    // GUARDIÁN estructural: el rango solo vuelve a dejar pasar el estado agotado.
    const src = fs.readFileSync(PULPO_JS, 'utf8');
    const pos = src.indexOf('retries.intentos <= qaEvidenceSeal.MAX_SEAL_REQUEUES');
    assert.ok(pos > 0, 'el drenador tiene que validar procedencia por contador');
    // La condición puede escribirse como `|| retries.corrupto === true` (descartar
    // si es corrupto) o como `&& retries.corrupto !== true` (exigir que no lo sea):
    // lo que se fija es que el chequeo MIRE el campo, no la forma de escribirlo.
    const ventana = src.slice(pos, pos + 200);
    assert.ok(/retries\.corrupto/.test(ventana),
        'el chequeo de procedencia tiene que excluir el contador corrupto');
});
