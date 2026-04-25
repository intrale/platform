// Tests del regex SAFE_IGNORE de skills-deterministicos/delivery.js
// (#2519 rev-1) — verifica que filtra archivos auto-generados del pipeline
// para que no se commiteen accidentalmente, sin afectar archivos del issue.
//
// Si la regex se actualiza en delivery.js, actualizá también este test.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Cargamos la regex extrayéndola del fuente. Esto evita duplicar la
// definición y nos asegura que el test cubre lo que realmente corre en
// producción. Si la convención del bloque cambia, el test falla loud.
function loadSafeIgnoreFromSource() {
    const srcPath = path.resolve(__dirname, '..', 'skills-deterministicos', 'delivery.js');
    const src = fs.readFileSync(srcPath, 'utf8');
    const match = src.match(/const SAFE_IGNORE = new RegExp\(([\s\S]*?)\);/);
    if (!match) throw new Error('SAFE_IGNORE no encontrado en delivery.js');
    // eslint-disable-next-line no-new-func
    return new Function(`return new RegExp(${match[1]});`)();
}

const SAFE_IGNORE = loadSafeIgnoreFromSource();

test('SAFE_IGNORE: filtra heartbeats de agentes', () => {
    assert.equal(SAFE_IGNORE.test('.claude/hooks/agent-2519.heartbeat'), true);
    assert.equal(SAFE_IGNORE.test('.claude/hooks/agent-1.heartbeat'), true);
    assert.equal(SAFE_IGNORE.test('.claude/hooks/agent-12345.heartbeat'), true);
});

test('SAFE_IGNORE: filtra agent-registry.json', () => {
    assert.equal(SAFE_IGNORE.test('.claude/hooks/agent-registry.json'), true);
});

test('SAFE_IGNORE: filtra activity-logger artifacts', () => {
    assert.equal(SAFE_IGNORE.test('.claude/hooks/activity-logger-last.json'), true);
    assert.equal(SAFE_IGNORE.test('.claude/hooks/activity-logger-zombie-check.json'), true);
    assert.equal(SAFE_IGNORE.test('.claude/hooks/activity-log.json'), true);
});

test('SAFE_IGNORE: filtra .pipeline/metrics-history.jsonl', () => {
    assert.equal(SAFE_IGNORE.test('.pipeline/metrics-history.jsonl'), true);
});

test('SAFE_IGNORE: filtra heartbeats sueltos en .pipeline', () => {
    assert.equal(SAFE_IGNORE.test('.pipeline/some-service.heartbeat'), true);
});

test('SAFE_IGNORE: filtra stackdumps en root', () => {
    assert.equal(SAFE_IGNORE.test('bash.exe.stackdump'), true);
});

test('SAFE_IGNORE: NO filtra fuentes del issue', () => {
    assert.equal(SAFE_IGNORE.test('qa/scripts/qa-video-share.js'), false);
    assert.equal(SAFE_IGNORE.test('.pipeline/pulpo.js'), false);
    assert.equal(SAFE_IGNORE.test('.pipeline/roles/qa.md'), false);
    assert.equal(SAFE_IGNORE.test('.pipeline/skills-deterministicos/delivery.js'), false);
    assert.equal(SAFE_IGNORE.test('app/composeApp/src/main/java/Foo.kt'), false);
    assert.equal(SAFE_IGNORE.test('users/src/main/resources/application.conf'), false);
});

test('SAFE_IGNORE: ancla al inicio de la ruta (no matchea en medio)', () => {
    // Un archivo legítimo cuyo nombre contenga "agent-registry.json" como sufijo
    // NO debe ser filtrado.
    assert.equal(SAFE_IGNORE.test('docs/agent-registry.json'), false);
    assert.equal(SAFE_IGNORE.test('users/src/main/resources/.claude/hooks/agent-registry.json'), false);
});
