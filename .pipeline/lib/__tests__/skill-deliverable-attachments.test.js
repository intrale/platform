// =============================================================================
// Tests skill-deliverable-attachments.js — Helper de adjuntos por skill (#3647)
//
// Cubre:
//   CA-1.1 — vacío => []
//   CA-1.2 — 2 PNGs ux issue-scoped => 2 paths
//   CA-1.3 — paths fuera de allowlist son responsabilidad del notifier; el
//            helper sólo se asegura de no inventar paths
//   CA-1.4 — issue-scoped estricto: PNGs de issue 3647 y 3648 en disco,
//            collectAttachmentsForSkill('ux', 3647, ...) devuelve sólo los 3647
//   CA-6  — regresión gate OFF: sin paths declarados ni archivos en disco,
//           collect devuelve [] (la notify text-only no rompe upstream)
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helper = require('../skill-deliverable-attachments');

// -----------------------------------------------------------------------------
// Fixtures: filesystem temporal con la estructura de directorios esperada
// -----------------------------------------------------------------------------

function mkTmpRoot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-attach-test-'));
    return {
        root: dir,
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
    };
}

function writeFile(root, relPath, contents) {
    const abs = path.join(root, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents || 'fixture');
}

// -----------------------------------------------------------------------------
// CA-1.1 — input vacío / inexistente
// -----------------------------------------------------------------------------

test('CA-1.1 — fixture vacío devuelve [] sin error', () => {
    const tmp = mkTmpRoot();
    try {
        const res = helper.collectAttachmentsForSkill('ux', 9999, 'criterios', { pipelineRoot: tmp.root });
        assert.deepEqual(res, []);
    } finally {
        tmp.cleanup();
    }
});

test('CA-1.1 — skill desconocido devuelve [] sin error', () => {
    const tmp = mkTmpRoot();
    try {
        writeFile(tmp.root, '.pipeline/assets/mockups/3647/dashboard-actual-01.png', 'PNG');
        const res = helper.collectAttachmentsForSkill('skill-inexistente', 3647, 'criterios', { pipelineRoot: tmp.root });
        assert.deepEqual(res, []);
    } finally {
        tmp.cleanup();
    }
});

test('CA-1.1 — issueNumber inválido devuelve []', () => {
    const tmp = mkTmpRoot();
    try {
        const res1 = helper.collectAttachmentsForSkill('ux', 'abc', 'criterios', { pipelineRoot: tmp.root });
        const res2 = helper.collectAttachmentsForSkill('ux', null, 'criterios', { pipelineRoot: tmp.root });
        const res3 = helper.collectAttachmentsForSkill('ux', 0, 'criterios', { pipelineRoot: tmp.root });
        assert.deepEqual(res1, []);
        assert.deepEqual(res2, []);
        assert.deepEqual(res3, []);
    } finally {
        tmp.cleanup();
    }
});

test('CA-1.1 — skill vacío devuelve []', () => {
    const tmp = mkTmpRoot();
    try {
        const res = helper.collectAttachmentsForSkill('', 3647, 'criterios', { pipelineRoot: tmp.root });
        assert.deepEqual(res, []);
    } finally {
        tmp.cleanup();
    }
});

// -----------------------------------------------------------------------------
// CA-1.2 — 2 PNGs ux issue-scoped en `.pipeline/assets/mockups/<issue>/`
// -----------------------------------------------------------------------------

test('CA-1.2 — ux con 2 PNGs en mockups/<issue>/ devuelve 2 paths', () => {
    const tmp = mkTmpRoot();
    try {
        writeFile(tmp.root, '.pipeline/assets/mockups/3647/dashboard-actual-01.png', 'PNG-actual');
        writeFile(tmp.root, '.pipeline/assets/mockups/3647/dashboard-esperado-01.png', 'PNG-esperado');

        const res = helper.collectAttachmentsForSkill('ux', 3647, 'criterios', { pipelineRoot: tmp.root });
        assert.equal(res.length, 2);
        assert.equal(res[0].type, 'image');
        assert.equal(res[1].type, 'image');

        // CA-UX (refinamiento): orden actual → esperado.
        assert.ok(res[0].path.includes('actual'), `esperaba actual primero, vino ${res[0].path}`);
        assert.ok(res[1].path.includes('esperado'), `esperaba esperado segundo, vino ${res[1].path}`);

        // Paths relativos al pipelineRoot (normalizados con /).
        for (const a of res) {
            assert.equal(typeof a.path, 'string');
            assert.ok(!path.isAbsolute(a.path), `path debe ser relativo: ${a.path}`);
            assert.ok(a.path.startsWith('.pipeline/assets/mockups/3647/'),
                `path debe ser issue-scoped: ${a.path}`);
        }
    } finally {
        tmp.cleanup();
    }
});

test('CA-1.2 — descriptors reflejan actual/esperado', () => {
    const tmp = mkTmpRoot();
    try {
        writeFile(tmp.root, '.pipeline/assets/mockups/3647/dashboard-actual-01.png', 'X');
        writeFile(tmp.root, '.pipeline/assets/mockups/3647/dashboard-esperado-01.png', 'X');
        const res = helper.collectAttachmentsForSkill('ux', 3647, 'criterios', { pipelineRoot: tmp.root });
        assert.equal(res[0].descriptor, 'actual');
        assert.equal(res[1].descriptor, 'esperado');
    } finally {
        tmp.cleanup();
    }
});

// -----------------------------------------------------------------------------
// CA-1.4 — Glob scoping issue-scoped obligatorio (defensa #3658)
// -----------------------------------------------------------------------------

test('CA-1.4 — con PNGs de 3647 y 3648 en disco, ux/3647 sólo devuelve los 3647', () => {
    const tmp = mkTmpRoot();
    try {
        // issue 3647 — los que esperamos
        writeFile(tmp.root, '.pipeline/assets/mockups/3647/dashboard-actual-01.png', 'a');
        writeFile(tmp.root, '.pipeline/assets/mockups/3647/dashboard-esperado-01.png', 'b');
        // issue 3648 — DEBEN ser ignorados
        writeFile(tmp.root, '.pipeline/assets/mockups/3648/dashboard-actual-01.png', 'c');
        writeFile(tmp.root, '.pipeline/assets/mockups/3648/dashboard-esperado-01.png', 'd');

        const res = helper.collectAttachmentsForSkill('ux', 3647, 'criterios', { pipelineRoot: tmp.root });
        assert.equal(res.length, 2);
        for (const a of res) {
            assert.ok(a.path.includes('3647'), `cross-contamination detectada: ${a.path}`);
            assert.ok(!a.path.includes('3648'), `cross-contamination detectada: ${a.path}`);
        }
    } finally {
        tmp.cleanup();
    }
});

test('CA-1.4 — convención plana legacy exige {issue} en filename', () => {
    const tmp = mkTmpRoot();
    try {
        // Estos archivos viven en `.pipeline/assets/mockups` (sin subdir issue)
        // pero el filename incluye 3647 → DEBE matchear.
        writeFile(tmp.root, '.pipeline/assets/mockups/3647-actual.png', 'a');
        // Este NO incluye `3647` en el filename → NO debe matchear.
        writeFile(tmp.root, '.pipeline/assets/mockups/random-other.png', 'b');
        // 3648 NO debe contaminar.
        writeFile(tmp.root, '.pipeline/assets/mockups/3648-actual.png', 'c');

        const res = helper.collectAttachmentsForSkill('ux', 3647, 'criterios', { pipelineRoot: tmp.root });
        assert.equal(res.length, 1);
        assert.ok(res[0].path.includes('3647-actual.png'));
    } finally {
        tmp.cleanup();
    }
});

test('CA-1.4 — sourceIsIssueScoped() valida el catálogo completo', () => {
    const catalog = helper.getSkillSourcesCatalog();
    for (const [skill, sources] of Object.entries(catalog)) {
        for (const source of sources) {
            assert.ok(helper.__internals.sourceIsIssueScoped(source),
                `source de ${skill} NO está issue-scoped: ${JSON.stringify(source)}`);
        }
    }
});

// -----------------------------------------------------------------------------
// Otros skills — po / guru / planner
// -----------------------------------------------------------------------------

test('po recolecta documentos en docs/<issue>/ con extensiones permitidas', () => {
    const tmp = mkTmpRoot();
    try {
        writeFile(tmp.root, '.pipeline/assets/docs/3647/criterios-refinados.md', '# X');
        writeFile(tmp.root, '.pipeline/assets/docs/3647/diseño-rechazado.exe', 'no');

        const res = helper.collectAttachmentsForSkill('po', 3647, 'criterios', { pipelineRoot: tmp.root });
        assert.equal(res.length, 1);
        assert.equal(res[0].type, 'document');
        assert.ok(res[0].path.endsWith('criterios-refinados.md'));
    } finally {
        tmp.cleanup();
    }
});

test('guru recolecta análisis en docs/<issue>/', () => {
    const tmp = mkTmpRoot();
    try {
        writeFile(tmp.root, '.pipeline/assets/docs/3647/analisis-tecnico.pdf', '%PDF');
        const res = helper.collectAttachmentsForSkill('guru', 3647, 'analisis', { pipelineRoot: tmp.root });
        assert.equal(res.length, 1);
        assert.equal(res[0].type, 'document');
        assert.equal(res[0].descriptor, 'analisis');
    } finally {
        tmp.cleanup();
    }
});

// -----------------------------------------------------------------------------
// CA-6 — regresión gate OFF: sin nada en disco, devuelve [] (no rompe)
// -----------------------------------------------------------------------------

test('CA-6 regresión — gate OFF (sin paths declarados ni archivos), devuelve []', () => {
    const tmp = mkTmpRoot();
    try {
        // Simula gate OFF: el agente /ux no generó nada, no hay subdir issue.
        // Otros archivos completamente unrelated en disco.
        writeFile(tmp.root, 'docs/unrelated/blob.txt', 'x');

        const res = helper.collectAttachmentsForSkill('ux', 3647, 'criterios', { pipelineRoot: tmp.root });
        assert.deepEqual(res, []);
    } finally {
        tmp.cleanup();
    }
});

// -----------------------------------------------------------------------------
// Cap defensivo HELPER_MAX_PER_INVOCATION
// -----------------------------------------------------------------------------

test('cap HELPER_MAX_PER_INVOCATION trunca a 12 si hay muchos PNGs', () => {
    const tmp = mkTmpRoot();
    try {
        for (let i = 0; i < 25; i++) {
            writeFile(tmp.root, `.pipeline/assets/mockups/3647/screen-${String(i).padStart(3, '0')}.png`, 'x');
        }
        const res = helper.collectAttachmentsForSkill('ux', 3647, 'criterios', { pipelineRoot: tmp.root });
        assert.equal(res.length, helper.__internals.HELPER_MAX_PER_INVOCATION);
    } finally {
        tmp.cleanup();
    }
});

// -----------------------------------------------------------------------------
// Dedup cross-source: si el mismo archivo matchea varios sources (improbable
// pero posible si futuras entradas se solapan), no se duplica.
// -----------------------------------------------------------------------------

test('dedup cross-source: mismo absPath nunca aparece duplicado', () => {
    const tmp = mkTmpRoot();
    try {
        // Este archivo matchea source[0] (dir issue-scoped) y source[2]
        // (filename incluye 3647). Sin dedup, vendría dos veces.
        writeFile(tmp.root, '.pipeline/assets/mockups/3647-actual.png', 'a');
        const res = helper.collectAttachmentsForSkill('ux', 3647, 'criterios', { pipelineRoot: tmp.root });
        const paths = res.map((a) => a.path);
        const unique = Array.from(new Set(paths));
        assert.equal(paths.length, unique.length, `dup paths: ${paths.join(', ')}`);
    } finally {
        tmp.cleanup();
    }
});

// -----------------------------------------------------------------------------
// Robustez: directorio existe pero contiene un subdirectorio con mismo nombre
// que un archivo — debe filtrarse (no es regular file).
// -----------------------------------------------------------------------------

test('subdirectorios dentro del root issue-scoped son ignorados', () => {
    const tmp = mkTmpRoot();
    try {
        writeFile(tmp.root, '.pipeline/assets/mockups/3647/dashboard-actual-01.png', 'a');
        // Subdirectorio que NO debe enumerarse como adjunto.
        fs.mkdirSync(path.join(tmp.root, '.pipeline/assets/mockups/3647/raw'), { recursive: true });
        fs.writeFileSync(path.join(tmp.root, '.pipeline/assets/mockups/3647/raw/buried.png'), 'no');

        const res = helper.collectAttachmentsForSkill('ux', 3647, 'criterios', { pipelineRoot: tmp.root });
        assert.equal(res.length, 1);
        assert.ok(res[0].path.endsWith('dashboard-actual-01.png'));
    } finally {
        tmp.cleanup();
    }
});

// -----------------------------------------------------------------------------
// Compat con paths absolutos no-issue-scoped: el caller (pulpo.js) no debe
// poder romper el helper pasando opts inválidos. El helper devuelve [] sin
// throwear.
// -----------------------------------------------------------------------------

test('opts.pipelineRoot inexistente devuelve [] sin throw', () => {
    const res = helper.collectAttachmentsForSkill('ux', 3647, 'criterios', {
        pipelineRoot: path.join(os.tmpdir(), 'definitivamente-no-existe-' + Date.now()),
    });
    assert.deepEqual(res, []);
});

test('opts ausente usa process.cwd() — no throw aunque no haya nada', () => {
    const res = helper.collectAttachmentsForSkill('ux', 99999999, 'criterios');
    assert.ok(Array.isArray(res));
});

// =============================================================================
// EP3-H2 (#3928) — Perfiles nuevos: qa, tester, security, build, architect,
// backend-dev, android-dev, web-dev, pipeline-dev.
// =============================================================================

// -----------------------------------------------------------------------------
// CA-1 — Recolección por perfil documental (8 skills) + reconfirmar qa.
// Cada skill con un .md issue-scoped en `.pipeline/assets/docs/<issue>/`
// devuelve exactamente 1 adjunto `type: 'document'`.
// -----------------------------------------------------------------------------

const DOC_PROFILES = [
    { skill: 'tester', descriptor: 'cobertura' },
    { skill: 'security', descriptor: 'seguridad' },
    { skill: 'build', descriptor: 'build' },
    { skill: 'architect', descriptor: 'receta' },
    { skill: 'backend-dev', descriptor: 'dev' },
    { skill: 'android-dev', descriptor: 'dev' },
    { skill: 'web-dev', descriptor: 'dev' },
    { skill: 'pipeline-dev', descriptor: 'dev' },
];

for (const { skill, descriptor } of DOC_PROFILES) {
    test(`CA-1 — ${skill} recolecta 1 documento en docs/<issue>/`, () => {
        const tmp = mkTmpRoot();
        try {
            writeFile(tmp.root, `.pipeline/assets/docs/3928/resumen-${skill}.md`, '# resumen');
            const res = helper.collectAttachmentsForSkill(skill, 3928, 'dev', { pipelineRoot: tmp.root });
            assert.equal(res.length, 1, `${skill}: esperaba 1 adjunto`);
            assert.equal(res[0].type, 'document');
            assert.equal(res[0].descriptor, descriptor);
            assert.ok(res[0].path.startsWith('.pipeline/assets/docs/3928/'),
                `${skill}: path debe ser issue-scoped, vino ${res[0].path}`);
        } finally {
            tmp.cleanup();
        }
    });

    test(`CA-1 — ${skill} también acepta .pdf`, () => {
        const tmp = mkTmpRoot();
        try {
            writeFile(tmp.root, `.pipeline/assets/docs/3928/informe-${skill}.pdf`, '%PDF');
            const res = helper.collectAttachmentsForSkill(skill, 3928, 'dev', { pipelineRoot: tmp.root });
            assert.equal(res.length, 1);
            assert.equal(res[0].type, 'document');
        } finally {
            tmp.cleanup();
        }
    });
}

// -----------------------------------------------------------------------------
// CA-2 — qa: entregable mixto video + document.
// -----------------------------------------------------------------------------

test('CA-2 — qa recolecta video en qa/evidence/<issue>/ y documento en docs/<issue>/', () => {
    const tmp = mkTmpRoot();
    try {
        writeFile(tmp.root, 'qa/evidence/3928/run-final.mp4', 'VIDEO');
        writeFile(tmp.root, '.pipeline/assets/docs/3928/qa-reporte.pdf', '%PDF');
        const res = helper.collectAttachmentsForSkill('qa', 3928, 'verificacion', { pipelineRoot: tmp.root });
        assert.equal(res.length, 2);
        const byType = Object.fromEntries(res.map((a) => [a.type, a]));
        assert.ok(byType.video, 'esperaba un adjunto video');
        assert.ok(byType.document, 'esperaba un adjunto document');
        assert.ok(byType.video.path.startsWith('qa/evidence/3928/'));
        assert.ok(byType.document.path.startsWith('.pipeline/assets/docs/3928/'));
    } finally {
        tmp.cleanup();
    }
});

test('CA-2 — qa con solo video devuelve solo el video', () => {
    const tmp = mkTmpRoot();
    try {
        writeFile(tmp.root, 'qa/evidence/3928/run.webm', 'VIDEO');
        const res = helper.collectAttachmentsForSkill('qa', 3928, 'verificacion', { pipelineRoot: tmp.root });
        assert.equal(res.length, 1);
        assert.equal(res[0].type, 'video');
    } finally {
        tmp.cleanup();
    }
});

// -----------------------------------------------------------------------------
// CA-6 (SEC-2) — Issue-scoping estricto: docs de issue A y B en disco,
// collect('tester', A) devuelve SOLO los de A (anti cross-issue disclosure).
// -----------------------------------------------------------------------------

test('CA-6 (SEC-2) — tester con docs de 3928 y 3929 devuelve solo los de 3928', () => {
    const tmp = mkTmpRoot();
    try {
        writeFile(tmp.root, '.pipeline/assets/docs/3928/cobertura.md', 'A');
        writeFile(tmp.root, '.pipeline/assets/docs/3929/cobertura.md', 'B');
        const res = helper.collectAttachmentsForSkill('tester', 3928, 'verificacion', { pipelineRoot: tmp.root });
        assert.equal(res.length, 1);
        assert.ok(res[0].path.includes('3928'), `cross-contamination: ${res[0].path}`);
        assert.ok(!res[0].path.includes('3929'), `cross-contamination: ${res[0].path}`);
    } finally {
        tmp.cleanup();
    }
});

// -----------------------------------------------------------------------------
// CA-7 (SEC-1) — Logs de build prohibidos en crudo: un .log en disco para
// `build` NO se devuelve (formats de build solo .md/.pdf).
// -----------------------------------------------------------------------------

test('CA-7 (SEC-1) — build NO adjunta .log crudo (riesgo de fuga de secretos)', () => {
    const tmp = mkTmpRoot();
    try {
        writeFile(tmp.root, '.pipeline/assets/docs/3928/build-gradle.log', 'AWS_SECRET=xxx');
        writeFile(tmp.root, '.pipeline/assets/docs/3928/build-resumen.md', '# build ok');
        const res = helper.collectAttachmentsForSkill('build', 3928, 'build', { pipelineRoot: tmp.root });
        assert.equal(res.length, 1, 'esperaba solo el .md, nunca el .log');
        assert.ok(res[0].path.endsWith('build-resumen.md'));
        assert.ok(!res.some((a) => a.path.endsWith('.log')), 'el .log NO debe adjuntarse');
    } finally {
        tmp.cleanup();
    }
});

// -----------------------------------------------------------------------------
// CA-5 — Coherencia de las 3 whitelists. Todo skill en SKILL_SOURCES (excepto
// legacy ux/cua) debe estar en deliverable_notifications.skills y en
// attachments_per_skill de config.yaml.
// -----------------------------------------------------------------------------

test('CA-5 — coherencia: SKILL_SOURCES ⊆ skills ∩ attachments_per_skill (config.yaml)', () => {
    const yaml = require('js-yaml');
    const cfgPath = path.join(__dirname, '..', '..', 'config.yaml');
    const cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8'));
    const dn = cfg.deliverable_notifications;
    const whitelistSkills = new Set(dn.skills);
    const apsSkills = new Set(Object.keys(dn.attachments_per_skill));

    const catalog = helper.getSkillSourcesCatalog();
    // `cua` es legacy (entregable interno del CUA, no notificable a Telegram por
    // las whitelists de deliverable_notifications). El resto debe estar sincronizado.
    const LEGACY = new Set(['cua']);

    for (const skill of Object.keys(catalog)) {
        if (LEGACY.has(skill)) continue;
        assert.ok(whitelistSkills.has(skill),
            `${skill} está en SKILL_SOURCES pero falta en deliverable_notifications.skills`);
        assert.ok(apsSkills.has(skill),
            `${skill} está en SKILL_SOURCES pero falta en attachments_per_skill`);
    }
});

test('CA-5 — coherencia inversa: todo skill notificable tiene source en SKILL_SOURCES', () => {
    const yaml = require('js-yaml');
    const cfgPath = path.join(__dirname, '..', '..', 'config.yaml');
    const cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8'));
    const dn = cfg.deliverable_notifications;
    const catalog = helper.getSkillSourcesCatalog();
    const catalogSkills = new Set(Object.keys(catalog));

    // Cada skill de la whitelist de notificación debe poder recolectar (tener
    // entrada en SKILL_SOURCES); sino sería "notificable pero sin adjuntos".
    for (const skill of dn.skills) {
        assert.ok(catalogSkills.has(skill),
            `${skill} está en deliverable_notifications.skills pero falta en SKILL_SOURCES`);
    }
});
