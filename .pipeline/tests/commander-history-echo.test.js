// =============================================================================
// commander-history-echo.test.js — Persistencia del eco en commander-history (#3918, CA-3 / RS-3)
//
// `appendCommanderHistory` vive en pulpo.js (no exportable sin side-effects de
// boot). Acá reproducimos fielmente su contrato — construir el entry `in` con
// los campos aditivos de `buildEchoHistoryFields` y sanitizar el `text` con el
// mismo `sanitizer` que usa el chokepoint real — y verificamos:
//   - RS-3: el `text` (free-text, único campo con input no confiable) pasa por
//     sanitizePipelineText; los campos nuevos son bool/número/enum (no free-text).
//   - CA-3: los campos transcript_echo / stt_confidence / stt_source se
//     persisten en el JSONL.
//   - Backward-compatible: un lector que sólo entiende direction/text descarta
//     los campos desconocidos sin romper.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildEchoHistoryFields } = require('../lib/commander/transcript-echo');
const { sanitize: sanitizePipelineText } = require('../sanitizer');

// Réplica fiel del chokepoint appendCommanderHistory (sanitiza text/reason,
// default timestamp, append JSON-line). Mantener en sync si cambia el original.
function appendCommanderHistory(historyFile, entry) {
    const safe = { ...entry };
    if (typeof safe.text === 'string') safe.text = sanitizePipelineText(safe.text);
    if (typeof safe.reason === 'string') safe.reason = sanitizePipelineText(safe.reason);
    if (!safe.timestamp) safe.timestamp = new Date().toISOString();
    fs.appendFileSync(historyFile, JSON.stringify(safe) + '\n');
}

function tmpHistory() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-echo-'));
    return path.join(dir, 'commander-history.jsonl');
}

test('CA-3: persiste campos aditivos en el entry in de audio', () => {
    const f = tmpHistory();
    const audio = { ok: true, source: 'local', confidence: { avgLogprob: -0.42 } };
    const entry = { direction: 'in', from: { id: 1 }, text: 'reiniciá el pipeline' };
    Object.assign(entry, buildEchoHistoryFields(audio));
    appendCommanderHistory(f, entry);

    const line = JSON.parse(fs.readFileSync(f, 'utf8').trim());
    assert.equal(line.transcript_echo, true);
    assert.equal(line.stt_source, 'local');
    assert.equal(line.stt_confidence, -0.42);
    assert.equal(line.direction, 'in');
});

test('CA-3: source openai se persiste como api', () => {
    const f = tmpHistory();
    const entry = { direction: 'in', text: 'algo' };
    Object.assign(entry, buildEchoHistoryFields({ ok: true, source: 'openai' }));
    appendCommanderHistory(f, entry);
    const line = JSON.parse(fs.readFileSync(f, 'utf8').trim());
    assert.equal(line.stt_source, 'api');
    assert.equal(line.stt_confidence, null);
});

test('RS-3: el text con secreto se sanitiza al persistir', () => {
    const f = tmpHistory();
    const entry = { direction: 'in', text: 'mi key AKIAIOSFODNN7EXAMPLE secreta' };
    Object.assign(entry, buildEchoHistoryFields({ ok: true, source: 'local' }));
    appendCommanderHistory(f, entry);
    const raw = fs.readFileSync(f, 'utf8');
    assert.equal(raw.includes('AKIAIOSFODNN7EXAMPLE'), false);
    // Los campos aditivos siguen presentes.
    const line = JSON.parse(raw.trim());
    assert.equal(line.transcript_echo, true);
});

test('audio fallido → sin campos aditivos (sólo entry base)', () => {
    const f = tmpHistory();
    const entry = { direction: 'in', text: 'x' };
    Object.assign(entry, buildEchoHistoryFields({ ok: false }));
    appendCommanderHistory(f, entry);
    const line = JSON.parse(fs.readFileSync(f, 'utf8').trim());
    assert.equal(line.transcript_echo, undefined);
    assert.equal(line.stt_source, undefined);
});

test('backward-compatible: lector que ignora campos desconocidos sigue leyendo', () => {
    const f = tmpHistory();
    const entry = { direction: 'in', text: 'hola' };
    Object.assign(entry, buildEchoHistoryFields({ ok: true, source: 'local', confidence: { avgLogprob: -0.3 } }));
    appendCommanderHistory(f, entry);

    // Simulamos un consumidor viejo: sólo lee direction y text.
    const line = JSON.parse(fs.readFileSync(f, 'utf8').trim());
    const { direction, text } = line;
    assert.equal(direction, 'in');
    assert.equal(text, 'hola');
});
