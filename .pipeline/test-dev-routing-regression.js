'use strict';

process.env.PULPO_NO_AUTOSTART = '1';
process.env.PULPO_SKIP_AGENT_MODELS_VALIDATE = '1';
process.env.PULPO_SKIP_DATA_RESIDENCY_VALIDATE = '1';

const test = require('node:test');
const assert = require('node:assert/strict');

const pulpo = require('./pulpo');
const configResolver = require('./lib/config-resolver');

// #5174 (rebote rev-1) — Este test leía `config.yaml` a mano con
// `yaml.load(fs.readFileSync(...))`. Post-partición eso sólo ve el lado KERNEL,
// y las cuatro claves de ruteo (`dev_skill_mapping`, `dev_routing_priority`,
// `dev_skill_partitions`, `pipeline_scope_keywords`) viven del lado PRODUCTO
// (`pipeline.config.json`). El fail-closed de `requerirClaveDeProducto`
// (pulpo.js) hacía fallar los 6 tests — correctamente: el lector suelto había
// quedado fuera del punto único de lectura.
//
// La config se resuelve por `lib/config-resolver`, que es exactamente la fuente
// que usa el pulpo en producción, así que este canario vuelve a ejercitar el
// ruteo real (kernel + producto mergeados) y no una vista parcial.
//
// `pipelineDir` se fija explícito a `.pipeline/` para que el test no dependa de
// las env vars de raíz que puedan estar hidratadas en el proceso del agente.
const config = configResolver.resolve({ pipelineDir: __dirname });

function route(issue, labels, extraConfig, text) {
  pulpo._clearIssueRoutingCachesForTest();
  pulpo._setIssueInfoForTest(issue, { labels, text: text || '' });
  return pulpo.determinarDevSkill(issue, extraConfig || config);
}

test('CA-3: preserva ruteo Intrale por labels conocidos', () => {
  const cases = [
    { labels: ['area:backend'], expected: 'backend-dev' },
    { labels: ['app:client'], expected: 'android-dev' },
    { labels: ['app:business'], expected: 'android-dev' },
    { labels: ['app:delivery'], expected: 'android-dev' },
    { labels: ['area:web'], expected: 'web-dev' },
    { labels: ['area:pipeline'], expected: 'pipeline-dev' },
  ];

  cases.forEach((c, index) => {
    assert.equal(route(468600 + index, c.labels), c.expected, c.labels.join(','));
  });
});

test('CA-3: sin label conserva default Intrale backend-dev', () => {
  assert.equal(route(468620, []), 'backend-dev');
  assert.equal(config.dev_skill_mapping.default, 'backend-dev');
});

test('CA-3: prioridad Intrale sigue ganando cuando coexisten labels', () => {
  assert.equal(route(468621, ['app:client', 'area:infra']), 'backend-dev');
  assert.equal(route(468622, ['app:client', 'area:pipeline']), 'pipeline-dev');
});

test('CA-3: override area:infra con contenido de pipeline sigue yendo a pipeline-dev', () => {
  const text = 'Cambiar .pipeline/pulpo.js para ajustar el scheduler';
  assert.equal(route(468623, ['area:infra'], config, text), 'pipeline-dev');
});

test('CA-4: producto sin capability de stack cae al dev genérico', () => {
  const noStackConfig = {
    ...config,
    dev_skill_mapping: {
      ...config.dev_skill_mapping,
      default: 'backend-dev',
      generic_fallback: 'dev',
    },
    dev_skill_partitions: {
      backend: [],
      frontend: [],
      pipeline: [],
      generic: ['dev'],
    },
  };

  assert.equal(route(468624, [], noStackConfig), 'dev');
});

test('CA-4: fallback genérico no reemplaza labels de stack explícitos', () => {
  const noDefaultStackConfig = {
    ...config,
    dev_skill_mapping: {
      ...config.dev_skill_mapping,
      default: 'backend-dev',
      generic_fallback: 'dev',
    },
  };

  assert.equal(route(468625, ['area:backend'], noDefaultStackConfig), 'backend-dev');
});
