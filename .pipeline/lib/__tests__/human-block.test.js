// Tests de .pipeline/lib/human-block.js (issue #2478)
// Valida marker en disco, schema de eventos human:blocked/unblocked y comandos.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Aislar PIPELINE_DIR a un tmp por test setup
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-humanblock-'));
fs.mkdirSync(path.join(TMP_DIR, '.claude'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.pipeline', 'desarrollo', 'dev', 'trabajando'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.pipeline', 'desarrollo', 'dev', 'pendiente'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.pipeline', 'desarrollo', 'verificacion', 'trabajando'), { recursive: true });
process.env.CLAUDE_PROJECT_DIR = TMP_DIR;
process.env.PIPELINE_REPO_ROOT = TMP_DIR;

delete require.cache[require.resolve('../traceability')];
delete require.cache[require.resolve('../human-block')];
const trace = require('../traceability');
const hb = require('../human-block');

function readEvents() {
    if (!fs.existsSync(trace.LOG_FILE)) return [];
    return fs.readFileSync(trace.LOG_FILE, 'utf8')
        .split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function resetFs() {
    // limpiar todos los markers
    for (const phase of ['dev', 'verificacion']) {
        for (const state of ['pendiente', 'trabajando', 'listo', 'bloqueado-humano']) {
            const dir = path.join(TMP_DIR, '.pipeline', 'desarrollo', phase, state);
            try {
                for (const f of fs.readdirSync(dir)) {
                    try { fs.unlinkSync(path.join(dir, f)); } catch {}
                }
            } catch {}
        }
    }
    try { fs.unlinkSync(trace.LOG_FILE); } catch {}
}

test('reportHumanBlock crea marker en bloqueado-humano/ y emite evento', () => {
    resetFs();
    const src = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'dev', 'trabajando', '2478.po');
    fs.writeFileSync(src, 'issue: 2478\n');

    const result = hb.reportHumanBlock({
        issue: 2478, skill: 'po', phase: 'dev',
        reason: 'Criterio contradictorio entre AC#2 y AC#5',
        question: '¿Cuál tiene prioridad si chocan?',
    });

    assert.equal(result.issue, 2478);
    assert.equal(result.skill, 'po');
    assert.equal(result.phase, 'dev');
    assert.equal(result.pipeline, 'desarrollo');
    assert.equal(fs.existsSync(src), false, 'src debe haberse movido');
    assert.equal(fs.existsSync(result.marker_path), true);
    assert.match(result.marker_path, /bloqueado-humano[\\/]2478\.po$/);

    const reasonFile = result.marker_path + '.reason.json';
    assert.equal(fs.existsSync(reasonFile), true);
    const reason = JSON.parse(fs.readFileSync(reasonFile, 'utf8'));
    assert.equal(reason.reason, 'Criterio contradictorio entre AC#2 y AC#5');
    assert.equal(reason.question, '¿Cuál tiene prioridad si chocan?');

    const events = readEvents();
    const blocked = events.find(e => e.event === 'human:blocked' && e.issue === 2478);
    assert.ok(blocked, 'evento human:blocked emitido');
    assert.equal(blocked.skill, 'po');
    assert.equal(blocked.phase, 'dev');
    assert.equal(blocked.pipeline, 'desarrollo');
    assert.equal(blocked.reason, 'Criterio contradictorio entre AC#2 y AC#5');
});

test('reportHumanBlock requiere reason y question', () => {
    resetFs();
    assert.throws(() => hb.reportHumanBlock({ issue: 1, skill: 'po', phase: 'dev', reason: '', question: 'x' }),
        /reason y question/);
    assert.throws(() => hb.reportHumanBlock({ issue: 1, skill: 'po', phase: 'dev', reason: 'x', question: '' }),
        /reason y question/);
});

test('reportHumanBlock requiere issue, skill, phase', () => {
    resetFs();
    assert.throws(() => hb.reportHumanBlock({ skill: 'po', phase: 'dev', reason: 'x', question: 'y' }),
        /issue, skill, phase/);
});

test('reportHumanBlock funciona aunque no exista marker activo', () => {
    resetFs();
    const result = hb.reportHumanBlock({
        issue: 9999, skill: 'qa', phase: 'verificacion',
        reason: 'Falta credencial AWS', question: '¿Quién regenera el token?',
        pipeline: 'desarrollo',
    });
    assert.equal(fs.existsSync(result.marker_path), true);
});

test('listBlockedIssues retorna todos los markers con metadata', () => {
    resetFs();
    hb.reportHumanBlock({
        issue: 1001, skill: 'po', phase: 'dev', pipeline: 'desarrollo',
        reason: 'r1', question: 'q1',
    });
    hb.reportHumanBlock({
        issue: 1002, skill: 'qa', phase: 'verificacion', pipeline: 'desarrollo',
        reason: 'r2', question: 'q2',
    });

    const list = hb.listBlockedIssues();
    assert.equal(list.length, 2);
    const issues = list.map(i => i.issue).sort();
    assert.deepEqual(issues, [1001, 1002]);
    const item = list.find(i => i.issue === 1001);
    assert.equal(item.skill, 'po');
    assert.equal(item.phase, 'dev');
    assert.equal(item.reason, 'r1');
    assert.equal(item.question, 'q1');
    assert.ok(typeof item.age_hours === 'number');
});

test('unblockIssue mueve marker a pendiente/ del target_phase y emite evento', () => {
    resetFs();
    hb.reportHumanBlock({
        issue: 2222, skill: 'po', phase: 'dev', pipeline: 'desarrollo',
        reason: 'r', question: 'q',
    });

    const res = hb.unblockIssue({
        issue: 2222, guidance: 'Aplicá AC#5 que es más reciente', unlocker: 'leo',
    });

    assert.equal(res.ok, true);
    assert.equal(res.issue, 2222);
    assert.equal(res.skill, 'po');
    assert.equal(res.from_phase, 'dev');
    assert.equal(res.to_phase, 'dev');
    assert.match(res.marker_path, /pendiente[\\/]2222\.po$/);
    assert.equal(fs.existsSync(res.marker_path), true);

    const guidanceFile = res.marker_path + '.guidance.txt';
    assert.equal(fs.existsSync(guidanceFile), true);
    assert.equal(fs.readFileSync(guidanceFile, 'utf8'), 'Aplicá AC#5 que es más reciente');

    // marker de bloqueado debe haber desaparecido
    const list = hb.listBlockedIssues();
    assert.equal(list.find(i => i.issue === 2222), undefined);

    const events = readEvents();
    const unblocked = events.find(e => e.event === 'human:unblocked' && e.issue === 2222);
    assert.ok(unblocked);
    assert.equal(unblocked.guidance, 'Aplicá AC#5 que es más reciente');
    assert.equal(unblocked.unlocker, 'leo');
    assert.equal(unblocked.target_phase, 'dev');
});

test('unblockIssue puede redirigir a otra fase con target_phase', () => {
    resetFs();
    hb.reportHumanBlock({
        issue: 3333, skill: 'qa', phase: 'verificacion', pipeline: 'desarrollo',
        reason: 'r', question: 'q',
    });

    const res = hb.unblockIssue({
        issue: 3333, guidance: 'Volver a dev por refactor', target_phase: 'dev',
    });

    assert.equal(res.ok, true);
    assert.equal(res.from_phase, 'verificacion');
    assert.equal(res.to_phase, 'dev');
    assert.match(res.marker_path, /desarrollo[\\/]dev[\\/]pendiente[\\/]3333\.qa$/);
});

test('unblockIssue retorna error si issue no está bloqueado', () => {
    resetFs();
    const res = hb.unblockIssue({ issue: 4444, guidance: 'x' });
    assert.equal(res.ok, false);
    assert.match(res.error, /no está en bloqueado-humano/);
});

test('findBlockedMarker localiza marker existente', () => {
    resetFs();
    hb.reportHumanBlock({
        issue: 5555, skill: 'tester', phase: 'dev', pipeline: 'desarrollo',
        reason: 'r', question: 'q',
    });
    const found = hb.findBlockedMarker(5555);
    assert.ok(found);
    assert.equal(found.skill, 'tester');
    assert.equal(found.phase, 'dev');
    assert.equal(found.pipeline, 'desarrollo');
});

test('listBlockedIssues ignora archivos .reason.json y .gitkeep', () => {
    resetFs();
    const dir = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'dev', 'bloqueado-humano');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.gitkeep'), '');
    hb.reportHumanBlock({
        issue: 6666, skill: 'po', phase: 'dev', pipeline: 'desarrollo',
        reason: 'r', question: 'q',
    });
    const list = hb.listBlockedIssues();
    assert.equal(list.filter(i => i.issue === 6666).length, 1);
    assert.equal(list.find(i => String(i.issue) === '.gitkeep'), undefined);
});

// =============================================================================
// #2549 — isHumanBlockReason: detección de motivos de bloqueo humano en rechazos
// =============================================================================

test('isHumanBlockReason detecta variantes literales del bloqueo humano', () => {
    const positives = [
        'bloqueo humano sobre PR #2547',
        'Bloqueo Humano sobre el PR mergeable',
        'bloqueo-humano: esperando merge',
        'Bloqueado por humano hasta merge',
        'necesita intervencion humana para mergear',
        'Necesita intervención humana — CODEOWNERS pendiente',
        'requiere intervención humana del CODEOWNERS',
        'needs-human merge required',
        'needs human review',
        'needs:human label needed',
        'Human review required before continuing',
        'Merge manual del PR #2547 esperando humano',
        'merge bloqueado por CODEOWNERS',
        'merge humano pendiente',
        'CODEOWNERS bloquea el merge automático',
        'PR #2547 mergeable, esperando merge humano',
        'pending human review on PR',
        'aprobación humana pendiente',
    ];
    for (const p of positives) {
        assert.equal(hb.isHumanBlockReason(p), true, `debería detectar: "${p}"`);
    }
});

test('isHumanBlockReason NO marca rechazos técnicos comunes', () => {
    const negatives = [
        '',
        null,
        undefined,
        'NullPointerException at FooBar.kt:42',
        'ENOTFOUND github.com',
        'Build failed: missing JAVA_HOME',
        'Tests rojos: 3 fallos en LoginTest',
        'Routing incorrecto: este issue es de backend',
        'Connection refused on port 8080',
        'Compilation error: unresolved reference foo',
    ];
    for (const n of negatives) {
        assert.equal(hb.isHumanBlockReason(n), false, `NO debería detectar: "${n}"`);
    }
});

test('inferHumanBlockQuestion menciona PR cuando el motivo lo cita', () => {
    const q = hb.inferHumanBlockQuestion('bloqueo humano sobre PR #2547', { skill: 'pipeline-dev' });
    assert.match(q, /\[pipeline-dev\]/);
    assert.match(q, /PR/i);
});

test('inferHumanBlockQuestion menciona CODEOWNERS cuando aplica', () => {
    const q = hb.inferHumanBlockQuestion('CODEOWNERS bloquea el merge automático');
    assert.match(q, /CODEOWNERS/);
});

test('inferHumanBlockQuestion devuelve fallback razonable cuando el motivo es ambiguo', () => {
    const q = hb.inferHumanBlockQuestion('algo raro pasa');
    assert.match(q, /revisar/i);
});

test('buildBlockedSummaryMarkdown destaca el highlight y lista todos los bloqueados', () => {
    resetFs();
    hb.reportHumanBlock({
        issue: 7001, skill: 'po', phase: 'dev', pipeline: 'desarrollo',
        reason: 'criterios contradictorios', question: '¿AC#2 o AC#5?',
    });
    hb.reportHumanBlock({
        issue: 7002, skill: 'pipeline-dev', phase: 'dev', pipeline: 'desarrollo',
        reason: 'PR #9999 esperando merge humano', question: '¿podés mergear?',
    });

    const md = hb.buildBlockedSummaryMarkdown({
        highlight: { issue: 7002, skill: 'pipeline-dev', reason: 'bloqueo humano sobre PR #9999', question: '¿mergeás?' },
    });

    assert.match(md, /Issue \*?#?7002/);
    assert.match(md, /Incidentes bloqueados esperando humano\*? \(2\)/);
    assert.match(md, /#7001/);
    assert.match(md, /#7002/);
    assert.match(md, /unblock/);
});

test('buildBlockedSummaryMarkdown sin bloqueados devuelve mensaje placeholder', () => {
    resetFs();
    const md = hb.buildBlockedSummaryMarkdown({});
    assert.match(md, /sin otros incidentes bloqueados/);
});

test('reportHumanBlock no duplica notificación: findBlockedMarker permite dedup', () => {
    resetFs();
    hb.reportHumanBlock({
        issue: 8001, skill: 'pipeline-dev', phase: 'dev', pipeline: 'desarrollo',
        reason: 'bloqueo humano sobre PR #1', question: '¿mergeás?',
    });
    const found = hb.findBlockedMarker(8001);
    assert.ok(found, 'el marker existe → cualquier siguiente ciclo del pulpo dedupea con esto');
    assert.equal(found.skill, 'pipeline-dev');
});

// =============================================================================
// E2E (#2549 CA): simular 3 ciclos del pulpo sobre un issue con bloqueo humano.
// El criterio del issue exige que el pulpo NO relance el skill en 3 ciclos
// consecutivos. Acá simulamos los 3 ciclos a nivel de la decisión: cada ciclo
// consulta `findBlockedMarker` antes de procesar; si está presente, no se hace
// nada (no se notifica, no se incrementa rev, no se mueve el archivo).
// =============================================================================

test('e2e: 3 ciclos consecutivos del pulpo sobre issue bloqueado por humano NO incrementan ni re-notifican', () => {
    resetFs();
    const issue = 9001;
    const motivo = 'bloqueo humano sobre PR #2547 mergeable, esperando merge de CODEOWNERS';

    // Simular el ciclo del pulpo: 1) clasifica motivo, 2) si es human-block y no hay
    // marker previo → reportHumanBlock + notifica; 3) si ya hay marker → noop.
    let notificacionesEnviadas = 0;
    let rebotesIncrementados = 0;
    function cicloPulpoSimulado(motivoRecibido) {
        if (!hb.isHumanBlockReason(motivoRecibido)) {
            // rebote técnico — incrementaría rev en el flujo real
            rebotesIncrementados++;
            return 'rebote-tecnico';
        }
        const yaBloqueado = hb.findBlockedMarker(issue);
        if (yaBloqueado) {
            // noop — el issue ya está dormido. No notificamos, no movemos.
            return 'noop-dedup';
        }
        hb.reportHumanBlock({
            issue, skill: 'pipeline-dev', phase: 'dev', pipeline: 'desarrollo',
            reason: motivoRecibido, question: 'mergeá el PR #2547',
        });
        notificacionesEnviadas++;
        return 'reportado-y-notificado';
    }

    // Ciclo 1 → primer rechazo, debería reportar + notificar.
    const r1 = cicloPulpoSimulado(motivo);
    // Ciclo 2 → marker ya existe, debería ser noop.
    const r2 = cicloPulpoSimulado(motivo);
    // Ciclo 3 → marker ya existe, debería ser noop.
    const r3 = cicloPulpoSimulado(motivo);

    assert.equal(r1, 'reportado-y-notificado');
    assert.equal(r2, 'noop-dedup');
    assert.equal(r3, 'noop-dedup');
    assert.equal(notificacionesEnviadas, 1, 'solo una notificación en 3 ciclos');
    assert.equal(rebotesIncrementados, 0, 'cero incrementos de rev — bloqueo humano NO consume budget de circuit breaker');
    const lista = hb.listBlockedIssues().filter(b => b.issue === issue);
    assert.equal(lista.length, 1, 'un único marker en bloqueado-humano/');
});

test('e2e: cuando humano desbloquea, el siguiente ciclo del pulpo procesa normalmente', () => {
    resetFs();
    const issue = 9002;
    hb.reportHumanBlock({
        issue, skill: 'pipeline-dev', phase: 'dev', pipeline: 'desarrollo',
        reason: 'bloqueo humano sobre PR #X', question: 'mergeá',
    });
    assert.ok(hb.findBlockedMarker(issue), 'pre-condición: marker existe');

    // Humano desbloquea (equivale a /unblock o quitar label en GitHub).
    const res = hb.unblockIssue({ issue, guidance: 'PR mergeado, podés seguir' });
    assert.equal(res.ok, true);
    assert.equal(hb.findBlockedMarker(issue), null, 'marker se removió de bloqueado-humano/');

    // Ciclo siguiente del pulpo: como NO hay marker, podría procesar de nuevo
    // (el archivo del unblock está en pendiente/ con guidance, listo para arrancar).
    const dirPendiente = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'dev', 'pendiente');
    const archivos = fs.readdirSync(dirPendiente)
        .filter(f => f.startsWith(String(issue) + '.') && !f.endsWith('.guidance.txt'));
    assert.equal(archivos.length, 1, 'el archivo del issue volvió a pendiente/');
});
