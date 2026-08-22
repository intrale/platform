// Tests de las acciones rápidas de needs-human en commander-deterministic (#4068)
// Cubren CA-Q2: cada acción nueva (mas-contexto, devolver-definicion, priorizar)
// registra authorized (operador en allowlist) y unauthorized (fuera de allowlist).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createDispatcher } = require('../commander-deterministic');

function tmpLogs() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-qa-'));
}

// humanBlock fake: captura ejecuciones y audits, validación real de acciones.
function fakeHumanBlock() {
    const executed = [];
    const audited = [];
    return {
        executed, audited,
        isQuickAction: (a) => ['unblock', 'mas-contexto', 'devolver-definicion', 'priorizar'].includes(a),
        executeQuickAction: ({ issue, action }) => { executed.push({ issue, action }); return { ok: true, action, issue, msg: `ok ${action} #${issue}` }; },
        auditQuickAction: (e) => { audited.push(e); return e; },
    };
}

function makeDispatcher(hb, operatorChatIds) {
    return createDispatcher({
        pipelineRoot: '.pipeline',
        logsDir: tmpLogs(),
        destructiveCooldown: false,
        humanBlock: hb,
        rechazarDeps: { cuaOperatorChatIds: operatorChatIds || [] },
    });
}

const ACTIONS = ['mas-contexto', 'devolver-definicion', 'priorizar'];

for (const action of ACTIONS) {
    test(`#4068 /${action} <issue> con operador autorizado → ejecuta + audita authorized`, async () => {
        const hb = fakeHumanBlock();
        // allowlist con el chat del operador; el mensaje viene de ese chat.
        const d = makeDispatcher(hb, ['123']);
        const r = await d.dispatch({ text: `/${action} 4068`, chat_id: '123', from: 'Leo' });
        assert.equal(r.status, 'ok');
        assert.match(r.reply, /✅/);
        assert.deepEqual(hb.executed, [{ issue: 4068, action }]);
        const a = hb.audited.find(x => x.result_status === 'authorized');
        assert.ok(a, 'auditó authorized');
        assert.equal(a.issue, 4068);
        assert.equal(a.action, action);
    });

    test(`#4068 /${action} <issue> con origen NO autorizado → no ejecuta + audita unauthorized`, async () => {
        const hb = fakeHumanBlock();
        // allowlist exige chat 999; el mensaje viene de otro chat.
        const d = makeDispatcher(hb, ['999']);
        const r = await d.dispatch({ text: `/${action} 4068`, chat_id: '123', from: 'intruso' });
        assert.match(r.reply, /No estás autorizado/);
        assert.equal(hb.executed.length, 0, 'no ejecutó la acción');
        assert.ok(hb.audited.some(x => x.result_status === 'unauthorized'), 'auditó unauthorized');
    });
}

test('#4068 sin allowlist configurada, el filtro CHAT_ID del listener es el gate (autoriza)', async () => {
    const hb = fakeHumanBlock();
    const d = makeDispatcher(hb, []); // sin operatorChatIds
    const r = await d.dispatch({ text: '/priorizar 7', chat_id: '123', from: 'Leo' });
    assert.match(r.reply, /✅/);
    assert.equal(hb.executed.length, 1);
});

test('#4068 args inválidos (issue no numérico) rebotan en validación de args', async () => {
    const hb = fakeHumanBlock();
    const d = makeDispatcher(hb, []);
    const r = await d.dispatch({ text: '/priorizar abc', chat_id: '123' });
    assert.equal(r.status, 'invalid_args');
    assert.equal(hb.executed.length, 0);
});
