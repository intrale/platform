'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { analyzeStuckIssue, classifySkill, DEFAULT_STALE_THRESHOLD_MS } = require('./stuck-phase-detector');

const NOW = 1_800_000_000_000;
const OLD = NOW - 20 * 60 * 1000;   // 20 min → stale
const RECENT = NOW - 60 * 1000;      // 1 min → reciente
const APROB = { resultado: 'aprobado' };
const CANCEL = { cancelado_por: 'fast-fail-rebote', cancelado_ts: 'x' };
const RECHAZO = { resultado: 'rechazado', motivo: 'x' };
const CORRUPT = { issue: 1, fase: 'validacion' }; // sin resultado

function deliv(skill, state, yaml, mtimeMs = OLD) { return { skill, state, yaml, mtimeMs }; }

// ─── classifySkill ──────────────────────────────────────────────────────────
test('classifySkill: aprobado en listo → done', () => {
    assert.equal(classifySkill('po', [deliv('po', 'listo', APROB)], new Set()).status, 'done');
});
test('classifySkill: cancelado → cancelled', () => {
    assert.equal(classifySkill('po', [deliv('po', 'procesado', CANCEL)], new Set()).status, 'cancelled');
});
test('classifySkill: rechazado → rejected', () => {
    assert.equal(classifySkill('po', [deliv('po', 'listo', RECHAZO)], new Set()).status, 'rejected');
});
test('classifySkill: presente sin resultado → corrupt', () => {
    assert.equal(classifySkill('po', [deliv('po', 'listo', CORRUPT)], new Set()).status, 'corrupt');
});
test('classifySkill: ausente → missing', () => {
    assert.equal(classifySkill('ux', [deliv('po', 'listo', APROB)], new Set()).status, 'missing');
});
test('classifySkill: en pendiente/trabajando → live (gana sobre todo)', () => {
    assert.equal(classifySkill('po', [deliv('po', 'listo', APROB)], new Set(['po'])).status, 'live');
});
test('classifySkill: prioridad listo(aprobado) > procesado(cancelado)', () => {
    const dels = [deliv('po', 'procesado', CANCEL), deliv('po', 'listo', APROB)];
    assert.equal(classifySkill('po', dels, new Set()).status, 'done');
});
test('classifySkill: archivado aprobado cuenta como done', () => {
    assert.equal(classifySkill('po', [deliv('po', 'archivado', APROB)], new Set()).status, 'done');
});
test('classifySkill: archivado cancelado NO es done', () => {
    assert.equal(classifySkill('po', [deliv('po', 'archivado', CANCEL)], new Set()).status, 'cancelled');
});

// ─── analyzeStuckIssue: no-stuck ────────────────────────────────────────────
test('completo → none', () => {
    const r = analyzeStuckIssue({
        requiredSkills: ['po', 'ux', 'guru'],
        deliverables: [deliv('po', 'listo', APROB), deliv('ux', 'listo', APROB), deliv('guru', 'listo', APROB)],
        nowMs: NOW,
    });
    assert.deepEqual([r.stuck, r.action], [false, 'none']);
});
test('hay trabajo vivo → none (no interferir)', () => {
    const r = analyzeStuckIssue({
        requiredSkills: ['po', 'ux'],
        deliverables: [deliv('po', 'listo', APROB)],
        liveSkills: ['ux'],
        nowMs: NOW,
    });
    assert.equal(r.action, 'none');
    assert.equal(r.reason, 'trabajo-vivo');
});
test('deliverable reciente (< threshold) → none (darle tiempo)', () => {
    const r = analyzeStuckIssue({
        requiredSkills: ['po', 'ux'],
        deliverables: [deliv('po', 'listo', APROB, RECENT), deliv('ux', 'procesado', CANCEL, RECENT)],
        nowMs: NOW,
    });
    assert.equal(r.action, 'none');
    assert.equal(r.reason, 'reciente');
});
test('sin deliverables → none (lo maneja el intake)', () => {
    const r = analyzeStuckIssue({ requiredSkills: ['po'], deliverables: [], nowMs: NOW });
    assert.equal(r.action, 'none');
});
test('sin skills requeridos → none', () => {
    const r = analyzeStuckIssue({ requiredSkills: [], deliverables: [deliv('po', 'listo', APROB)], nowMs: NOW });
    assert.equal(r.action, 'none');
});

// ─── analyzeStuckIssue: requeue ─────────────────────────────────────────────
test('CASO #4534: guru aprobado + po/ux cancelados (stale) → ESCALATE (cancelado = ambiguo)', () => {
    const r = analyzeStuckIssue({
        requiredSkills: ['po', 'ux', 'guru'],
        deliverables: [
            deliv('guru', 'listo', APROB),
            deliv('po', 'procesado', CANCEL),
            deliv('ux', 'procesado', CANCEL),
        ],
        nowMs: NOW,
    });
    assert.equal(r.action, 'escalate', 'un cancelado implica rechazo previo → humano decide, no re-encolar a ciegas');
    assert.match(r.reason, /cancel/);
});
test('CASO #4507: review aprobado + po/architect archivado-aprobado + ux faltante → requeue [ux]', () => {
    const r = analyzeStuckIssue({
        requiredSkills: ['review', 'po', 'ux', 'architect'],
        deliverables: [
            deliv('review', 'listo', APROB),
            deliv('po', 'archivado', APROB),
            deliv('architect', 'archivado', APROB),
        ],
        nowMs: NOW,
    });
    assert.equal(r.action, 'requeue');
    assert.deepEqual(r.requeueSkills, ['ux']);
});
test('skill missing (stale, no live) → requeue', () => {
    const r = analyzeStuckIssue({
        requiredSkills: ['po', 'ux'],
        deliverables: [deliv('po', 'listo', APROB)],
        nowMs: NOW,
    });
    assert.equal(r.action, 'requeue');
    assert.deepEqual(r.requeueSkills, ['ux']);
});
test('skill corrupto (sin resultado) → ESCALATE (indeterminado, no re-correr a ciegas)', () => {
    const r = analyzeStuckIssue({
        requiredSkills: ['po', 'ux'],
        deliverables: [deliv('po', 'listo', APROB), deliv('ux', 'listo', CORRUPT)],
        nowMs: NOW,
    });
    assert.equal(r.action, 'escalate');
});
test('mixto: faltante + cancelado → ESCALATE (la ambigüedad gana sobre requeue)', () => {
    const r = analyzeStuckIssue({
        requiredSkills: ['po', 'ux', 'guru'],
        deliverables: [deliv('po', 'listo', APROB), deliv('ux', 'procesado', CANCEL)], // guru missing
        nowMs: NOW,
    });
    assert.equal(r.action, 'escalate', 'si hay cualquier ambigüedad, no auto-remediar parcial');
});

// ─── analyzeStuckIssue: escalate ────────────────────────────────────────────
test('rechazo REAL → escalate (NO re-encolar, evita loop)', () => {
    const r = analyzeStuckIssue({
        requiredSkills: ['po', 'ux'],
        deliverables: [deliv('po', 'listo', APROB), deliv('ux', 'listo', RECHAZO)],
        nowMs: NOW,
    });
    assert.equal(r.action, 'escalate');
    assert.match(r.reason, /rechazo/);
});
test('rechazo + faltante → escalate gana (el rechazo manda)', () => {
    const r = analyzeStuckIssue({
        requiredSkills: ['po', 'ux', 'guru'],
        deliverables: [deliv('po', 'listo', RECHAZO)],
        nowMs: NOW,
    });
    assert.equal(r.action, 'escalate');
});

// ─── boundaries ─────────────────────────────────────────────────────────────
test('boundary: 1ms bajo el threshold → none (aún no stale)', () => {
    const r = analyzeStuckIssue({
        requiredSkills: ['po', 'ux'],
        deliverables: [deliv('po', 'listo', APROB, NOW - DEFAULT_STALE_THRESHOLD_MS + 1)],
        nowMs: NOW,
    });
    assert.equal(r.action, 'none', 'edad < threshold no es stale');
});
test('boundary: exactamente en el threshold → stale (age >= threshold)', () => {
    const r = analyzeStuckIssue({
        requiredSkills: ['po', 'ux'],
        deliverables: [deliv('po', 'listo', APROB, NOW - DEFAULT_STALE_THRESHOLD_MS)],
        nowMs: NOW,
    });
    assert.equal(r.stuck, true);
    assert.equal(r.action, 'requeue');
});
test('threshold custom respetado', () => {
    const r = analyzeStuckIssue({
        requiredSkills: ['po', 'ux'],
        deliverables: [deliv('po', 'listo', APROB, NOW - 5 * 60 * 1000)],
        nowMs: NOW,
        staleThresholdMs: 3 * 60 * 1000,
    });
    assert.equal(r.action, 'requeue', '5min > threshold custom de 3min');
});

// ─── robustez de inputs ─────────────────────────────────────────────────────
test('inputs vacíos/undefined no tiran', () => {
    assert.doesNotThrow(() => analyzeStuckIssue());
    assert.doesNotThrow(() => analyzeStuckIssue({ requiredSkills: ['po'], deliverables: null, nowMs: NOW }));
    assert.doesNotThrow(() => analyzeStuckIssue({ requiredSkills: ['po'], deliverables: [{ skill: 'po' }], nowMs: NOW }));
});
test('yaml faltante en deliverable no tira y cuenta como corrupt → escalate', () => {
    const r = analyzeStuckIssue({
        requiredSkills: ['po'],
        deliverables: [{ skill: 'po', state: 'listo', mtimeMs: OLD }], // sin yaml
        nowMs: NOW,
    });
    assert.equal(r.action, 'escalate'); // corrupt → indeterminado → humano
});

// ═══════════════════════════════════════════════════════════════════════════
// #5641 — Caída de infra ≠ veredicto de rechazo
//
// El Pulpo sintetiza `resultado: rechazado` cuando el proceso del agente muere
// con exit code ≠ 0. Ese deliverable no contiene ninguna decisión de review,
// pero el detector lo contaba como rechazo real y frenaba el issue pidiendo
// humano (6 de 12 issues frenados de la ola 9.4 del 2026-08-06 eran esto).
//
// La discriminación es por PROCEDENCIA ESTRUCTURADA (`veredicto_sintetizado_por`,
// campo que sólo el Pulpo escribe), NUNCA por el texto del `motivo`.
// ═══════════════════════════════════════════════════════════════════════════

const { classifyPhase } = require('./stuck-phase-detector');

// Veredicto sintetizado por el Pulpo: el agente se cayó, nunca opinó.
const INFRA = {
    resultado: 'rechazado',
    motivo: 'Agente terminó con código 1',
    veredicto_sintetizado_por: 'pulpo',
    agente_exit_code: 1,
};
// Hermano drenado por el fast-fail que disparó esa caída.
const DRENADO = (porQuien = 'po', infra = true) => ({
    cancelado_por: 'fast-fail-rebote',
    cancelado_ts: 'x',
    cancelado_disparado_por: porQuien,
    cancelado_disparador_infra: infra,
});
// Shape REAL de #5175: po caído + review/ux drenados + architect aprobado.
const SHAPE_5175 = {
    requiredSkills: ['po', 'review', 'ux', 'architect'],
    deliverables: [
        deliv('po', 'procesado', INFRA),
        deliv('review', 'procesado', DRENADO('po')),
        deliv('ux', 'procesado', DRENADO('po')),
        deliv('architect', 'procesado', APROB),
    ],
};

// ─── CA-5 / CA-6: procedencia, nunca el texto del motivo ────────────────────
test('CA-5 classifySkill: veredicto_sintetizado_por pulpo → infra-failed', () => {
    const c = classifySkill('po', [deliv('po', 'listo', INFRA)], new Set());
    assert.equal(c.status, 'infra-failed');
    assert.equal(c.exitCode, 1, 'el exit code viaja para el audit y el texto al operador');
});
test('CA-6 SEC-1: motivo que CITA el literal de infra pero SIN procedencia → rejected', () => {
    const y = { resultado: 'rechazado', motivo: 'CA-1 no se cumple: secret hardcodeado en Foo.kt:42. El log dice: Agente terminó con código 1' };
    assert.equal(classifySkill('review', [deliv('review', 'listo', y)], new Set()).status, 'rejected');
});
test('CA-6 SEC-1: el literal con prefijo [skill] tampoco alcanza sin procedencia', () => {
    const y = { resultado: 'rechazado', motivo: '[po] Agente terminó con código 1' };
    assert.equal(classifySkill('po', [deliv('po', 'listo', y)], new Set()).status, 'rejected');
});
test('CA-5: procedencia distinta de "pulpo" NO habilita el carril (fail-closed)', () => {
    const y = { ...INFRA, veredicto_sintetizado_por: 'agente' };
    assert.equal(classifySkill('po', [deliv('po', 'listo', y)], new Set()).status, 'rejected');
});
test('R-2 orden de guardas: procedencia + cancelado_por → infra-failed, no cancelled', () => {
    // El drenaje fast-fail hace `{...prev, cancelado_por}`: preserva el veredicto
    // previo. Con el orden viejo (cancelado_por antes que resultado) esta rama era
    // inalcanzable justo en el shape que motivó el issue.
    const y = { ...INFRA, ...DRENADO('otro') };
    assert.equal(classifySkill('po', [deliv('po', 'procesado', y)], new Set()).status, 'infra-failed');
});
test('un aprobado con procedencia sigue siendo done (done gana)', () => {
    const y = { resultado: 'aprobado', veredicto_sintetizado_por: 'pulpo' };
    assert.equal(classifySkill('po', [deliv('po', 'listo', y)], new Set()).status, 'done');
});

// ─── CA-9: re-mapeo cancelled → missing, fail-closed en cada puerta ─────────
test('CA-9 classifyPhase: hermanos drenados por un infra-failed → missing', () => {
    const cs = classifyPhase(SHAPE_5175.requiredSkills, SHAPE_5175.deliverables, new Set());
    const byName = Object.fromEntries(cs.map((c) => [c.skill, c]));
    assert.equal(byName.po.status, 'infra-failed');
    assert.equal(byName.review.status, 'missing');
    assert.equal(byName.review.remappedFrom, 'cancelled');
    assert.equal(byName.ux.status, 'missing');
    assert.equal(byName.architect.status, 'done');
});
test('CA-9 fail-closed: legacy sin cancelado_disparado_por → cancelled', () => {
    const dels = [deliv('po', 'procesado', INFRA), deliv('ux', 'procesado', CANCEL)];
    const cs = classifyPhase(['po', 'ux'], dels, new Set());
    assert.equal(cs.find((c) => c.skill === 'ux').status, 'cancelled');
});
test('CA-9 fail-closed: cancelado_disparador_infra false → cancelled', () => {
    const dels = [deliv('po', 'procesado', INFRA), deliv('ux', 'procesado', DRENADO('po', false))];
    const cs = classifyPhase(['po', 'ux'], dels, new Set());
    assert.equal(cs.find((c) => c.skill === 'ux').status, 'cancelled');
});
test('CA-9 fail-closed: disparador MIXTO (infra + rechazo real) → cancelled', () => {
    const dels = [
        deliv('po', 'procesado', INFRA),
        deliv('review', 'procesado', RECHAZO),                    // rechazo de contenido
        deliv('ux', 'procesado', DRENADO('po,review')),
    ];
    const cs = classifyPhase(['po', 'review', 'ux'], dels, new Set());
    assert.equal(cs.find((c) => c.skill === 'ux').status, 'cancelled',
        'un solo rechazo de contenido en la mezcla ⇒ no se relaja el gate');
});
test('CA-9 fail-closed: disparador que NO es de la fase → cancelled', () => {
    const dels = [deliv('po', 'procesado', INFRA), deliv('ux', 'procesado', DRENADO('desconocido'))];
    const cs = classifyPhase(['po', 'ux'], dels, new Set());
    assert.equal(cs.find((c) => c.skill === 'ux').status, 'cancelled');
});
test('CA-9: sin ningún infra-failed en la fase, classifyPhase no re-mapea nada', () => {
    const dels = [deliv('po', 'procesado', RECHAZO), deliv('ux', 'procesado', DRENADO('po'))];
    const cs = classifyPhase(['po', 'ux'], dels, new Set());
    assert.equal(cs.find((c) => c.skill === 'ux').status, 'cancelled');
});

// ─── CA-10: la acción sobre el shape real de #5175 ──────────────────────────
test('CA-10 shape de #5175 → requeue de po,review,ux (NO needs-human)', () => {
    const r = analyzeStuckIssue({ ...SHAPE_5175, nowMs: NOW });
    assert.equal(r.action, 'requeue');
    assert.deepEqual(r.requeueSkills, ['po', 'review', 'ux']);
    assert.deepEqual(r.infra.skills, ['po']);
    assert.deepEqual(r.infra.drained, ['review', 'ux']);
    assert.deepEqual(r.infra.exitCodes, { po: 1 });
});
test('CA-UX-2 el reason del carril infra NO dice "nunca corrieron"', () => {
    const r = analyzeStuckIssue({ ...SHAPE_5175, nowMs: NOW });
    assert.match(r.reason, /caída de infra/);
    assert.match(r.reason, /exit 1/, 'el operador necesita el exit code');
    assert.match(r.reason, /drenados por fast-fail/, 'distingue al caído de los arrastrados');
    assert.doesNotMatch(r.reason, /nunca corrieron/);
});
test('CA-UX-2 no-regresión: skills genuinamente faltantes conservan su reason', () => {
    const r = analyzeStuckIssue({
        requiredSkills: ['po', 'ux'],
        deliverables: [deliv('po', 'listo', APROB)],
        nowMs: NOW,
    });
    assert.equal(r.reason, 're-encolar skills faltantes (nunca corrieron): ux');
});
test('infra + un skill que nunca corrió → ambos se re-encolan', () => {
    const r = analyzeStuckIssue({
        requiredSkills: ['po', 'ux', 'guru'],
        deliverables: [deliv('po', 'procesado', INFRA), deliv('guru', 'listo', APROB)],
        nowMs: NOW,
    });
    assert.equal(r.action, 'requeue');
    assert.deepEqual(r.requeueSkills, ['po', 'ux']);
    assert.match(r.reason, /nunca corrieron \(ux\)/);
});

// ─── CA-11 / CA-12 / CA-2: la línea roja del PO (fail-closed) ──────────────
test('CA-11 no-regresión: rechazo de contenido real → escalate', () => {
    const y = { resultado: 'rechazado', motivo: 'CA-3 incumplido: el endpoint devuelve 500 con payload vacío' };
    const r = analyzeStuckIssue({
        requiredSkills: ['po', 'review'],
        deliverables: [deliv('po', 'listo', APROB), deliv('review', 'listo', y)],
        nowMs: NOW,
    });
    assert.equal(r.action, 'escalate');
});
test('CA-12 invariante security: rechazo sin procedencia NUNCA se auto-reencola', () => {
    const y = { resultado: 'rechazado', motivo: 'SEC-2: token de Cognito logueado en claro en AuthService.kt:88' };
    const r = analyzeStuckIssue({
        requiredSkills: ['security', 'po'],
        deliverables: [deliv('security', 'listo', y), deliv('po', 'listo', APROB)],
        nowMs: NOW,
    });
    assert.equal(r.action, 'escalate');
    assert.match(r.reason, /security:rejected/);
});
test('CA-12: security rechazado convive con un infra-failed y sigue ganando el escalate', () => {
    const y = { resultado: 'rechazado', motivo: 'SEC-2: credencial en claro' };
    const r = analyzeStuckIssue({
        requiredSkills: ['security', 'po'],
        deliverables: [deliv('security', 'listo', y), deliv('po', 'procesado', INFRA)],
        nowMs: NOW,
    });
    assert.equal(r.action, 'escalate', 'un rechazo de contenido bloquea el carril de infra');
});
test('CA-2 anti-spoof: tras el strip del Pulpo el rechazo de contenido → escalate', () => {
    // El Pulpo borra `veredicto_sintetizado_por`/`agente_exit_code` del YAML del
    // agente ANTES de evaluarlos, así que lo que llega al detector es esto:
    const spoofeadoYaLimpiado = { resultado: 'rechazado', motivo: 'CA-4 incumplido: falta el test de borde' };
    const r = analyzeStuckIssue({
        requiredSkills: ['review'],
        deliverables: [deliv('review', 'listo', spoofeadoYaLimpiado)],
        nowMs: NOW,
    });
    assert.equal(r.action, 'escalate');
});

// ─── CA-8: pureza del detector ─────────────────────────────────────────────
test('CA-8 pureza: el detector no requiere el clasificador de rebotes ni fs', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, 'stuck-phase-detector.js'), 'utf8');
    const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    assert.deepEqual(requires, ['./phase-completion'],
        'la fuente única compartida es el CAMPO estructurado, no el módulo clasificador');
});
