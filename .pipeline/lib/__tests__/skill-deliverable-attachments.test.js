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
const { seedRepoRootConfig } = require('./_test-helpers');

// -----------------------------------------------------------------------------
// Fixtures: filesystem temporal con la estructura de directorios esperada
// -----------------------------------------------------------------------------

function mkTmpRoot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-attach-test-'));
    // #5172 — el sandbox hace de REPO ROOT, así que la config vive en
    // `<root>/.pipeline/`. Sin ella la validación de fase falla cerrado en vez
    // de degradar; el documento MÍNIMO deja el enum de fases en el mismo
    // FALLBACK que este fixture venía ejercitando.
    seedRepoRootConfig(dir);
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
        // #4584: los archivos siguen la convención `<skill>-<fase>-<issue>.<ext>`.
        writeFile(tmp.root, '.pipeline/assets/docs/3647/po-criterios-3647.md', '# X');
        writeFile(tmp.root, '.pipeline/assets/docs/3647/po-diseño-rechazado.exe', 'no');

        const res = helper.collectAttachmentsForSkill('po', 3647, 'criterios', { pipelineRoot: tmp.root });
        assert.equal(res.length, 1);
        assert.equal(res[0].type, 'document');
        assert.ok(res[0].path.endsWith('po-criterios-3647.md'));
    } finally {
        tmp.cleanup();
    }
});

test('guru recolecta análisis en docs/<issue>/', () => {
    const tmp = mkTmpRoot();
    try {
        writeFile(tmp.root, '.pipeline/assets/docs/3647/guru-analisis-3647.pdf', '%PDF');
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
    { skill: 'review', descriptor: 'review' },
    { skill: 'backend-dev', descriptor: 'dev' },
    { skill: 'android-dev', descriptor: 'dev' },
    { skill: 'web-dev', descriptor: 'dev' },
    { skill: 'pipeline-dev', descriptor: 'dev' },
];

for (const { skill, descriptor } of DOC_PROFILES) {
    test(`CA-1 — ${skill} recolecta 1 documento en docs/<issue>/`, () => {
        const tmp = mkTmpRoot();
        try {
            // #4584: filename con prefijo `<skill>-` (convención de write-deliverable).
            writeFile(tmp.root, `.pipeline/assets/docs/3928/${skill}-resumen.md`, '# resumen');
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
            writeFile(tmp.root, `.pipeline/assets/docs/3928/${skill}-informe.pdf`, '%PDF');
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
        writeFile(tmp.root, '.pipeline/assets/docs/3928/tester-cobertura.md', 'A');
        writeFile(tmp.root, '.pipeline/assets/docs/3929/tester-cobertura.md', 'B');
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

    // #4019 — `delivery` es notificable de TEXTO PURO: la notificación de
    // entrega anexa el avance de ola como sección de texto en el cuerpo del
    // mensaje (ver `buildWaveProgressSection` en deliverable-notify.js), no como
    // adjunto. Por eso no tiene entrada en SKILL_SOURCES y queda exento de la
    // invariante "notificable ⟹ tiene adjuntos" (a runtime `collectAttachments`
    // devuelve [] sin crash). Toda otra skill notificable sí debe poder recolectar.
    const TEXT_ONLY = new Set(['delivery']);

    for (const skill of dn.skills) {
        if (TEXT_ONLY.has(skill)) continue;
        assert.ok(catalogSkills.has(skill),
            `${skill} está en deliverable_notifications.skills pero falta en SKILL_SOURCES`);
    }
});

// -----------------------------------------------------------------------------
// #4255 — fase por artefacto (aditivo): manifest > filename > hint > null
// -----------------------------------------------------------------------------

test('#4255 — collector devuelve fase inferida del filename phase-scoped', () => {
    const tmp = mkTmpRoot();
    try {
        writeFile(tmp.root, '.pipeline/assets/docs/4255/po-criterios-4255.md', 'crit');
        const res = helper.collectAttachmentsForSkill('po', 4255, undefined, { pipelineRoot: tmp.root });
        assert.equal(res.length, 1);
        assert.equal(res[0].fase, 'criterios');
        // No rompe los campos existentes.
        assert.equal(res[0].type, 'document');
        assert.equal(res[0].descriptor, 'criterios');
    } finally {
        tmp.cleanup();
    }
});

test('#4255 — manifest tiene prioridad sobre la inferencia del filename', () => {
    const tmp = mkTmpRoot();
    try {
        const relPath = '.pipeline/assets/docs/4255/po-4255.md';
        writeFile(tmp.root, relPath, 'crit');
        // Índice apunta esa entry a fase "aprobacion".
        const { upsertDeliverableIndex } = require('../deliverable-index');
        upsertDeliverableIndex({
            issue: '4255', fase: 'aprobacion', agente: 'po', tipo: 'document',
            path: relPath, timestamp: '2026-07-01T10:00:00.000Z', pipelineRoot: tmp.root,
        });
        const res = helper.collectAttachmentsForSkill('po', 4255, 'criterios', { pipelineRoot: tmp.root });
        const entry = res.find((r) => r.path === relPath);
        assert.ok(entry, 'debe encontrar el artefacto');
        assert.equal(entry.fase, 'aprobacion', 'manifest gana sobre el hint');
    } finally {
        tmp.cleanup();
    }
});

test('#4255 — sin manifest ni patrón, cae al phase hint recibido', () => {
    const tmp = mkTmpRoot();
    try {
        // #4584: token `guru-` presente pero SIN el patrón `<skill>-<fase>-<issue>`
        // (no termina en `-321`), así inferFaseFromName devuelve null y cae al hint.
        writeFile(tmp.root, '.pipeline/assets/docs/321/guru-dossier.md', 'x');
        const res = helper.collectAttachmentsForSkill('guru', 321, 'analisis', { pipelineRoot: tmp.root });
        assert.equal(res.length, 1);
        assert.equal(res[0].fase, 'analisis');
    } finally {
        tmp.cleanup();
    }
});

test('#4255 — no rompe los 14 perfiles: cada uno recolecta sin tirar y expone fase', () => {
    const tmp = mkTmpRoot();
    try {
        const catalog = helper.getSkillSourcesCatalog();
        for (const skill of Object.keys(catalog)) {
            const res = helper.collectAttachmentsForSkill(skill, 4255, 'dev', { pipelineRoot: tmp.root });
            assert.ok(Array.isArray(res), `${skill} debe devolver array`);
        }
    } finally {
        tmp.cleanup();
    }
});

test('#4524 · CA-6 — una entry tipo:exception NO aparece en buildManifestFaseMap pero SÍ es visible en el store', () => {
    const tmp = mkTmpRoot();
    try {
        const { upsertDeliverableIndex, readDeliverableIndex } = require('../deliverable-index');
        // Excepción sin path (pipeline-dev::dev) + un document real con path.
        upsertDeliverableIndex({
            issue: '4524', fase: 'dev', agente: 'pipeline-dev', tipo: 'exception',
            motivo_no_aplica: 'issue de infra pura sin entregable físico',
            timestamp: '2026-07-07T10:00:00.000Z', pipelineRoot: tmp.root,
        });
        const relPath = '.pipeline/assets/docs/4524/guru-analisis-4524.md';
        writeFile(tmp.root, relPath, 'analisis');
        upsertDeliverableIndex({
            issue: '4524', fase: 'analisis', agente: 'guru', tipo: 'document',
            path: relPath, timestamp: '2026-07-07T10:00:00.000Z', pipelineRoot: tmp.root,
        });

        // La excepción NO genera adjunto: buildManifestFaseMap filtra por `path` string.
        const faseMap = helper.__internals.buildManifestFaseMap('4524', tmp.root);
        assert.ok(!faseMap.has(''), 'no debe mapear una entry sin path');
        assert.equal(faseMap.size, 1, 'sólo el document con path entra al manifest');
        assert.equal(faseMap.get(relPath.replace(/\\/g, '/')), 'analisis');

        // Pero SÍ es visible en el store (readDeliverableIndex).
        const read = readDeliverableIndex('4524', { pipelineRoot: tmp.root });
        const exception = read.entries.find((e) => e.tipo === 'exception');
        assert.ok(exception, 'la excepción debe seguir visible en el store');
        assert.equal(exception.agente, 'pipeline-dev');
        assert.equal(exception.fase, 'dev');
        assert.ok(exception.motivo_no_aplica.length > 0);
        assert.ok(!('path' in exception), 'la excepción no lleva path');
    } finally {
        tmp.cleanup();
    }
});

// -----------------------------------------------------------------------------
// #4507 — Las excepciones del índice (tipo:"exception", path:null) NO son
// adjuntos físicos: no aparecen en collectAttachmentsForSkill y no rompen la
// lectura del manifest.
// -----------------------------------------------------------------------------

test('#4507 — una excepción en el índice no se recolecta como adjunto físico', () => {
    const tmp = mkTmpRoot();
    try {
        const di = require('../deliverable-index');
        di.upsertDeliverableException({
            issue: '4507', fase: 'dev', agente: 'android-dev',
            motivo: 'Issue de solo-docs, sin cambios de app.',
            pipelineRoot: tmp.root, phaseEnum: ['dev'],
        });
        // No hay ningún .md/.pdf en disco → collect no debe inventar adjuntos.
        const res = helper.collectAttachmentsForSkill('android-dev', 4507, 'dev', { pipelineRoot: tmp.root });
        assert.deepEqual(res, []);
    } finally {
        tmp.cleanup();
    }
});

test('#4507 — excepción en el índice no rompe la lectura del manifest ni el mapeo fase', () => {
    const tmp = mkTmpRoot();
    try {
        const di = require('../deliverable-index');
        // Excepción en dev + artefacto físico real en analisis.
        di.upsertDeliverableException({
            issue: '4507', fase: 'dev', agente: 'android-dev',
            motivo: 'No aplica en dev.', pipelineRoot: tmp.root, phaseEnum: ['dev', 'analisis'],
        });
        writeFile(tmp.root, '.pipeline/assets/docs/4507/android-dev-analisis-4507.md', 'contenido');
        di.upsertDeliverableIndex({
            issue: '4507', fase: 'analisis', agente: 'android-dev', tipo: 'document',
            path: '.pipeline/assets/docs/4507/android-dev-analisis-4507.md', bytes: 9,
            pipelineRoot: tmp.root, phaseEnum: ['dev', 'analisis'],
        });
        const res = helper.collectAttachmentsForSkill('android-dev', 4507, 'dev', { pipelineRoot: tmp.root });
        // Sólo el artefacto físico real; la excepción (path:null) no aparece.
        assert.equal(res.length, 1);
        assert.equal(res[0].path, '.pipeline/assets/docs/4507/android-dev-analisis-4507.md');
        assert.equal(res[0].fase, 'analisis');
    } finally {
        tmp.cleanup();
    }
});

// -----------------------------------------------------------------------------
// #4514 — propagación del flag `sensible` desde el índice de entregables.
// El canal (deliverable-notify) lo usa para gatear el encolado a Drive público.
// -----------------------------------------------------------------------------

test('#4514 — collector propaga sensible:true del índice para security/verificacion', () => {
    const tmp = mkTmpRoot();
    try {
        const relPath = '.pipeline/assets/docs/4514/security-verificacion-4514.md';
        writeFile(tmp.root, relPath, '## Reporte de auditoría\n\n**Veredicto:** a corregir');
        const { upsertDeliverableIndex } = require('../deliverable-index');
        upsertDeliverableIndex({
            issue: '4514', fase: 'verificacion', agente: 'security', tipo: 'document',
            path: relPath, sensible: true, timestamp: '2026-07-07T12:00:00.000Z',
            pipelineRoot: tmp.root,
        });

        const res = helper.collectAttachmentsForSkill('security', 4514, 'verificacion', { pipelineRoot: tmp.root });
        const entry = res.find((r) => r.path === relPath);
        assert.ok(entry, 'debe encontrar el reporte');
        assert.equal(entry.sensible, true, 'el flag sensible del índice debe propagarse al adjunto');
    } finally {
        tmp.cleanup();
    }
});

// #4507 — regresión E2E writer→reader con REPO ROOT crudo. El test #4514 de
// arriba escribe y lee con `pipelineRoot: tmp.root` CRUDO (ambos aterrizan en
// <tmp.root>/deliverables/ y coinciden entre sí), por lo que nunca modela la
// traducción real: `writeDeliverable` persiste el índice bajo `.pipeline/deliverables/`
// (write-deliverable.js:236) mientras `collectAttachmentsForSkill` es invocado por
// pulpo con el REPO ROOT. Si `resolvePipelineDir` no normaliza repo-root → `.pipeline`,
// el lector cae en <repo>/deliverables/ (stray, inexistente) y el flag `sensible`
// se resuelve siempre `false` → gate #4514 anulado.
test('#4507 — writeDeliverable(repoRoot) + collectAttachments(repoRoot) propaga sensible:true', () => {
    const tmp = mkTmpRoot();
    try {
        // El repo root debe existir como dir para que write-deliverable resuelva paths.
        fs.mkdirSync(path.join(tmp.root, '.pipeline'), { recursive: true });
        const { writeDeliverable } = require('../write-deliverable');
        // Escritor REAL con el contrato público: repo root crudo (igual que en producción).
        writeDeliverable('security', 4507, {
            fase: 'verificacion', sensible: true,
            md: '## Reporte de auditoría\n\n**Veredicto:** a corregir',
            pipelineRoot: tmp.root,
        });

        // El índice canónico debe existir bajo .pipeline/deliverables/ y NO como stray.
        assert.ok(
            fs.existsSync(path.join(tmp.root, '.pipeline', 'deliverables', '4507.json')),
            'writeDeliverable debe indexar en .pipeline/deliverables/ (canónico)');
        assert.ok(
            !fs.existsSync(path.join(tmp.root, 'deliverables', '4507.json')),
            'no debe existir índice stray en <repo>/deliverables/');

        // Lector con REPO ROOT crudo (como lo invoca pulpo vía collectAttachmentsForSkill).
        const res = helper.collectAttachmentsForSkill('security', 4507, 'verificacion', { pipelineRoot: tmp.root });
        const entry = res.find((r) => r.path.endsWith('security-verificacion-4507.md'));
        assert.ok(entry, 'debe encontrar el reporte escrito por writeDeliverable');
        assert.equal(entry.sensible, true, 'el flag sensible del índice canónico debe propagarse al adjunto (gate #4514)');
        assert.equal(entry.fase, 'verificacion', 'la fase del manifest gana sobre la inferencia por filename (#4255)');
    } finally {
        tmp.cleanup();
    }
});

test('#4514 — sin índice, el adjunto expone sensible:false por default', () => {
    const tmp = mkTmpRoot();
    try {
        writeFile(tmp.root, '.pipeline/assets/docs/4514/security-4514.md', '# reporte');
        const res = helper.collectAttachmentsForSkill('security', 4514, 'verificacion', { pipelineRoot: tmp.root });
        assert.equal(res.length, 1);
        assert.equal(res[0].sensible, false, 'default no-sensible cuando el path no está indexado');
    } finally {
        tmp.cleanup();
    }
});

test('#4514 — buildManifestSensibleMap devuelve mapa vacío sin índice (best-effort)', () => {
    const tmp = mkTmpRoot();
    try {
        const map = helper.__internals.buildManifestSensibleMap('4514', tmp.root);
        assert.ok(map instanceof Map);
        assert.equal(map.size, 0);
    } finally {
        tmp.cleanup();
    }
});

// =============================================================================
// #4584 — Regresión: entregables NO se multiplican. Con varios skills dejando
// su `.md` en la MISMA carpeta `.pipeline/assets/docs/<issue>/`, cada notify
// resuelve SÓLO su propio archivo (token `<skill>-`), nunca los ajenos.
// Reproduce el escape real de #4523 (architect re-envió 4 archivos ajenos).
// =============================================================================

// Fixture exacto del incidente #4523: 4 entregables de fases previas conviven en
// la carpeta del issue antes de que corran las fases tardías.
function seedMultiSkillFolder(root, issue) {
    writeFile(root, `.pipeline/assets/docs/${issue}/build-build-${issue}.md`, '# build');
    writeFile(root, `.pipeline/assets/docs/${issue}/guru-validacion-${issue}.md`, '# guru');
    writeFile(root, `.pipeline/assets/docs/${issue}/security-verificacion-${issue}.md`, '# sec');
    writeFile(root, `.pipeline/assets/docs/${issue}/tester-verificacion-${issue}.md`, '# tester');
}

test('#4584 CA-3 — architect con 4 entregables ajenos en la carpeta resuelve 0 (entrega por comentario)', () => {
    const tmp = mkTmpRoot();
    try {
        seedMultiSkillFolder(tmp.root, 4523);
        // architect entrega su receta como comentario; no hay `architect-*.md`.
        const res = helper.collectAttachmentsForSkill('architect', 4523, 'aprobacion', { pipelineRoot: tmp.root });
        assert.deepEqual(res, [], `architect NO debe re-enviar entregables ajenos, vino ${JSON.stringify(res.map(r => r.path))}`);
    } finally {
        tmp.cleanup();
    }
});

test('#4584 CA-3 — architect con su propio archivo resuelve exactamente 1 (el suyo)', () => {
    const tmp = mkTmpRoot();
    try {
        seedMultiSkillFolder(tmp.root, 4523);
        // El fallback de pulpo.js escribe `architect-<fase>-<issue>.md`.
        writeFile(tmp.root, '.pipeline/assets/docs/4523/architect-aprobacion-4523.md', '# receta');
        const res = helper.collectAttachmentsForSkill('architect', 4523, 'aprobacion', { pipelineRoot: tmp.root });
        assert.equal(res.length, 1, `architect debe resolver SOLO su archivo, vino ${JSON.stringify(res.map(r => r.path))}`);
        assert.ok(res[0].path.endsWith('architect-aprobacion-4523.md'));
    } finally {
        tmp.cleanup();
    }
});

test('#4584 CA-3 — cada skill en una carpeta multi-skill resuelve exactamente su propio archivo', () => {
    const tmp = mkTmpRoot();
    try {
        seedMultiSkillFolder(tmp.root, 4523);
        const expected = {
            build: 'build-build-4523.md',
            guru: 'guru-validacion-4523.md',
            security: 'security-verificacion-4523.md',
            tester: 'tester-verificacion-4523.md',
        };
        for (const [skill, filename] of Object.entries(expected)) {
            const res = helper.collectAttachmentsForSkill(skill, 4523, 'verificacion', { pipelineRoot: tmp.root });
            assert.equal(res.length, 1, `${skill}: esperaba 1 adjunto propio, vino ${res.length} (${JSON.stringify(res.map(r => r.path))})`);
            assert.ok(res[0].path.endsWith(filename), `${skill}: esperaba ${filename}, vino ${res[0].path}`);
        }
    } finally {
        tmp.cleanup();
    }
});

test('#4584 CA-3 — los 4 devs comparten carpeta y NO se pisan entre sí (token completo <skill>-)', () => {
    const tmp = mkTmpRoot();
    try {
        const issue = 4600;
        writeFile(tmp.root, `.pipeline/assets/docs/${issue}/backend-dev-dev-${issue}.md`, '# be');
        writeFile(tmp.root, `.pipeline/assets/docs/${issue}/android-dev-dev-${issue}.md`, '# an');
        writeFile(tmp.root, `.pipeline/assets/docs/${issue}/web-dev-dev-${issue}.md`, '# we');
        writeFile(tmp.root, `.pipeline/assets/docs/${issue}/pipeline-dev-dev-${issue}.md`, '# pi');
        for (const skill of ['backend-dev', 'android-dev', 'web-dev', 'pipeline-dev']) {
            const res = helper.collectAttachmentsForSkill(skill, issue, 'dev', { pipelineRoot: tmp.root });
            assert.equal(res.length, 1, `${skill}: colisión entre devs, vino ${JSON.stringify(res.map(r => r.path))}`);
            assert.ok(res[0].path.endsWith(`${skill}-dev-${issue}.md`), `${skill}: vino ${res[0].path}`);
        }
    } finally {
        tmp.cleanup();
    }
});

test('#4584 — token corto no cae en falso positivo por substring (po vs qa-reporte)', () => {
    const tmp = mkTmpRoot();
    try {
        // `qa-reporte.pdf` contiene la subcadena "po" (rePOrte); el token `po-`
        // (con guión de cierre) evita el falso positivo.
        writeFile(tmp.root, '.pipeline/assets/docs/4601/qa-reporte.pdf', '%PDF');
        const res = helper.collectAttachmentsForSkill('po', 4601, 'aprobacion', { pipelineRoot: tmp.root });
        assert.deepEqual(res, [], `po NO debe agarrar el reporte de qa por substring, vino ${JSON.stringify(res.map(r => r.path))}`);
    } finally {
        tmp.cleanup();
    }
});
