// =============================================================================
// Tests de `lib/infra-noise.js` (#6708).
//
// El módulo decide si el árbol sucio de un worktree es trabajo humano o ruido
// regenerable. Un falso "es ruido" BORRA trabajo irrecuperable, así que los
// casos negativos (lo que NO se puede clasificar como ruido) pesan tanto como
// los positivos.
//
// Los fixtures salen de una corrida real de `git status --porcelain` sobre los
// worktrees de la máquina el 2026-08-28, no de casos inventados.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const noise = require('../infra-noise');

// -----------------------------------------------------------------------------
// Ruido de infra: lo que la propia infra reescribe en cada corrida
// -----------------------------------------------------------------------------

test('el heartbeat del agente es ruido de infra', () => {
  assert.strictEqual(noise.isInfraNoisePath('.claude/hooks/agent-6150.heartbeat'), true);
  assert.strictEqual(noise.isInfraNoisePath('.claude/hooks/agent-4807.heartbeat.stale'), true);
});

test('la copia de .claude/ del worktree es ruido de infra', () => {
  assert.strictEqual(noise.isInfraNoisePath('.claude/hooks/activity-logger-last.json'), true);
  assert.strictEqual(noise.isInfraNoisePath('.claude/settings.local.json'), true);
});

test('la evidencia de QA es ruido de infra (regenerable corriendo QA)', () => {
  assert.strictEqual(noise.isInfraNoisePath('qa/evidence/6146/'), true);
  assert.strictEqual(noise.isInfraNoisePath('qa/evidence/5690/qa-5690-guion.txt'), true);
});

test('los directorios de estado del pipeline son ruido de infra', () => {
  assert.strictEqual(noise.isInfraNoisePath('.pipeline/state/label-mutations.jsonl'), true);
  assert.strictEqual(noise.isInfraNoisePath('.pipeline/ready/dashboard.ready'), true);
  assert.strictEqual(noise.isInfraNoisePath('.pipeline/logs/pulpo.log'), true);
  assert.strictEqual(noise.isInfraNoisePath('.pipeline/sessions/6708.json'), true);
  assert.strictEqual(noise.isInfraNoisePath('.pipeline/audit/disk-guard.jsonl'), true);
});

test('los archivos de las colas de fases son ruido de infra', () => {
  assert.strictEqual(noise.isInfraNoisePath('.pipeline/desarrollo/dev/pendiente/6708.pipeline-dev'), true);
  assert.strictEqual(noise.isInfraNoisePath('.pipeline/definicion/analisis/listo/1234.po'), true);
});

test('los archivos de estado sueltos en la raíz de .pipeline/ son ruido', () => {
  assert.strictEqual(noise.isInfraNoisePath('.pipeline/agent-registry.json'), true);
  assert.strictEqual(noise.isInfraNoisePath('.pipeline/qa-env-state.json'), true);
  assert.strictEqual(noise.isInfraNoisePath('.pipeline/.paused'), true);
});

test('los artefactos de build son ruido de infra en cualquier módulo', () => {
  assert.strictEqual(noise.isInfraNoisePath('build/libs/users-all.jar'), true);
  assert.strictEqual(noise.isInfraNoisePath('app/composeApp/build/outputs/apk/x.apk'), true);
  assert.strictEqual(noise.isInfraNoisePath('.gradle/configuration-cache/x.bin'), true);
  assert.strictEqual(noise.isInfraNoisePath('.kotlin/sessions/x'), true);
  assert.strictEqual(noise.isInfraNoisePath('kotlin-js-store/yarn.lock'), true);
  assert.strictEqual(noise.isInfraNoisePath('node_modules/foo/index.js'), true);
});

test('acepta separadores de Windows', () => {
  assert.strictEqual(noise.isInfraNoisePath('.claude\\hooks\\agent-1.heartbeat'), true);
  assert.strictEqual(noise.isInfraNoisePath('qa\\evidence\\6146\\x.png'), true);
});

// -----------------------------------------------------------------------------
// Trabajo real: lo que NUNCA puede clasificarse como ruido
// -----------------------------------------------------------------------------

test('el código de producto NO es ruido', () => {
  assert.strictEqual(noise.isInfraNoisePath('users/src/main/kotlin/ar/com/intrale/Modules.kt'), false);
  assert.strictEqual(noise.isInfraNoisePath('app/composeApp/src/commonMain/kotlin/Login.kt'), false);
});

test('el CÓDIGO FUENTE del pipeline NO es ruido, aunque viva bajo .pipeline/', () => {
  // Este es el caso que separa a este módulo del criterio de #6290, que filtra
  // `.pipeline/` entero: un agente `pipeline-dev` edita exactamente estos
  // archivos, y tratarlos como ruido borraría su trabajo sin pushear.
  assert.strictEqual(noise.isInfraNoisePath('.pipeline/pulpo.js'), false);
  assert.strictEqual(noise.isInfraNoisePath('.pipeline/lib/stuck-phase-reconciler.js'), false);
  assert.strictEqual(noise.isInfraNoisePath('.pipeline/lib/__tests__/foo.test.js'), false);
  assert.strictEqual(noise.isInfraNoisePath('.pipeline/roles/qa.md'), false);
  assert.strictEqual(noise.isInfraNoisePath('.pipeline/config.yaml'), false);
  assert.strictEqual(noise.isInfraNoisePath('.pipeline/skills-deterministicos/delivery.js'), false);
});

test('la documentación y los workflows de CI NO son ruido', () => {
  assert.strictEqual(noise.isInfraNoisePath('docs/pipeline/gestion-de-disco.md'), false);
  assert.strictEqual(noise.isInfraNoisePath('.github/workflows/pr-checks.yml'), false);
});

test('un directorio nuevo bajo .pipeline/ NO es ruido por default (fail-closed)', () => {
  // La lista de directorios de estado es una allowlist explícita. Que un
  // directorio desconocido quede PROTEGIDO es el fallo seguro.
  assert.strictEqual(noise.isInfraNoisePath('.pipeline/inventado-manana/x.json'), false);
});

// -----------------------------------------------------------------------------
// Parseo de porcelain
// -----------------------------------------------------------------------------

test('parsea el código y el path sin comerse el espacio del código XY', () => {
  assert.deepStrictEqual(noise.parsePorcelainLine(' M users/x.kt'), { code: ' M', filepath: 'users/x.kt' });
  assert.deepStrictEqual(noise.parsePorcelainLine('?? qa/evidence/1/'), { code: '??', filepath: 'qa/evidence/1/' });
  assert.deepStrictEqual(noise.parsePorcelainLine('A  .pipeline/lib/x.js'), { code: 'A ', filepath: '.pipeline/lib/x.js' });
});

test('en un rename toma el DESTINO, que es lo que existe en disco', () => {
  const p = noise.parsePorcelainLine('R  users/Viejo.kt -> users/Nuevo.kt');
  assert.strictEqual(p.filepath, 'users/Nuevo.kt');
});

test('desenvuelve los paths citados por core.quotePath', () => {
  const p = noise.parsePorcelainLine(' M "users/con espacio.kt"');
  assert.strictEqual(p.filepath, 'users/con espacio.kt');
});

test('una línea vacía o no parseable devuelve null', () => {
  assert.strictEqual(noise.parsePorcelainLine(''), null);
  assert.strictEqual(noise.parsePorcelainLine('   '), null);
  assert.strictEqual(noise.parsePorcelainLine(null), null);
});

test('una línea no parseable NO es ruido (fail-closed)', () => {
  assert.strictEqual(noise.isInfraNoiseEntry('basura'), false);
});

test('un conflicto de merge NUNCA es ruido, aunque el path lo sea', () => {
  // `UU .claude/...` sería ruido por path, pero un conflicto sin resolver es
  // trabajo humano a medio hacer: borrarlo es irrecuperable.
  assert.strictEqual(noise.isInfraNoisePath('.claude/hooks/x.json'), true);
  assert.strictEqual(noise.isInfraNoiseEntry('UU .claude/hooks/x.json'), false);
  assert.strictEqual(noise.isInfraNoiseEntry('AA qa/evidence/1/x.png'), false);
  assert.strictEqual(noise.isInfraNoiseEntry('DU .pipeline/logs/x.log'), false);
});

// -----------------------------------------------------------------------------
// El caso de aceptación del issue, con fixtures reales
// -----------------------------------------------------------------------------

test('worktree de issue cerrado con SOLO ruido de infra queda sin cambios relevantes', () => {
  // Fixture real: `platform.agent-6150-pipeline-dev`, issue cerrado.
  const porcelain = [
    ' M .claude/hooks/activity-logger-last.json',
    ' M .claude/hooks/activity-logger-zombie-check.json',
    '?? .claude/hooks/agent-6150.heartbeat',
    '?? qa/evidence/6150/',
  ].join('\n');
  assert.deepStrictEqual(noise.relevantChanges(porcelain), []);
});

test('worktree con código real sin pushear conserva sus cambios relevantes', () => {
  // Fixture real: `platform.agent-6118-pipeline-dev`, con trabajo de verdad.
  const porcelain = [
    ' M .claude/hooks/activity-logger-last.json',
    'M  .pipeline/lib/block-classifier.js',
    'A  .pipeline/lib/rejection-severity.js',
    'UU .pipeline/lib/operational-state-lint.allowlist.json',
    ' M .pipeline/roles/qa.md',
    ' M docs/pipeline/self-healing-fases-varadas.md',
    '?? .claude/hooks/agent-6118.heartbeat',
    '?? qa/evidence/6118/',
  ].join('\n');
  const relevant = noise.relevantChanges(porcelain);
  assert.deepStrictEqual(relevant, [
    '.pipeline/lib/block-classifier.js',
    '.pipeline/lib/rejection-severity.js',
    '.pipeline/lib/operational-state-lint.allowlist.json',
    '.pipeline/roles/qa.md',
    'docs/pipeline/self-healing-fases-varadas.md',
  ]);
});

test('worktree con un .kt modificado conserva el cambio', () => {
  // Fixture real: `platform.agent-1941-backend-dev`.
  const porcelain = [
    ' M users/src/main/kotlin/ar/com/intrale/Modules.kt',
    '?? users/src/main/kotlin/ar/com/intrale/ShoppingList.kt',
  ].join('\n');
  assert.strictEqual(noise.relevantChanges(porcelain).length, 2);
});

test('un árbol limpio no reporta cambios', () => {
  assert.deepStrictEqual(noise.relevantChanges(''), []);
  assert.deepStrictEqual(noise.relevantChanges('\n\n'), []);
});
