// =============================================================================
// Tests `nextInQueue` — #3023
//
// Valida el comportamiento del slice de cola "Próximos 10" en relación al
// filtrado por allowlist de pausa parcial:
//   - sin pausa → comportamiento actual (sin filtro)
//   - pausa parcial con matches → solo issues de la allowlist
//   - pausa parcial sin matches → array vacío
//   - coerción string↔number (item.issue es string, allowedIssues es number[])
//
// El módulo `partial-pause` se aísla a un tmp dir vía PIPELINE_DIR_OVERRIDE
// para evitar tocar el `.partial-pause.json` real del repo.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Aislar el módulo `partial-pause` (que el slice usa internamente) a un tmp dir
// PROPIO de este test. Si otro test ya cargó el módulo con un override distinto,
// se invalida el cache para forzar la recarga con nuestro override.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-next-in-queue-'));
process.env.PIPELINE_DIR_OVERRIDE = TMP_DIR;

delete require.cache[require.resolve('../partial-pause')];
delete require.cache[require.resolve('../dashboard-slices')];

const pp = require('../partial-pause');
const slices = require('../dashboard-slices');

// Helper: crea un directorio de pipeline mínimo con archivos `pendiente/`
// reflejando issues encolados. Devuelve el path raíz del pipeline simulado.
function mkTmpPipeline(items) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-niq-pipeline-'));
    for (const it of items) {
        const sub = path.join(dir, it.pipeline, it.fase, 'pendiente');
        fs.mkdirSync(sub, { recursive: true });
        fs.writeFileSync(path.join(sub, `${it.issue}.${it.skill}`), '');
    }
    return dir;
}

function mkState(items) {
    const allFasesMap = new Map();
    const issueMatrix = {};
    for (const it of items) {
        allFasesMap.set(`${it.pipeline}/${it.fase}`, { pipeline: it.pipeline, fase: it.fase });
        if (!issueMatrix[String(it.issue)]) {
            issueMatrix[String(it.issue)] = {
                title: it.title || `issue ${it.issue}`,
                bounces: it.bounces || 0,
                fases: {},
            };
        }
    }
    return {
        config: { concurrencia: { 'pipeline-dev': 2, 'android-dev': 2, ux: 1 } },
        allFases: [...allFasesMap.values()],
        issueMatrix,
        etaAverages: {},
    };
}

function clearPause() {
    const { PARTIAL_FILE, PAUSE_FILE } = pp._paths();
    try { fs.unlinkSync(PARTIAL_FILE); } catch {}
    try { fs.unlinkSync(PAUSE_FILE); } catch {}
}

const baseItems = [
    { issue: 2998, skill: 'pipeline-dev', pipeline: 'desarrollo', fase: 'dev', title: 'A' },
    { issue: 3023, skill: 'pipeline-dev', pipeline: 'desarrollo', fase: 'dev', title: 'B' },
    { issue: 4000, skill: 'android-dev', pipeline: 'desarrollo', fase: 'dev', title: 'C' },
    { issue: 5000, skill: 'ux',          pipeline: 'desarrollo', fase: 'validacion', title: 'D' },
];

test('nextInQueue: sin pausa parcial activa → retorna todos los items (CA-3)', () => {
    clearPause();
    const PIPELINE = mkTmpPipeline(baseItems);
    try {
        const state = mkState(baseItems);
        const out = slices.nextInQueue(state, { PIPELINE }, 10);
        const issues = out.map(o => o.issue).sort();
        assert.deepEqual(issues, ['2998', '3023', '4000', '5000']);
    } finally {
        try { fs.rmSync(PIPELINE, { recursive: true, force: true }); } catch {}
    }
});

test('nextInQueue: pausa parcial con matches → solo issues de la allowlist (CA-1)', () => {
    clearPause();
    pp.setPartialPause([2998, 3023], { source: 'test' });
    const PIPELINE = mkTmpPipeline(baseItems);
    try {
        const state = mkState(baseItems);
        const out = slices.nextInQueue(state, { PIPELINE }, 10);
        const issues = out.map(o => o.issue).sort();
        assert.deepEqual(issues, ['2998', '3023']);
        // CA-3 (anti-regresión): items fuera de la allowlist NO aparecen.
        assert.equal(out.find(o => o.issue === '4000'), undefined);
        assert.equal(out.find(o => o.issue === '5000'), undefined);
    } finally {
        clearPause();
        try { fs.rmSync(PIPELINE, { recursive: true, force: true }); } catch {}
    }
});

test('nextInQueue: pausa parcial sin matches → array vacío (CA-2)', () => {
    clearPause();
    pp.setPartialPause([99999], { source: 'test' });
    const PIPELINE = mkTmpPipeline(baseItems);
    try {
        const state = mkState(baseItems);
        const out = slices.nextInQueue(state, { PIPELINE }, 10);
        assert.deepEqual(out, []);
    } finally {
        clearPause();
        try { fs.rmSync(PIPELINE, { recursive: true, force: true }); } catch {}
    }
});

test('nextInQueue: coerción string↔number — item.issue (string) matchea allowedIssues (number) (CA-6)', () => {
    clearPause();
    // allowlist con números puros, items en el filesystem siempre dan strings
    // (`f.split('.')[0]`). El filtro debe matchear igual.
    pp.setPartialPause([2998], { source: 'test' });
    const PIPELINE = mkTmpPipeline(baseItems);
    try {
        const state = mkState(baseItems);
        const out = slices.nextInQueue(state, { PIPELINE }, 10);
        assert.equal(out.length, 1);
        assert.equal(out[0].issue, '2998');
        assert.equal(typeof out[0].issue, 'string', 'item.issue debe seguir siendo string como hoy');
    } finally {
        clearPause();
        try { fs.rmSync(PIPELINE, { recursive: true, force: true }); } catch {}
    }
});

test('nextInQueue: pausa total (paused) → no filtra (queda como running para esta card; banner global se encarga)', () => {
    clearPause();
    // Pausa total: NO está en alcance del issue #3023 (out of scope explícito).
    // El comportamiento esperado es: la cola se sigue mostrando como hoy.
    fs.writeFileSync(pp._paths().PAUSE_FILE, '');
    const PIPELINE = mkTmpPipeline(baseItems);
    try {
        const state = mkState(baseItems);
        const out = slices.nextInQueue(state, { PIPELINE }, 10);
        // En modo `paused` el filtro no se aplica (sólo `partial_pause` filtra)
        // → todos los items siguen visibles. El banner global del header
        // existente avisa al operador del estado.
        const issues = out.map(o => o.issue).sort();
        assert.deepEqual(issues, ['2998', '3023', '4000', '5000']);
    } finally {
        clearPause();
        try { fs.rmSync(PIPELINE, { recursive: true, force: true }); } catch {}
    }
});

test('nextInQueue: opts.pipelineMode inyectado tiene precedencia sobre lectura del FS', () => {
    // Caller (ej. route handler) lee el modo una vez y se lo pasa al slice
    // para evitar doble FS read. El slice debe respetar el modo inyectado.
    clearPause();
    pp.setPartialPause([2998], { source: 'test' });
    const PIPELINE = mkTmpPipeline(baseItems);
    try {
        const state = mkState(baseItems);
        // Forzar `running` aunque el FS diga partial_pause
        const fakeRunning = { mode: 'running', allowedIssues: [], createdAt: null, source: null };
        const out = slices.nextInQueue(state, { PIPELINE }, 10, { pipelineMode: fakeRunning });
        const issues = out.map(o => o.issue).sort();
        assert.deepEqual(issues, ['2998', '3023', '4000', '5000'],
            'pipelineMode running inyectado anula lectura del .partial-pause.json del FS');
    } finally {
        clearPause();
        try { fs.rmSync(PIPELINE, { recursive: true, force: true }); } catch {}
    }
});

test('nextInQueue: limit recorta despues del filtrado por allowlist', () => {
    clearPause();
    pp.setPartialPause([2998, 3023, 4000, 5000], { source: 'test' });
    const PIPELINE = mkTmpPipeline(baseItems);
    try {
        const state = mkState(baseItems);
        const out = slices.nextInQueue(state, { PIPELINE }, 2);
        assert.equal(out.length, 2);
    } finally {
        clearPause();
        try { fs.rmSync(PIPELINE, { recursive: true, force: true }); } catch {}
    }
});

// Cleanup: evita dejar el TMP_DIR colgando en /tmp después de los tests.
test.after(() => {
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
});
