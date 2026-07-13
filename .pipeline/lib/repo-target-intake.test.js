// .pipeline/lib/repo-target-intake.test.js
// Test de intake multi-repo (#4693 · CA-A1/CA-A3 / REQ-SEC-1).
//
// Modela EXACTAMENTE la decisión del loop de intake de pulpo.js:
//
//     for (const repo of repoTarget.getIntakeRepos()) {
//       if (!repoTarget.isRepoAllowed(repo)) continue;   // fail-closed, cero spawns
//       gh issue list --repo <repo> ...                   // <- consulta efectiva
//     }
//
// Verifica la frontera de confianza sin depender del módulo gigante pulpo.js:
//   - allowlist [platform, kernel] ⇒ el intake consulta AMBOS con --repo.
//   - un tercer repo NO allowlisted ⇒ CERO consultas (cero spawns).
//
// Ejecución: node --test .pipeline/lib/repo-target-intake.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { getIntakeRepos, isRepoAllowed } = require('./repo-target');

// Réplica fiel del gate del loop de intake: devuelve los repos que el Pulpo
// EFECTIVAMENTE consultaría (`gh issue list --repo <r>`), aplicando el mismo
// doble filtro fail-closed que pulpo.js — getIntakeRepos() (⊆ allowlist) +
// isRepoAllowed() antes de interpolar el `--repo`.
function reposConsultadosPorIntake(cfg) {
  const queried = [];
  for (const repo of getIntakeRepos(cfg)) {
    if (!isRepoAllowed(repo, cfg)) continue; // fail-closed: cero spawns
    queried.push(repo);
  }
  return queried;
}

test('CA-A1: allowlist [platform, kernel] ⇒ el intake consulta AMBOS repos', () => {
  const cfg = {
    repos: {
      primary: 'intrale/platform',
      allowlist: ['intrale/platform', 'intrale/kernel'],
      // sin `intake` ⇒ intake = allowlist completa
    },
  };
  assert.deepStrictEqual(
    reposConsultadosPorIntake(cfg),
    ['intrale/platform', 'intrale/kernel'],
  );
});

test('CA-A3: un tercer repo NO allowlisted inyectado en `intake` ⇒ CERO consultas', () => {
  const cfg = {
    repos: {
      primary: 'intrale/platform',
      allowlist: ['intrale/platform', 'intrale/kernel'],
      // Un atacante/typo mete un tercer repo en el intake:
      intake: ['intrale/platform', 'intrale/kernel', 'attacker/evil'],
    },
  };
  const queried = reposConsultadosPorIntake(cfg);
  assert.ok(!queried.includes('attacker/evil'), 'el repo no-allowlisted jamás se consulta');
  assert.deepStrictEqual(queried, ['intrale/platform', 'intrale/kernel']);
});

test('CA-A3: repo malformado (shell injection) en intake ⇒ CERO consultas', () => {
  const cfg = {
    repos: {
      primary: 'intrale/platform',
      allowlist: ['intrale/platform'],
      intake: ['intrale/platform', 'intrale/platform; rm -rf /'],
    },
  };
  assert.deepStrictEqual(reposConsultadosPorIntake(cfg), ['intrale/platform']);
});

test('CA-A3: allowlist vacía ⇒ intake sólo consulta el primary (nunca allow-all)', () => {
  const cfg = { repos: { primary: 'intrale/platform', allowlist: [] } };
  assert.deepStrictEqual(reposConsultadosPorIntake(cfg), ['intrale/platform']);
});

test('gate REQ-SEC-5: intake=[platform] con kernel allowlisted ⇒ kernel NO se consulta', () => {
  const cfg = {
    repos: {
      primary: 'intrale/platform',
      allowlist: ['intrale/platform', 'intrale/kernel'],
      intake: ['intrale/platform'],
    },
  };
  const queried = reposConsultadosPorIntake(cfg);
  assert.deepStrictEqual(queried, ['intrale/platform']);
  assert.ok(!queried.includes('intrale/kernel'), 'kernel allowlisted pero fuera del intake efectivo');
});
