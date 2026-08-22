// =============================================================================
// Tests pr-info-fetcher.js — Issue #3030
//
// Cubre:
//   - CA-11 (security): validación de entrada — issue no numérico → null,
//     SIN invocar gh.
//   - CA-12 (security): args como array, no shell-string. Verificamos que el
//     runner recibe un array de argumentos sin caracteres de shell raros.
//   - CA-13 (security): JSON malformado → fallback `{ error: true }` sin crash.
//   - CA-14 (security): timeout pasado a spawnSync; error.code === 'ETIMEDOUT'
//     o status null → fallback `{ error: true }`.
//   - Selección del PR más reciente cuando hay varios candidatos por branch.
//   - Filtro estricto por prefix de branch para evitar falsos positivos.
//   - Sin matches → null.
//   - Exit code != 0 → fallback con error.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { fetchPrInfoForIssue, fetchPrInfoForIssueAsync, resolvePrForGateWrite, __FIELDS } = require('../pr-info-fetcher');

/** Crea un runner falso con los efectos solicitados y registra todas las invocaciones. */
function makeRunner(fakeResult) {
  const calls = [];
  const runner = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (typeof fakeResult === 'function') return fakeResult(cmd, args, opts);
    return fakeResult;
  };
  runner.calls = calls;
  return runner;
}

// -- CA-11: validación de entrada --------------------------------------------

test('CA-11 | issue no numérico → null y NO invoca gh', () => {
  const runner = makeRunner({ status: 0, stdout: '[]' });
  for (const bogus of ['abc', '0', '-1', '1.5', '', null, undefined, NaN, '3030; rm -rf /']) {
    const out = fetchPrInfoForIssue(bogus, { runner, ghBin: 'fake-gh' });
    assert.equal(out, null, `bogus=${JSON.stringify(bogus)}`);
  }
  assert.equal(runner.calls.length, 0, 'gh runner no debe ser invocado para entradas inválidas');
});

test('CA-11 | issue numérico positivo invoca gh', () => {
  const runner = makeRunner({ status: 0, stdout: '[]' });
  fetchPrInfoForIssue(3030, { runner, ghBin: 'fake-gh' });
  assert.equal(runner.calls.length, 1);
});

// -- CA-12: argumentos como array, no shell-string ----------------------------

test('CA-12 | args se pasan como array al runner (no como string interpolada)', () => {
  const runner = makeRunner({ status: 0, stdout: '[]' });
  fetchPrInfoForIssue(3030, { runner, ghBin: 'fake-gh', cwd: '/tmp' });

  const call = runner.calls[0];
  assert.equal(call.cmd, 'fake-gh');
  assert.ok(Array.isArray(call.args), 'args debe ser array');
  assert.deepEqual(call.args.slice(0, 2), ['pr', 'list']);
  // Debe contener --search head:agent/3030-
  const searchIdx = call.args.indexOf('--search');
  assert.ok(searchIdx >= 0);
  assert.equal(call.args[searchIdx + 1], 'head:agent/3030-');
  // No hay caracteres de shell sin escapar (chequeo conservador)
  for (const a of call.args) {
    assert.equal(typeof a, 'string');
    assert.doesNotMatch(a, /[;&|`$]/, `arg "${a}" no debe contener metacharacters de shell`);
  }
});

test('CA-12 | timeout y windowsHide pasan a spawnSync', () => {
  const runner = makeRunner({ status: 0, stdout: '[]' });
  fetchPrInfoForIssue(3030, { runner, timeoutMs: 7777, cwd: '/work' });
  const call = runner.calls[0];
  assert.equal(call.opts.timeout, 7777);
  assert.equal(call.opts.windowsHide, true);
  assert.equal(call.opts.cwd, '/work');
  assert.equal(call.opts.encoding, 'utf8');
});

// -- CA-13: JSON malformado --------------------------------------------------

test('CA-13 | JSON malformado → fallback con error sin crash', () => {
  const runner = makeRunner({ status: 0, stdout: '{ this is not json' });
  const out = fetchPrInfoForIssue(3030, { runner });
  assert.equal(out.error, true);
  assert.equal(out.reason, 'json_parse_failed');
});

test('CA-13 | stdout vacío → null (lista vacía interpretada)', () => {
  const runner = makeRunner({ status: 0, stdout: '' });
  const out = fetchPrInfoForIssue(3030, { runner });
  assert.equal(out, null);
});

// -- CA-14: timeout / errores de proceso -------------------------------------

test('CA-14 | spawnSync devuelve error ETIMEDOUT → fallback', () => {
  const runner = makeRunner({
    status: null,
    stdout: '',
    stderr: '',
    error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }),
  });
  const out = fetchPrInfoForIssue(3030, { runner });
  assert.equal(out.error, true);
  assert.equal(out.reason, 'spawn_error');
});

test('CA-14 | spawnSync arroja excepción → fallback (no propaga)', () => {
  const runner = makeRunner(() => { throw new Error('spawn boom'); });
  const out = fetchPrInfoForIssue(3030, { runner });
  assert.equal(out.error, true);
  assert.equal(out.reason, 'spawn_failed');
});

test('resolvedor gate incluye campos de seguridad y resuelve un único PR estricto', () => {
  for (const field of ['labels', 'isCrossRepository', 'headRepositoryOwner']) assert.match(__FIELDS, new RegExp(field));
  const runner = makeRunner({ status: 0, stdout: JSON.stringify([{
    number: 5519, headRefName: 'agent/5400-android-dev', state: 'OPEN', labels: [{ name: 'needs-definition' }],
    isCrossRepository: false, headRepositoryOwner: { login: 'intrale' },
  }]) });
  assert.deepEqual(resolvePrForGateWrite(5400, { runner }), { ok: true, pr: {
    number: 5519, headRefName: 'agent/5400-android-dev', state: 'OPEN', labels: ['needs-definition'],
  } });
});

test('resolvedor gate falla cerrado ante ausencia, ambigüedad, fork y consulta fallida', () => {
  const pr = (number, branch, state = 'OPEN') => ({ number, headRefName: branch, state, labels: [],
    isCrossRepository: false, headRepositoryOwner: { login: 'intrale' }, body: 'Closes #5400' });
  assert.equal(resolvePrForGateWrite(5400, { runner: makeRunner({ status: 0, stdout: JSON.stringify([pr(1, 'feature/ajena')]) }) }).reason, 'no_strict_match');
  assert.equal(resolvePrForGateWrite(5400, { runner: makeRunner({ status: 0, stdout: JSON.stringify([pr(1, 'agent/5400-a'), pr(2, 'agent/5400-b')]) }) }).reason, 'ambiguous_match');
  assert.equal(resolvePrForGateWrite(5400, { runner: makeRunner({ status: 0, stdout: JSON.stringify([{ ...pr(3, 'agent/5400-a'), isCrossRepository: true }]) }) }).reason, 'cross_repository');
  assert.equal(resolvePrForGateWrite(5400, { runner: makeRunner({ status: 1, stderr: 'falló' }) }).reason, 'fetch_failed');
});

test('resolvedor gate desambigua solamente cuando existe un único PR abierto', () => {
  const base = { labels: [], isCrossRepository: false, headRepositoryOwner: { login: 'intrale' } };
  const runner = makeRunner({ status: 0, stdout: JSON.stringify([
    { ...base, number: 10, headRefName: 'agent/5400-old', state: 'MERGED' },
    { ...base, number: 11, headRefName: 'agent/5400-current', state: 'OPEN' },
  ]) });
  assert.equal(resolvePrForGateWrite(5400, { runner }).pr.number, 11);
});

test('CA-14 | exit code != 0 → fallback con stderr truncado', () => {
  const runner = makeRunner({
    status: 1,
    stdout: '',
    stderr: 'authentication required'.repeat(50),
  });
  const out = fetchPrInfoForIssue(3030, { runner });
  assert.equal(out.error, true);
  assert.equal(out.reason, 'non_zero_exit');
  assert.equal(out.exit, 1);
  assert.ok(out.stderr.length <= 200, 'stderr no debe filtrar más de 200 chars');
});

// -- Selección del candidato --------------------------------------------------

test('Selección | con varios PRs cuyo branch matchea, elige el más recientemente actualizado', () => {
  const stdout = JSON.stringify([
    { number: 100, headRefName: 'agent/3030-pipeline-dev', state: 'CLOSED', updatedAt: '2026-05-01T10:00:00Z', url: 'https://x/100' },
    { number: 101, headRefName: 'agent/3030-pipeline-dev', state: 'MERGED', updatedAt: '2026-05-06T22:00:00Z', url: 'https://x/101' },
    { number: 102, headRefName: 'agent/3030-pipeline-dev', state: 'OPEN', updatedAt: '2026-05-05T10:00:00Z', url: 'https://x/102' },
  ]);
  const runner = makeRunner({ status: 0, stdout });
  const out = fetchPrInfoForIssue(3030, { runner });
  assert.equal(out.number, 101);
  assert.equal(out.state, 'MERGED');
});

test('Filtro estricto | descarta PRs cuyo branch NO empieza con agent/<n>-', () => {
  const stdout = JSON.stringify([
    { number: 200, headRefName: 'feature/random', state: 'OPEN', updatedAt: '2026-05-06T22:00:00Z' },
    { number: 201, headRefName: 'agent/3030-pipeline-dev', state: 'OPEN', updatedAt: '2026-05-06T20:00:00Z' },
  ]);
  const runner = makeRunner({ status: 0, stdout });
  const out = fetchPrInfoForIssue(3030, { runner });
  assert.equal(out.number, 201, 'debe quedarse con el match estricto aunque sea más viejo');
});

test('Sin matches | array vacío → null', () => {
  const runner = makeRunner({ status: 0, stdout: '[]' });
  assert.equal(fetchPrInfoForIssue(3030, { runner }), null);
});

// =============================================================================
// #4133 — fetchPrInfoForIssueAsync (versión NO bloqueante, execFile)
//
// Misma lógica/contrato que la versión sync, pero devuelve Promise y no clava el
// event loop. Es la pata que faltaba migrar tras #4128: el path sync envuelto en
// Promise.then NO era async → spawnSync bloqueaba /api/health → rollback falso.
// Usamos el asyncRunner inyectable (firma async tipo-spawnSync) para evitar gh.
// =============================================================================

/** Crea un asyncRunner falso que resuelve `fakeResult` y registra invocaciones. */
function makeAsyncRunner(fakeResult) {
  const calls = [];
  const runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (typeof fakeResult === 'function') return fakeResult(cmd, args, opts);
    return fakeResult;
  };
  runner.calls = calls;
  return runner;
}

test('async | CA-11 — issue no numérico → Promise<null> y NO invoca gh', async () => {
  const asyncRunner = makeAsyncRunner({ status: 0, stdout: '[]' });
  for (const bogus of ['abc', '0', '-1', '', null, undefined, NaN, '3030; rm -rf /']) {
    const out = await fetchPrInfoForIssueAsync(bogus, { asyncRunner, ghBin: 'fake-gh' });
    assert.equal(out, null, `bogus=${JSON.stringify(bogus)}`);
  }
  assert.equal(asyncRunner.calls.length, 0, 'gh no debe invocarse para entradas inválidas');
});

test('async | devuelve una Promise (no bloquea el llamador)', () => {
  const asyncRunner = makeAsyncRunner({ status: 0, stdout: '[]' });
  const p = fetchPrInfoForIssueAsync(3030, { asyncRunner });
  assert.ok(p && typeof p.then === 'function', 'debe retornar un thenable');
  return p;
});

test('async | args como array (sin shell-string) y mismo search prefix', async () => {
  const asyncRunner = makeAsyncRunner({ status: 0, stdout: '[]' });
  await fetchPrInfoForIssueAsync(3030, { asyncRunner, ghBin: 'fake-gh' });
  const call = asyncRunner.calls[0];
  assert.equal(call.cmd, 'fake-gh');
  assert.ok(Array.isArray(call.args), 'args debe ser array');
  const searchIdx = call.args.indexOf('--search');
  assert.equal(call.args[searchIdx + 1], 'head:agent/3030-');
  for (const a of call.args) assert.doesNotMatch(a, /[;&|`$]/);
});

test('async | selección del PR más reciente (mismo contrato que sync)', async () => {
  const stdout = JSON.stringify([
    { number: 100, headRefName: 'agent/3030-x', state: 'CLOSED', updatedAt: '2026-05-01T10:00:00Z', url: 'https://x/100' },
    { number: 101, headRefName: 'agent/3030-x', state: 'MERGED', updatedAt: '2026-05-06T22:00:00Z', url: 'https://x/101' },
  ]);
  const asyncRunner = makeAsyncRunner({ status: 0, stdout });
  const out = await fetchPrInfoForIssueAsync(3030, { asyncRunner });
  assert.equal(out.number, 101);
  assert.equal(out.state, 'MERGED');
});

test('async | exit code != 0 → fallback con error (no propaga)', async () => {
  const asyncRunner = makeAsyncRunner({ status: 1, stdout: '', stderr: 'auth required' });
  const out = await fetchPrInfoForIssueAsync(3030, { asyncRunner });
  assert.equal(out.error, true);
  assert.equal(out.reason, 'non_zero_exit');
});

test('async | runner que rechaza → fallback spawn_failed (no propaga)', async () => {
  const asyncRunner = makeAsyncRunner(() => Promise.reject(new Error('execFile boom')));
  const out = await fetchPrInfoForIssueAsync(3030, { asyncRunner });
  assert.equal(out.error, true);
  assert.equal(out.reason, 'spawn_failed');
});
