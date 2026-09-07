// =============================================================================
// #6459 — `recent-requests.js`: fuente ÚNICA del listado de peticiones del
// Commander, compartida por el dashboard legacy y por el panel del home V3.
//
// Es el módulo que evita que las dos superficies vuelvan a divergir (el rebote
// de QA fue justamente eso: el listado existía en una sola de las dos).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { listRecentRequests, parseLogName, readMeta } = require('../recent-requests');

function tmpLogDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'recentreq-6459-'));
}

function writeRequest(dir, id, meta) {
    fs.writeFileSync(path.join(dir, `commander-${id}.log`), 'x\n', 'utf8');
    if (meta !== undefined) {
        fs.writeFileSync(path.join(dir, `commander-${id}.meta.json`), JSON.stringify(meta), 'utf8');
    }
}

test('parseLogName parte el id por el ÚLTIMO guión (chat_id de grupo es negativo)', () => {
    const r = parseLogName('commander--1001234567890-1787611707632.log');
    assert.strictEqual(r.id, '-1001234567890-1787611707632');
    assert.strictEqual(r.chat, '-1001234567890');
    assert.strictEqual(r.epochms, 1787611707632);
});

test('parseLogName con timestamp no numérico ⇒ epochms 0, no NaN', () => {
    const r = parseLogName('commander-42-nofecha.log');
    assert.strictEqual(r.epochms, 0);
});

test('lista ordenada de la más nueva a la más vieja', () => {
    const dir = tmpLogDir();
    writeRequest(dir, '-100-1787611700000', { resultado: 'ok' });
    writeRequest(dir, '-100-1787611900000', { resultado: 'huerfano' });
    writeRequest(dir, '-100-1787611800000', { resultado: 'error' });

    const out = listRecentRequests(dir);
    assert.deepStrictEqual(out.map((o) => o.epochms), [1787611900000, 1787611800000, 1787611700000]);
});

test('respeta el límite pedido y el default', () => {
    const dir = tmpLogDir();
    for (let i = 0; i < 12; i++) writeRequest(dir, `-100-17876117000${String(i).padStart(2, '0')}`, { resultado: 'ok' });
    assert.strictEqual(listRecentRequests(dir).length, 8);      // DEFAULT_LIMIT
    assert.strictEqual(listRecentRequests(dir, 3).length, 3);
});

test('adjunta el sidecar parseado, y null cuando no existe', () => {
    const dir = tmpLogDir();
    writeRequest(dir, '-100-1787611900000', { resultado: 'huerfano', provider: 'anthropic' });
    writeRequest(dir, '-100-1787611800000'); // sin sidecar

    const out = listRecentRequests(dir);
    assert.deepStrictEqual(out[0].meta, { resultado: 'huerfano', provider: 'anthropic' });
    assert.strictEqual(out[1].meta, null);
});

test('sidecar corrupto ⇒ meta null, nunca excepción', () => {
    const dir = tmpLogDir();
    writeRequest(dir, '-100-1787611900000');
    fs.writeFileSync(path.join(dir, 'commander--100-1787611900000.meta.json'), '{roto', 'utf8');
    assert.strictEqual(listRecentRequests(dir)[0].meta, null);
});

test('sidecar que no es objeto (array / número) ⇒ meta null', () => {
    const dir = tmpLogDir();
    writeRequest(dir, '-100-1787611900000');
    fs.writeFileSync(path.join(dir, 'commander--100-1787611900000.meta.json'), '42', 'utf8');
    assert.strictEqual(listRecentRequests(dir)[0].meta, null);
});

test('ignora archivos que no son logs de petición del Commander', () => {
    const dir = tmpLogDir();
    writeRequest(dir, '-100-1787611900000', { resultado: 'ok' });
    fs.writeFileSync(path.join(dir, 'pulpo.log'), 'x', 'utf8');
    fs.writeFileSync(path.join(dir, 'commander--100-1787611900000.stages.jsonl'), 'x', 'utf8');
    fs.writeFileSync(path.join(dir, 'build-6459.log'), 'x', 'utf8');

    const out = listRecentRequests(dir);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].file, 'commander--100-1787611900000.log');
});

test('directorio inexistente ⇒ array vacío, nunca excepción', () => {
    assert.deepStrictEqual(listRecentRequests(path.join(os.tmpdir(), 'no-existe-6459-abc')), []);
});

test('readdirSync que explota ⇒ array vacío (el dashboard nunca se cae por esto)', () => {
    const fakeFs = {
        readdirSync() { throw new Error('EACCES'); },
        existsSync() { return false; },
        readFileSync() { return ''; },
    };
    assert.deepStrictEqual(listRecentRequests('/lo/que/sea', 5, { fs: fakeFs }), []);
});

test('readMeta con fs inyectado que falla ⇒ null', () => {
    const fakeFs = {
        existsSync() { return true; },
        readFileSync() { throw new Error('EIO'); },
    };
    assert.strictEqual(readMeta('/d', 'x', fakeFs, path), null);
});
