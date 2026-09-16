'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withEnv } = require('../lib/test-helpers/with-env');

for (const scenario of ['cutover', 'fuera de ventana', 'pausa preexistente']) {
    test(`la degradación real encola la alerta y respeta el halt: ${scenario}`, (t) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opstate-wiring-5113-'));
        const backendPath = require.resolve('../lib/operational-state-backend');
        try {
            withEnv({ PIPELINE_DIR_OVERRIDE: dir, PIPELINE_OPSTATE_DURABLE: '1' }, () => {
                const windowOpen = scenario !== 'fuera de ventana';
                // Config efectiva aislada de la selección de proyecto del agente.
                t.mock.method(require('../lib/config-resolver'), 'resolve', () => ({
                    operational_state: { durable: true }, kernel: { cutover_window: windowOpen },
                }));
                fs.writeFileSync(path.join(dir, 'config.yaml'),
                    `operational_state:\n  durable: true\nkernel:\n  cutover_window: ${windowOpen}\n`);
                const pausePath = path.join(dir, '.paused');
                if (scenario === 'pausa preexistente') fs.writeFileSync(pausePath, 'pausa manual');
                delete require.cache[backendPath];
                const backend = require(backendPath);
                backend._setDriverForTests({
                    driver: { getItem() { throw new Error('ECONNRESET'); } },
                    spec: { tableName: 'intrale-kernel-coordination' },
                    projectId: 'intrale-platform', instanceId: 'fakeInstance', atomicUpdate: true,
                });
                // Sin sink falso: se recorren clasificador, notifier y dropfile reales.
                assert.equal(backend.readKeyWithVersion('partial-pause').degraded, true);
                assert.equal(fs.existsSync(pausePath), windowOpen);
                if (scenario === 'pausa preexistente') {
                    assert.equal(fs.readFileSync(pausePath, 'utf8'), 'pausa manual');
                } else if (windowOpen) {
                    assert.equal(JSON.parse(fs.readFileSync(pausePath)).source, 'kernel-cutover-degraded-halt');
                }
                const queue = path.join(dir, 'servicios', 'telegram', 'pendiente');
                const drops = fs.readdirSync(queue).filter((name) => name.endsWith('.json'));
                assert.equal(drops.length, 1);
                const payload = JSON.parse(fs.readFileSync(path.join(queue, drops[0]), 'utf8'));
                const text = payload.text.replace(/\\/g, '');
                assert.match(text, /Estado externo sin respuesta - dispatch denegado/);
                assert.match(text, /operational_state\.durable/);
                assert.match(text, /runbook-cutover-estado-operativo/);
                assert.doesNotMatch(text, /kernel\.durable|sigue por filesystem|catálogo durable/);
                // El rate-limit silencia el segundo aviso, pero nunca el halt.
                if (windowOpen) fs.unlinkSync(pausePath);
                backend.readKeyWithVersion('partial-pause');
                assert.equal(fs.existsSync(pausePath), windowOpen);
                assert.equal(fs.readdirSync(queue).filter((name) => name.endsWith('.json')).length, 1);
                console.log(JSON.stringify({ scenario, degraded: true, queueFiles: drops.length,
                    pausedExists: fs.existsSync(pausePath), rollbackFlag: 'operational_state.durable' }));
            });
        } finally {
            delete require.cache[backendPath];
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
}
