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

// =============================================================================
// Regresión #3145 — Artifacts auxiliares no son markers de skill.
//
// `nextInQueue` listaba `3076.po.comment.md` como agente "po.comment.md" en
// la cola (caso real visto el 2026-05-11). El listador filtra ahora cualquier
// archivo con > 2 segmentos, además de los sufijos típicos.
// =============================================================================
test('nextInQueue: ignora .comment.md como marker fantasma', () => {
    clearPause();
    const PIPELINE = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-niq-artifact-'));
    try {
        const sub = path.join(PIPELINE, 'definicion', 'criterios', 'pendiente');
        fs.mkdirSync(sub, { recursive: true });
        // Marker real + artifact con > 2 segmentos
        fs.writeFileSync(path.join(sub, '3076.pipeline-dev'), '');
        fs.writeFileSync(path.join(sub, '3076.po.comment.md'), 'criterios');
        const state = {
            config: { concurrencia: { 'pipeline-dev': 2 } },
            allFases: [{ pipeline: 'definicion', fase: 'criterios' }],
            issueMatrix: { '3076': { title: 'x', bounces: 0, fases: {} } },
            etaAverages: {},
        };
        const out = slices.nextInQueue(state, { PIPELINE }, 10);
        assert.equal(out.length, 1, 'solo el marker real debe aparecer');
        assert.equal(out[0].skill, 'pipeline-dev');
        assert.equal(out.find(o => o.skill === 'po.comment.md'), undefined);
    } finally {
        try { fs.rmSync(PIPELINE, { recursive: true, force: true }); } catch {}
    }
});

test('nextInQueue: ignora .guidance.txt y .reason.json como markers fantasma', () => {
    clearPause();
    const PIPELINE = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-niq-artifact2-'));
    try {
        const sub = path.join(PIPELINE, 'desarrollo', 'dev', 'pendiente');
        fs.mkdirSync(sub, { recursive: true });
        fs.writeFileSync(path.join(sub, '3075.pipeline-dev'), '');
        fs.writeFileSync(path.join(sub, '3075.pipeline-dev.guidance.txt'), 'pista');
        fs.writeFileSync(path.join(sub, '3075.pipeline-dev.reason.json'), '{}');
        const state = {
            config: { concurrencia: { 'pipeline-dev': 2 } },
            allFases: [{ pipeline: 'desarrollo', fase: 'dev' }],
            issueMatrix: { '3075': { title: 'x', bounces: 0, fases: {} } },
            etaAverages: {},
        };
        const out = slices.nextInQueue(state, { PIPELINE }, 10);
        assert.equal(out.length, 1, 'solo el marker real debe aparecer');
        assert.equal(out[0].skill, 'pipeline-dev');
    } finally {
        try { fs.rmSync(PIPELINE, { recursive: true, force: true }); } catch {}
    }
});

// =============================================================================
// Regresión #3145 (Bug 2) — Early-break no se consume con items fuera de allowlist.
//
// Antes del fix: `if (out.length >= limit * 4) break;` se evaluaba ANTES de
// filtrar por allowlist. Una fase con >= limit*4 items legacy fuera de
// allowlist comía el early-break y ocultaba items reales de fases posteriores.
//
// Ahora el filtro de allowlist está dentro del loop, así que items
// descartados ni se cuentan para el early-break.
// =============================================================================
test('nextInQueue: backlog legacy fuera de allowlist no oculta items reales de otras fases', () => {
    clearPause();
    // limit=2 → early-break en out.length >= 8
    // Simulamos 12 items legacy en validacion/pendiente (todos fuera de allowlist)
    // + 1 item real en desarrollo/dev/pendiente (dentro de allowlist)
    const PIPELINE = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-niq-earlybreak-'));
    try {
        const legacyDir = path.join(PIPELINE, 'desarrollo', 'validacion', 'pendiente');
        fs.mkdirSync(legacyDir, { recursive: true });
        for (let i = 1; i <= 12; i++) {
            fs.writeFileSync(path.join(legacyDir, `${1000 + i}.ux`), '');
        }
        const devDir = path.join(PIPELINE, 'desarrollo', 'dev', 'pendiente');
        fs.mkdirSync(devDir, { recursive: true });
        fs.writeFileSync(path.join(devDir, '3075.pipeline-dev'), '');

        pp.setPartialPause([3075], { source: 'test' });

        const issueMatrix = { '3075': { title: 'real', bounces: 0, fases: {} } };
        for (let i = 1; i <= 12; i++) {
            issueMatrix[String(1000 + i)] = { title: `legacy ${i}`, bounces: 0, fases: {} };
        }
        const state = {
            config: { concurrencia: { 'pipeline-dev': 2, ux: 1 } },
            // OJO: orden importa — validacion se procesa ANTES que dev
            allFases: [
                { pipeline: 'desarrollo', fase: 'validacion' },
                { pipeline: 'desarrollo', fase: 'dev' },
            ],
            issueMatrix,
            etaAverages: {},
        };
        const out = slices.nextInQueue(state, { PIPELINE }, 2);
        assert.equal(out.length, 1, 'el item real de la fase posterior debe aparecer');
        assert.equal(out[0].issue, '3075');
    } finally {
        clearPause();
        try { fs.rmSync(PIPELINE, { recursive: true, force: true }); } catch {}
    }
});

// Cleanup: evita dejar el TMP_DIR colgando en /tmp después de los tests.
test.after(() => {
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
});
