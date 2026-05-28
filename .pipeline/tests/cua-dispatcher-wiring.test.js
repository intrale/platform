// =============================================================================
// cua-dispatcher-wiring.test.js — Tests de wiring CUA end-to-end (issue #3541
// rebote rev-1).
//
// El primer pasaje del dev tenía dos gaps que el PO encontró en `aprobacion`:
//
//   Gap #1 — pulpo.js no pasaba el bloque `cua` cargado de `config.yaml` al
//            `createDispatcher`. Resultado: el `cuaEmitter` interno siempre
//            resolvía `enabled=false` (cfg viene undefined), aunque el operador
//            seteara `cua.enabled: true` en config.yaml. CA-FUNC-5/6 rotos en
//            producción.
//
//   Gap #2 — `commander-deterministic.js` (`buildDefaultHandlers`) no
//            propagaba `cuaOperatorChatIds` ni `allowedCuaCommands` desde
//            `rechazarDeps` al `createRechazarHandler`. Resultado: aun
//            arreglando Gap #1, `/rechazar <cua-cmd>` siempre caía en
//            `unauthorized_rebobinar` (CA-SEC-6 fail-closed total).
//
// Los tests previos (cua-notifications.test.js) ejercitaban el handler y el
// emitter en aislamiento, construyéndolos con opciones explícitas — eso por
// definición no detecta los gaps de wiring porque saltea el camino real.
//
// Este archivo ejercita `createDispatcher` con la API tal cual la llama pulpo:
//
//   - `options.cua = { config, pipelineRoot, telegramQueueDir, log }`
//   - `options.rechazarDeps = { cuaOperatorChatIds, allowedCuaCommands, ... }`
//
// y verifica los dos contratos:
//
//   1. `dispatcher.cuaEmitter.enabled === true` cuando `cua.config.enabled` es
//      true (Gap #1).
//   2. `dispatch({chat_id:'1', text:'/rechazar load-wave validation motivo'})`
//      con chat_id allowlisted devuelve OK y NO contiene "No autorizado"
//      (Gap #2).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const cd = require('../lib/commander-deterministic');

function mkTmp(name) {
    const dir = path.join(os.tmpdir(), `cua-wiring-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'audit'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'rejections'), { recursive: true });
    return dir;
}

function fullCuaConfig(overrides) {
    return Object.assign({
        enabled: true,
        kill_switch: false,
        notifiable_stages: ['init', 'validation', 'analysis', 'completion'],
        allowed_commands: ['load-wave', 'wave', 'validate-issue'],
        operator_chat_ids: ['1'],
        truncate_chars: 1500,
        dedup_window_hours: 1,
        max_attachment_bytes: 5 * 1024 * 1024,
        attachment_subroot: '',
        audit_file: null,
        audio_enabled: false,
    }, overrides || {});
}

function makeDispatcher(tmpDir, cuaCfg, dispatcherOverrides) {
    return cd.createDispatcher(Object.assign({
        pipelineRoot: tmpDir,
        logsDir: path.join(tmpDir, 'logs'),
        expectedChatId: '1',
        rateLimit: { burst: 100, ratePerMin: 1000 },
        destructiveCooldown: false,
        // Forma EXACTA en que pulpo.js cablea estas dependencias después del fix.
        cua: {
            config: cuaCfg,
            pipelineRoot: tmpDir,
            telegramQueueDir: path.join(tmpDir, 'queue'),
            log: () => {},
        },
        rechazarDeps: {
            auditDir: path.join(tmpDir, 'audit'),
            rejectionsDir: path.join(tmpDir, 'rejections'),
            whisperLocal: { transcribeLocal: async () => ({ ok: false }), isAvailable: () => false },
            githubClient: { viewIssue: () => ({ ok: false, error: 'no gh' }) },
            randomVariant: () => 1,
            cuaOperatorChatIds: Array.isArray(cuaCfg.operator_chat_ids) ? cuaCfg.operator_chat_ids : [],
            allowedCuaCommands: Array.isArray(cuaCfg.allowed_commands) ? cuaCfg.allowed_commands : [],
        },
    }, dispatcherOverrides || {}));
}

// ---------------------------------------------------------------------------
// Gap #1 — cua config llega al dispatcher → cuaEmitter.enabled = true.
// ---------------------------------------------------------------------------

test('Gap #1: createDispatcher con cua.config.enabled=true → cuaEmitter habilitado', () => {
    const tmp = mkTmp('gap1-enabled');
    const dispatcher = makeDispatcher(tmp, fullCuaConfig());

    assert.equal(dispatcher.cuaEmitter.enabled, true,
        'cuaEmitter.enabled debe ser true cuando cua.config.enabled=true llega vía createDispatcher');
    assert.deepEqual(dispatcher.cuaEmitter.allowedCommands.sort(),
        ['load-wave', 'validate-issue', 'wave'].sort(),
        'allowedCommands debe propagarse desde cua.config.allowed_commands');
    assert.deepEqual(dispatcher.cuaEmitter.notifiableStages,
        ['init', 'validation', 'analysis', 'completion'],
        'notifiableStages debe propagarse desde cua.config.notifiable_stages');
});

test('Gap #1: cua.config.enabled=false (o ausente) → cuaEmitter NO habilitado', () => {
    const tmp = mkTmp('gap1-disabled');
    const dispatcher = makeDispatcher(tmp, fullCuaConfig({ enabled: false }));
    assert.equal(dispatcher.cuaEmitter.enabled, false);
});

test('Gap #1: cua.config.kill_switch=true → cuaEmitter NO habilitado aunque enabled=true', () => {
    const tmp = mkTmp('gap1-killswitch');
    const dispatcher = makeDispatcher(tmp, fullCuaConfig({ kill_switch: true }));
    assert.equal(dispatcher.cuaEmitter.enabled, false);
});

test('Gap #1: createDispatcher SIN options.cua → cuaEmitter NO habilitado (default seguro)', () => {
    const tmp = mkTmp('gap1-no-cua');
    const dispatcher = cd.createDispatcher({
        pipelineRoot: tmp,
        logsDir: path.join(tmp, 'logs'),
        expectedChatId: '1',
        rateLimit: { burst: 100, ratePerMin: 1000 },
        destructiveCooldown: false,
    });
    assert.equal(dispatcher.cuaEmitter.enabled, false,
        'sin bloque cua, el dispatcher debe degradar a OFF (no romper)');
});

// ---------------------------------------------------------------------------
// Gap #1 (integración) — el wiring real produce un enqueue cuando se invoca
// un comando whitelisted desde el dispatcher.
// ---------------------------------------------------------------------------

test('Gap #1 integración: comando whitelisted dispara cuaEmit("init") con cfg correcta', () => {
    const tmp = mkTmp('gap1-emit');
    const dispatcher = makeDispatcher(tmp, fullCuaConfig());

    const emitResult = dispatcher.cuaEmit({
        command: 'load-wave',
        stage: 'init',
        status: 'in_progress',
        preview: '⏳ Comando init',
    });

    assert.equal(emitResult.ok, true, `emit init debe ser ok, reason=${emitResult.reason}`);
    assert.equal(emitResult.action, 'enqueued');
    const queueFiles = fs.readdirSync(path.join(tmp, 'queue'));
    assert.equal(queueFiles.length, 1, 'debe haber 1 dropfile en la queue de telegram');
    assert.match(queueFiles[0], /^\d+-cua-load-wave-init\.json$/);
});

test('Gap #1 integración: emit con cfg ausente (degradado) → skipped por disabled', () => {
    const tmp = mkTmp('gap1-emit-disabled');
    // Repetimos el escenario PRE-FIX: pulpo no pasa el bloque cua.
    const dispatcher = cd.createDispatcher({
        pipelineRoot: tmp,
        logsDir: path.join(tmp, 'logs'),
        expectedChatId: '1',
        rateLimit: { burst: 100, ratePerMin: 1000 },
        destructiveCooldown: false,
    });
    const emitResult = dispatcher.cuaEmit({
        command: 'load-wave',
        stage: 'init',
        status: 'in_progress',
        preview: 'init',
    });
    assert.equal(emitResult.ok, false);
    assert.equal(emitResult.reason, 'disabled');
});

// ---------------------------------------------------------------------------
// Gap #2 — cuaOperatorChatIds + allowedCuaCommands llegan al rechazar-handler.
// ---------------------------------------------------------------------------

test('Gap #2: chat_id allowlisted + comando whitelisted → /rechazar CUA NO devuelve unauthorized', async () => {
    const tmp = mkTmp('gap2-authorized');
    const dispatcher = makeDispatcher(tmp, fullCuaConfig({ operator_chat_ids: ['1'] }));

    const r = await dispatcher.dispatch({
        chat_id: '1',
        from: 'leo',
        text: '/rechazar load-wave validation no me cierra la ola',
    });

    assert.ok(r.reply, 'debe haber reply');
    assert.ok(!/No autorizado/i.test(r.reply),
        `con chat_id allowlisted, /rechazar CUA NO debe responder "No autorizado". reply=${JSON.stringify(r.reply)}`);
    assert.ok(!/No conozco el comando CUA/i.test(r.reply),
        `con comando whitelisted, NO debe responder "comando desconocido". reply=${JSON.stringify(r.reply)}`);
    // CA-SEC-6: si el wiring funcionó, debe haber un evento JSON de rebobinado.
    const events = fs.readdirSync(path.join(tmp, 'rejections'));
    assert.equal(events.length, 1, `debe haberse persistido el evento de rebobinado. events=${JSON.stringify(events)}`);
    assert.match(events[0], /^cua-load-wave-validation-\d+\.json$/);
});

test('Gap #2: chat_id NO allowlisted → /rechazar CUA devuelve unauthorized (fail-closed)', async () => {
    const tmp = mkTmp('gap2-unauthorized');
    const dispatcher = makeDispatcher(tmp, fullCuaConfig({ operator_chat_ids: ['9999'] }), {
        expectedChatId: null, // desactivamos el filtro expectedChatId para no atajarlo antes
    });

    const r = await dispatcher.dispatch({
        chat_id: '1',
        from: 'mal',
        text: '/rechazar load-wave validation pruebo a colarme',
    });

    assert.ok(r.reply, 'debe haber reply');
    assert.match(r.reply, /No autorizado/i,
        `con chat_id no allowlisted, debe responder "No autorizado". reply=${JSON.stringify(r.reply)}`);
});

test('Gap #2: lista de comandos vacía → /rechazar CUA falla por invalid_cua_command', async () => {
    const tmp = mkTmp('gap2-empty-cmds');
    const dispatcher = makeDispatcher(tmp, fullCuaConfig({
        allowed_commands: [],
        operator_chat_ids: ['1'],
    }));

    const r = await dispatcher.dispatch({
        chat_id: '1',
        from: 'leo',
        text: '/rechazar load-wave validation nada',
    });

    assert.ok(r.reply);
    // Lista vacía hace que load-wave no esté permitido → handler responde con
    // "No conozco el comando CUA" o similar. Lo importante: NO debe responder
    // "No autorizado" (Gap #2 fail-closed por allowlist vacía de chat_ids).
    assert.ok(!/No autorizado/i.test(r.reply),
        `con chat_id allowlisted, falla por comando no por chat_id. reply=${JSON.stringify(r.reply)}`);
});
