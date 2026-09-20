// =============================================================================
// #7439 CA-5 — Campo `cause` (causa estructurada) del marker de bloqueo humano.
//
// `cause` es la llave del filtro de auto-levantamiento de la hermana #7440
// (RS-4.1): un marker con `cause:'design-decision'` va a poder levantarse solo
// cuando aparezca la firma del arquitecto. Por eso el enum es CERRADO en
// escritura Y en lectura (RS-C.1): un `.reason.json` editado a mano, un
// call-site que pase cualquier otra cosa o un marker legacy NUNCA producen una
// causa que este código no haya escrito.
//
// También cubre `signoff_verifiable` (UX-F): sólo el `false` explícito se
// persiste y se expone; con él la ficha dice "no pude comprobar la firma".
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Aislar PIPELINE_DIR a un tmp, como hace `human-block.test.js`.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-hb-cause-7439-'));
fs.mkdirSync(path.join(TMP_DIR, '.claude'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.pipeline', 'definicion', 'criterios', 'trabajando'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.pipeline', 'desarrollo', 'dev', 'trabajando'), { recursive: true });
const { withEnv } = require('../test-helpers/with-env');

// `traceability.REPO_ROOT` (y con él `PIPELINE_DIR` de human-block) se resuelve
// al cargar el módulo: el require va DENTRO del `withEnv` para que capture el
// tmpdir y el helper restaure el entorno después (#6258).
let trace, hb;
withEnv(
    { CLAUDE_PROJECT_DIR: TMP_DIR, PIPELINE_REPO_ROOT: TMP_DIR },
    () => {
        delete require.cache[require.resolve('../traceability')];
        delete require.cache[require.resolve('../human-block')];
        trace = require('../traceability');
        hb = require('../human-block');
    },
);
const blockCause = require('../block-cause');

function resetFs() {
    for (const pipeline of hb.PIPELINES) {
        const root = path.join(TMP_DIR, '.pipeline', pipeline);
        let phases = [];
        try { phases = fs.readdirSync(root); } catch { continue; }
        for (const phase of phases) {
            const dir = path.join(root, phase, hb.BLOCK_SUBDIR);
            try { for (const f of fs.readdirSync(dir)) { try { fs.unlinkSync(path.join(dir, f)); } catch {} } } catch {}
        }
    }
    try { fs.unlinkSync(trace.LOG_FILE); } catch {}
}

const BASE = Object.freeze({
    issue: 7439, skill: 'definicion', phase: 'criterios', pipeline: 'definicion',
    reason: 'Freno #7439: plantea una decisión de arquitectura.',
    question: '¿Lo dejo pasar o esperás a que lo revise?',
    moveFromActive: false, skipGithubLabel: true,
});

function leerReason(markerPath) {
    return JSON.parse(fs.readFileSync(hb.reasonFilePath(markerPath), 'utf8'));
}

// -----------------------------------------------------------------------------
// Enum y normalizador (módulo hoja + re-export)
// -----------------------------------------------------------------------------

test('#7439 — BLOCK_CAUSE_ENUM es cerrado, congelado y re-exportado desde human-block', () => {
    assert.deepEqual([...blockCause.BLOCK_CAUSE_ENUM], ['design-decision']);
    assert.ok(Object.isFrozen(blockCause.BLOCK_CAUSE_ENUM));
    assert.equal(hb.BLOCK_CAUSE_ENUM, blockCause.BLOCK_CAUSE_ENUM, 'human-block re-exporta el MISMO objeto');
    assert.equal(hb.normalizeBlockCause, blockCause.normalizeBlockCause);
});

test('#7439 RS-C.1 — normalizeBlockCause: sólo el string EXACTO del enum; todo lo demás es null', () => {
    assert.equal(hb.normalizeBlockCause('design-decision'), 'design-decision');
    for (const v of [' design-decision', 'design-decision ', 'Design-Decision', 'otra-cosa', '',
        ['design-decision'], { cause: 'design-decision' }, 1, true, null, undefined]) {
        assert.equal(hb.normalizeBlockCause(v), null, `debería ser null: ${JSON.stringify(v)}`);
    }
});

test('#7439 — block-cause.js es un módulo HOJA (0 requires) y el enum sobrevive a ambos órdenes de carga', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'block-cause.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    assert.equal((src.match(/require\(/g) || []).length, 0, 'el módulo hoja no requiere nada');

    // Ciclo human-block ⇄ decision-card: en los dos órdenes, `cause` se
    // normaliza bien (si `decision-card` importara el enum desde `human-block`
    // uno de los dos órdenes lo dejaría `undefined`).
    for (const orden of [['../decision-card', '../human-block'], ['../human-block', '../decision-card']]) {
        for (const m of ['../decision-card', '../human-block', '../block-cause']) {
            delete require.cache[require.resolve(m)];
        }
        const mods = orden.map((m) => require(m));
        const dcMod = mods[orden.indexOf('../decision-card')];
        const hbMod = mods[orden.indexOf('../human-block')];
        assert.equal(hbMod.normalizeBlockCause('design-decision'), 'design-decision', `orden ${orden}`);
        const card = dcMod.buildDecisionCard({ issue: 1, cause: 'design-decision', question: '¿Seguimos?' }, Date.now());
        assert.equal(card.tipo, 'decision', `orden ${orden}: la ficha ve el enum`);
    }
    // Restaurar el módulo que usa el resto de este archivo.
    delete require.cache[require.resolve('../human-block')];
});

// -----------------------------------------------------------------------------
// Escritura: reportHumanBlock
// -----------------------------------------------------------------------------

test('#7439 CA-5 — reportHumanBlock({ cause:"design-decision" }) persiste `cause` en el .reason.json y lo devuelve', () => {
    resetFs();
    const r = hb.reportHumanBlock({ ...BASE, cause: 'design-decision' });
    const meta = leerReason(r.marker_path);
    assert.equal(meta.cause, 'design-decision');
    assert.equal(r.cause, 'design-decision');
    assert.ok(!('signoff_verifiable' in meta), 'sin `signoff_verifiable` explícito la clave no existe');
    assert.equal(r.signoff_verifiable, null);
});

test('#7439 CA-5 — valores fuera del enum NO se persisten: la clave `cause` no existe en el JSON', () => {
    for (const cause of ['otra-cosa', ' design-decision', ['design-decision'], '', 0, undefined]) {
        resetFs();
        const r = hb.reportHumanBlock({ ...BASE, cause });
        const meta = leerReason(r.marker_path);
        assert.ok(!('cause' in meta), `cause=${JSON.stringify(cause)} se persistió: ${JSON.stringify(meta.cause)}`);
        assert.equal(r.cause, null);
    }
});

test('#7439 UX-F — signoff_verifiable: sólo el `false` EXPLÍCITO se persiste', () => {
    resetFs();
    const r = hb.reportHumanBlock({ ...BASE, cause: 'design-decision', signoff_verifiable: false });
    const meta = leerReason(r.marker_path);
    assert.equal(meta.signoff_verifiable, false);
    assert.equal(r.signoff_verifiable, false);
    for (const v of [true, 'false', 0, null, undefined, 'no']) {
        resetFs();
        const r2 = hb.reportHumanBlock({ ...BASE, cause: 'design-decision', signoff_verifiable: v });
        assert.ok(!('signoff_verifiable' in leerReason(r2.marker_path)), `signoff_verifiable=${JSON.stringify(v)} se persistió`);
        assert.equal(r2.signoff_verifiable, null);
    }
});

test('#7439 — `cause` no toca las claves históricas del .reason.json', () => {
    resetFs();
    const r = hb.reportHumanBlock({ ...BASE, cause: 'design-decision', evidence: 'cita del issue' });
    const meta = leerReason(r.marker_path);
    for (const k of ['issue', 'skill', 'phase', 'pipeline', 'reason', 'question', 'precondition', 'evidence', 'blocked_at']) {
        assert.ok(k in meta, `falta la clave histórica ${k}`);
    }
    assert.deepEqual(meta.precondition, { type: 'human_judgment' });
});

// -----------------------------------------------------------------------------
// Lectura normalizada: listBlockedIssues + listBlockedMarkers
// -----------------------------------------------------------------------------

test('#7439 CA-5 — listBlockedIssues y listBlockedMarkers exponen `cause` y `signoff_verifiable`', () => {
    resetFs();
    hb.reportHumanBlock({ ...BASE, cause: 'design-decision', signoff_verifiable: false });
    const fila = hb.listBlockedIssues().find((b) => b.issue === 7439);
    assert.ok(fila);
    assert.equal(fila.cause, 'design-decision');
    assert.equal(fila.signoff_verifiable, false);
    const markers = hb.listBlockedMarkers(7439);
    assert.equal(markers.length, 1);
    assert.equal(markers[0].cause, 'design-decision');
    assert.deepEqual(Object.keys(markers[0]).sort(), ['blocked_at', 'cause', 'file', 'phase', 'pipeline', 'skill', 'synthetic'],
        'las claves históricas de listBlockedMarkers no cambian: se suman cause (#7439) y blocked_at + synthetic (#7440 CA-11)');
});

test('#7439 CA-5 — marker LEGACY sin `cause` ⇒ cause:null y signoff_verifiable:null en ambas lecturas', () => {
    resetFs();
    const r = hb.reportHumanBlock({ ...BASE });
    // Reescribir el .reason.json con la forma anterior a #7439.
    fs.writeFileSync(hb.reasonFilePath(r.marker_path), JSON.stringify({
        issue: 7439, skill: 'definicion', phase: 'criterios', pipeline: 'definicion',
        reason: BASE.reason, question: BASE.question, blocked_at: new Date().toISOString(),
    }));
    const fila = hb.listBlockedIssues().find((b) => b.issue === 7439);
    assert.equal(fila.cause, null);
    assert.equal(fila.signoff_verifiable, null);
    assert.equal(hb.listBlockedMarkers(7439)[0].cause, null);
});

test('#7439 RS-C.1 — .reason.json editado a mano con una causa inválida ⇒ null en lectura', () => {
    for (const cause of [' design-decision', ['design-decision'], 'otra-cosa', 42, { x: 1 }]) {
        resetFs();
        const r = hb.reportHumanBlock({ ...BASE, cause: 'design-decision' });
        const meta = leerReason(r.marker_path);
        fs.writeFileSync(hb.reasonFilePath(r.marker_path), JSON.stringify({ ...meta, cause, signoff_verifiable: 'false' }));
        const fila = hb.listBlockedIssues().find((b) => b.issue === 7439);
        assert.equal(fila.cause, null, `cause=${JSON.stringify(cause)} pasó la lectura`);
        assert.equal(fila.signoff_verifiable, null, 'un "false" en string no es el false explícito');
        assert.equal(hb.listBlockedMarkers(7439)[0].cause, null);
    }
});

test('#7439 — .reason.json ausente o corrupto ⇒ listBlockedMarkers devuelve cause:null y NO lanza', () => {
    resetFs();
    const r = hb.reportHumanBlock({ ...BASE, cause: 'design-decision' });
    fs.writeFileSync(hb.reasonFilePath(r.marker_path), '{ esto no es json');
    assert.doesNotThrow(() => hb.listBlockedMarkers(7439));
    assert.equal(hb.listBlockedMarkers(7439)[0].cause, null);
    fs.unlinkSync(hb.reasonFilePath(r.marker_path));
    assert.doesNotThrow(() => hb.listBlockedMarkers(7439));
    assert.equal(hb.listBlockedMarkers(7439).length, 1, 'el marker sigue listándose sin su sidecar');
    assert.equal(hb.listBlockedMarkers(7439)[0].cause, null);
});

test('#7439 RS-C.4 — re-reportHumanBlock sobre un issue que ya tenía marker con `cause` lo conserva', () => {
    resetFs();
    const r1 = hb.reportHumanBlock({ ...BASE, cause: 'design-decision', signoff_verifiable: false });
    assert.equal(leerReason(r1.marker_path).cause, 'design-decision');
    // Segunda escritura del MISMO gate (mismo skill/phase): vuelve a pasar la causa.
    const r2 = hb.reportHumanBlock({ ...BASE, cause: 'design-decision', signoff_verifiable: false });
    assert.equal(r2.marker_path, r1.marker_path);
    const meta = leerReason(r2.marker_path);
    assert.equal(meta.cause, 'design-decision');
    assert.equal(meta.signoff_verifiable, false);
    assert.equal(hb.listBlockedMarkers(7439)[0].cause, 'design-decision');
});

test('#7439 — enriquecerConTitulo (recordatorio de 6 h) preserva `cause` y `signoff_verifiable`', () => {
    resetFs();
    hb.reportHumanBlock({ ...BASE, cause: 'design-decision', signoff_verifiable: false });
    const filas = hb.listBlockedIssues().filter((b) => b.issue === 7439);
    const enriquecidas = hb.enriquecerConTitulo(filas, { 7439: { title: 'Ejemplo' } });
    assert.equal(enriquecidas.length, 1);
    assert.equal(enriquecidas[0].cause, 'design-decision');
    assert.equal(enriquecidas[0].signoff_verifiable, false);
});

// -----------------------------------------------------------------------------
// CA-4-UX en el recordatorio de 6 h — camino REAL, de punta a punta (rebote QA)
//
// El test anterior atajaba por `enriquecerConTitulo` y no pasaba por
// `evaluateReminders`, que armaba cada `due` a mano y DESCARTABA `cause` y
// `signoff_verifiable`. Resultado en producción: el title-cache aportaba
// `needs-definition`, `clasificar` caía en `firma` y el recordatorio decía
// «¿Aprobás el alcance de #N…?» / «visto bueno» / `/unblock N aprobar` — el
// copy de GATE 1 que este issue elimina. Acá se ejecuta `runReminderTick` con
// la fila tal cual sale de `listBlockedIssues()` (marker escrito por
// `reportHumanBlock`), con el title-cache real en disco y `needs-definition`
// en los labels, que es la condición que hacía caer la clasificación.
// -----------------------------------------------------------------------------

const reminder = require('../human-block-reminder');
const { TITLE_CACHE_FILE } = require('../issue-title-cache');

function correrTickReal({ signoffVerifiable, ageHours }) {
    resetFs();
    hb.reportHumanBlock({
        ...BASE,
        cause: 'design-decision',
        ...(signoffVerifiable === false ? { signoff_verifiable: false } : {}),
    });
    // Fila REAL (no fabricada) con la antigüedad forzada para que el
    // recordatorio esté vencido: `evaluateReminders` prefiere `blocked_at`.
    const now = new Date();
    const filas = hb.listBlockedIssues()
        .filter((b) => b.issue === 7439)
        .map((b) => ({ ...b, blocked_at: new Date(now.getTime() - ageHours * 3600000).toISOString() }));
    assert.equal(filas.length, 1);
    assert.equal(filas[0].cause, 'design-decision', 'precondición: la fila real trae la causa');

    const pipelineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-hb-7439-tick-'));
    fs.writeFileSync(path.join(pipelineDir, TITLE_CACHE_FILE), JSON.stringify({
        7439: { title: 'Aviso honesto al operador', labels: ['needs-definition', 'area:pipeline'] },
    }));
    const stateFile = path.join(pipelineDir, 'reminder-state.json');

    let texto = null;
    const r = reminder.runReminderTick({
        pipelineDir, stateFile, now,
        listBlocked: () => filas,
        sendTelegram: (t) => { texto = t; },
    });
    return { r, texto };
}

test('#7439 CA-4-UX — runReminderTick con la fila real de listBlockedIssues NO emite el copy de firma (GATE 1)', () => {
    const { r, texto } = correrTickReal({ signoffVerifiable: false, ageHours: 6.5 });
    assert.deepEqual(r, { sent: true, due: 1 });
    assert.equal(typeof texto, 'string');
    assert.doesNotMatch(texto, /Aprob[aá]s el alcance/, 'el recordatorio ofrecía firmar el alcance');
    assert.doesNotMatch(texto, /visto bueno/, 'el recordatorio explicaba el freno como falta de firma de definición');
    assert.doesNotMatch(texto, /\/unblock 7439 aprobar/, 'el recordatorio proponía el comando de GATE 1');
    assert.doesNotMatch(texto, /Aprobar el alcance|Ajustar los criterios/, 'opciones de GATE 1 en la ficha');
    assert.doesNotMatch(texto, /^ *\d+\. Rechazar$/m, 'opción "Rechazar" de GATE 1 en la ficha');
    // Copy UX-F literal: la firma no PUDO comprobarse, no es que falte.
    assert.match(texto, /no pudo comprobar/);
    assert.match(texto, /falló la consulta a GitHub, no falta la firma/);
    // La primera línea de la ficha es la pregunta LITERAL del gate (UX §1.8).
    assert.match(texto, /¿Lo dejo pasar o esperás a que lo revise\?/);
    assert.match(texto, /Ya está decidido en el issue/);
});

test('#7439 CA-4-UX — runReminderTick sin `signoff_verifiable:false` elige el "Por qué" de "no encontré la firma"', () => {
    const { r, texto } = correrTickReal({ signoffVerifiable: null, ageHours: 6.5 });
    assert.deepEqual(r, { sent: true, due: 1 });
    assert.doesNotMatch(texto, /Aprob[aá]s el alcance|visto bueno/);
    assert.doesNotMatch(texto, /no pudo comprobar/);
    assert.match(texto, /no encontré la firma del arquitecto/);
});

test('#7439 — evaluateReminders propaga `cause` y `signoff_verifiable` normalizados al `due`', () => {
    const now = Date.now();
    const base = {
        issue: 7439, skill: 'definicion', phase: 'criterios', pipeline: 'definicion',
        reason: 'r', question: 'q', blocked_at: new Date(now - 7 * 3600000).toISOString(), age_hours: 7,
    };
    const { due } = reminder.evaluateReminders({
        now,
        state: { issues: {} },
        blocked: [
            { ...base, issue: 1, cause: 'design-decision', signoff_verifiable: false },
            { ...base, issue: 2, cause: 'design-decision' },
            // Fuera del enum / sin normalizar: nunca llega al `due` tal cual.
            { ...base, issue: 3, cause: 'otra-cosa', signoff_verifiable: 'false' },
            { ...base, issue: 4 },
        ],
    });
    const porIssue = Object.fromEntries(due.map((d) => [d.issue, d]));
    assert.equal(porIssue[1].cause, 'design-decision');
    assert.equal(porIssue[1].signoff_verifiable, false);
    assert.equal(porIssue[2].cause, 'design-decision');
    assert.equal(porIssue[2].signoff_verifiable, null);
    assert.equal(porIssue[3].cause, null);
    assert.equal(porIssue[3].signoff_verifiable, null);
    assert.equal(porIssue[4].cause, null);
    assert.equal(porIssue[4].signoff_verifiable, null);
});
