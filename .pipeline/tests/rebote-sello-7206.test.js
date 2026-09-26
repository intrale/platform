// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const yaml = require('js-yaml');
const seal = require('../lib/qa-evidence-seal');
const gate = require('../lib/delivery/freshness-gate');
const detector = require('../lib/stuck-phase-detector');
const { stripProcedenciaAgente } = require('../lib/rebote-classifier');
const ISSUE = 999706;

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sello-7206-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['--no-replace-objects', '-C', cwd, ...args], {
    encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Prueba');
  git('config', 'user.email', 'test@intrale.test');
  git('config', 'commit.gpgsign', 'false');
  git('commit', '--allow-empty', '-qm', 'A');
  const head = git('rev-parse', 'HEAD');
  const pipelineDir = path.join(cwd, '.pipeline');
  const write = (state, data) => {
    const file = path.join(pipelineDir, 'desarrollo/verificacion', state, `${ISSUE}.qa`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, yaml.dump(data));
    return file;
  };
  const data = { resultado: 'aprobado' };
  assert.equal(seal.sealHeadOnly({ data, cwd, motivo: 'infra', modo: 'structural' }).sealed, true);
  write('procesado', data);
  const params = { cwd, pipelineDir, issue: ISSUE };
  return { cwd, git, head, pipelineDir, write, data, params };
}

test('recibos confiables consumen el rechazo; valores ajenos permanecen rechazados', () => {
  for (const value of ['barrido', 'reconciler', 'agente', '', undefined]) {
    const d = { skill: 'review', state: 'procesado', mtimeMs: 1,
      yaml: { resultado: 'rechazado', rebote_emitido_por: value } };
    const expected = ['barrido', 'reconciler'].includes(value) ? 'consumed' : 'rejected';
    assert.equal(detector.classifySkill('review', [d], new Set()).status, expected);
    const result = detector.analyzeStuckIssue({ requiredSkills: ['review'], deliverables: [d], nowMs: 1800000000000 });
    assert.equal(result.action, expected === 'consumed' ? 'none' : 'rebote');
    if (expected === 'consumed') {
      assert.equal(result.reason, 'rechazo-ya-rebotado');
      const fresh = { ...d, skill: 'security', yaml: { resultado: 'rechazado' } };
      assert.equal(detector.analyzeStuckIssue({ requiredSkills: ['review', 'security'],
        deliverables: [d, fresh], nowMs: 1800000000000 }).action, 'rebote');
    }
  }
});

test('el on-exit descarta los cuatro campos de recibo declarados por agentes', () => {
  const keys = ['rebote_emitido_por', 'rebote_emitido_ts', 'rebote_emitido_destino', 'rebote_emitido_numero'];
  const data = Object.fromEntries(keys.map(k => [k, 'barrido']));
  const result = stripProcedenciaAgente(data);
  for (const key of keys) { assert.equal(data[key], undefined); assert.ok(result.campos.includes(key)); }
});

test('commit vacío conserva frescura por árbol, audita ids y verifica el HEAD actual', t => {
  const f = fixture(t);
  f.git('commit', '--allow-empty', '-qm', 'B');
  const fresh = seal.checkVerdictFreshness(f.params);
  assert.equal(fresh.caduco, false);
  assert.equal(fresh.frescura, 'arbol-identico');
  assert.equal(fresh.tree_actual, fresh.tree_sellado);
  assert.notEqual(fresh.head_actual, fresh.head_sellado);
  const result = gate.evaluateFreshnessGate({ ...f.params, root: f.cwd });
  assert.equal(result.shaVerificado, fresh.head_actual);
  const audit = fs.readFileSync(path.join(f.pipelineDir, 'logs', 'audit-seal-caducidad.jsonl'), 'utf8');
  for (const value of [fresh.head_actual, fresh.head_sellado, fresh.tree_actual, 'aceptado-arbol-identico']) assert.ok(audit.includes(value));
});

test('contenido distinto y git replace no permiten reutilizar el sello', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.cwd, 'nuevo.txt'), 'cambio');
  f.git('add', 'nuevo.txt'); f.git('commit', '-qm', 'C');
  const current = f.git('rev-parse', 'HEAD');
  f.git('replace', f.head, current);
  const result = seal.checkVerdictFreshness(f.params);
  assert.equal(result.caduco, true);
  assert.equal(result.motivo, 'arbol-distinto');
  assert.notEqual(result.tree_actual, result.tree_sellado);
});

test('árbol idéntico sin auditoría durable mantiene cerrado el gate', t => {
  const f = fixture(t);
  f.git('commit', '--allow-empty', '-qm', 'B');
  fs.writeFileSync(path.join(f.pipelineDir, 'logs'), 'directorio bloqueado');
  assert.equal(seal.checkVerdictFreshness(f.params).caduco, true);
});

test('barrido estampa sólo el rechazo y conserva al hermano aprobado', () => {
  const source = fs.readFileSync(path.join(__dirname, '../pulpo.js'), 'utf8');
  const start = source.indexOf('            // #7206: el destino ya existe.');
  const end = source.indexOf('\n          }', start);
  assert.ok(start > 0 && end > start);
  const files = { review: { resultado: 'rechazado' }, po: { resultado: 'aprobado' } };
  require('node:vm').runInNewContext(source.slice(start, end), {
    archivos: [{ path: 'review' }, { path: 'po' }],
    readYamlSafe: p => files[p], writeYaml: (p, data) => { files[p] = data; },
    faseDestino: 'dev', nuevoReboteNumero: 2, issue: ISSUE, log: () => assert.fail('No debe fallar'),
  });
  assert.equal(files.review.rebote_emitido_por, 'barrido');
  assert.equal(files.review.rebote_emitido_numero, 2);
  assert.equal(files.review.rebote_emitido_destino, 'dev');
  assert.equal(files.po.rebote_emitido_por, undefined);
});

test('deriveTree rechaza refs libres, commits ausentes y tree ids', t => {
  const f = fixture(t);
  const derive = seal.__test__.deriveTree;
  for (const ref of ['HEAD', '-x', null, 'a'.repeat(40), f.data.sello.tree]) assert.throws(() => derive(f.cwd, ref));
  assert.equal(derive(f.cwd, f.head), f.data.sello.tree);
});

test('sello vigente re-ratifica sin contador, stamp de caducidad ni pending', t => {
  const f = fixture(t);
  f.write('listo', f.data);
  const result = seal.requeueVerification({ ...f.params, motivo: 'head-desincronizado' });
  assert.equal(result.reratificado, true);
  assert.equal(result.intentos, 0);
  assert.equal(result.escalado, false);
  const orders = result.ordenes.map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
  assert.ok(orders.some(x => x.label === 'qa:passed'));
  assert.ok(orders.every(x => !['qa:pending', 'needs-human'].includes(x.label)));
  const phase = path.join(f.pipelineDir, 'desarrollo/verificacion');
  assert.ok(!fs.existsSync(path.join(phase, `.${ISSUE}.seal-retries`)));
  assert.ok(fs.readFileSync(path.join(f.pipelineDir, 'logs', 'audit-seal-caducidad.jsonl'), 'utf8').includes('re-ratificado'));
});

test('vigencia es fail-closed y respeta la primera fuente sellada', t => {
  const f = fixture(t);
  assert.equal(seal.findVigentSealedVerdict({ ...f.params, issue: '../x' }).vigente, false);
  assert.equal(seal.findVigentSealedVerdict({ ...f.params, cwd: null }).vigente, false);
  assert.equal(seal.findVigentSealedVerdict({ ...f.params, cwd: path.join(f.cwd, 'ausente') }).vigente, false);
  f.write('listo', { resultado: 'aprobado', sello: { derivado_por: 'qa-evidence-seal', head: 'a'.repeat(40) } });
  assert.equal(seal.findVigentSealedVerdict(f.params).vigente, false);
  f.write('listo', { resultado: 'rechazado' });
  f.write('procesado', { resultado: 'aprobado', sello: { head: f.head } });
  assert.equal(seal.findVigentSealedVerdict(f.params).vigente, false);
  f.write('archivado', f.data);
  assert.equal(seal.findVigentSealedVerdict(f.params).vigente, true);
});

test('productor conserva generaciones crecientes e incluye issue y PR', t => {
  const f = fixture(t);
  const args = { ...f.params, ahora: '2026-09-12T20:00:00.000Z', prNumber: 999707 };
  const first = seal.reratifySealedVerdict(args);
  const second = seal.reratifySealedVerdict(args);
  assert.ok(path.basename(second.ordenes[0]) > path.basename(first.ordenes[0]));
  assert.equal(JSON.parse(fs.readFileSync(second.ordenes[1])).target, 'pr');
});

test('drenador real descarta la revocación vieja sin crear nuevos work-files', t => {
  const f = fixture(t);
  const helpers = require('../lib/__tests__/_test-helpers');
  helpers.seedPipelineConfig(f.pipelineDir);
  helpers.seedRealProductManifest(f.pipelineDir);
  const { withEnv } = require('../lib/test-helpers/with-env');
  // #7112 — pulpo.js resuelve el dir POR LLAMADA: el override tiene que seguir
  // vigente mientras corre el drenador, no sólo durante el require.
  withEnv({ PIPELINE_DIR_OVERRIDE: f.pipelineDir, PULPO_NO_AUTOSTART: '1' }, () => {
  const pulpo = require('../pulpo');
  const pending = path.join(f.pipelineDir, ...seal.REQUEUE_QUEUE_DIR);
  fs.mkdirSync(pending, { recursive: true });
  seal.requeueVerification({ pipelineDir: f.pipelineDir, issue: ISSUE, motivo: 'head-desincronizado' });
  const name = `${ISSUE}-requeue.json`;
  fs.writeFileSync(path.join(pending, name), JSON.stringify({ tipo: seal.REQUEUE_TYPE, issue: ISSUE, intentos: 1 }));
  // Falla real del append, sin afectar otras rutas: la orden debe sobrevivir.
  const auditPath = path.join(f.pipelineDir, 'logs', 'audit-seal-caducidad.jsonl');
  fs.unlinkSync(auditPath);
  fs.mkdirSync(auditPath);
  const originalOrder = fs.readFileSync(path.join(pending, name), 'utf8');
  pulpo.drenarRequeueVerificacion({ pipelines: { desarrollo: { skills_por_fase: { verificacion: ['qa'] } } } }, {
    comentar: () => assert.fail('No debe revocar'), resolveCwd: () => f.cwd, resolvePr: () => 999707,
  });
  assert.equal(fs.readFileSync(path.join(pending, name), 'utf8'), originalOrder);
  assert.ok(!fs.existsSync(path.join(path.dirname(pending), 'procesado', name)));
  assert.ok(!fs.existsSync(path.join(f.pipelineDir, 'desarrollo/verificacion/pendiente', `${ISSUE}.qa`)));
  const githubQueue = path.join(f.pipelineDir, 'servicios/github/pendiente');
  assert.ok(fs.readdirSync(githubQueue).every(n =>
    JSON.parse(fs.readFileSync(path.join(githubQueue, n))).label !== 'qa:passed'));
  fs.rmdirSync(auditPath);
  pulpo.drenarRequeueVerificacion({ pipelines: { desarrollo: { skills_por_fase: { verificacion: ['qa'] } } } }, {
    comentar: () => assert.fail('No debe revocar'), resolveCwd: () => f.cwd, resolvePr: () => 999707,
  });
  const done = path.join(path.dirname(pending), 'procesado', name);
  assert.equal(JSON.parse(fs.readFileSync(done)).descartada, 'sello-vigente');
  assert.ok(!fs.existsSync(path.join(f.pipelineDir, 'desarrollo/verificacion/pendiente', `${ISSUE}.qa`)));
  assert.ok(!fs.existsSync(path.join(pending, name)));
  const queue = path.join(f.pipelineDir, 'servicios/github/pendiente');
  const orders = fs.readdirSync(queue).map(n => JSON.parse(fs.readFileSync(path.join(queue, n))));
  assert.ok(orders.some(o => o.label === 'qa:passed' && o.target === 'issue'));
  assert.ok(orders.some(o => o.label === 'qa:passed' && o.target === 'pr'));
  const event = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    .find(entry => entry.evento === 're-ratificado');
  assert.equal(event.evento, 're-ratificado');
  assert.equal(event.fuente, path.join(f.pipelineDir, 'desarrollo/verificacion/procesado', `${ISSUE}.qa`));
  for (const key of ['head_sellado', 'head_actual', 'tree_sellado', 'tree_actual']) {
    assert.match(event[key], /^[a-f0-9]{40}$/);
  }
  }, { permitirApagarControl: ['PULPO_NO_AUTOSTART'], motivo: 'cargar pulpo.js como módulo para ejercitar el drenador sin arrancar el loop' });
});

test('productor no publica éxito sin auditoría y permite reintentar sin gastar contador', t => {
  const f = fixture(t);
  const blocked = path.join(f.pipelineDir, 'logs');
  fs.writeFileSync(blocked, 'no es directorio');
  const result = seal.requeueVerification({ ...f.params, motivo: 'head-desincronizado' });
  assert.equal(result.ok, false);
  assert.equal(result.reratificado, false);
  assert.equal(result.reintentable, true);
  assert.equal(result.motivo, 'auditoria-no-persistida');
  assert.equal(result.intentos, 0);
  assert.deepEqual(result.ordenes, []);
  assert.ok(!fs.existsSync(path.join(f.pipelineDir, 'servicios/github/pendiente')));
  assert.ok(!fs.existsSync(path.join(f.pipelineDir, 'desarrollo/verificacion', `.${ISSUE}.seal-retries`)));
  fs.unlinkSync(blocked);
  assert.equal(seal.requeueVerification(f.params).reratificado, true);
});
