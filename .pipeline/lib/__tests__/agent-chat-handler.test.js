// agent-chat-handler — endpoints del dashboard /api/agent-chat (#3605).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const handler = require('../agent-chat-handler');

// -----------------------------------------------------------------------------
test('validateLogFileName acepta formato canónico', () => {
    assert.equal(handler.validateLogFileName('3559.guru.log'), '3559.guru.log');
    assert.equal(handler.validateLogFileName('123.tester.log'), '123.tester.log');
    assert.equal(handler.validateLogFileName('build-3520.log'), 'build-3520.log');
});

test('validateLogFileName rechaza path-traversal', () => {
    assert.equal(handler.validateLogFileName('../../../etc/passwd'), null);
    assert.equal(handler.validateLogFileName('/etc/passwd'), null);
    assert.equal(handler.validateLogFileName('..\\..\\etc'), null);
    assert.equal(handler.validateLogFileName('foo.log'), null); // no matchea formato
    assert.equal(handler.validateLogFileName(''), null);
    assert.equal(handler.validateLogFileName(null), null);
    assert.equal(handler.validateLogFileName(undefined), null);
    assert.equal(handler.validateLogFileName(123), null);
});

test('validateLogFileName extrae basename antes de validar', () => {
    // path.basename('../../foo.log') = 'foo.log' → no matchea regex → null
    assert.equal(handler.validateLogFileName('../../3559.guru.log'), '3559.guru.log');
});

// -----------------------------------------------------------------------------
test('sanitizeOperatorMessage trunca a 2000 chars', () => {
    const long = 'A'.repeat(3000);
    const sanitized = handler.sanitizeOperatorMessage(long);
    assert.equal(sanitized.length, 2000);
});

test('sanitizeOperatorMessage strip-ea control chars excepto \\n y \\t', () => {
    const input = 'hola\x00\x01mundo\nlínea2\ttab\x7Fdel';
    const sanitized = handler.sanitizeOperatorMessage(input);
    assert.equal(sanitized, 'holamundo\nlínea2\ttabdel');
});

test('sanitizeOperatorMessage tolera input no-string', () => {
    assert.equal(handler.sanitizeOperatorMessage(null), '');
    assert.equal(handler.sanitizeOperatorMessage(undefined), '');
    assert.equal(handler.sanitizeOperatorMessage(123), '123');
});

// -----------------------------------------------------------------------------
test('ipcCodeToHttpStatus mapeo correcto', () => {
    assert.equal(handler.ipcCodeToHttpStatus('NO_AGENT'), 404);
    assert.equal(handler.ipcCodeToHttpStatus('AGENT_DEAD'), 410);
    assert.equal(handler.ipcCodeToHttpStatus('PIPE_BROKEN'), 410);
    assert.equal(handler.ipcCodeToHttpStatus('QUEUE_FULL'), 429);
    assert.equal(handler.ipcCodeToHttpStatus('UNKNOWN'), 500);
    assert.equal(handler.ipcCodeToHttpStatus(null), 500);
});

// Issue #3721 — nuevos códigos en ipcCodeToHttpStatus.
test('ipcCodeToHttpStatus: OPERATOR_DELIMITER_INJECTION → 400 (CA-SEC-2)', () => {
    assert.equal(handler.ipcCodeToHttpStatus('OPERATOR_DELIMITER_INJECTION'), 400);
});

test('ipcCodeToHttpStatus: INVALID_PARAMS → 400 (CA-SEC-1)', () => {
    assert.equal(handler.ipcCodeToHttpStatus('INVALID_PARAMS'), 400);
});

test('ipcCodeToHttpStatus: AGENT_NOT_COMMUNICABLE → 412', () => {
    assert.equal(handler.ipcCodeToHttpStatus('AGENT_NOT_COMMUNICABLE'), 412);
});

// -----------------------------------------------------------------------------
// CA-SEC-1 (issue #3721): validateChatParams rechaza intentos de path
// traversal y values fuera del enum del pipeline.
// -----------------------------------------------------------------------------
test('validateChatParams: body válido pasa', () => {
    const r = handler.validateChatParams({ issue: '123', skill: 'guru', fase: 'dev' });
    assert.deepEqual(r, { ok: true });
});

test('validateChatParams: body válido con pipeline explícito pasa', () => {
    const r = handler.validateChatParams({
        issue: '123', skill: 'guru', fase: 'analisis', pipeline: 'definicion',
    });
    assert.deepEqual(r, { ok: true });
});

test('validateChatParams: issue con path traversal → field=issue', () => {
    const r = handler.validateChatParams({ issue: '../etc/passwd', skill: 'guru', fase: 'dev' });
    assert.deepEqual(r, { ok: false, field: 'issue' });
});

test('validateChatParams: issue no-numérico → field=issue', () => {
    const r = handler.validateChatParams({ issue: 'abc', skill: 'guru', fase: 'dev' });
    assert.deepEqual(r, { ok: false, field: 'issue' });
});

test('validateChatParams: skill con slash → field=skill', () => {
    assert.deepEqual(
        handler.validateChatParams({ issue: '1', skill: 'foo/bar', fase: 'dev' }),
        { ok: false, field: 'skill' },
    );
    assert.deepEqual(
        handler.validateChatParams({ issue: '1', skill: 'foo\\bar', fase: 'dev' }),
        { ok: false, field: 'skill' },
    );
});

test('validateChatParams: fase fuera del enum → field=fase', () => {
    assert.deepEqual(
        handler.validateChatParams({ issue: '1', skill: 'guru', fase: 'hack' }),
        { ok: false, field: 'fase' },
    );
    assert.deepEqual(
        handler.validateChatParams({ issue: '1', skill: 'guru', fase: '' }),
        { ok: false, field: 'fase' },
    );
});

test('validateChatParams: pipeline fuera del enum → field=pipeline', () => {
    const r = handler.validateChatParams({
        issue: '1', skill: 'guru', fase: 'dev', pipeline: 'hack',
    });
    assert.deepEqual(r, { ok: false, field: 'pipeline' });
});

test('validateChatParams: pipeline omitido se permite (default desarrollo)', () => {
    const r = handler.validateChatParams({ issue: '1', skill: 'guru', fase: 'dev' });
    assert.deepEqual(r, { ok: true });
});

// -----------------------------------------------------------------------------
// Tests de integración del POST /api/agent-chat (issue #3721).
// Verifica la cascada discriminada 200 / 400 / 410 / 412 sin alzar un server
// HTTP real: pasamos req/res fakes a handler.handle directamente.
// -----------------------------------------------------------------------------
const { EventEmitter } = require('node:events');
const { __resetSingletonForTesting } = require('../agent-ipc');
const pathMod = require('node:path');

function makeReq({ body, headers = {}, method = 'POST', url = '/api/agent-chat', remote = '127.0.0.1' } = {}) {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = {
        'content-type': 'application/json',
        ...headers,
    };
    req.socket = { remoteAddress: remote };
    // Emitir el body de forma asíncrona para que `readBodyJson` se enganche
    // a 'data' y 'end' antes.
    process.nextTick(() => {
        if (body != null) {
            req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
        }
        req.emit('end');
    });
    req.destroy = () => {};
    return req;
}

function makeRes() {
    const res = {
        statusCode: null,
        headers: null,
        body: '',
        writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
        end(body) { this.body = body || ''; this.__done = true; },
        __done: false,
    };
    return res;
}

function waitForRes(res, timeoutMs = 1000) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
            if (res.__done) return resolve(res);
            if (Date.now() - start > timeoutMs) return reject(new Error('res timeout'));
            setImmediate(tick);
        };
        tick();
    });
}

// -----------------------------------------------------------------------------
// #5796 · Aislamiento cross-proceso de los temporales de esta batería.
//
// `os.tmpdir()` es un directorio GLOBAL de la máquina y `Date.now()` tiene
// resolución de milisegundos. Dos corridas concurrentes de la batería —dos
// agentes del pipeline, dos worktrees, el tester de dos issues a la vez— que
// llegan al mismo test dentro del mismo milisegundo derivan EXACTAMENTE la
// misma ruta y se pisan los archivos entre sí: una corrida rota su archivo y la
// otra lo vuelve a crear en el medio, o el `finally` de una borra el temporal
// que la otra todavía está usando.
//
// El síntoma no señala al código bajo prueba: aparece como un `existsSync` que
// devuelve lo contrario de lo esperado, o un `readFileSync` sobre un archivo
// que "debería" existir. Se lee como un bug de rotación/append y no lo es.
//
// `mkdtempSync` delega la unicidad al sistema operativo: cada proceso recibe su
// propio directorio, sin coordinación ni suerte de por medio.
// -----------------------------------------------------------------------------
const TMP_DIRS_TO_CLEAN = [];

function uniqueTmpPath(prefix, basename = 'chat.jsonl') {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), prefix));
    TMP_DIRS_TO_CLEAN.push(dir);
    return pathMod.join(dir, basename);
}

// Red de seguridad: los `finally` de cada test siguen borrando sus archivos;
// esto sólo se lleva los directorios contenedores al terminar el proceso.
process.on('exit', () => {
    for (const dir of TMP_DIRS_TO_CLEAN) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
    }
});

const TMP_LOG_DIR = uniqueTmpPath('chat-handler-it-', 'logs');

test('handle POST: params inválidos (path traversal en issue) → 400 con field=issue', async () => {
    __resetSingletonForTesting();
    fs.mkdirSync(TMP_LOG_DIR, { recursive: true });
    const req = makeReq({
        body: { issue: '../etc/passwd', skill: 'guru', fase: 'dev', message: 'hola' },
    });
    const res = makeRes();
    handler.handle(req, res, { PIPELINE: 'desarrollo', LOG_DIR: TMP_LOG_DIR, log: () => {} });
    await waitForRes(res);
    assert.equal(res.statusCode, 400);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'INVALID_PARAMS');
    assert.equal(parsed.field, 'issue');
});

test('handle POST: fase fuera del enum → 400 con field=fase', async () => {
    __resetSingletonForTesting();
    const req = makeReq({
        body: { issue: '123', skill: 'guru', fase: 'hack', message: 'hola' },
    });
    const res = makeRes();
    handler.handle(req, res, { PIPELINE: 'desarrollo', LOG_DIR: TMP_LOG_DIR, log: () => {} });
    await waitForRes(res);
    assert.equal(res.statusCode, 400);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.field, 'fase');
});

test('handle POST: skill con slash → 400 con field=skill', async () => {
    __resetSingletonForTesting();
    const req = makeReq({
        body: { issue: '123', skill: 'foo/bar', fase: 'dev', message: 'hola' },
    });
    const res = makeRes();
    handler.handle(req, res, { PIPELINE: 'desarrollo', LOG_DIR: TMP_LOG_DIR, log: () => {} });
    await waitForRes(res);
    assert.equal(res.statusCode, 400);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.field, 'skill');
});

test('handle POST: agente vivo en FS sin registry → 412 con reason agent_alive_pulpo_restarted_or_no_interactive', async () => {
    // Setup: fakear FS para que heartbeat 9999 sea fresco + carrier presente.
    const REPO_ROOT_FAKE = '/fake/repo';
    const now = 10_000_000;
    const hbFile = pathMod.join(REPO_ROOT_FAKE, '.claude', 'hooks', 'agent-9999.heartbeat');
    const carrier = pathMod.join(REPO_ROOT_FAKE, '.pipeline', 'desarrollo', 'dev', 'trabajando', '9999.guru');
    const fakeFs = {
        existsSync(p) { return p === hbFile || p === carrier; },
        statSync(p) {
            if (p === hbFile) return { mtimeMs: now - 10_000 };
            const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err;
        },
    };
    __resetSingletonForTesting({
        fsImpl: fakeFs,
        repoRootImpl: REPO_ROOT_FAKE,
        nowImpl: () => now,
    });

    const req = makeReq({
        body: { issue: '9999', skill: 'guru', fase: 'dev', message: 'hola agente' },
    });
    const res = makeRes();
    handler.handle(req, res, { PIPELINE: 'desarrollo', LOG_DIR: TMP_LOG_DIR, log: () => {} });
    await waitForRes(res);
    assert.equal(res.statusCode, 412);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, 'agent_alive_pulpo_restarted_or_no_interactive');
    assert.match(parsed.hint, /#3748/);
});

test('handle POST: agente realmente muerto (heartbeat expirado) → 410', async () => {
    const REPO_ROOT_FAKE = '/fake/repo';
    const now = 10_000_000;
    // FS sin heartbeat → heartbeat_expired.
    const fakeFs = {
        existsSync() { return false; },
        statSync() { const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err; },
    };
    __resetSingletonForTesting({
        fsImpl: fakeFs,
        repoRootImpl: REPO_ROOT_FAKE,
        nowImpl: () => now,
    });

    const req = makeReq({
        body: { issue: '8888', skill: 'guru', fase: 'dev', message: 'hola' },
    });
    const res = makeRes();
    handler.handle(req, res, { PIPELINE: 'desarrollo', LOG_DIR: TMP_LOG_DIR, log: () => {} });
    await waitForRes(res);
    assert.equal(res.statusCode, 410);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.reason, 'heartbeat_expired');
});

test('handle POST: cleanup del TMP_LOG_DIR', () => {
    // Limpieza best-effort del directorio temporal compartido en los tests
    // de integración.
    try { fs.rmSync(TMP_LOG_DIR, { recursive: true, force: true }); } catch (_) {}
    assert.ok(true);
});

// -----------------------------------------------------------------------------
test('readChatHistory: archivo no existe → entries vacío', () => {
    const tmp = uniqueTmpPath('chat-');
    const result = handler.readChatHistory(tmp);
    assert.equal(result.entries.length, 0);
    assert.equal(result.truncated, false);
});

test('readChatHistory: archivo válido devuelve entries', () => {
    const tmp = uniqueTmpPath('chat-');
    const lines = [
        JSON.stringify({ timestamp: '2026-05-29T12:00:00Z', type: 'operator_message', message_id: 'm1', message: 'hola', author: 'operator', remoteAddress: '127.0.0.1' }),
        JSON.stringify({ timestamp: '2026-05-29T12:00:05Z', type: 'agent_response', message_id: 'r1', message: 'ok', author: 'agent' }),
    ];
    fs.writeFileSync(tmp, lines.join('\n') + '\n', 'utf8');
    try {
        const result = handler.readChatHistory(tmp);
        assert.equal(result.entries.length, 2);
        assert.equal(result.entries[0].type, 'operator_message');
        assert.equal(result.entries[0].message, 'hola');
        // remoteAddress NO debe aparecer en la respuesta al cliente (forense interno)
        assert.equal(result.entries[0].remoteAddress, undefined);
        assert.equal(result.entries[1].type, 'agent_response');
    } finally {
        fs.unlinkSync(tmp);
    }
});

test('readChatHistory: skip-ea líneas corruptas con conteo', () => {
    const tmp = uniqueTmpPath('chat-');
    const lines = [
        JSON.stringify({ timestamp: '2026-05-29T12:00:00Z', type: 'operator_message', message_id: 'm1', message: 'hola' }),
        '{this is not valid json',
        JSON.stringify({ timestamp: '2026-05-29T12:00:05Z', type: 'agent_response', message_id: 'r1', message: 'ok' }),
    ];
    fs.writeFileSync(tmp, lines.join('\n') + '\n', 'utf8');
    try {
        const result = handler.readChatHistory(tmp);
        assert.equal(result.entries.length, 2);
        assert.equal(result.corruptLines, 1);
    } finally {
        fs.unlinkSync(tmp);
    }
});

// -----------------------------------------------------------------------------
test('maybeRotateChatFile: noop si no existe', () => {
    const tmp = uniqueTmpPath('chat-');
    // Solo debe no crashear
    handler.maybeRotateChatFile(tmp, () => {});
    assert.equal(fs.existsSync(tmp), false);
});

test('maybeRotateChatFile: noop si bajo el cap', () => {
    const tmp = uniqueTmpPath('chat-rot-');
    fs.writeFileSync(tmp, 'pequeño contenido\n', 'utf8');
    try {
        handler.maybeRotateChatFile(tmp, () => {});
        // Debe seguir intacto.
        assert.equal(fs.existsSync(tmp), true);
        assert.equal(fs.existsSync(tmp + '.1'), false);
    } finally {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
});

test('maybeRotateChatFile: rota cuando supera el cap', () => {
    const tmp = uniqueTmpPath('chat-rot2-');
    // Generar contenido > cap (5MB)
    const big = Buffer.alloc(handler.CHAT_FILE_ROTATE_BYTES + 1024, 'x').toString('utf8');
    fs.writeFileSync(tmp, big, 'utf8');
    try {
        handler.maybeRotateChatFile(tmp, () => {});
        // Tras rotar, el .chat.jsonl ya no debe existir y el .1 sí.
        assert.equal(fs.existsSync(tmp), false);
        assert.equal(fs.existsSync(tmp + '.1'), true);
    } finally {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        if (fs.existsSync(tmp + '.1')) fs.unlinkSync(tmp + '.1');
    }
});

test('maybeRotateChatFile: reintenta EBUSY transitorio al rotar en Windows', () => {
    const tmp = uniqueTmpPath('chat-rot-ebusy-');
    fs.writeFileSync(tmp, Buffer.alloc(handler.CHAT_FILE_ROTATE_BYTES + 1, 'x'));
    const originalRename = fs.renameSync;
    let attempts = 0;
    const fakeRenameFile = (...args) => {
        attempts++;
        if (attempts <= 2) {
            const error = new Error('resource busy');
            error.code = 'EBUSY';
            throw error;
        }
        return originalRename(...args);
    };
    try {
        handler.maybeRotateChatFile(tmp, () => {}, fakeRenameFile);
        assert.equal(fs.existsSync(tmp), false);
        assert.equal(fs.existsSync(tmp + '.1'), true);
        assert.equal(attempts, 3);
    } finally {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        if (fs.existsSync(tmp + '.1')) fs.unlinkSync(tmp + '.1');
    }
});

// -----------------------------------------------------------------------------
test('isLoopbackRemote: 127.0.0.1 ok', () => {
    const req = { socket: { remoteAddress: '127.0.0.1' }, headers: {} };
    assert.equal(handler.isLoopbackRemote(req), true);
});

test('isLoopbackRemote: ::1 ok', () => {
    const req = { socket: { remoteAddress: '::1' }, headers: {} };
    assert.equal(handler.isLoopbackRemote(req), true);
});

test('isLoopbackRemote: ::ffff:127.0.0.1 ok (IPv4-mapped)', () => {
    const req = { socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: {} };
    assert.equal(handler.isLoopbackRemote(req), true);
});

test('isLoopbackRemote: IP externa rechaza', () => {
    const req = { socket: { remoteAddress: '192.168.1.10' }, headers: {} };
    assert.equal(handler.isLoopbackRemote(req), false);
});

// -----------------------------------------------------------------------------
test('hasValidOrigin: sin Origin ni Referer → ok (curl/tests locales)', () => {
    const req = { headers: {} };
    assert.equal(handler.hasValidOrigin(req), true);
});

test('hasValidOrigin: Origin localhost:3200 ok', () => {
    const req = { headers: { origin: 'http://localhost:3200' } };
    assert.equal(handler.hasValidOrigin(req), true);
});

test('hasValidOrigin: Origin distinto → rechaza', () => {
    const req = { headers: { origin: 'http://evil.com' } };
    assert.equal(handler.hasValidOrigin(req), false);
});

test('hasValidOrigin: Referer válido ok', () => {
    const req = { headers: { referer: 'http://127.0.0.1:3200/logs/view/3559.guru.log' } };
    assert.equal(handler.hasValidOrigin(req), true);
});

// -----------------------------------------------------------------------------
test('appendChatEntry: escribe línea JSONL en el archivo', async () => {
    const tmp = uniqueTmpPath('chat-append-');
    const entry = {
        timestamp: '2026-05-29T12:00:00Z',
        type: 'operator_message',
        message_id: 'abc',
        message: 'hola',
        author: 'operator',
    };
    try {
        await handler.appendChatEntry(tmp, entry, () => {});
        const raw = fs.readFileSync(tmp, 'utf8');
        const lines = raw.split('\n').filter(Boolean);
        assert.equal(lines.length, 1);
        const parsed = JSON.parse(lines[0]);
        assert.equal(parsed.message_id, 'abc');
        assert.equal(parsed.message, 'hola');
    } finally {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        // cleanup del .lock por si quedó residual
        const lock = tmp + '.lock';
        if (fs.existsSync(lock)) fs.unlinkSync(lock);
    }
});
