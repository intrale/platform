'use strict';

// Tests del agregador KPI "Entregables por skill" (#3932 / EP3-H6).
// Cubren los CA verificables:
//   - CA-3: dedup por (issue, fase, skill) — líneas repetidas no inflan.
//   - CA-6: líneas malformadas se descartan sin lanzar excepción.
//   - CA-5: el objeto retornado NO contiene preview/content_hash/dropfile/
//           attachment_path (no-exposición — security A01/A02).
//   - CA-6: skill/fase fuera de whitelist se descartan.
//   - CA-4: cálculo de pct y bandas de color en bordes (59/60/79/80).
//   - Denominador opción (a) desde procesado/ + fallback (b) parcial.
// Aislados: arman un repoRoot temporal en os.tmpdir(), sin tocar el repo real.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require('./kpi-deliverables-by-skill');
const { getDeliverablesBySkill, bandFor, _resetCache, _buildWhitelists } = mod;

// Config fake que replica la estructura real de config.yaml (whitelists).
const FAKE_CONFIG = {
    pipelines: {
        definicion: {
            fases: ['analisis', 'criterios', 'sizing'],
            skills_por_fase: {
                analisis: ['guru', 'security'],
                criterios: ['po', 'ux', 'architect'],
                sizing: ['planner'],
            },
        },
        desarrollo: {
            fases: ['validacion', 'dev', 'build', 'verificacion', 'linteo', 'aprobacion', 'entrega'],
            skills_por_fase: {
                validacion: ['po', 'ux', 'guru'],
                dev: ['backend-dev', 'android-dev', 'web-dev', 'pipeline-dev'],
                build: ['build'],
                verificacion: ['tester', 'security', 'qa'],
                aprobacion: ['review', 'po', 'ux', 'architect'],
                entrega: ['delivery'],
            },
        },
    },
    deliverable_notifications: {
        skills: ['guru', 'po', 'ux', 'planner', 'qa', 'tester', 'security', 'build',
            'architect', 'backend-dev', 'android-dev', 'web-dev', 'pipeline-dev', 'delivery'],
    },
};

// Crea un repoRoot temporal con el JSONL y, opcionalmente, dirs procesado/.
// `lines`: array de objetos (se serializan a JSONL) o strings crudos (para
// inyectar líneas malformadas).
function makeRepo(lines, procesado) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpi-deliv-'));
    const auditDir = path.join(root, '.pipeline', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    const body = (lines || []).map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
    fs.writeFileSync(path.join(auditDir, 'deliverable-notifications.jsonl'), body + '\n');

    // procesado: { "pipeline/fase": ["3932.guru", ...] }
    for (const [key, files] of Object.entries(procesado || {})) {
        const [pipe, fase] = key.split('/');
        const dir = path.join(root, '.pipeline', pipe, fase, 'procesado');
        fs.mkdirSync(dir, { recursive: true });
        for (const f of files) fs.writeFileSync(path.join(dir, f), 'x');
    }
    return root;
}

function bySkill(result, skill) {
    return result.skills.find((s) => s.skill === skill);
}

test('bandFor mapea bandas de color en los bordes (CA-4: 59/60/79/80)', () => {
    assert.strictEqual(bandFor(80).band, 'verde');
    assert.strictEqual(bandFor(80).severity, 'ok');
    assert.strictEqual(bandFor(79).band, 'amarillo');
    assert.strictEqual(bandFor(79).severity, 'warn');
    assert.strictEqual(bandFor(60).band, 'amarillo');
    assert.strictEqual(bandFor(60).severity, 'warn');
    assert.strictEqual(bandFor(59).band, 'rojo');
    assert.strictEqual(bandFor(59).severity, 'bad');
    assert.strictEqual(bandFor(100).band, 'verde');
    assert.strictEqual(bandFor(0).band, 'rojo');
    assert.strictEqual(bandFor(null).band, 'gris');
    assert.strictEqual(bandFor(null).severity, 'none');
});

test('CA-3: dedup por (issue, fase, skill) — líneas repetidas no inflan el numerador', () => {
    _resetCache();
    const root = makeRepo([
        { ts: '2026-06-03T10:00:00Z', issue: 100, fase: 'analisis', skill: 'guru', pipeline: 'definicion' },
        { ts: '2026-06-03T10:01:00Z', issue: 100, fase: 'analisis', skill: 'guru', pipeline: 'definicion' }, // duplicado exacto
        { ts: '2026-06-03T10:02:00Z', issue: 101, fase: 'analisis', skill: 'guru', pipeline: 'definicion' },
    ], {
        'definicion/analisis': ['100.guru', '101.guru'],
    });
    const r = getDeliverablesBySkill({ REPO_ROOT: root, config: FAKE_CONFIG });
    const guru = bySkill(r, 'guru');
    assert.strictEqual(guru.delivered, 2); // 100 y 101, el duplicado no suma
    assert.strictEqual(guru.total, 2);
    assert.strictEqual(guru.pct, 100);
    assert.strictEqual(guru.band, 'verde');
});

test('CA-6: líneas malformadas se descartan sin lanzar excepción', () => {
    _resetCache();
    const root = makeRepo([
        '{ esto no es json valido',
        '',
        'null',
        '12345',
        { ts: '2026-06-03T10:00:00Z', issue: 200, fase: 'criterios', skill: 'po', pipeline: 'definicion' },
        '}{ basura',
    ], {
        'definicion/criterios': ['200.po'],
    });
    let r;
    assert.doesNotThrow(() => { r = getDeliverablesBySkill({ REPO_ROOT: root, config: FAKE_CONFIG }); });
    const po = bySkill(r, 'po');
    assert.strictEqual(po.delivered, 1); // solo la línea válida cuenta
});

test('CA-5: el objeto retornado NO contiene preview/content_hash/dropfile/attachment_path', () => {
    _resetCache();
    // Líneas con TODOS los campos sensibles presentes (como el JSONL real).
    const root = makeRepo([
        {
            ts: '2026-06-03T10:00:00Z', issue: 300, fase: 'analisis', skill: 'guru', pipeline: 'definicion',
            content_hash: 'deadbeef', preview: 'CONTENIDO SECRETO DEL ANALISIS', attachment_path: '/tmp/x.json',
            dropfile: '123-deliverable-300-guru.json', telegram_enqueue_ok: true,
        },
    ], {
        'definicion/analisis': ['300.guru'],
    });
    const r = getDeliverablesBySkill({ REPO_ROOT: root, config: FAKE_CONFIG });
    const serialized = JSON.stringify(r);
    for (const forbidden of ['preview', 'content_hash', 'dropfile', 'attachment_path', 'CONTENIDO SECRETO', 'deadbeef']) {
        assert.ok(!serialized.includes(forbidden), `el resultado NO debe exponer "${forbidden}"`);
    }
    // Las cards sólo tienen claves agregadas.
    const allowedKeys = new Set(['skill', 'delivered', 'total', 'pct', 'band', 'severity', 'partial']);
    for (const card of r.skills) {
        for (const k of Object.keys(card)) {
            assert.ok(allowedKeys.has(k), `clave inesperada en card: ${k}`);
        }
    }
});

test('CA-6: skill/fase fuera de whitelist se descartan', () => {
    _resetCache();
    const root = makeRepo([
        { ts: '2026-06-03T10:00:00Z', issue: 400, fase: 'analisis', skill: 'hacker-skill', pipeline: 'definicion' }, // skill no whitelisted
        { ts: '2026-06-03T10:01:00Z', issue: 401, fase: 'fase-fantasma', skill: 'guru', pipeline: 'definicion' },    // fase no whitelisted
        { ts: '2026-06-03T10:02:00Z', issue: 402, fase: 'analisis', skill: 'guru', pipeline: 'definicion' },          // válido
    ], {});
    const r = getDeliverablesBySkill({ REPO_ROOT: root, config: FAKE_CONFIG });
    assert.strictEqual(bySkill(r, 'hacker-skill'), undefined); // no aparece
    const guru = bySkill(r, 'guru');
    assert.strictEqual(guru.delivered, 1); // sólo el issue 402; 401 descartado por fase
});

test('denominador opción (a): cuenta cierres desde procesado/ del filesystem', () => {
    _resetCache();
    // 2 cierres de tester en verificacion, 1 con entregable → pct = 50.
    const root = makeRepo([
        { ts: '2026-06-03T10:00:00Z', issue: 500, fase: 'verificacion', skill: 'tester', pipeline: 'desarrollo' },
    ], {
        'desarrollo/verificacion': ['500.tester', '501.tester'],
    });
    const r = getDeliverablesBySkill({ REPO_ROOT: root, config: FAKE_CONFIG });
    const tester = bySkill(r, 'tester');
    assert.strictEqual(tester.delivered, 1);
    assert.strictEqual(tester.total, 2);
    assert.strictEqual(tester.pct, 50);
    assert.strictEqual(tester.band, 'rojo');
    assert.strictEqual(tester.partial, false);
});

test('fallback (b): sin procesado/ el denominador usa el universo de fases y marca partial', () => {
    _resetCache();
    // planner aparece sólo en 1 fase (sizing). Sin procesado → universe=1, partial=true.
    const root = makeRepo([
        { ts: '2026-06-03T10:00:00Z', issue: 600, fase: 'sizing', skill: 'planner', pipeline: 'definicion' },
    ], {}); // sin dirs procesado
    const r = getDeliverablesBySkill({ REPO_ROOT: root, config: FAKE_CONFIG });
    const planner = bySkill(r, 'planner');
    assert.strictEqual(planner.delivered, 1);
    assert.strictEqual(planner.total, 1);      // universo de fases de planner
    assert.strictEqual(planner.partial, true); // marcado como dato parcial
    assert.strictEqual(planner.pct, 100);
});

test('skill sin cierres ni entregables: total=0 y pct=null (UX G-UX-4, no 0% rojo)', () => {
    _resetCache();
    // delivery aparece en entrega; sin procesado y sin entregables → total via
    // universo de fases (delivery está en 1 fase) → partial. Para forzar total=0
    // usamos un skill whitelisted que NO esté en skills_por_fase.
    const cfg = JSON.parse(JSON.stringify(FAKE_CONFIG));
    cfg.deliverable_notifications.skills.push('skill-huerfano');
    const root = makeRepo([], {});
    const r = getDeliverablesBySkill({ REPO_ROOT: root, config: cfg });
    const orphan = bySkill(r, 'skill-huerfano');
    assert.ok(orphan, 'el skill whitelisted debe aparecer aunque no tenga datos');
    assert.strictEqual(orphan.total, 0);
    assert.strictEqual(orphan.pct, null);
    assert.strictEqual(orphan.band, 'gris');
});

test('JSONL inexistente: no lanza, numeratorAvailable=false', () => {
    _resetCache();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpi-deliv-empty-'));
    let r;
    assert.doesNotThrow(() => { r = getDeliverablesBySkill({ REPO_ROOT: root, config: FAKE_CONFIG }); });
    assert.strictEqual(r.meta.numeratorAvailable, false);
    assert.ok(Array.isArray(r.skills));
});

test('orden por accionabilidad: peores primero (pct ascendente), sin-datos al final', () => {
    _resetCache();
    const root = makeRepo([
        { ts: '2026-06-03T10:00:00Z', issue: 700, fase: 'analisis', skill: 'guru', pipeline: 'definicion' },
        { ts: '2026-06-03T10:01:00Z', issue: 701, fase: 'criterios', skill: 'po', pipeline: 'definicion' },
    ], {
        'definicion/analisis': ['700.guru', '702.guru'],   // guru 1/2 = 50%
        'definicion/criterios': ['701.po'],                // po 1/1 = 100%
    });
    const r = getDeliverablesBySkill({ REPO_ROOT: root, config: FAKE_CONFIG });
    const guruIdx = r.skills.findIndex((s) => s.skill === 'guru');
    const poIdx = r.skills.findIndex((s) => s.skill === 'po');
    assert.ok(guruIdx < poIdx, 'guru (50%) debe ir antes que po (100%)');
});

test('_buildWhitelists arma skills y fases desde el config', () => {
    const { skillsWhitelist, faseWhitelist, faseUniverseBySkill } = _buildWhitelists(FAKE_CONFIG);
    assert.ok(skillsWhitelist.has('guru'));
    assert.ok(skillsWhitelist.has('pipeline-dev'));
    assert.ok(!skillsWhitelist.has('hacker-skill'));
    assert.ok(faseWhitelist.has('analisis'));
    assert.ok(faseWhitelist.has('verificacion'));
    // guru aparece en analisis (definicion) y validacion (desarrollo) → 2 fases.
    assert.strictEqual(faseUniverseBySkill.get('guru').size, 2);
});

test('config vacío → whitelists vacías → no agrega nada (fail-open)', () => {
    _resetCache();
    const root = makeRepo([
        { ts: '2026-06-03T10:00:00Z', issue: 800, fase: 'analisis', skill: 'guru', pipeline: 'definicion' },
    ], {});
    const r = getDeliverablesBySkill({ REPO_ROOT: root, config: {} });
    assert.strictEqual(r.skills.length, 0); // sin whitelist no se agrega nada
});
