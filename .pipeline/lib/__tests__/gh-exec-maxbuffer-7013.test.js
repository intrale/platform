'use strict';

// =============================================================================
// gh-exec-maxbuffer-7013.test.js — las llamadas `gh` por execSync no pueden
// volver a morir con ENOBUFS cuando la respuesta supera 1 MiB (regresión #7013).
//
// Historia: #7013 subió `INTAKE_GH_LIST_LIMIT` de 50 a 500 para que los issues
// de ola más viejos dejaran de quedar fuera de la ventana del listado. Con ese
// tope, la respuesta del intake de definición (`--json ...,body` sobre ~193
// issues) pasó a ~1,06 MB — apenas por encima del `maxBuffer` default de
// `execSync` (1 MiB). Cada llamada moría con ENOBUFS antes de devolver nada, el
// `catch` del caller lo degradaba a "sin candidatos" y el brazo de intake quedó
// silenciosamente inerte: ningún issue volvía a entrar a definición.
//
// ENOBUFS no matchea `CONN_ERROR_PATTERNS` del breaker, así que tampoco había
// alerta por ese lado. El fallo era mudo, ciclo tras ciclo.
// =============================================================================

process.env.PULPO_NO_AUTOSTART = '1'; // permitir require sin arrancar el pulpo.

const test = require('node:test');
const assert = require('node:assert/strict');

const pulpo = require('../../pulpo.js');

test('el piso de maxBuffer de las llamadas gh queda muy por encima de 1 MiB', () => {
  assert.equal(typeof pulpo.GH_EXEC_MAX_BUFFER, 'number');
  assert.ok(
    pulpo.GH_EXEC_MAX_BUFFER >= 8 * 1024 * 1024,
    `el buffer de las llamadas gh no puede bajar de 8 MiB (actual: ${pulpo.GH_EXEC_MAX_BUFFER})`,
  );
});

test('_ghExecSyncGuarded soporta una respuesta mayor al default de execSync', () => {
  // ~2 MiB de salida: el doble del default de Node, sin red ni gh de por medio.
  const bytes = 2 * 1024 * 1024;
  const cmd = `"${process.execPath}" -e "process.stdout.write('x'.repeat(${bytes}))"`;

  const out = pulpo._ghExecSyncGuarded(cmd, { encoding: 'utf8', timeout: 30000, windowsHide: true });

  assert.equal(out.length, bytes, 'la respuesta debe llegar entera, sin truncar ni fallar por ENOBUFS');
});

test('un caller puede seguir ajustando maxBuffer por opts', () => {
  const cmd = `"${process.execPath}" -e "process.stdout.write('x'.repeat(4096))"`;

  assert.throws(
    () => pulpo._ghExecSyncGuarded(cmd, { encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 16 }),
    /ENOBUFS|maxBuffer/i,
    'el default no puede pisar un maxBuffer explícito del caller',
  );
});
