// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// Tests de la aprobación humana de excepciones (#7592 · D1 · CA-5 · CA-7 caso 6).
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { APPROVAL_LABEL, checkExceptionApproval, diffExceptions, fetchPrLabelsFromEnv } = require('../exceptions-diff');
const { basePolicy } = require('./_fixture-repo');

const EXC = Object.freeze({
  paquete: 'gpl-lib@2.0.0',
  licencia: 'GPL-3.0-only',
  justificacion: 'uso interno',
  aprobado_por: 'leitolarreta',
  revisar_antes: '2026-12-31',
});

function fakeGit(basePolicyObj) {
  return (args) => {
    if (args[0] === 'rev-parse') return 'abc123\n';
    if (args[0] === 'show') {
      if (basePolicyObj === null) throw new Error('fatal: path does not exist');
      return JSON.stringify(basePolicyObj);
    }
    throw new Error(`git inesperado: ${args.join(' ')}`);
  };
}

const labels = (list) => async () => list;

test('una excepción nueva sin el label humano hace fallar el gate', async () => {
  const r = await checkExceptionApproval({
    headPolicy: basePolicy({ exceptions: [EXC] }),
    baseRef: 'main',
    execGit: fakeGit(basePolicy()),
    fetchLabels: labels(['area:infra']),
  });
  assert.equal(r.status, 'rejected');
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].type, 'EXCEPCIÓN SIN APROBAR');
  assert.equal(r.findings[0].coordinate, 'gpl-lib@2.0.0');
  assert.match(r.findings[0].action, new RegExp(APPROVAL_LABEL));
});

test('con el label licencias:excepcion-aprobada la excepción nueva pasa', async () => {
  const r = await checkExceptionApproval({
    headPolicy: basePolicy({ exceptions: [EXC] }),
    baseRef: 'main',
    execGit: fakeGit(basePolicy()),
    fetchLabels: labels(['area:infra', APPROVAL_LABEL]),
  });
  assert.equal(r.status, 'approved');
  assert.deepEqual(r.findings, []);
});

test('una excepción modificada (ej. fecha extendida) también exige el label', async () => {
  const r = await checkExceptionApproval({
    headPolicy: basePolicy({ exceptions: [{ ...EXC, revisar_antes: '2030-01-01' }] }),
    baseRef: 'main',
    execGit: fakeGit(basePolicy({ exceptions: [EXC] })),
    fetchLabels: labels([]),
  });
  assert.equal(r.status, 'rejected');
});

test('sin cambios en las excepciones pasa sin consultar labels', async () => {
  let consulted = false;
  const r = await checkExceptionApproval({
    headPolicy: basePolicy({ exceptions: [{ ...EXC }] }),
    baseRef: 'main',
    // mismo contenido con otro orden de claves: no es un cambio
    execGit: fakeGit(basePolicy({ exceptions: [Object.fromEntries(Object.entries(EXC).reverse())] })),
    fetchLabels: async () => { consulted = true; return []; },
  });
  assert.equal(r.status, 'unchanged');
  assert.equal(consulted, false);
});

test('quitar una excepción no requiere aprobación', () => {
  assert.deepEqual(diffExceptions([EXC], []), []);
});

test('si la base no tiene política, toda excepción cuenta como nueva', async () => {
  const r = await checkExceptionApproval({
    headPolicy: basePolicy({ exceptions: [EXC] }),
    baseRef: 'main',
    execGit: fakeGit(null),
    fetchLabels: labels([]),
  });
  assert.equal(r.status, 'rejected');
});

test('sin rama base (schedule, push o manual) no compara y no rompe', async () => {
  const r = await checkExceptionApproval({
    headPolicy: basePolicy({ exceptions: [EXC] }),
    baseRef: null,
    execGit: () => { throw new Error('no debería llamarse'); },
    fetchLabels: () => { throw new Error('no debería llamarse'); },
  });
  assert.equal(r.status, 'skipped');
  assert.deepEqual(r.findings, []);
});

test('fail-closed: si no se pueden leer los labels y hay excepciones nuevas, falla', async () => {
  const r = await checkExceptionApproval({
    headPolicy: basePolicy({ exceptions: [EXC] }),
    baseRef: 'main',
    execGit: fakeGit(basePolicy()),
    fetchLabels: async () => { throw new Error('403'); },
  });
  assert.equal(r.status, 'rejected');
  assert.match(r.findings[0].detail, /no se pudieron leer los labels/);
});

test('fail-closed: si la rama base no está disponible, falla', async () => {
  const r = await checkExceptionApproval({
    headPolicy: basePolicy(),
    baseRef: 'main',
    execGit: () => { throw new Error('unknown revision'); },
    fetchLabels: labels([]),
  });
  assert.equal(r.status, 'rejected');
  assert.match(r.findings[0].detail, /fetch-depth/);
});

test('los labels se leen en runtime de la API del PR con el token del job', async () => {
  const calls = [];
  const fakeFs = { readFileSync: () => JSON.stringify({ pull_request: { number: 77 } }) };
  const fetchImpl = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization });
    return { ok: true, json: async () => ({ labels: [{ name: APPROVAL_LABEL }, { name: 'x' }] }) };
  };
  const got = await fetchPrLabelsFromEnv({
    env: { GITHUB_REPOSITORY: 'intrale/platform', GITHUB_TOKEN: 't0k', GITHUB_EVENT_PATH: '/evento.json' },
    fs: fakeFs,
    fetchImpl,
  });
  assert.deepEqual(got, [APPROVAL_LABEL, 'x']);
  assert.equal(calls[0].url, 'https://api.github.com/repos/intrale/platform/pulls/77');
  assert.equal(calls[0].auth, 'Bearer t0k');
});

test('lectura de labels sin entorno de Actions falla (y el gate queda fail-closed)', async () => {
  await assert.rejects(() => fetchPrLabelsFromEnv({ env: {}, fs: {} }), /GITHUB_REPOSITORY/);
});
