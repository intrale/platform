'use strict';

// #5244 rev-6 — el job `secret-scan` es el ÚNICO no-advisory de security-sast.yml:
// es el que decide si un secreto entra o no al repo. Si sus steps usan tags
// mutables (`@v4`), el dueño de la action puede repuntear el tag en silencio y
// reemplazar el código que corre dentro del gate — el mismo vector de
// supply-chain que este issue viene a cerrar (casos trivy-action /
// kics-github-action). Semgrep lo marca con
// yaml.github-actions.security.github-actions-mutable-action-tag.
//
// Este test es la regresión: si alguien vuelve a poner un tag mutable en el job
// bloqueante, falla acá y no en un review thread tres días después.
//
// Alcance deliberado: SÓLO el job `secret-scan`. Los otros jobs del workflow
// vienen de main, son advisory (`continue-on-error: true`) y su pineado es un
// issue aparte — ampliarlo acá mezclaría alcances.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const REPO = path.join(__dirname, '..', '..');
const WORKFLOW = path.join(REPO, '.github', 'workflows', 'security-sast.yml');
const WORKFLOW_TEXT = fs.readFileSync(WORKFLOW, 'utf8');
const WORKFLOW_DOC = yaml.load(WORKFLOW_TEXT);

const JOB = 'secret-scan';
const SHA40 = /^[0-9a-f]{40}$/;

function secretScanJob() {
  const job = WORKFLOW_DOC && WORKFLOW_DOC.jobs && WORKFLOW_DOC.jobs[JOB];
  assert.ok(job, `security-sast.yml no declara el job "${JOB}"`);
  return job;
}

// Líneas crudas del bloque del job, para poder mirar los comentarios (js-yaml
// los descarta al parsear).
function jobRawLines() {
  const lines = WORKFLOW_TEXT.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `${JOB}:` && /^ {2}\S/.test(line));
  assert.ok(start >= 0, `no se encontró el bloque del job "${JOB}" en el yml`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}\S/.test(line));
  return end === -1 ? rest : rest.slice(0, end);
}

test('el job secret-scan sigue siendo bloqueante (continue-on-error explícito en false)', () => {
  assert.equal(secretScanJob()['continue-on-error'], false);
});

test('todos los steps del job secret-scan usan actions pineadas a un SHA de 40 chars', () => {
  const usos = secretScanJob().steps.filter((step) => step && step.uses);
  assert.ok(usos.length >= 3, 'se esperaban al menos 3 steps con `uses:` en el job secret-scan');

  for (const step of usos) {
    const [action, ref] = String(step.uses).split('@');
    assert.ok(ref, `el step "${step.name}" usa "${step.uses}" sin ref`);
    assert.match(
      ref,
      SHA40,
      `el step "${step.name}" usa el tag mutable "${step.uses}"; pinealo al SHA de 40 chars ` +
        `de la release (patrón: uses: ${action}@<sha40> # vX.Y.Z)`,
    );
  }
});

test('cada action pineada deja el tag legible como comentario al final de la línea', () => {
  const usos = jobRawLines().filter((line) => line.trim().startsWith('uses:'));
  assert.ok(usos.length >= 3, 'no se encontraron los `uses:` del job secret-scan en el texto crudo');

  for (const line of usos) {
    assert.match(
      line,
      /uses:\s+\S+@[0-9a-f]{40}\s+#\s*v\d+\.\d+(\.\d+)?/,
      `sin el tag como comentario el pin queda ilegible: "${line.trim()}"`,
    );
  }
});

test('no queda ningún tag mutable en el texto crudo del job secret-scan', () => {
  const mutables = jobRawLines().filter((line) => /uses:\s+\S+@(v\d|main|master)\b/.test(line));
  assert.deepEqual(
    mutables.map((l) => l.trim()),
    [],
    'el job bloqueante no puede depender de un ref que el dueño de la action puede repuntear',
  );
});
