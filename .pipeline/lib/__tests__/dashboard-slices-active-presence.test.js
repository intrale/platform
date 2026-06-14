// =============================================================================
// Tests `activeAgents` — merge de presencia observacional del Commander (#3948)
//
// Cubre los CA verificables del merge en el slice:
//   - CA-1/CA-3/CA-4: presencia fresca se mergea como agente sintético con
//     observational:true / cancelable:false / hasLog:false, identificado como
//     "Commander" (issue:null).
//   - CA-8/SEC-4: presencia stale (sobre TTL) se ignora; archivo corrupto no
//     rompe el slice.
//   - CA-2: el merge NO toca el issueMatrix ni inventa entries en `trabajando/`
//     → los contadores de concurrencia del pulpo (que sólo escanean
//     `trabajando/`) jamás ven la presencia.
//
// La presencia se aísla a un tmp file monkeypatcheando `presencePath` del módulo
// `commander-presence` (la MISMA instancia cacheada que captura el slice).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const presence = require('../commander-presence');
const slices = require('../dashboard-slices');

// Redirigir la ruta de presencia a un tmp file controlado por el test. El slice
// llama `commanderPresence.presencePath()` (sin args) en runtime, así que con
// sobreescribir el método sobre la instancia cacheada alcanza.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-active-presence-'));
const PRES_FILE = path.join(TMP_DIR, 'commander-presence.json');
presence.presencePath = () => PRES_FILE;

function clearPresFile() {
    try { fs.rmSync(PRES_FILE, { force: true }); } catch { /* noop */ }
}

// Estado mínimo con un agente real en `trabajando/` para verificar coexistencia.
function stateWithRealAgent() {
    return {
        issueMatrix: {
            '1732': {
                title: 'Issue real',
                estadoActual: 'trabajando',
                faseActual: 'desarrollo/dev',
                fases: {
                    'desarrollo/dev': [
                        { skill: 'pipeline-dev', pipeline: 'desarrollo', fase: 'dev', estado: 'trabajando', durationMs: 120000 },
                    ],
                },
            },
        },
        etaAverages: {},
    };
}

test('CA-1/CA-3/CA-4: presencia fresca se mergea como agente sintético observacional', () => {
    clearPresFile();
    fs.writeFileSync(PRES_FILE, JSON.stringify({ petitionId: 'opaque1', fase: 'pensando', startedAt: Date.now() - 3000 }));

    const out = slices.activeAgents(stateWithRealAgent());
    const commander = out.find(a => a.skill === 'commander');
    assert.ok(commander, 'debe existir la card del Commander');
    assert.equal(commander.observational, true);
    assert.equal(commander.cancelable, false);
    assert.equal(commander.hasLog, false);
    assert.equal(commander.issue, null);
    assert.equal(commander.title, 'Commander');
    assert.equal(commander.fase, 'pensando');
    assert.equal(commander.petitionId, 'opaque1');
    assert.ok(commander.durationMs >= 3000);
});

test('CA-2: el agente real sigue presente y el merge no inventa entries de fase', () => {
    clearPresFile();
    fs.writeFileSync(PRES_FILE, JSON.stringify({ petitionId: 'opaque2', fase: 'verificando', startedAt: Date.now() }));

    const state = stateWithRealAgent();
    const out = slices.activeAgents(state);

    // El agente real persiste.
    const real = out.find(a => a.issue === '1732');
    assert.ok(real);
    assert.equal(real.skill, 'pipeline-dev');

    // El merge NO mutó el issueMatrix (canal separado, no work-file en trabajando/).
    const fases = state.issueMatrix['1732'].fases['desarrollo/dev'];
    assert.equal(fases.length, 1, 'no se agregaron entries sintéticos al issueMatrix');
    assert.equal(fases.some(e => e.skill === 'commander'), false);

    // Exactamente UNA card de commander (la sintética), sin issue asociado.
    const commanders = out.filter(a => a.skill === 'commander');
    assert.equal(commanders.length, 1);
    assert.equal(commanders[0].issue, null);
});

test('CA-8: presencia stale (sobre TTL ~5min) se ignora', () => {
    clearPresFile();
    fs.writeFileSync(PRES_FILE, JSON.stringify({ petitionId: 'old', fase: 'pensando', startedAt: Date.now() - (6 * 60 * 1000) }));
    const out = slices.activeAgents(stateWithRealAgent());
    assert.equal(out.some(a => a.skill === 'commander'), false);
});

test('SEC-4: archivo de presencia corrupto no rompe el slice', () => {
    clearPresFile();
    fs.writeFileSync(PRES_FILE, '{ corrupto sin cerrar');
    let out;
    assert.doesNotThrow(() => { out = slices.activeAgents(stateWithRealAgent()); });
    // El agente real sigue, sin card de commander.
    assert.ok(out.find(a => a.issue === '1732'));
    assert.equal(out.some(a => a.skill === 'commander'), false);
});

test('SEC-2: fase fuera del enum en el archivo se ignora (defensa en profundidad)', () => {
    clearPresFile();
    fs.writeFileSync(PRES_FILE, JSON.stringify({ petitionId: 'x', fase: '<script>', startedAt: Date.now() }));
    const out = slices.activeAgents(stateWithRealAgent());
    assert.equal(out.some(a => a.skill === 'commander'), false);
});

test('sin archivo de presencia, activeAgents devuelve sólo agentes reales', () => {
    clearPresFile();
    const out = slices.activeAgents(stateWithRealAgent());
    assert.equal(out.length, 1);
    assert.equal(out[0].issue, '1732');
});
