// =============================================================================
// #5176 · CA-UX-1..5 — cómo se le comunica el estado operativo al operador.
//
// Los CA de datos (SEC-3/SEC-4/SEC-5, R7, A-1) ya están cubiertos por
// `operational-state-readers-g1/g2-5176.test.js`. Este archivo cubre el eje que
// esos tests NO pueden cubrir: un lector puede distinguir perfectamente los 3
// modos en los DATOS y aun así rendir un texto que le dice lo contrario al
// operador.
//
// Regla de oro del archivo (CA-UX-2, literal):
//   "El test se ejecuta SOBRE LA SALIDA RENDERIZADA del template, no sobre el
//    objeto que se le pasa. Un assert sobre {empty-allowlist: false} pasa en
//    verde mientras el operador sigue leyendo '🟢 sin pausa parcial'."
//
// Por eso acá NO se espía `fillTemplate`, no se inspecciona el contexto y no se
// mockea el render: se dispara `/allowlist` de punta a punta y se assertea
// sobre el string que saldría por Telegram. Idem para el tablero: se lee el
// texto que los módulos de vista emiten y se ejecuta la lógica de rótulo real.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const commanderDet = require('../commander-deterministic');
const { dispatchWindowLabel } = require('../dispatch-window-label');
const dashboardSlices = require('../dashboard-slices');

function mkTmp(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmrf(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function writePartial(dir, marker) {
    fs.writeFileSync(path.join(dir, '.partial-pause.json'), JSON.stringify(marker));
}

/** Render REAL de `/allowlist`: el string que le llega al operador. */
async function allowlistReply(dir) {
    const dispatcher = commanderDet.createDispatcher({
        pipelineRoot: dir,
        logsDir: path.join(dir, 'logs'),
        rateLimit: { burst: 100, ratePerMin: 600 },
    });
    const r = await dispatcher.dispatch({ text: '/allowlist', chat_id: '1' });
    assert.equal(r.status, 'ok');
    return r.reply;
}

const CREATED = '2026-08-14T10:00:00.000Z';

// ─── CA-UX-1 + CA-UX-2 · el halt total es un TERCER estado del render ───────

test('#5176 CA-UX-1 · halt total: el render anuncia el halt', async () => {
    const dir = mkTmp('ux-halt-');
    try {
        writePartial(dir, { allowed_issues: [5176, 5179], created_at: CREATED });
        fs.writeFileSync(path.join(dir, '.paused'), '');
        const reply = await allowlistReply(dir);
        assert.match(reply, /halt total/, `debe anunciar el halt: ${reply.slice(0, 400)}`);
        assert.match(reply, /Pipeline detenido por completo/);
    } finally { rmrf(dir); }
});

test('#5176 CA-UX-2 · halt total: el render NO dice "sin pausa parcial"', async () => {
    const dir = mkTmp('ux-halt-excl-');
    try {
        writePartial(dir, { allowed_issues: [5176], created_at: CREATED });
        fs.writeFileSync(path.join(dir, '.paused'), '');
        const reply = await allowlistReply(dir);
        // Este es EL assert del rebote: la versión anterior agregaba una línea
        // de halt debajo de un "*Estado:* 🟢 sin pausa parcial" que seguía ahí.
        assert.ok(
            !/sin pausa parcial/.test(reply),
            `con halt total el estado no puede decir "sin pausa parcial": ${reply.slice(0, 400)}`,
        );
        // Y las dos ramas de estado son mutuamente excluyentes: tampoco puede
        // aparecer el estado amarillo de pausa parcial.
        assert.ok(!/pausa parcial activa/.test(reply));
    } finally { rmrf(dir); }
});

test('#5176 CA-UX-1 · halt total CON issues: el operador ve que no perdió las autorizaciones', async () => {
    const dir = mkTmp('ux-halt-issues-');
    try {
        writePartial(dir, { allowed_issues: [5176, 5179, 5191], created_at: CREATED });
        fs.writeFileSync(path.join(dir, '.paused'), '');
        const reply = await allowlistReply(dir);
        assert.match(reply, /3 issues autorizados/, 'anuncia cuántos quedan en espera');
        assert.ok(reply.includes('5176') && reply.includes('5191'), 'y los sigue listando');
        assert.ok(!/Allowlist vacía/.test(reply), 'el halt no vacía la allowlist observada');
    } finally { rmrf(dir); }
});

test('#5176 CA-UX-1 · halt total: el origen de la pausa viaja al render cuando existe', async () => {
    const dir = mkTmp('ux-halt-origin-');
    try {
        fs.writeFileSync(path.join(dir, '.paused'), JSON.stringify({
            source: 'wizard-pausa', ts: CREATED, detail: 'mantenimiento programado',
        }));
        const reply = await allowlistReply(dir);
        assert.match(reply, /halt total/);
        assert.match(reply, /mantenimiento programado/);
    } finally { rmrf(dir); }
});

test('#5176 CA-UX-2 · marker AUSENTE: dice "vacía" y NO inventa un halt', async () => {
    const dir = mkTmp('ux-absent-');
    try {
        const reply = await allowlistReply(dir);
        assert.match(reply, /Allowlist vacía/);
        assert.ok(!/halt total/.test(reply), 'sin marker `.paused` no hay halt que anunciar');
        assert.match(reply, /sin pausa parcial/);
    } finally { rmrf(dir); }
});

test('#5176 CA-UX-2 · allowlist con issues: el render contiene los números reales', async () => {
    const dir = mkTmp('ux-issues-');
    try {
        writePartial(dir, { allowed_issues: [5176, 5179], created_at: CREATED });
        const reply = await allowlistReply(dir);
        assert.ok(reply.includes('5176') && reply.includes('5179'));
        assert.ok(!/Allowlist vacía/.test(reply));
        assert.ok(!/halt total/.test(reply));
    } finally { rmrf(dir); }
});

// ─── CA-UX-3 · la ventana por skill se nombra por lo que restringe ──────────

test('#5176 CA-UX-3 · /allowlist con ventana POR SKILL no dice "0 issues" ni "vacía"', async () => {
    const dir = mkTmp('ux-skills-');
    try {
        writePartial(dir, { allowed_issues: [], allowed_skills: ['builder', 'qa'], created_at: CREATED });
        const reply = await allowlistReply(dir);
        assert.match(reply, /2 skills/, `debe rotularse por skills: ${reply.slice(0, 400)}`);
        assert.ok(reply.includes('builder') && reply.includes('qa'), 'nombra los skills');
        assert.ok(!/0 issues/.test(reply));
        assert.ok(!/Allowlist vacía/.test(reply));
        // La línea histórica del template ("equivale a running normal") deja de
        // aplicar: una ventana por skill SÍ restringe el dispatch.
        assert.ok(!/equivale a \*running normal\*/.test(reply), reply.slice(0, 400));
        assert.match(reply, /NO es \*running normal\*/);
        assert.match(reply, /pausa parcial activa/, 'el modo del envoltorio es partial_pause (#3680 CA-A15)');
    } finally { rmrf(dir); }
});

test('#5176 CA-UX-3 · ventana MIXTA: el render muestra los dos contadores', async () => {
    const dir = mkTmp('ux-mixed-');
    try {
        writePartial(dir, { allowed_issues: [5176], allowed_skills: ['builder'], created_at: CREATED });
        const reply = await allowlistReply(dir);
        assert.match(reply, /1 issues · 1 skills/);
        assert.ok(reply.includes('5176') && reply.includes('builder'));
    } finally { rmrf(dir); }
});

test('#5176 CA-UX-3 · pausa parcial VACÍA por los dos ejes sí conserva el copy histórico', async () => {
    const dir = mkTmp('ux-empty-both-');
    try {
        writePartial(dir, { allowed_issues: [], allowed_skills: [], created_at: CREATED });
        const reply = await allowlistReply(dir);
        assert.match(reply, /Allowlist vacía/);
        assert.ok(!/skills/.test(reply), 'sin skills autorizados no se inventa una ventana');
    } finally { rmrf(dir); }
});

test('#5176 CA-UX-3 · dispatchWindowLabel cubre las cuatro combinaciones', () => {
    assert.equal(dispatchWindowLabel(3, 0), '3 issues');
    assert.equal(dispatchWindowLabel(0, 2), '2 skills');
    assert.equal(dispatchWindowLabel(3, 2), '3 issues · 2 skills');
    assert.equal(dispatchWindowLabel(0, 0), '0 issues');
    // Entradas basura no rompen la pill del header.
    assert.equal(dispatchWindowLabel(undefined, undefined), '0 issues');
    assert.equal(dispatchWindowLabel(-1, NaN), '0 issues');
});

// ─── CA-UX-3 · la pill del header (client-side, ejecutada de verdad) ────────

/**
 * Ejecuta el snippet cliente de `header-meta.js` en un `vm` con un `window`
 * mínimo y devuelve el rótulo real que la pill mostraría. Es render, no lectura
 * de código fuente: si el snippet cambia de forma, este test lo ve.
 */
function headerPillLabel(allowedIssues, allowedSkills) {
    const { headerPillsClientScript } = require('../../views/dashboard/header-meta');
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(headerPillsClientScript(), sandbox);
    assert.equal(typeof sandbox.window.__dispatchWindowLabel, 'function',
        'headerPillsClientScript debe exponer window.__dispatchWindowLabel');
    return '⏸ Parcial · ' + sandbox.window.__dispatchWindowLabel(allowedIssues, allowedSkills);
}

test('#5176 CA-UX-3 · la pill del header rotula la ventana por skill como skills', () => {
    assert.equal(headerPillLabel([], ['builder', 'qa']), '⏸ Parcial · 2 skills');
    assert.equal(headerPillLabel([5176, 5179], []), '⏸ Parcial · 2 issues');
    assert.equal(headerPillLabel([5176], ['builder']), '⏸ Parcial · 1 issues · 1 skills');
});

test('#5176 CA-UX-3 · home.js dejó de derivar la pill de allowedIssues.length', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '..', '..', 'views', 'dashboard', 'home.js'), 'utf8',
    );
    assert.ok(
        !src.includes("d.allowedIssues.length+' issues'"),
        'home.js no puede volver al rótulo por issues puro (regresión de CA-UX-3)',
    );
    assert.ok(src.includes('plDispatchWindowLabel(d.allowedIssues, d.allowedSkills)'));
});

// ─── CA-UX-4 · ningún control de inspección desaparece ──────────────────────

/**
 * Ejecuta `plRefreshToggleVisibility()` de `pipeline-redesign.js` con un DOM
 * mínimo. Se extrae la función del bundle cliente real (no una copia) para que
 * el test falle si alguien vuelve a condicionar sólo por `allowedIssues`.
 */
function toggleVisibility(modeState) {
    const { pipelineRedesignClientScript } = require('../../views/dashboard/pipeline-redesign');
    const src = pipelineRedesignClientScript();
    const start = src.indexOf('function plRefreshToggleVisibility()');
    assert.ok(start > 0, 'plRefreshToggleVisibility debe existir en el bundle cliente');
    const end = src.indexOf('\nfunction ', start + 1);
    const fnSrc = src.slice(start, end > 0 ? end : undefined);

    const toggle = { id: 'pl-allowlist-toggle', style: { display: '' }, attrs: {} };
    const sandbox = {
        document: { getElementById: (id) => (id === 'pl-allowlist-toggle' ? toggle : null) },
        pipelineModeState: modeState,
        plOnlyWave: true,
        tickPipelineRedesign: undefined,
    };
    toggle.setAttribute = (k, v) => { toggle.attrs[k] = v; };
    vm.createContext(sandbox);
    vm.runInContext(`${fnSrc}\nplRefreshToggleVisibility();`, sandbox);
    return toggle.style.display;
}

test('#5176 CA-UX-4 · con ventana POR SKILL el toggle de inspección sigue visible', () => {
    const display = toggleVisibility({
        mode: 'partial_pause', allowedIssues: [], allowedSkills: ['builder'],
    });
    assert.notEqual(display, 'none', 'una restricción vigente no puede esconder el control');
    assert.equal(display, 'inline-flex');
});

test('#5176 CA-UX-4 · con ventana por issues el toggle sigue visible (sin regresión)', () => {
    assert.equal(
        toggleVisibility({ mode: 'partial_pause', allowedIssues: [5176], allowedSkills: [] }),
        'inline-flex',
    );
});

test('#5176 CA-UX-4 · sin restricción vigente el toggle se sigue ocultando', () => {
    assert.equal(
        toggleVisibility({ mode: 'partial_pause', allowedIssues: [], allowedSkills: [] }),
        'none',
    );
    assert.equal(
        toggleVisibility({ mode: 'running', allowedIssues: [], allowedSkills: [] }),
        'none',
    );
});

// ─── CA-UX-3/4 · el productor: el header slice publica allowedSkills ────────

test('#5176 CA-UX-3 · headerSlice publica allowedSkills (sin él el cliente no puede rotular)', () => {
    const dir = mkTmp('ux-header-slice-');
    const prev = process.env.PIPELINE_DIR_OVERRIDE;
    try {
        writePartial(dir, { allowed_issues: [], allowed_skills: ['builder', 'qa'], created_at: CREATED });
        process.env.PIPELINE_DIR_OVERRIDE = dir;
        const slice = dashboardSlices.headerSlice({ procesos: {} }, { PIPELINE: dir });
        assert.equal(slice.mode, 'partial_pause', 'SEC-4: la ventana por skill activa partial_pause');
        assert.deepEqual(slice.allowedIssues, []);
        assert.deepEqual(slice.allowedSkills, ['builder', 'qa']);
    } finally {
        if (prev === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
        else process.env.PIPELINE_DIR_OVERRIDE = prev;
        rmrf(dir);
    }
});

// ─── CA-UX-5 · sin campos permanentemente vacíos ───────────────────────────

test('#5176 CA-UX-5 · el template ya no declara last-modified-by (campo muerto)', () => {
    const tpl = fs.readFileSync(
        path.join(__dirname, '..', 'commander', 'templates', 'allowlist.md'), 'utf8',
    );
    assert.ok(
        !tpl.includes('last-modified-by'),
        'ningún escritor emite modified_by: el campo sale del contrato (fuente real: #5195)',
    );
});

test('#5176 CA-UX-5 · marker ausente dice "sin pausa parcial registrada", no "nunca"', async () => {
    const dir = mkTmp('ux-nunca-');
    try {
        const reply = await allowlistReply(dir);
        assert.match(reply, /sin pausa parcial registrada/);
        assert.ok(!/nunca/i.test(reply), '"nunca" no distinguía "nunca hubo" de "se levantó y se borró"');
    } finally { rmrf(dir); }
});
