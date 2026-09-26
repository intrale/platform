// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// #6565 — el estado runtime del pipeline nunca debe aterrizar dentro del repo.
// Regresión del hallazgo de seguridad [OWASP A05 / CWE-538]: un `pipelineDir`
// relativo se resolvía contra el CWD (working tree del repo) y versionaba el
// libro contable de cuota en un repo público.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');

const ledger = require('../lib/multi-provider/quota-ledger');

test('rechaza un pipelineDir relativo en vez de resolverlo contra el CWD del repo', () => {
  assert.throws(
    () => ledger.ledgerPath({ pipelineDir: 'UsersAdministratorAppDataLocalTempintrale-pipeline-pruebas.pipeline' }),
    /ruta ABSOLUTA/,
    'un dir relativo debe abortar, no escribir dentro del working tree',
  );
});

test('rechaza el path deformado por backslashes de Windows comidos por el shell POSIX', () => {
  // Reproduce la causa raíz exacta: 'C:\Users\...\.pipeline' pasado por un
  // shell POSIX queda con los separadores colapsados y deja de ser absoluto.
  const BS = String.fromCharCode(92); // backslash, sin literal que el shell pueda comerse
  const windows = ['C:', 'Users', 'Administrator', 'AppData', 'Local', 'Temp', 'x', '.pipeline'].join(BS);
  const deformado = windows.split(BS).join('');
  assert.strictEqual(path.isAbsolute(deformado), false, 'precondición: el path colapsado es relativo');
  assert.throws(() => ledger.ledgerPath({ pipelineDir: deformado }), /ruta ABSOLUTA/);
});

test('rechaza pipelineDir vacío o no-string sin caer en un path silencioso', () => {
  for (const malo of ['', '   ', 42, {}, []]) {
    assert.throws(() => ledger.assertPipelineDirAbsoluto(malo), /ruta ABSOLUTA/, `debería rechazar ${JSON.stringify(malo)}`);
  }
});

test('acepta una ruta absoluta y la usa para componer el path del ledger', () => {
  const abs = path.join(os.tmpdir(), 'intrale-6565-test', '.pipeline');
  const p = ledger.ledgerPath({ pipelineDir: abs });
  assert.strictEqual(p, path.join(abs, 'state', 'quota-ledger.jsonl'));
  assert.ok(path.isAbsolute(p), 'el path resultante debe ser absoluto');
});

test('el mensaje de error explica cómo pasar la ruta en formato POSIX', () => {
  assert.throws(() => ledger.assertPipelineDirAbsoluto('relativo/.pipeline'), (e) => {
    assert.ok(e instanceof TypeError);
    assert.match(e.message, /PIPELINE_DIR_OVERRIDE/);
    assert.match(e.message, /POSIX/);
    return true;
  });
});
