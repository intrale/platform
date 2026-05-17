// =============================================================================
// commander-quota-cooldown.test.js — Tests del modo degradado del Commander
// Issue #3253 — Commander SPoF en Claude (path a)
//
// Cubre:
//   - CA-1  → `/quota` read-only (estado activo / vacío / corrupto)
//   - CA-S1 → `/quota` con args mutativos (clear/reset/delete/force) NO toca FS
//   - CA-S2 → respuesta de `/quota` SOLO usa campos whitelisted (sin JSON crudo)
//   - CA-4  → cooldown ≥60s en /restart, /limpiar, /ghostbusters, /reset
//   - CA-5  → integración: `/quota` clasifica como deterministic + args strict
//
// Ejecutar:  node --test .pipeline/lib/__tests__/commander-quota-cooldown.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const commanderDet = require('../commander-deterministic');
const {
    createDestructiveCooldown,
    humanizeRetryAfter,
    DEFAULT_DESTRUCTIVE_COMMANDS,
} = require('../commander/destructive-cooldown');
const { clearCache } = require('../commander/fill-template');

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function makeTmpPipeline() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-3253-'));
    const logsDir = path.join(dir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    return { dir, logsDir };
}

function cleanup(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function writeFlag(pipelineDir, payload) {
    fs.writeFileSync(path.join(pipelineDir, 'quota-exhausted.json'), JSON.stringify(payload, null, 2));
}

// -----------------------------------------------------------------------------
// CA-1 — /quota read-only — clasificación + handler
// -----------------------------------------------------------------------------

test('CA-1: classify /quota como deterministic', () => {
    const r = commanderDet.classify('/quota');
    assert.equal(r.class, 'deterministic');
    assert.equal(r.command, 'quota');
});

test('CA-1: classify "cuota claude" (NLP) como deterministic', () => {
    const r = commanderDet.classify('cuota claude');
    assert.equal(r.class, 'deterministic');
    assert.equal(r.command, 'quota');
});

test('CA-1: /quota sin flag activo responde "cuota disponible"', async () => {
    const { dir, logsDir } = makeTmpPipeline();
    clearCache();
    try {
        const dispatcher = commanderDet.createDispatcher({
            pipelineRoot: dir,
            logsDir,
            destructiveCooldown: false,
        });
        const result = await dispatcher.dispatch({ chat_id: '1', from: 'Leo', text: '/quota' });
        assert.equal(result.status, 'ok');
        assert.equal(result.handler, 'quota');
        assert.ok(/cuota disponible/i.test(result.reply), `reply esperada con "cuota disponible", got: ${result.reply}`);
        assert.ok(!/exhausted/i.test(result.reply), 'no debe filtrar campo crudo "exhausted"');
    } finally {
        cleanup(dir);
    }
});

test('CA-1: /quota con flag activo responde con campos whitelisted', async () => {
    const { dir, logsDir } = makeTmpPipeline();
    clearCache();
    try {
        const detected = new Date(Date.now() - 47 * 60 * 1000); // hace 47 min
        const resets = new Date(Date.now() + 13 * 60 * 1000);   // en 13 min
        writeFlag(dir, {
            exhausted: true,
            provider: 'anthropic',
            model: 'claude-opus-4-7',
            resets_at: resets.toISOString(),
            detected_at: detected.toISOString(),
            pattern_matched: 'usage_limit_error',
            // Campo "interno" que NO debe leakear al reply (CA-S2).
            internal_path: 'C:\\Workspaces\\secret\\path\\to\\file.json',
        });

        const dispatcher = commanderDet.createDispatcher({
            pipelineRoot: dir,
            logsDir,
            destructiveCooldown: false,
        });
        const result = await dispatcher.dispatch({ chat_id: '1', from: 'Leo', text: '/quota' });
        assert.equal(result.status, 'ok');
        assert.equal(result.handler, 'quota');

        // CA-S2: el reply contiene los campos whitelisted (escapados MarkdownV2).
        assert.ok(/anthropic/.test(result.reply), 'provider debe estar presente');
        assert.ok(/usage/.test(result.reply) && /limit/.test(result.reply) && /error/.test(result.reply),
            'pattern_matched debe estar presente (escapado MarkdownV2 con \\_)');
        // CA-S2: NO debe filtrar paths internos ni el JSON crudo.
        assert.ok(!/internal_path/i.test(result.reply), 'no debe filtrar campos internos del JSON');
        assert.ok(!/C:\\\\Workspaces/i.test(result.reply), 'no debe filtrar paths absolutos');
        assert.ok(!/\bsecret\b/i.test(result.reply), 'no debe filtrar valores internos');
    } finally {
        cleanup(dir);
    }
});

test('CA-1: /quota con JSON corrupto responde safe-default (no leakea contenido crudo)', async () => {
    const { dir, logsDir } = makeTmpPipeline();
    clearCache();
    try {
        fs.writeFileSync(path.join(dir, 'quota-exhausted.json'), '{{{not valid json — secret_token=AAAAA');
        const dispatcher = commanderDet.createDispatcher({
            pipelineRoot: dir,
            logsDir,
            destructiveCooldown: false,
        });
        const result = await dispatcher.dispatch({ chat_id: '1', from: 'Leo', text: '/quota' });
        assert.equal(result.status, 'ok');
        // Safe-default: responde como si no hubiera flag (CA-S2).
        assert.ok(/cuota disponible/i.test(result.reply));
        // CRÍTICO: no debe emitir el JSON crudo ni el token.
        assert.ok(!/secret_token/i.test(result.reply), 'NO debe filtrar contenido crudo del JSON corrupto');
        assert.ok(!/AAAAA/i.test(result.reply));
    } finally {
        cleanup(dir);
    }
});

// -----------------------------------------------------------------------------
// CA-S1 — /quota es read-only, args mutativos rechazan sin tocar FS
// -----------------------------------------------------------------------------

test('CA-S1: /quota clear rechaza args y NO toca el archivo', async () => {
    const { dir, logsDir } = makeTmpPipeline();
    clearCache();
    const flagPath = path.join(dir, 'quota-exhausted.json');
    try {
        writeFlag(dir, {
            exhausted: true,
            provider: 'anthropic',
            resets_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            detected_at: new Date().toISOString(),
            pattern_matched: 'usage_limit_error',
        });
        const before = fs.readFileSync(flagPath, 'utf8');

        const dispatcher = commanderDet.createDispatcher({
            pipelineRoot: dir,
            logsDir,
            destructiveCooldown: false,
        });
        // Probar cada variante mutativa
        for (const args of ['clear', 'reset', 'delete', 'force', '--clear']) {
            const result = await dispatcher.dispatch({
                chat_id: '1',
                from: 'Leo',
                text: `/quota ${args}`,
            });
            assert.equal(result.status, 'invalid_args', `${args} debe rechazarse como invalid_args`);
            // Validar que el archivo NO fue modificado en ningún caso.
            const after = fs.readFileSync(flagPath, 'utf8');
            assert.equal(after, before, `/quota ${args} NO debe modificar el archivo`);
        }
    } finally {
        cleanup(dir);
    }
});

test('CA-S1: validateArgs rechaza /quota con argumentos (cualquiera)', () => {
    // Sin args → OK
    assert.equal(commanderDet.validateArgs('quota', '').ok, true);
    assert.equal(commanderDet.validateArgs('quota', '   ').ok, true);
    // Cualquier arg → inválido
    for (const args of ['clear', 'reset', 'delete', 'force', '--clear', 'anything', '1', 'x']) {
        const r = commanderDet.validateArgs('quota', args);
        assert.equal(r.ok, false, `quota "${args}" debe ser invalid_args`);
    }
});

// -----------------------------------------------------------------------------
// CA-4 — Cooldown destructivo
// -----------------------------------------------------------------------------

test('CA-4: createDestructiveCooldown identifica restart/limpiar/ghostbusters/reset', () => {
    const cd = createDestructiveCooldown();
    assert.equal(cd.isDestructive('restart'), true);
    assert.equal(cd.isDestructive('limpiar'), true);
    assert.equal(cd.isDestructive('ghostbusters'), true);
    assert.equal(cd.isDestructive('reset'), true);
    assert.equal(cd.isDestructive('RESTART'), true, 'normaliza case');
    // No destructivos:
    assert.equal(cd.isDestructive('status'), false);
    assert.equal(cd.isDestructive('quota'), false);
    assert.equal(cd.isDestructive('snapshot'), false);
});

test('CA-4: cooldown bloquea segunda invocación dentro de 60s', () => {
    let clock = 1_000_000;
    const cd = createDestructiveCooldown({ cooldownMs: 60_000, now: () => clock });

    // Primera invocación: permitido
    let c = cd.check('chat-1', 'restart');
    assert.equal(c.allowed, true);
    cd.recordSuccess('chat-1', 'restart');

    // 30s después: bloqueado, retryAfterMs ≈ 30s
    clock += 30_000;
    c = cd.check('chat-1', 'restart');
    assert.equal(c.allowed, false);
    assert.ok(c.retryAfterMs > 25_000 && c.retryAfterMs <= 30_000);

    // 60s después: permitido de nuevo
    clock += 31_000; // total elapsed 61s desde recordSuccess
    c = cd.check('chat-1', 'restart');
    assert.equal(c.allowed, true);
});

test('CA-4: cooldown por (chatId, command) — chats distintos no se afectan', () => {
    let clock = 1_000_000;
    const cd = createDestructiveCooldown({ cooldownMs: 60_000, now: () => clock });
    cd.recordSuccess('chat-A', 'restart');
    // Otro chat puede ejecutar restart aunque chat-A esté en cooldown
    assert.equal(cd.check('chat-B', 'restart').allowed, true);
    // Y chat-A puede ejecutar otro comando destructivo (limpiar)
    assert.equal(cd.check('chat-A', 'limpiar').allowed, true);
    // Pero NO restart
    assert.equal(cd.check('chat-A', 'restart').allowed, false);
});

test('CA-4: dispatcher rechaza restart consecutivo con status="cooldown"', async () => {
    const { dir, logsDir } = makeTmpPipeline();
    clearCache();
    let clock = 1_000_000;
    try {
        const dispatcher = commanderDet.createDispatcher({
            pipelineRoot: dir,
            logsDir,
            destructiveCooldown: { cooldownMs: 60_000 },
            now: () => clock,
            // El handler de restart vive en pulpo.js — acá inyectamos uno
            // dummy que devuelve un texto. El dispatcher debe registrar
            // success y a partir de ahí bloquear hasta cumplir cooldown.
            handlers: {
                restart: async () => '🔄 Reinicio simulado en progreso',
            },
        });
        // Primer /restart: pasa
        const first = await dispatcher.dispatch({ chat_id: '999', from: 'Leo', text: '/restart' });
        assert.equal(first.status, 'ok');
        assert.equal(first.handler, 'restart');
        assert.ok(first.reply && first.reply.length > 0);

        // 10s después: rechazado por cooldown
        clock += 10_000;
        const second = await dispatcher.dispatch({ chat_id: '999', from: 'Leo', text: '/restart' });
        assert.equal(second.status, 'cooldown');
        assert.ok(/cooldown/i.test(second.reply), `reply debe mencionar cooldown: ${second.reply}`);
        assert.ok(/restart/i.test(second.reply), 'reply debe mencionar el comando');

        // 60s después de recordSuccess: permitido
        clock += 60_000;
        const third = await dispatcher.dispatch({ chat_id: '999', from: 'Leo', text: '/restart' });
        assert.equal(third.status, 'ok');
    } finally {
        cleanup(dir);
    }
});

test('CA-4: dispatcher con destructiveCooldown:false no aplica cooldown', async () => {
    const { dir, logsDir } = makeTmpPipeline();
    clearCache();
    try {
        const dispatcher = commanderDet.createDispatcher({
            pipelineRoot: dir,
            logsDir,
            destructiveCooldown: false,
            handlers: {
                restart: async () => '🔄 ok',
            },
        });
        const a = await dispatcher.dispatch({ chat_id: '7', from: 'Leo', text: '/restart' });
        const b = await dispatcher.dispatch({ chat_id: '7', from: 'Leo', text: '/restart' });
        assert.equal(a.status, 'ok');
        assert.equal(b.status, 'ok');
    } finally {
        cleanup(dir);
    }
});

test('CA-4: markDestructiveSuccess para handlers legacy en pulpo.js', async () => {
    const { dir, logsDir } = makeTmpPipeline();
    clearCache();
    let clock = 1_000_000;
    try {
        const dispatcher = commanderDet.createDispatcher({
            pipelineRoot: dir,
            logsDir,
            destructiveCooldown: { cooldownMs: 60_000 },
            now: () => clock,
            // Sin handler restart en el dispatcher (simula que el handler
            // vive en pulpo.js via switch case legacy). El dispatcher
            // devuelve no_handler.
        });
        const r1 = await dispatcher.dispatch({ chat_id: '8', from: 'Leo', text: '/restart' });
        assert.equal(r1.status, 'no_handler');

        // pulpo.js confirmó éxito → marca manualmente
        const marked = dispatcher.markDestructiveSuccess('8', 'restart');
        assert.equal(marked, true);

        // Ahora un nuevo /restart cae en cooldown ANTES de llegar al handler
        const r2 = await dispatcher.dispatch({ chat_id: '8', from: 'Leo', text: '/restart' });
        assert.equal(r2.status, 'cooldown');
    } finally {
        cleanup(dir);
    }
});

test('CA-4: humanizeRetryAfter formatea correctamente', () => {
    assert.equal(humanizeRetryAfter(0), '0s');
    assert.equal(humanizeRetryAfter(500), '1s'); // ceil
    assert.equal(humanizeRetryAfter(45_000), '45s');
    assert.equal(humanizeRetryAfter(60_000), '1m');
    assert.equal(humanizeRetryAfter(75_000), '1m 15s');
    assert.equal(humanizeRetryAfter(120_000), '2m');
});

test('CA-4: checkDestructiveCooldown read-only no avanza el reloj', () => {
    let clock = 1_000_000;
    const { dir, logsDir } = makeTmpPipeline();
    clearCache();
    try {
        const dispatcher = commanderDet.createDispatcher({
            pipelineRoot: dir,
            logsDir,
            destructiveCooldown: { cooldownMs: 60_000 },
            now: () => clock,
        });
        // Sin recordSuccess previo → siempre allowed, no importa cuántas veces consultes
        for (let i = 0; i < 5; i += 1) {
            const c = dispatcher.checkDestructiveCooldown('z', 'restart');
            assert.equal(c.allowed, true);
        }
    } finally {
        cleanup(dir);
    }
});

// -----------------------------------------------------------------------------
// CA-5 — Integración: /quota dentro de la pista determinista
// -----------------------------------------------------------------------------

test('CA-5: /quota figura en DETERMINISTIC_SLASH (allowlist explícita)', () => {
    assert.ok(commanderDet.DETERMINISTIC_SLASH.has('quota'),
        'commander-deterministic.DETERMINISTIC_SLASH debe contener "quota"');
});

test('CA-5: /quota tiene ARG_SCHEMAS estricto (read-only)', () => {
    assert.ok(commanderDet.ARG_SCHEMAS.quota,
        'commander-deterministic.ARG_SCHEMAS.quota debe estar definido');
    // El allow() debe rechazar args no vacíos
    assert.equal(commanderDet.ARG_SCHEMAS.quota.allow(''), true);
    assert.equal(commanderDet.ARG_SCHEMAS.quota.allow('clear'), false);
});

test('CA-5: DEFAULT_DESTRUCTIVE_COMMANDS cubre restart, limpiar, ghostbusters, reset', () => {
    const cmds = new Set([...DEFAULT_DESTRUCTIVE_COMMANDS]);
    for (const c of ['restart', 'limpiar', 'ghostbusters', 'reset']) {
        assert.ok(cmds.has(c), `DEFAULT_DESTRUCTIVE_COMMANDS debe incluir "${c}"`);
    }
});
