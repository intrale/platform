// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// =============================================================================
// #7459 — `/unblock` del Commander retira `needs-human` por la cola auditada.
//
// Regresión: el handler `cmdUnblock` de `pulpo.js` removía el label legacy
// `needs:human` con `gh` pelado (`execSync`, `stdio:'ignore'`, `catch {}`): el
// marker pasaba a `pendiente/`, el operador veía un ✅, y el label `needs-human`
// seguía puesto → el Pulpo volvía a tratar al issue como bloqueado.
//
// Cubre los 6 casos de la receta del arquitecto:
//   1. regresión principal (orden `remove-label needs-human` con procedencia)
//   2. sin `gh` en el PATH y sin `child_process` en proceso
//   3. respuesta honesta cuando el encolado falla (CA-3 / G-2 / G-3 / SEC-5)
//   4. estático: `cmdUnblock.toString()` sin `gh` ni label legacy (CA-1 / CA-2)
//   5. helper `enqueueRemoveNeedsHuman` con `authorizedBy` obligatorio (SEC-1)
//   6. guarda SEC-4: la cola REAL del servicio-github no cambia
//
// SEC-4: `human-block.js` congela `GH_QUEUE_DIR` desde `trace.REPO_ROOT` al
// cargar → el env temporal se fija ANTES del primer `require`. Un test verde
// que deje una orden real en `servicios/github/pendiente/` es un destrabe no
// autorizado (ya pasó con #7456 sobre #7113/#7114).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ── Guarda SEC-4 (antes de cualquier require) ───────────────────────────────
const REAL_REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const REAL_GH_QUEUE = path.join(REAL_REPO_ROOT, '.pipeline', 'servicios', 'github', 'pendiente');
function contarOrdenesRealesHb() {
    try { return fs.readdirSync(REAL_GH_QUEUE).filter((f) => f.includes('hb-')).length; }
    catch { return 0; }
}
const ORDENES_REALES_ANTES = contarOrdenesRealesHb();

// ── Aislamiento del env (patrón human-block-cause-7439.test.js, #6258) ──────
const { withEnv } = require('../test-helpers/with-env');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-unblock-label-'));
fs.mkdirSync(path.join(TMP_DIR, '.claude'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.pipeline', 'desarrollo', 'dev', 'pendiente'), { recursive: true });
// `traceability.REPO_ROOT` (y con él `GH_QUEUE_DIR` de human-block) se congela
// al cargar: el require va DENTRO del `withEnv`. `PIPELINE_DIR_OVERRIDE` es la
// forma declarada (#7112 SEC-9) de apuntar un test a un tmp para `pipeline-env`;
// `PULPO_NO_AUTOSTART=1` permite requerir pulpo.js sin arrancar el singleton.
const ENV_TMP = Object.freeze({
    CLAUDE_PROJECT_DIR: TMP_DIR,
    PIPELINE_REPO_ROOT: TMP_DIR,
    PIPELINE_DIR_OVERRIDE: path.join(TMP_DIR, '.pipeline'),
    PULPO_NO_AUTOSTART: '1',
});
const enTmp = (fn) => withEnv(ENV_TMP, fn);

let hb, guardrail, pulpo;
enTmp(() => {
    delete require.cache[require.resolve('../traceability')];
    delete require.cache[require.resolve('../human-block')];
    hb = require('../human-block');
    guardrail = require('../label-guardrail');
    // `pulpo.js:166` toma `human-block` del require cache → es el MISMO módulo
    // cargado bajo el tmp. `deps.humanBlock` se pasa igual, explícito, para que
    // el test no dependa del orden de carga.
    pulpo = require('../../pulpo');
});
// Toda llamada al handler corre bajo el env tmp: el `log()` de la rama de
// fallo resuelve su destino en tiempo de ejecución vía `pipeline-env`.
const unblock = (args, deps) => enTmp(() => pulpo.cmdUnblock(args, deps));

const TMP_GH_QUEUE = path.join(TMP_DIR, '.pipeline', 'servicios', 'github', 'pendiente');
const DEV_DIR = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'dev');

assert.equal(hb.PIPELINE_DIR, path.join(TMP_DIR, '.pipeline'), 'human-block debe estar aislado al tmp');
assert.equal(typeof pulpo.cmdUnblock, 'function', 'cmdUnblock debe exportarse bajo PULPO_NO_AUTOSTART=1');

function limpiarTmp() {
    for (const d of [TMP_GH_QUEUE, path.join(DEV_DIR, 'pendiente'), path.join(DEV_DIR, 'bloqueado-humano')]) {
        try { for (const f of fs.readdirSync(d)) fs.rmSync(path.join(d, f), { force: true }); } catch {}
    }
}

function leerOrdenes() {
    try {
        return fs.readdirSync(TMP_GH_QUEUE).map((f) => JSON.parse(fs.readFileSync(path.join(TMP_GH_QUEUE, f), 'utf8')));
    } catch { return []; }
}

function bloquear(issue) {
    return hb.reportHumanBlock({
        issue, skill: 'android-dev', phase: 'dev', pipeline: 'desarrollo',
        reason: 'Falta decidir el flavor', question: '¿client o business?',
    });
}

function afirmarMarkerEnPendiente(issue, guidance) {
    const marker = path.join(DEV_DIR, 'pendiente', `${issue}.android-dev`);
    assert.equal(fs.existsSync(marker), true, 'marker debe estar en dev/pendiente');
    assert.equal(fs.existsSync(path.join(DEV_DIR, 'bloqueado-humano', `${issue}.android-dev`)), false);
    assert.equal(fs.readFileSync(marker + '.guidance.txt', 'utf8'), guidance);
}

test.beforeEach(limpiarTmp);
test.after(() => {
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
});

// ── 1. Regresión principal ──────────────────────────────────────────────────
test('/unblock mueve el marker y encola remove-label needs-human con procedencia autorizada', () => {
    bloquear(7113);
    const guidance = 'seguir con la validación';

    const respuesta = unblock(`7113 ${guidance}`, { humanBlock: hb });

    assert.match(respuesta, /^✅ Issue \*#7113\* desbloqueado\./);
    assert.match(respuesta, /\*Skill:\* `android-dev` · \*Fase:\* `dev` → `dev`/);
    assert.match(respuesta, /\*Orientación guardada\*/);
    afirmarMarkerEnPendiente(7113, guidance);

    // `reportHumanBlock` también encola el `label needs-human` de ida → filtrar por action.
    const removes = leerOrdenes().filter((o) => o.action === 'remove-label');
    assert.equal(removes.length, 1, 'exactamente una orden remove-label');
    assert.deepEqual(removes[0], {
        action: 'remove-label',
        issue: 7113,
        label: 'needs-human',
        guardrail_authorized: true,
        authorized_by: 'commander:telegram:unblock',
    });

    // El guardrail de #5690 la acepta tal como está (sin haber sido tocado).
    const veredicto = guardrail.evaluateLabelOrder({ action: 'remove-label', label: 'needs-human', order: removes[0] });
    assert.equal(veredicto.allowed, true, `guardrail rechazó la orden: ${JSON.stringify(veredicto)}`);

    const comments = leerOrdenes().filter((o) => o.action === 'comment');
    assert.equal(comments.length, 1, 'exactamente una orden comment');
    assert.equal(comments[0].issue, 7113);
    assert.match(comments[0].body, /Desbloqueado por humano/);
    assert.match(comments[0].body, /seguir con la validación/);
    assert.match(comments[0].body, /comando \/unblock por Telegram/);

    // Sin tmpfile del camino viejo.
    assert.deepEqual(fs.readdirSync(path.join(TMP_DIR, '.pipeline')).filter((f) => f.startsWith('.unblock-comment-')), []);
});

// ── 2. Sin gh en el PATH y sin child_process ────────────────────────────────
test('/unblock no depende de gh: con PATH vacío y sin GH_BIN encola igual y no invoca child_process', () => {
    const cp = require('node:child_process');
    const originales = { execSync: cp.execSync, spawnSync: cp.spawnSync, execFileSync: cp.execFileSync };
    let invocaciones = 0;
    const enoent = () => { invocaciones++; const e = new Error('spawnSync gh ENOENT'); e.code = 'ENOENT'; throw e; };
    cp.execSync = enoent; cp.spawnSync = enoent; cp.execFileSync = enoent;
    try {
        bloquear(7114);
        // `withEnv` restaura PATH/GH_BIN pase lo que pase (#6258); `undefined` borra la variable.
        const respuesta = withEnv({ PATH: '', Path: '', GH_BIN: undefined }, () => unblock('#7114 aprobar', { humanBlock: hb }));
        assert.match(respuesta, /^✅ Issue \*#7114\* desbloqueado\./);
        assert.equal(invocaciones, 0, 'cmdUnblock no debe invocar child_process');
        afirmarMarkerEnPendiente(7114, 'aprobar');
        const removes = leerOrdenes().filter((o) => o.action === 'remove-label');
        assert.equal(removes.length, 1);
        assert.equal(removes[0].label, 'needs-human');
        assert.equal(removes[0].authorized_by, 'commander:telegram:unblock');
        assert.equal(removes[0].guardrail_authorized, true);
    } finally {
        Object.assign(cp, originales);
    }
});

// ── 3. Respuesta honesta ────────────────────────────────────────────────────
function afirmarSinFuga(respuesta) {
    assert.doesNotMatch(respuesta, /✅/, 'sin ✅ engañoso');
    assert.match(respuesta, /^⚠️/);
    assert.doesNotMatch(respuesta, /Error:/);
    assert.doesNotMatch(respuesta, /[A-Za-z]:\\|\/tmp\/|\.pipeline[\\/]/, 'sin paths absolutos (SEC-5)');
    assert.match(respuesta, /\*Skill:\* `android-dev` · \*Fase:\* `dev` → `dev`/, 'misma línea Skill/Fase que el éxito (G-3)');
}

test('si falla el encolado del remove-label la respuesta lo dice, pide quitar needs-human a mano y el marker queda en pendiente', () => {
    bloquear(7115);
    const doble = { ...hb, enqueueRemoveNeedsHuman: () => false, enqueueGithub: () => false };
    const respuesta = unblock('7115 reintentar con REST', { humanBlock: doble });
    afirmarSinFuga(respuesta);
    assert.match(respuesta, /needs-human/);
    assert.match(respuesta, /a mano/);
    assert.match(respuesta, /orientación quedó guardada/);
    assert.match(respuesta, /seguir viendo bloqueado/);
    afirmarMarkerEnPendiente(7115, 'reintentar con REST');
    assert.deepEqual(leerOrdenes().filter((o) => o.action === 'remove-label'), []);
});

test('si falla sólo el remove-label (el comment sale) el copy sigue pidiendo quitar el label a mano', () => {
    bloquear(7116);
    const doble = { ...hb, enqueueRemoveNeedsHuman: () => false };
    const respuesta = unblock('7116 seguir', { humanBlock: doble });
    afirmarSinFuga(respuesta);
    assert.match(respuesta, /no pude encolar el retiro del label/);
    assert.match(respuesta, /needs-human/);
    assert.match(respuesta, /a mano/);
    assert.equal(leerOrdenes().filter((o) => o.action === 'comment').length, 1);
});

test('si falla sólo el comment el issue queda destrabado y el copy NO manda a quitar el label a mano', () => {
    bloquear(7117);
    const doble = { ...hb, enqueueGithub: () => false };
    const respuesta = unblock('7117 seguir', { humanBlock: doble });
    afirmarSinFuga(respuesta);
    assert.match(respuesta, /desbloqueado, pero \*no pude encolar el comentario\*/);
    assert.doesNotMatch(respuesta, /retiro del label/);
    assert.doesNotMatch(respuesta, /[Qq]uitalo a mano/);
    afirmarMarkerEnPendiente(7117, 'seguir');
    // El remove-label sí salió por el helper real (delegó en el enqueueGithub real del módulo).
    const removes = leerOrdenes().filter((o) => o.action === 'remove-label');
    assert.equal(removes.length, 1);
    assert.equal(removes[0].authorized_by, 'commander:telegram:unblock');
});

test('idempotencia (G-5): un segundo /unblock sin marker responde ⚠️, no un ✅ nuevo ni encola nada', () => {
    bloquear(7118);
    assert.match(unblock('7118 seguir', { humanBlock: hb }), /^✅/);
    const ordenesAntes = leerOrdenes().length;
    const segunda = unblock('7118 seguir', { humanBlock: hb });
    assert.match(segunda, /^⚠️/);
    assert.doesNotMatch(segunda, /✅/);
    assert.equal(leerOrdenes().length, ordenesAntes, 'no encola nada si no había marker');
});

// ── 4. Estático (CA-1 / CA-2) ───────────────────────────────────────────────
test('cmdUnblock no contiene gh en proceso ni el label legacy (estático)', () => {
    const src = pulpo.cmdUnblock.toString();
    assert.doesNotMatch(src, /execSync|spawnSync|execFileSync|child_process|GH_BIN|needs:human/);
    assert.doesNotMatch(src, /\.unblock-comment-/);
    // Usa unblockIssue (un marker + orientación), no executeQuickAction (todos, sin orientación).
    assert.match(src, /\.unblockIssue\(/);
    assert.doesNotMatch(src, /executeQuickAction/);
    assert.match(src, /enqueueRemoveNeedsHuman\(issue, 'commander:telegram:unblock'\)/);
});

// ── 5. Helper enqueueRemoveNeedsHuman (SEC-1) ───────────────────────────────
test('enqueueRemoveNeedsHuman exige authorizedBy no vacío', () => {
    const spy = () => { throw new Error('no debería encolar'); };
    assert.throws(() => hb.enqueueRemoveNeedsHuman(1, '', { enqueue: spy }), /authorizedBy/);
    assert.throws(() => hb.enqueueRemoveNeedsHuman(1, undefined, { enqueue: spy }), /authorizedBy/);
    assert.throws(() => hb.enqueueRemoveNeedsHuman(1, '   ', { enqueue: spy }), /authorizedBy/);
    assert.throws(() => hb.enqueueRemoveNeedsHuman(1, 42, { enqueue: spy }), /authorizedBy/);
});

test('enqueueRemoveNeedsHuman arma la orden con los 4 campos y devuelve lo que devuelve enqueue', () => {
    const llamadas = [];
    const spy = (action, payload) => { llamadas.push([action, payload]); return 'ret'; };
    const r = hb.enqueueRemoveNeedsHuman('7113', ' x ', { enqueue: spy });
    assert.equal(r, 'ret');
    assert.deepEqual(llamadas, [['remove-label', {
        issue: 7113, label: hb.NEEDS_HUMAN_LABEL, guardrail_authorized: true, authorized_by: 'x',
    }]]);
    assert.equal(hb.NEEDS_HUMAN_LABEL, 'needs-human');
});

test('los botones de la alerta siguen retirando needs-human con su propia procedencia (human-block:<action>)', () => {
    const llamadas = [];
    const enqueueGithub = (action, payload) => { llamadas.push({ action, ...payload }); return true; };
    const r = hb.executeQuickAction({
        issue: 7119, action: 'unblock',
        deps: { enqueueGithub, reactivateAllBlocked: () => [] },
    });
    assert.equal(r.ok, true);
    const removes = llamadas.filter((o) => o.action === 'remove-label');
    assert.equal(removes.length, 1);
    assert.equal(removes[0].label, 'needs-human');
    assert.equal(removes[0].guardrail_authorized, true);
    assert.equal(removes[0].authorized_by, 'human-block:unblock', 'procedencia de botón ≠ procedencia de comando');
});

// ── 6. Guarda SEC-4 ─────────────────────────────────────────────────────────
test('SEC-4: la cola real del servicio-github no cambió durante la suite', () => {
    assert.equal(contarOrdenesRealesHb(), ORDENES_REALES_ANTES, `órdenes hb- reales en ${REAL_GH_QUEUE}`);
    assert.ok(!TMP_GH_QUEUE.startsWith(REAL_GH_QUEUE), 'la cola del test es un tmp');
});
