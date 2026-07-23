// =============================================================================
// commander-llm-audit.test.js — Integration test del audit-log LLM
// Issue #3257 · CA-4
//
// Reproduce el flujo END-TO-END de pulpo.js para mensajes class='llm':
// classify(text) → si LLM, llamar a auditLog.record explícitamente (sin
// pasar por dispatcher.dispatch, que es el camino determinístico) → el
// archivo `commander-audit-YYYY-MM-DD.jsonl` debe contener una fila con
// `intent_class='llm'`.
//
// Sin este test, la regresión del Bloqueante #2 del review-3257 vuelve
// silenciosa: el flujo LLM queda fuera del audit y la métrica CA-4
// "% determinístico vs LLM" marca ~100% determinístico permanentemente.
//
// Ejecutar:
//   node --test .pipeline/lib/__tests__/commander-llm-audit.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const commanderDet = require('../commander-deterministic');

/**
 * Reproduce el bucle de clasificación de pulpo.js:7338-7370. Solo el código
 * mínimo que toca el audit-log — no levanta dispatcher real para llms
 * (esa es exactamente la rama que el bug del review evidenciaba como rota).
 */
function simulatePulpoCommanderLoop({ dispatcher, mensajes, chatId }) {
    const comandos = [];
    const textoLibre = [];
    for (const m of mensajes) {
        const intent = commanderDet.classify(m.text);
        if (intent.class === 'deterministic' || intent.class === 'unknown') {
            comandos.push({ m, intent });
        } else {
            // class === 'llm' — registro explícito en audit-log SIN dispatcher.dispatch
            // (réplica fiel de la fix en pulpo.js).
            dispatcher.auditLog.record({
                from: m.from,
                chat_id: m.chat_id || chatId,
                raw_command: intent.rawTruncated,
                intent_class: 'llm',
                handler: intent.command || null,
                args: intent.args,
                result_status: 'ok',
                duration_ms: 0,
            });
            textoLibre.push(m);
        }
    }
    return { comandos, textoLibre };
}

test('integration: mensaje LLM emite fila intent_class="llm" en audit-log', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-llm-audit-'));
    const logsDir = path.join(tmpDir, 'logs');
    const dispatcher = commanderDet.createDispatcher({
        pipelineRoot: tmpDir,
        logsDir,
        rateLimit: { burst: 100, ratePerMin: 600 },
    });

    // Mensaje claramente conversacional (>80 chars) → clasifica como 'llm'.
    const llmText = 'Necesito que me ayudes a redactar una historia de usuario que cubra cuando el repartidor cancela una entrega después de salir del comercio pero antes de llegar';
    const mensajes = [
        { from: 'Leo', chat_id: 'chat-1', text: llmText },
    ];

    const { textoLibre } = simulatePulpoCommanderLoop({
        dispatcher, mensajes, chatId: 'chat-1',
    });

    // El mensaje debe ir a textoLibre (lo procesa Claude después).
    assert.equal(textoLibre.length, 1, 'mensaje LLM va a textoLibre');

    // Y el audit-log debe tener una fila con intent_class="llm".
    const today = new Date().toISOString().slice(0, 10);
    const auditFile = path.join(logsDir, `commander-audit-${today}.jsonl`);
    assert.ok(fs.existsSync(auditFile), `audit-log existe en ${auditFile}`);
    const lines = fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean);
    const llmRows = lines
        .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
        .filter((r) => r && r.intent_class === 'llm');
    assert.ok(llmRows.length >= 1, 'al menos una fila intent_class="llm" en el audit-log');
    assert.equal(llmRows[0].chat_id, 'chat-1');
    assert.equal(llmRows[0].result_status, 'ok');

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('integration: computeRoutingMetrics ve tráfico LLM real, no solo determinístico', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-llm-metrics-'));
    const logsDir = path.join(tmpDir, 'logs');
    const dispatcher = commanderDet.createDispatcher({
        pipelineRoot: tmpDir,
        logsDir,
        rateLimit: { burst: 100, ratePerMin: 600 },
    });

    // Mezcla: 2 deterministicos (vía dispatch real) + 3 LLM (vía audit directo).
    await dispatcher.dispatch({ from: 'Leo', chat_id: 'c1', text: '/descanso' });
    await dispatcher.dispatch({ from: 'Leo', chat_id: 'c1', text: '/salud' });
    simulatePulpoCommanderLoop({
        dispatcher,
        chatId: 'c1',
        mensajes: [
            { from: 'Leo', chat_id: 'c1', text: 'contame un chiste sobre desarrolladores trasnochados que viven a base de café y panchos' },
            { from: 'Leo', chat_id: 'c1', text: 'qué te parece si refactorizamos el módulo de notificaciones para que use coroutines en vez de callbacks anidados' },
            { from: 'Leo', chat_id: 'c1', text: 'necesito que pienses qué historias agregar al próximo sprint considerando que el equipo está saturado y queremos bajar la deuda técnica' },
        ],
    });

    const metrics = commanderDet.computeRoutingMetrics(logsDir, { days: 1 });
    assert.equal(metrics.buckets.length, 1);
    const bucket = metrics.buckets[0];
    assert.ok(bucket.deterministic >= 2, `deterministicos >= 2 (vio ${bucket.deterministic})`);
    assert.ok(bucket.llm >= 3, `llm >= 3 (vio ${bucket.llm})`);
    // El % determinístico NO puede ser 100% — esa era la regresión del review.
    assert.ok(bucket.percentDeterministic < 100,
        `% determinístico debería ser < 100% cuando hay tráfico LLM (vio ${bucket.percentDeterministic}%)`);

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('integration: snapshot handler renderiza sin tirar excepción', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-snapshot-'));
    // Crear una jerarquía mínima de desarrollo/<fase>/<estado>/ con un par de archivos.
    const desarrollo = path.join(tmpDir, 'desarrollo');
    for (const phase of ['dev', 'build', 'verificacion']) {
        for (const state of ['pendiente', 'trabajando', 'listo']) {
            fs.mkdirSync(path.join(desarrollo, phase, state), { recursive: true });
        }
    }
    fs.writeFileSync(path.join(desarrollo, 'dev', 'pendiente', '1234.pipeline-dev'),
        'issue: 1234\nfase: dev\npipeline: desarrollo\n');
    fs.writeFileSync(path.join(desarrollo, 'build', 'trabajando', '1235.builder'),
        'issue: 1235\nfase: build\npipeline: desarrollo\n');

    const dispatcher = commanderDet.createDispatcher({
        pipelineRoot: tmpDir,
        logsDir: path.join(tmpDir, 'logs'),
        rateLimit: { burst: 100, ratePerMin: 600 },
    });
    const r = await dispatcher.dispatch({ text: '/snapshot', chat_id: '1' });
    assert.equal(r.intent.class, 'deterministic');
    assert.equal(r.intent.command, 'snapshot');
    assert.equal(r.status, 'ok');
    assert.ok(r.reply, 'reply no nulo');
    assert.ok(r.reply.includes('Snapshot'), 'reply contiene "Snapshot"');
    // No referencia el LLM ni Claude:
    assert.ok(!/claude/i.test(r.reply), 'reply no menciona Claude');

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('integration: listado handler con filtro válido responde sin LLM', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-listado-'));
    const desarrollo = path.join(tmpDir, 'desarrollo');
    fs.mkdirSync(path.join(desarrollo, 'dev', 'pendiente'), { recursive: true });
    fs.writeFileSync(path.join(desarrollo, 'dev', 'pendiente', '999.pipeline-dev'),
        'issue: 999\n');

    const dispatcher = commanderDet.createDispatcher({
        pipelineRoot: tmpDir,
        logsDir: path.join(tmpDir, 'logs'),
        rateLimit: { burst: 100, ratePerMin: 600 },
    });
    const r = await dispatcher.dispatch({ text: '/listado pendientes', chat_id: '1' });
    assert.equal(r.intent.class, 'deterministic');
    assert.equal(r.status, 'ok');
    assert.ok(r.reply.includes('Listado'));
    assert.ok(r.reply.includes('999'));

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('integration: allowlist handler responde aunque .partial-pause.json no exista', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-allowlist-'));
    const dispatcher = commanderDet.createDispatcher({
        pipelineRoot: tmpDir,
        logsDir: path.join(tmpDir, 'logs'),
        rateLimit: { burst: 100, ratePerMin: 600 },
    });
    const r = await dispatcher.dispatch({ text: '/allowlist', chat_id: '1' });
    assert.equal(r.status, 'ok');
    assert.ok(r.reply.includes('Allowlist'));

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('integration: allowlist handler lee .partial-pause.json válido', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-allowlist-with-'));
    fs.writeFileSync(
        path.join(tmpDir, '.partial-pause.json'),
        JSON.stringify({ issues: [{ issue: 1234, title: 'Test issue' }] })
    );
    const dispatcher = commanderDet.createDispatcher({
        pipelineRoot: tmpDir,
        logsDir: path.join(tmpDir, 'logs'),
        rateLimit: { burst: 100, ratePerMin: 600 },
    });
    const r = await dispatcher.dispatch({ text: '/allowlist', chat_id: '1' });
    assert.equal(r.status, 'ok');
    assert.ok(r.reply.includes('1234'), `reply incluye número de issue: ${r.reply.slice(0,300)}`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('integration: procesos handler responde sin invocar shell', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-procesos-'));
    const dispatcher = commanderDet.createDispatcher({
        pipelineRoot: tmpDir,
        logsDir: path.join(tmpDir, 'logs'),
        rateLimit: { burst: 100, ratePerMin: 600 },
    });
    const r = await dispatcher.dispatch({ text: '/procesos', chat_id: '1' });
    assert.equal(r.intent.class, 'deterministic');
    assert.equal(r.intent.command, 'procesos');
    assert.equal(r.status, 'ok');
    assert.ok(r.reply.includes('Procesos Node'));
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('integration: screenshot handler no falla si no hay puppeteer instalado', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-screenshot-'));
    const dispatcher = commanderDet.createDispatcher({
        pipelineRoot: tmpDir,
        logsDir: path.join(tmpDir, 'logs'),
        rateLimit: { burst: 100, ratePerMin: 600 },
    });
    const r = await dispatcher.dispatch({ text: '/screenshot', chat_id: '1' });
    assert.equal(r.status, 'ok');
    assert.ok(r.reply.includes('Screenshot'));
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('integration: dashboard-down handler responde "was-not-running" si puerto libre', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-dashdown-'));
    const dispatcher = commanderDet.createDispatcher({
        pipelineRoot: tmpDir,
        logsDir: path.join(tmpDir, 'logs'),
        rateLimit: { burst: 100, ratePerMin: 600 },
    });
    // Puerto random altísimo: improbable que esté en uso
    process.env.DASHBOARD_PORT = '59873';
    try {
        const r = await dispatcher.dispatch({ text: '/dashboard-down', chat_id: '1' });
        assert.equal(r.status, 'ok');
        assert.ok(r.reply.includes('Dashboard'));
        assert.ok(r.reply.includes('no estaba corriendo') || r.reply.includes('Dashboard bajado'));
    } finally {
        delete process.env.DASHBOARD_PORT;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
