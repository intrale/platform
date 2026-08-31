// =============================================================================
// #6432 rev-3 — T14 (integración) y RS-3 (procedencia negativa).
//
// EL DEFECTO QUE ESTO CIERRA. La cadena entera de la historia —`delivery` deja
// un hint estructurado en su YAML → el barrido lo acepta si (y sólo si) la
// procedencia es la correcta → el circuit breaker acuña la precondición
// `merge_checks_race` en el `.reason.json` → el selector del brazo lo elige
// para el rescate— estaba MUERTA por una sola variable equivocada en el guard
// de procedencia SEC-9 (`pulpo.js:4601`): se comparaba `faseRechazo`
// (`pipelineConfig.fase_rechazo`, que vale `null` o `dev`) contra `'entrega'`,
// una condición insatisfacible. El hint se anulaba SIEMPRE.
//
// Toda la suite de unitarios estaba en verde igual, porque esos tests arman
// `motivosClasificados` a mano y llaman `classifyPrecondition` directo: nunca
// recorren la línea del guard. Por eso este test arranca del ARCHIVO EN DISCO y
// pasa por `brazoBarrido` real.
//
//   T14  — YAML de `delivery` en `desarrollo/entrega/listo/` con el hint
//          → `brazoBarrido` → `.reason.json` con `precondition.type ===
//          'merge_checks_race'` → `listBlockedIssues` lo normaliza → el selector
//          lo elige para reclamar.
//   RS-3 — el mismo hint, bien formado, emitido desde una procedencia que NO es
//          `delivery`/`entrega`/`desarrollo`/mismo-issue ⇒ se descarta a
//          `human_judgment`, fail-closed y silencioso. Sin estos negativos,
//          "arreglar" el guard borrando condiciones (en vez de corregir la
//          variable) reabre la superficie que #4748 SEC-1 vino a cerrar.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// --- Aislamiento TOTAL del filesystem, ANTES de requerir pulpo.js ------------
// `PIPELINE` se congela al cargar el módulo (pulpo.js:625): si el override se
// setea después del require, la constante ya capturó el `.pipeline` de
// producción y el test escribe markers y órdenes REALES.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mrace-e2e-6432-'));
const TMP_PIPE = path.join(TMP_ROOT, '.pipeline');

// `human-block` sólo barre estos dos pipelines (`human-block.js:39`), así que el
// negativo de "pipeline ≠ desarrollo" se monta sobre `definicion`: es el único
// otro pipeline cuyo marker el barrido puede encontrar.
const PIPELINES_FIXTURE = {
  desarrollo: ['entrega', 'dev'],
  definicion: ['entrega', 'dev'],
};
for (const [pipe, fases] of Object.entries(PIPELINES_FIXTURE)) {
  for (const fase of fases) {
    for (const estado of ['pendiente', 'trabajando', 'listo', 'procesado', 'archivado', 'bloqueado-humano']) {
      fs.mkdirSync(path.join(TMP_PIPE, pipe, fase, estado), { recursive: true });
    }
  }
}
fs.mkdirSync(path.join(TMP_PIPE, 'desarrollo', 'verificacion', 'listo'), { recursive: true });
for (const estado of ['pendiente', 'trabajando', 'procesado', 'archivado']) {
  fs.mkdirSync(path.join(TMP_PIPE, 'desarrollo', 'verificacion', estado), { recursive: true });
}
fs.mkdirSync(path.join(TMP_PIPE, 'servicios', 'github', 'pendiente'), { recursive: true });
fs.mkdirSync(path.join(TMP_PIPE, 'servicios', 'telegram', 'pendiente'), { recursive: true });
fs.mkdirSync(path.join(TMP_PIPE, 'logs'), { recursive: true });
fs.mkdirSync(path.join(TMP_ROOT, '.claude'), { recursive: true });
// `loadConfig()` corre dentro del barrido (resolver de cross-phase). Se le da la
// config REAL copiada al tmp: así el resolver valida el schema de verdad en vez
// de caer al camino de "config corrupta".
fs.copyFileSync(path.join(REPO_ROOT, '.pipeline', 'config.yaml'), path.join(TMP_PIPE, 'config.yaml'));
try {
  fs.copyFileSync(path.join(REPO_ROOT, 'pipeline.config.json'), path.join(TMP_ROOT, 'pipeline.config.json'));
} catch { /* opcional según el corte de migración */ }

process.env.PULPO_NO_AUTOSTART = '1';
process.env.PULPO_SKIP_AGENT_MODELS_VALIDATE = '1';
process.env.PIPELINE_DIR_OVERRIDE = TMP_PIPE;
process.env.PIPELINE_REPO_ROOT = TMP_ROOT;
process.env.CLAUDE_PROJECT_DIR = TMP_ROOT;

// HERMETICIDAD: el circuit breaker manda un audio TTS best-effort al escalar.
// En un test eso es una llamada de red por caso. Se stubea el módulo ANTES del
// require de pulpo.js para que la suite no dependa de `edge-tts` ni de Telegram;
// el camino de audio sigue siendo el mismo, sólo que no sale del proceso.
require.cache[require.resolve('../multimedia')] = {
  id: require.resolve('../multimedia'),
  filename: require.resolve('../multimedia'),
  loaded: true,
  exports: {
    textToSpeechWithMeta: async () => ({ error: 'stub de test: TTS deshabilitado' }),
    sendVoiceTelegram: async () => ({ ok: false, error: 'stub de test' }),
  },
};

const pulpo = require('../pulpo');
const humanBlock = require('../lib/human-block');
const core = require('../lib/brazo-desbloqueo-core');

const PR = 6500;
const SHA = 'd'.repeat(40);
const ISSUE = 6432;

// Config sintética: SÓLO las fases que este test barre. `brazoBarrido` recibe la
// config por argumento, así que el fixture no depende del `config.yaml` real
// (que igual está en disco para el `loadConfig()` interno).
function makeConfig() {
  return {
    circuit_breaker: { rebotes_max: 3 },
    pipelines: {
      desarrollo: {
        fases: ['entrega'],
        fase_rechazo: 'dev',
        skills_por_fase: { entrega: ['delivery'], dev: ['pipeline-dev'] },
      },
    },
  };
}

function resetFs() {
  for (const [pipe, fases] of Object.entries(PIPELINES_FIXTURE)) {
    for (const fase of [...fases, 'verificacion']) {
      for (const estado of ['pendiente', 'trabajando', 'listo', 'procesado', 'archivado', 'bloqueado-humano']) {
        const dir = path.join(TMP_PIPE, pipe, fase, estado);
        try { for (const f of fs.readdirSync(dir)) { try { fs.unlinkSync(path.join(dir, f)); } catch {} } } catch {}
      }
    }
  }
  for (const svc of ['github', 'telegram']) {
    const dir = path.join(TMP_PIPE, 'servicios', svc, 'pendiente');
    try { for (const f of fs.readdirSync(dir)) { try { fs.unlinkSync(path.join(dir, f)); } catch {} } } catch {}
  }
}

/**
 * Deja el issue al borde del circuit breaker: 3 rebotes de código previos en la
 * fase de rechazo. Es el estado en el que el pulpo escala a `needs-human` y, con
 * él, acuña la precondición.
 */
function seedRebotesAgotados(issue, pipeline = 'desarrollo') {
  const dir = path.join(TMP_PIPE, pipeline, 'dev', 'procesado');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${issue}.pipeline-dev`),
    `issue: ${issue}\nfase: dev\npipeline: ${pipeline}\nrebote: true\nrebote_tipo: codigo\nrebote_numero: 3\n`);
}

/** Escribe el YAML de un skill que rechazó, en `listo/` de una fase. */
function writeRechazo({ pipeline = 'desarrollo', fase = 'entrega', skill = 'delivery', issue = ISSUE, yamlIssue = null, hint = true }) {
  const dir = path.join(TMP_PIPE, pipeline, fase, 'listo');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${issue}.${skill}`);
  const lines = [
    `issue: ${yamlIssue == null ? issue : yamlIssue}`,
    `fase: ${fase}`,
    `pipeline: ${pipeline}`,
    'resultado: rechazado',
    'gravedad: grave',
    'motivo: "El check requerido todavia no reporto; la entrega no puede confirmar el merge."',
  ];
  if (hint) lines.push(`precondicion_merge_checks: {"pr":${PR},"head_sha":"${SHA}"}`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function reasonDelMarker(issue) {
  const marker = humanBlock.findBlockedMarker(issue);
  if (!marker) return null;
  const reasonFile = `${marker.file || marker.marker_path}.reason.json`;
  if (!fs.existsSync(reasonFile)) return null;
  return JSON.parse(fs.readFileSync(reasonFile, 'utf8'));
}

// -----------------------------------------------------------------------------
// T14 — la cadena completa, sobre el barrido real.
// -----------------------------------------------------------------------------
test('#6432 T14: delivery/entrega con hint válido ⇒ marker merge_checks_race y el selector lo reclama', () => {
  resetFs();
  seedRebotesAgotados(ISSUE);
  writeRechazo({});

  pulpo.brazoBarrido(makeConfig());

  // (1) El circuit breaker escaló y acuñó la precondición en el `.reason.json`.
  const reason = reasonDelMarker(ISSUE);
  assert.ok(reason, 'el circuit breaker tiene que haber dejado marker + reason');
  assert.deepEqual(reason.precondition, { type: 'merge_checks_race', pr: PR, head_sha: SHA },
    'la precondición nace del hint del YAML de delivery, no de human_judgment');

  // (2) `listBlockedIssues` la normaliza igual (es lo que consume el brazo).
  const markers = humanBlock.listBlockedIssues().filter(m => Number(m.issue) === ISSUE);
  assert.equal(markers.length, 1);
  assert.deepEqual(markers[0].precondition, { type: 'merge_checks_race', pr: PR, head_sha: SHA });

  // (3) El selector del brazo lo elige para reclamar (mismos gates, PR sano).
  const { toReclaim, toDegrade } = core.selectMergeRaceBlocksToReclaim({
    markers,
    prStates: {
      [PR]: {
        number: PR, url: `https://github.com/intrale/platform/pull/${PR}`,
        state: 'OPEN', mergeStateStatus: 'CLEAN', headRefOid: SHA,
        headRefName: `agent/${ISSUE}-pipeline-dev`, isCrossRepository: false,
        headRepositoryOwner: { login: 'intrale' }, labels: ['qa:passed'],
      },
    },
    ledger: {},
    maxAttempts: 3,
  });
  assert.equal(toDegrade.length, 0);
  assert.equal(toReclaim.length, 1, 'el marker acuñado por el barrido es reclamable');
  assert.equal(Number(toReclaim[0].issue), ISSUE);
});

// -----------------------------------------------------------------------------
// RS-3 — procedencia negativa. Las CUATRO condiciones son conjuntivas: cada
// negativo tiene que caer a `human_judgment`, en silencio.
// -----------------------------------------------------------------------------
const NEGATIVOS = [
  {
    nombre: 'skill ≠ delivery (el hint de otro agente no vale)',
    seed: () => writeRechazo({ skill: 'review' }),
    config: () => {
      const c = makeConfig();
      c.pipelines.desarrollo.skills_por_fase.entrega = ['review'];
      return c;
    },
  },
  {
    nombre: 'fase ≠ entrega (delivery no corre en verificacion)',
    seed: () => writeRechazo({ fase: 'verificacion' }),
    config: () => {
      const c = makeConfig();
      c.pipelines.desarrollo.fases = ['verificacion'];
      c.pipelines.desarrollo.skills_por_fase.verificacion = ['delivery'];
      return c;
    },
  },
  {
    nombre: 'pipeline ≠ desarrollo',
    seed: () => { seedRebotesAgotados(ISSUE, 'definicion'); return writeRechazo({ pipeline: 'definicion' }); },
    config: () => ({
      circuit_breaker: { rebotes_max: 3 },
      pipelines: {
        definicion: {
          fases: ['entrega'], fase_rechazo: 'dev',
          skills_por_fase: { entrega: ['delivery'], dev: ['pipeline-dev'] },
        },
      },
    }),
  },
  {
    nombre: 'issue del YAML ≠ issue del ciclo',
    seed: () => writeRechazo({ yamlIssue: 9999 }),
    config: makeConfig,
  },
];

for (const caso of NEGATIVOS) {
  test(`#6432 RS-3: ${caso.nombre} ⇒ human_judgment, sin acuñar merge_checks_race`, () => {
    resetFs();
    seedRebotesAgotados(ISSUE);
    caso.seed();

    pulpo.brazoBarrido(caso.config());

    const reason = reasonDelMarker(ISSUE);
    assert.ok(reason, 'el circuit breaker escala igual: lo que cambia es la precondición');
    assert.deepEqual(reason.precondition, { type: 'human_judgment' },
      'un hint de procedencia ajena NO puede acuñar merge_checks_race');

    const markers = humanBlock.listBlockedIssues().filter(m => Number(m.issue) === ISSUE);
    const { toReclaim, toDegrade } = core.selectMergeRaceBlocksToReclaim({
      markers, prStates: {}, ledger: {}, maxAttempts: 3,
    });
    assert.equal(toReclaim.length, 0, 'nada que reclamar: el rescate automático no se abre');
    assert.equal(toDegrade.length, 0);
  });
}

test('#6432 RS-3: sin hint en el YAML el marker sigue naciendo human_judgment', () => {
  resetFs();
  seedRebotesAgotados(ISSUE);
  writeRechazo({ hint: false });

  pulpo.brazoBarrido(makeConfig());

  const reason = reasonDelMarker(ISSUE);
  assert.ok(reason);
  assert.deepEqual(reason.precondition, { type: 'human_judgment' });
});
