// =============================================================================
// Tests equipo view — link de log para agentes observacionales (#4335).
//
// Antes, `teamAgentRow` ocultaba el link de log a los agentes observacionales
// (Commander/Sherlock) con el guard `!observational`. Ahora, si el slice resolvió
// un `.log` fresco (`hasLog:true` + `logFile`), la fila DEBE renderizar el link
// `/logs/view/<file>?live=1`. Sin log fresco (`hasLog:false`) → sin link.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const equipo = require('../views/dashboard/equipo');

test('observacional con hasLog:true renderiza link de log en vivo', () => {
    const html = equipo.teamAgentRow({
        issue: null, title: 'Commander', skill: 'commander', fase: 'pensando',
        observational: true, cancelable: false,
        hasLog: true, logFile: 'commander-42-1699999999999.log',
        durationMs: 3000,
    });
    assert.match(html, /\/logs\/view\/commander-42-1699999999999\.log\?live=1/,
        'debe incluir el href al log en vivo');
    assert.match(html, /eq-ag-log/, 'debe renderizar el anchor de log');
    // Sigue siendo no cancelable (protegido).
    assert.match(html, /protegido/);
});

test('observacional Sherlock con hasLog:true renderiza link', () => {
    const html = equipo.teamAgentRow({
        issue: null, title: 'Sherlock', skill: 'sherlock', fase: 'verificando',
        observational: true, cancelable: false,
        hasLog: true, logFile: 'sherlock-42-1699999999999-sherlock.log',
        durationMs: 1200,
    });
    assert.match(html, /\/logs\/view\/sherlock-42-1699999999999-sherlock\.log\?live=1/);
});

test('observacional sin log fresco (hasLog:false) NO renderiza link (sin fantasma)', () => {
    const html = equipo.teamAgentRow({
        issue: null, title: 'Commander', skill: 'commander', fase: 'pensando',
        observational: true, cancelable: false,
        hasLog: false,
        durationMs: 3000,
    });
    assert.ok(!/eq-ag-log/.test(html), 'sin log fresco no debe haber anchor de log');
    assert.ok(!/\/logs\/view\//.test(html), 'sin href a log');
});

test('agente real (no observacional) con hasLog conserva su link', () => {
    const html = equipo.teamAgentRow({
        issue: '1732', title: 'Issue', skill: 'pipeline-dev', fase: 'dev',
        observational: false, cancelable: true,
        hasLog: true, logFile: '1732-pipeline-dev.log',
        durationMs: 5000,
    });
    assert.match(html, /\/logs\/view\/1732-pipeline-dev\.log\?live=1/);
    assert.match(html, /cancelar/, 'agente real sigue siendo cancelable');
});
