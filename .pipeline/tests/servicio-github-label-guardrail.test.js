// =============================================================================
// servicio-github-label-guardrail.test.js — #5690
//
// El CA central del issue no es "el guardrail devuelve false": es que la orden
// **no muta el issue**. Eso sólo se puede probar en el worker de la cola, con
// un `ghClient` mockeado que registra si `editIssue` fue invocado.
//
// Se monta una cola real en un tmpdir (`PIPELINE_STATE_DIR`) y se corre
// `processQueue({ ghClient })` — el mismo entrypoint de producción. Los tests
// spawnean un proceso Node por caso porque `servicio-github.js` resuelve sus
// constantes de path en el require, a partir de `PIPELINE_STATE_DIR`.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PIPELINE = path.resolve(__dirname, '..');

/**
 * Corre una orden por el worker real y devuelve lo que el ghClient observó.
 *
 * @param {object} orden        - el JSON que se deja en `pendiente/`.
 * @param {object} opts
 * @param {string[]|'throw'} opts.labels - lo que devuelve `getIssueLabels`
 *        (o 'throw' para simular rate limit / red caída).
 */
function correrOrden(orden, { labels = [] } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), '5690-cola-'));
    for (const sub of ['pendiente', 'trabajando', 'listo', 'fallido']) {
        fs.mkdirSync(path.join(dir, 'servicios', 'github', sub), { recursive: true });
    }
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    const nombreOrden = `${orden.issue}-${orden.action}-test.json`;
    fs.writeFileSync(
        path.join(dir, 'servicios', 'github', 'pendiente', nombreOrden),
        JSON.stringify(orden),
    );

    const salidaPath = path.join(dir, 'observado.json');
    const script = `
      process.env.PIPELINE_STATE_DIR = ${JSON.stringify(dir)};
      const fs = require('fs');
      const svc = require(${JSON.stringify(path.join(PIPELINE, 'servicio-github.js'))});
      const observado = { editIssue: [], createLabel: [], getIssueLabels: [], comment: [] };
      const LABELS = ${JSON.stringify(labels)};
      const ghClient = {
        editIssue: (issue, opts) => { observado.editIssue.push({ issue, opts }); return { ok: true }; },
        createLabel: (name) => { observado.createLabel.push(name); return { created: true }; },
        listLabels: () => [],
        commentIssue: (issue, body) => { observado.comment.push({ issue, body }); },
        getIssueLabels: (issue) => {
          observado.getIssueLabels.push(issue);
          if (LABELS === 'throw') throw new Error('gh: API rate limit exceeded');
          return LABELS;
        },
      };
      try { svc.processQueue({ ghClient }); } catch (e) { observado.error = e.message; }
      fs.writeFileSync(${JSON.stringify(salidaPath)}, JSON.stringify(observado));
    `;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(r.status, 0, `worker fallo: ${r.stderr}`);
    const observado = JSON.parse(fs.readFileSync(salidaPath, 'utf8'));

    // La orden procesada viaja a `listo/` con los campos de traza.
    const listoDir = path.join(dir, 'servicios', 'github', 'listo');
    const archivos = fs.readdirSync(listoDir).filter((f) => f.endsWith('.json'));
    const procesada = archivos.length
        ? JSON.parse(fs.readFileSync(path.join(listoDir, archivos[0]), 'utf8'))
        : null;

    return { observado, procesada, dir, stdout: r.stdout, stderr: r.stderr };
}

// -----------------------------------------------------------------------------
// CA: orden que agrega needs-human sobre issue con tipo:recomendacion
// -----------------------------------------------------------------------------

test('CA: agregar needs-human a una recomendacion es rechazado y editIssue NO se invoca', () => {
    const { observado, procesada } = correrOrden(
        { action: 'label', issue: 1732, label: 'needs-human' },
        { labels: ['tipo:recomendacion', 'enhancement'] },
    );
    assert.deepStrictEqual(observado.editIssue, [], 'el issue NO debe mutarse');
    assert.deepStrictEqual(observado.createLabel, [], 'no debe crearse ningun label');
    assert.strictEqual(procesada.discarded, 'label-guardrail:mezcla-needs-human-sobre-recomendacion');
    assert.ok(procesada.discarded_at);
    assert.deepStrictEqual(procesada.guardrail_labels_actuales, ['tipo:recomendacion', 'enhancement']);
});

test('CA: agregar tipo:recomendacion sobre un issue con needs-human es rechazado y editIssue NO se invoca', () => {
    const { observado, procesada } = correrOrden(
        { action: 'label', issue: 1733, label: 'tipo:recomendacion' },
        { labels: ['needs-human', 'bug'] },
    );
    assert.deepStrictEqual(observado.editIssue, []);
    assert.strictEqual(procesada.discarded, 'label-guardrail:mezcla-recomendacion-sobre-needs-human');
});

// -----------------------------------------------------------------------------
// SEC-B / SEC-B bis — el case 'remove-label'
// -----------------------------------------------------------------------------

test('SEC-B bis: remove-label de needs-human desde la cola anonima → editIssue NO invocado', () => {
    const { observado, procesada } = correrOrden(
        { action: 'remove-label', issue: 1234, label: 'needs-human' },
    );
    assert.deepStrictEqual(observado.editIssue, [], 'un JSON de 80 bytes no puede destrabar un gate humano');
    assert.strictEqual(procesada.discarded, 'label-guardrail:remove-needs-human-sin-origen-autorizado');
});

test('SEC-B: remove-label de needs-human con procedencia declarada SI se aplica (no rompe el destrabe)', () => {
    const { observado, procesada } = correrOrden({
        action: 'remove-label',
        issue: 1234,
        label: 'needs-human',
        guardrail_authorized: true,
        authorized_by: 'human-block:unblock',
    });
    assert.strictEqual(observado.editIssue.length, 1);
    assert.deepStrictEqual(observado.editIssue[0], { issue: 1234, opts: { removeLabel: 'needs-human' } });
    assert.ok(!procesada.discarded);
});

// -----------------------------------------------------------------------------
// SEC-A — auto-aprobación desde la cola
// -----------------------------------------------------------------------------

test('SEC-A: recommendation:approved desde la cola anonima → editIssue NO invocado', () => {
    const { observado, procesada } = correrOrden(
        { action: 'label', issue: 4321, label: 'recommendation:approved' },
    );
    assert.deepStrictEqual(observado.editIssue, [], 'una reco no puede auto-aprobarse por la cola');
    assert.deepStrictEqual(observado.createLabel, []);
    assert.strictEqual(procesada.discarded, 'label-guardrail:approved-sin-origen-autorizado');
    assert.deepStrictEqual(observado.getIssueLabels, [], 'SEC-D: no debe costar un `gh issue view`');
});

// -----------------------------------------------------------------------------
// SEC-C — fail-closed ante consulta indeterminada
// -----------------------------------------------------------------------------

test('SEC-C: si getIssueLabels tira, la orden se rechaza y editIssue NO se invoca', () => {
    const { observado, procesada } = correrOrden(
        { action: 'label', issue: 5555, label: 'needs-human' },
        { labels: 'throw' },
    );
    assert.strictEqual(observado.getIssueLabels.length, 1, 'se intentó consultar');
    assert.deepStrictEqual(observado.editIssue, [], 'ante la duda NO se aplica');
    assert.strictEqual(procesada.discarded, 'label-guardrail:guardrail-indeterminado');
});

// -----------------------------------------------------------------------------
// SEC-4 — ningún camino del guardrail remueve needs-human
// -----------------------------------------------------------------------------

test('SEC-4: ningun rechazo del guardrail produce una remocion de needs-human', () => {
    const escenarios = [
        [{ action: 'label', issue: 1, label: 'needs-human' }, { labels: ['tipo:recomendacion'] }],
        [{ action: 'label', issue: 2, label: 'tipo:recomendacion' }, { labels: ['needs-human'] }],
        [{ action: 'label', issue: 3, label: 'recommendation:approved' }, {}],
        [{ action: 'remove-label', issue: 4, label: 'needs-human' }, {}],
        [{ action: 'label', issue: 5, label: 'needs-human' }, { labels: 'throw' }],
    ];
    for (const [orden, opts] of escenarios) {
        const { observado } = correrOrden(orden, opts);
        const remociones = observado.editIssue.filter((c) => c.opts && c.opts.removeLabel);
        assert.deepStrictEqual(
            remociones, [],
            `el escenario ${orden.action}/${orden.label} produjo una remocion`,
        );
    }
});

// -----------------------------------------------------------------------------
// No-regresión: el camino normal sigue funcionando
// -----------------------------------------------------------------------------

test('no-regresion: un label no sensible se aplica normalmente y sin consultar labels', () => {
    const { observado, procesada } = correrOrden({ action: 'label', issue: 900, label: 'priority:high' });
    assert.strictEqual(observado.editIssue.length, 1);
    assert.deepStrictEqual(observado.editIssue[0], { issue: 900, opts: { addLabel: 'priority:high' } });
    assert.deepStrictEqual(observado.getIssueLabels, [], 'SEC-D: sin `gh issue view` extra');
    assert.ok(!procesada.discarded);
});

test('no-regresion: needs-human sobre un issue que NO es recomendacion se aplica', () => {
    const { observado, procesada } = correrOrden(
        { action: 'label', issue: 901, label: 'needs-human' },
        { labels: ['bug', 'priority:critical'] },
    );
    assert.strictEqual(observado.editIssue.length, 1);
    assert.deepStrictEqual(observado.editIssue[0], { issue: 901, opts: { addLabel: 'needs-human' } });
    assert.ok(!procesada.discarded);
});

test('no-regresion: un comment no pasa por el guardrail', () => {
    const { observado } = correrOrden({ action: 'comment', issue: 902, body: 'hola' });
    assert.strictEqual(observado.comment.length, 1);
    assert.deepStrictEqual(observado.getIssueLabels, []);
});
