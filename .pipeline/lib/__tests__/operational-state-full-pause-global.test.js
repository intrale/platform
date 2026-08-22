// =============================================================================
// operational-state-full-pause-global.test.js — SEC-6 (#5110 · Ola 9.4 · E2).
//
// `.pipeline/.paused` es el HALT TOTAL del pipeline y es un control de
// SEGURIDAD: es el botón que un humano aprieta cuando algo se está yendo de
// las manos.
//
// Namespacearlo junto con el resto del estado operativo lo haría fallar
// ABIERTO — el modo de fallo más peligroso posible acá. Con `.paused` por
// proyecto, un proyecto que todavía no tiene su marker seguiría despachando
// con el sistema "pausado", y el operador creería que frenó todo.
//
// Por eso D4: `.paused` queda GLOBAL, en la raíz física, con precedencia
// máxima. Si algún día se agrega pausa por proyecto es ADITIVA:
// `pausaEfectiva = globalPaused || projectPaused`.
//
// Este archivo es el test de contrato de esa decisión: si alguien mueve
// `pauseFile()` al namespace, todo esto se pone rojo.
//
// Ejecutar:  node --test .pipeline/lib/__tests__/operational-state-full-pause-global.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { seedPipelineConfig } = require('./_test-helpers');

const SUBSTRATE = [
    '../operational-state', '../waves', '../partial-pause',
    '../partial-pause-audit', '../project-context', '../full-pause-state',
];

const ALPHA = 'proj-alpha';
const BETA = 'proj-beta';

function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opstate-pause-'));
    seedPipelineConfig(dir);
    fs.mkdirSync(path.join(dir, 'descriptors'), { recursive: true });
    for (const id of [ALPHA, BETA]) {
        fs.writeFileSync(path.join(dir, 'descriptors', `${id}.json`), JSON.stringify({ identity: { projectId: id } }));
    }
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    process.env.PIPELINE_OPSTATE_NAMESPACED = '1';
    return dir;
}

function teardown(dir) {
    delete process.env.PIPELINE_DIR_OVERRIDE;
    delete process.env.PIPELINE_OPSTATE_NAMESPACED;
    delete process.env.PIPELINE_PROJECT_ID;
    delete process.env.PIPELINE_PROJECT_BINDING;
    delete process.env.PIPELINE_ALLOW_UNSCOPED_DISPATCH;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
}

function enterProject(projectId) {
    for (const m of SUBSTRATE) delete require.cache[require.resolve(m)];
    const pc = require('../project-context');
    pc._resetForTests();
    const nonce = `n-${projectId}`;
    pc.writeSpawnBinding({ projectId, nonce });
    process.env.PIPELINE_PROJECT_ID = projectId;
    process.env.PIPELINE_PROJECT_BINDING = nonce;
    const opState = require('../operational-state');
    opState._internal.invalidateCache();
    return opState;
}

/** Marker de halt total, en la raíz física. */
function writeGlobalPause(dir) {
    fs.writeFileSync(path.join(dir, '.paused'), JSON.stringify({
        reason: 'test SEC-6', by: 'test', at: new Date().toISOString(),
    }));
}

// ─── El path NO se namespacea ───────────────────────────────────────────────

test('SEC-6 · pauseFile() vive en la raíz física, NO bajo projects/<id>/', () => {
    const dir = setup();
    try {
        for (const id of [ALPHA, BETA]) {
            const paths = enterProject(id)._internal.paths();
            assert.equal(paths.PAUSE_FILE, path.join(dir, '.paused'),
                '.paused debe quedar en la raíz física');
            assert.ok(!paths.PAUSE_FILE.includes(path.join('projects', id)),
                '.paused NO puede caer en el namespace del proyecto');
        }
    } finally { teardown(dir); }
});

test('SEC-6 · los dos proyectos comparten EXACTAMENTE el mismo .paused', () => {
    const dir = setup();
    try {
        const a = enterProject(ALPHA)._internal.paths().PAUSE_FILE;
        const b = enterProject(BETA)._internal.paths().PAUSE_FILE;
        assert.equal(a, b, 'un solo halt total para todo el sistema');
    } finally { teardown(dir); }
});

test('SEC-6 · el .partial-pause SÍ se namespacea, el .paused NO (mismo _paths)', () => {
    // Los dos markers viven en el mismo módulo: el test fija que se los trate
    // distinto a propósito, no por olvido.
    const dir = setup();
    try {
        const paths = enterProject(ALPHA)._internal.paths();
        assert.ok(paths.PARTIAL_FILE.includes(ALPHA), 'la allowlist es por proyecto');
        assert.ok(!paths.PAUSE_FILE.includes(ALPHA), 'el halt total no lo es');
    } finally { teardown(dir); }
});

// ─── El efecto: con .paused puesto, NINGÚN proyecto despacha ────────────────

test('SEC-6 · con .paused global, ningún proyecto despacha', () => {
    const dir = setup();
    try {
        // Ambos proyectos con su allowlist propia poblada: si el halt fallara
        // abierto, estos issues se despacharían.
        const auth = { authorizedBy: 'test', justification: 'poblar allowlist antes del halt' };
        enterProject(ALPHA).setAllowlist([101], auth);
        enterProject(BETA).setAllowlist([201], auth);

        writeGlobalPause(dir);

        for (const [id, issue] of [[ALPHA, 101], [BETA, 201]]) {
            const st = enterProject(id);
            assert.equal(st.getDispatchState().mode, 'paused', `${id} debe verse pausado`);
            assert.equal(st.isIssueAllowed(issue), false,
                `${id} no puede despachar ${issue} con halt total puesto`);
        }
    } finally { teardown(dir); }
});

test('SEC-6 · el halt global gana sobre la allowlist de CADA proyecto (precedencia máxima)', () => {
    const dir = setup();
    try {
        const auth = { authorizedBy: 'test', justification: 'allowlist activa bajo halt' };
        enterProject(ALPHA).setAllowlist([101, 102], auth);
        writeGlobalPause(dir);

        const st = enterProject(ALPHA);
        // La allowlist sigue existiendo en disco — el halt no la borra, la
        // sobrescribe en precedencia. Eso es lo que permite reanudar sin perderla.
        assert.ok(fs.existsSync(path.join(dir, 'projects', ALPHA, '.partial-pause.json')));
        assert.equal(st.isIssueAllowed(101), false);
        assert.equal(st.isIssueAllowed(102), false);
    } finally { teardown(dir); }
});

test('SEC-6 · sacar .paused reanuda a los dos proyectos con su allowlist intacta', () => {
    const dir = setup();
    try {
        const auth = { authorizedBy: 'test', justification: 'verificar reanudacion post-halt' };
        enterProject(ALPHA).setAllowlist([101], auth);
        enterProject(BETA).setAllowlist([201], auth);

        writeGlobalPause(dir);
        assert.equal(enterProject(ALPHA).isIssueAllowed(101), false);

        fs.unlinkSync(path.join(dir, '.paused'));

        const a = enterProject(ALPHA);
        assert.equal(a.isIssueAllowed(101), true, 'A recupera su allowlist');
        assert.equal(a.isIssueAllowed(201), false, 'y sigue sin ver la de B');
        assert.equal(enterProject(BETA).isIssueAllowed(201), true, 'B recupera la suya');
    } finally { teardown(dir); }
});

// ─── isFullPauseActive sigue fail-closed ────────────────────────────────────

test('SEC-6 · isFullPauseActive() no cambia de semántica: true bajo halt', () => {
    const dir = setup();
    try {
        enterProject(ALPHA);
        writeGlobalPause(dir);
        for (const m of SUBSTRATE) delete require.cache[require.resolve(m)];
        const st = enterProject(ALPHA);
        const { isFullPauseActive } = require('../full-pause-state');
        assert.equal(isFullPauseActive({ stateMod: st }), true);
    } finally { teardown(dir); }
});

test('SEC-6 · isFullPauseActive() sigue fail-closed si el estado es ilegible', () => {
    const dir = setup();
    try {
        const { isFullPauseActive } = require('../full-pause-state');
        const explota = { getDispatchState() { throw new Error('estado ilegible'); } };
        // Indeterminado ⇒ NUNCA "en marcha". Es la garantía que hace seguro
        // apoyarse en este helper para decidir si algo puede correr.
        assert.equal(isFullPauseActive({ stateMod: explota }), true);
    } finally { teardown(dir); }
});
