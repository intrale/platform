'use strict';

// #4523 — Smoke test del camino integrado del fallback OBLIGATORIO de
// pipeline-dev/dev. `pulpo.js` no es importable en aislamiento (arranca un
// servicio), por eso el smoke ejerce el MISMO choke point que usa el bloque
// scopeado de `pulpo.js`: `buildMinimalDeliverableMd` → `writeDeliverable`
// (redacción + validación de fase + índice idempotente) → lectura del índice.
// Replica textualmente las dos guardas del bloque (skill/fase/resultado +
// umbral anti-ruido genérico) para blindar la CA-3.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildMinimalDeliverableMd } = require('../lib/minimal-deliverable');
const { writeDeliverable } = require('../lib/write-deliverable');
const { readDeliverableIndex } = require('../lib/deliverable-index');

// Root de repo temporal aislado por caso (evita tocar el store real).
function tmpRepoRoot(tag) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), `wf4523-${tag}-`));
    fs.mkdirSync(path.join(base, '.pipeline', 'deliverables'), { recursive: true });
    return base;
}

// Espejo EXACTO de la guarda del bloque #4523 en pulpo.js: bypass sólo para
// pipeline-dev/dev aprobado sin adjuntos. Para cualquier otro skill se mantiene
// el umbral anti-ruido genérico (esSustantiva >= 80).
function debeMaterializarPipelineDev(notifySkill, fase, resultado, attachments) {
    const sinAdjuntos = !Array.isArray(attachments) || attachments.length === 0;
    return notifySkill === 'pipeline-dev' && fase === 'dev'
        && resultado === 'aprobado' && sinAdjuntos;
}

function debeMaterializarGenerico(notasRaw, attachments) {
    const sinAdjuntos = !Array.isArray(attachments) || attachments.length === 0;
    const esSustantiva = String(notasRaw || '').trim().length >= 80;
    return sinAdjuntos && esSustantiva;
}

test('caso: pipeline-dev/dev aprobado sin adjunto y sin notas → materializa .md indexado pipeline-dev::dev', () => {
    const root = tmpRepoRoot('happy');
    const issue = 4523;

    // Guarda del bloque scopeado: debe habilitar la materialización.
    assert.strictEqual(debeMaterializarPipelineDev('pipeline-dev', 'dev', 'aprobado', []), true);

    const md = buildMinimalDeliverableMd({
        issue, fase: 'desarrollo/dev', skill: 'pipeline-dev', resultado: 'aprobado', notas: '',
    });
    writeDeliverable('pipeline-dev', issue, { fase: 'dev', md, pipelineRoot: root });

    const idx = readDeliverableIndex(issue, { pipelineRoot: root });
    const entry = idx.entries.find((e) => e && e.agente === 'pipeline-dev' && e.fase === 'dev');
    assert.ok(entry, 'existe entry pipeline-dev::dev en el índice');
    assert.strictEqual(entry.tipo, 'document');

    // El .md materializado existe en disco y trae el contenido mínimo (CA-2).
    const mdFile = path.join(root, entry.path);
    assert.ok(fs.existsSync(mdFile), 'el .md existe en disco');
    const body = fs.readFileSync(mdFile, 'utf8');
    assert.match(body, /#4523/);
    assert.match(body, /desarrollo\/dev/);
    assert.match(body, /pipeline-dev/);
    assert.match(body, /aprobado/);
    assert.match(body, /\(sin notas\)/);
    assert.ok(body.trim().length > 0);
});

test('caso: seguridad — nota mínima con token sintético sale redactada (CA-4)', () => {
    const root = tmpRepoRoot('sec');
    const issue = 4523;
    // Token sintético AWS (no real) embebido en la nota mínima.
    const akia = 'AKIA' + 'IOSFODNN7EXAMPLE';
    const md = buildMinimalDeliverableMd({
        issue, fase: 'desarrollo/dev', skill: 'pipeline-dev', resultado: 'aprobado',
        notas: `cierre ok, credencial ${akia} quedó en el log`,
    });
    writeDeliverable('pipeline-dev', issue, { fase: 'dev', md, pipelineRoot: root });

    const idx = readDeliverableIndex(issue, { pipelineRoot: root });
    const entry = idx.entries.find((e) => e && e.agente === 'pipeline-dev' && e.fase === 'dev');
    assert.ok(entry, 'existe entry pipeline-dev::dev');
    const body = fs.readFileSync(path.join(root, entry.path), 'utf8');
    // El camino nuevo NO debe bypassear redactContent: el token no aparece literal.
    assert.strictEqual(body.includes(akia), false, 'el token AKIA fue redactado');
});

test('caso: idempotencia — dos barridos no duplican la entry pipeline-dev::dev (CA-5)', () => {
    const root = tmpRepoRoot('idem');
    const issue = 4523;
    const md = buildMinimalDeliverableMd({
        issue, fase: 'desarrollo/dev', skill: 'pipeline-dev', resultado: 'aprobado', notas: '',
    });
    writeDeliverable('pipeline-dev', issue, { fase: 'dev', md, pipelineRoot: root });
    writeDeliverable('pipeline-dev', issue, { fase: 'dev', md, pipelineRoot: root });

    const idx = readDeliverableIndex(issue, { pipelineRoot: root });
    const matches = idx.entries.filter((e) => e && e.agente === 'pipeline-dev' && e.fase === 'dev');
    assert.strictEqual(matches.length, 1, 'upsert idempotente: una sola entry');
});

test('caso: otro skill (backend-dev/dev) aprobado con nota <80 y sin adjunto → NO materializa (anti-ruido CA-3)', () => {
    const root = tmpRepoRoot('antinoise');
    const issue = 4523;
    const notaTrivial = 'ok, aprobado'; // < 80 chars

    // El bypass scopeado NO aplica a backend-dev.
    assert.strictEqual(debeMaterializarPipelineDev('backend-dev', 'dev', 'aprobado', []), false);
    // El umbral genérico tampoco materializa una nota trivial.
    assert.strictEqual(debeMaterializarGenerico(notaTrivial, []), false);

    // Como ninguna guarda habilita la escritura, no se llama writeDeliverable →
    // el índice queda vacío para backend-dev.
    const idx = readDeliverableIndex(issue, { pipelineRoot: root });
    const anyBackend = idx.entries.some((e) => e && e.agente === 'backend-dev');
    assert.strictEqual(anyBackend, false, 'no se materializa .md para backend-dev con nota trivial');
});

test('caso: nota trivial (<80) en pipeline-dev SÍ materializa (bypass del umbral)', () => {
    const root = tmpRepoRoot('trivial');
    const issue = 4523;
    const notaTrivial = 'ok, aprobado';
    // La guarda scopeada habilita aunque la nota sea trivial.
    assert.strictEqual(debeMaterializarPipelineDev('pipeline-dev', 'dev', 'aprobado', []), true);

    const md = buildMinimalDeliverableMd({
        issue, fase: 'desarrollo/dev', skill: 'pipeline-dev', resultado: 'aprobado', notas: notaTrivial,
    });
    writeDeliverable('pipeline-dev', issue, { fase: 'dev', md, pipelineRoot: root });

    const idx = readDeliverableIndex(issue, { pipelineRoot: root });
    const entry = idx.entries.find((e) => e && e.agente === 'pipeline-dev' && e.fase === 'dev');
    assert.ok(entry, 'la nota trivial materializa igual para pipeline-dev');
    const body = fs.readFileSync(path.join(root, entry.path), 'utf8');
    assert.match(body, /ok, aprobado/);
});
