'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { seedProductManifest } = require('../../lib/__tests__/_test-helpers');

function tmpRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-deliverable-'));
    fs.mkdirSync(path.join(root, '.pipeline', 'logs'), { recursive: true });
    fs.mkdirSync(path.join(root, 'qa', 'artifacts'), { recursive: true });
    // #5172 — el sandbox modela un `.pipeline/` real: la lectura de config pasa
    // por `lib/config-resolver` y un dir sin `config.yaml` es fallo de lectura,
    // ya no degrada en silencio. `pipelines: {}` es config VÁLIDA sin fases
    // declaradas → enum vacío → `FALLBACK_PHASES` (el caso previo del fixture).
    fs.writeFileSync(path.join(root, '.pipeline', 'config.yaml'), 'pipelines: {}\n');
    // #5174 — el sandbox también siembra `pipeline.config.json`: post-partición
    // el resolver falla cerrado si el manifiesto de producto no está junto al
    // kernel. Fixture YAML mínimo escrito a mano ⇒ `seedProductManifest` en modo
    // auto-partición (slice vacío), NO el manifiesto real: `pipelines: {}` debe
    // seguir dando enum de fases vacío → `FALLBACK_PHASES`.
    seedProductManifest(path.join(root, '.pipeline'));
    return root;
}

function loadBuilder(root) {
    process.env.PIPELINE_REPO_ROOT = root;
    process.env.CLAUDE_PROJECT_DIR = root;
    delete process.env.PIPELINE_WORKTREE;
    delete require.cache[require.resolve('../build')];
    return require('../build');
}

test('build-deliverable - escribe md e indice issue -> fase build -> agente build', () => {
    const root = tmpRoot();
    const builder = loadBuilder(root);
    const report = builder.appendBuildDeliverableSections('## Build: EXITOSO', {
        issue: 4510,
        scope: 'module:app',
        status: 'verde',
        timestamp: '2026-07-06T12:00:00.000Z',
        artifacts: [{
            name: 'composeApp-client-debug.apk',
            type: 'apk',
            bytes: 123,
            sha256: 'a'.repeat(64),
            path: 'qa/artifacts/composeApp-client-debug.apk',
        }],
        logPath: '.pipeline/logs/4510-build.log',
    });

    const res = builder.materializeBuildDeliverable(4510, report, {
        pipelineRoot: root,
        timestamp: '2026-07-06T12:00:00.000Z',
    });

    assert.equal(res.indexed, true);
    assert.ok(res.path.replace(/\\/g, '/').endsWith('.pipeline/assets/docs/4510/build-build-4510.md'));
    const md = fs.readFileSync(res.path, 'utf8');
    assert.match(md, /Estado: verde/);
    assert.match(md, /SHA-256: a{64}/);
    assert.match(md, /Ruta relativa: qa\/artifacts\/composeApp-client-debug\.apk/);

    const idx = JSON.parse(fs.readFileSync(path.join(root, '.pipeline', 'deliverables', '4510.json'), 'utf8'));
    assert.equal(idx.entries.length, 1);
    assert.equal(idx.entries[0].fase, 'build');
    assert.equal(idx.entries[0].agente, 'build');
    assert.equal(idx.entries[0].path, '.pipeline/assets/docs/4510/build-build-4510.md');
});

test('build-deliverable - fallo temprano produce entregable rojo con diagnostico y log local', () => {
    const root = tmpRoot();
    const builder = loadBuilder(root);
    const report = builder.buildExceptionReport({
        issue: 4510,
        scope: 'smart',
        motivo: 'Excepcion en build.js: spawn EACCES',
        logPath: '.pipeline/logs/4510-build.log',
        timestamp: '2026-07-06T12:00:00.000Z',
    });

    const res = builder.materializeBuildDeliverable(4510, report, {
        pipelineRoot: root,
        timestamp: '2026-07-06T12:00:00.000Z',
    });
    const md = fs.readFileSync(res.path, 'utf8');

    assert.match(md, /## Build: FALLIDO/);
    assert.match(md, /Estado: rojo/);
    assert.match(md, /Clasificacion: pipeline_exception/);
    assert.match(md, /Log crudo local: \.pipeline\/logs\/4510-build\.log/);
    assert.match(md, /no se adjunta como entregable notificable/);
});

test('build-deliverable - redacta rutas absolutas locales antes de persistir', () => {
    const root = tmpRoot();
    const builder = loadBuilder(root);
    const report = [
        '## Build: FALLIDO',
        'Detalle: C:\\Workspaces\\Intrale\\platform\\app\\composeApp\\build.gradle.kts',
        'Otro detalle: /home/agent/platform/secret/path.txt',
    ].join('\n');

    const res = builder.materializeBuildDeliverable(4510, report, {
        pipelineRoot: root,
        timestamp: '2026-07-06T12:00:00.000Z',
    });
    const md = fs.readFileSync(res.path, 'utf8');

    assert.doesNotMatch(md, /C:\\Workspaces/);
    assert.doesNotMatch(md, /\/home\/agent/);
    assert.match(md, /\[ruta-local-redactada\]/);
});

test('build-deliverable - recolector de build publica md/pdf y excluye log crudo', () => {
    const root = tmpRoot();
    const builder = loadBuilder(root);
    const helper = require('../../lib/skill-deliverable-attachments');
    const docsDir = path.join(root, '.pipeline', 'assets', 'docs', '4510');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, 'build-gradle.log'), 'AWS_SECRET=xxx', 'utf8');

    builder.materializeBuildDeliverable(4510, '## Build: EXITOSO', {
        pipelineRoot: root,
        timestamp: '2026-07-06T12:00:00.000Z',
    });

    const attachments = helper.collectAttachmentsForSkill('build', 4510, 'build', { pipelineRoot: root });
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].type, 'document');
    assert.ok(attachments[0].path.endsWith('build-build-4510.md'));
    assert.equal(attachments.some((a) => a.path.endsWith('.log')), false);
});
