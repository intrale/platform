// =============================================================================
// Tests `activeAgents` — merge de presencia observacional del Sherlock (#4332)
//
// Cubre los CA verificables del merge en el slice:
//   - CA-1/CA-2/CA-5: presencia fresca se mergea como agente sintético con
//     observational:true / cancelable:false / hasLog:false, identificado como
//     "Sherlock" (issue:null).
//   - CA-4/SEC-4: presencia stale (sobre TTL) se ignora; archivo corrupto o fase
//     fuera del enum no rompe el slice.
//   - CA-5: el merge NO toca el issueMatrix ni inventa entries en `trabajando/`
//     → los contadores de concurrencia del pulpo jamás ven la presencia.
//   - UX-3: cuando coexisten Commander y Sherlock, el Commander queda primero y
//     el Sherlock inmediatamente al lado (adyacentes al frente de la banda).
//
// Ambas presencias se aíslan a tmp files monkeypatcheando `presencePath` de los
// módulos `commander-presence` / `sherlock-presence` (las MISMAS instancias
// cacheadas que captura el slice).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sherlock = require('../sherlock-presence');
const commander = require('../commander-presence');
const slices = require('../dashboard-slices');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-active-sherlock-'));
const SHERLOCK_FILE = path.join(TMP_DIR, 'sherlock-presence.json');
const COMMANDER_FILE = path.join(TMP_DIR, 'commander-presence.json');
sherlock.presencePath = () => SHERLOCK_FILE;
commander.presencePath = () => COMMANDER_FILE;

function clearFiles() {
    try { fs.rmSync(SHERLOCK_FILE, { force: true }); } catch { /* noop */ }
    try { fs.rmSync(COMMANDER_FILE, { force: true }); } catch { /* noop */ }
}

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

test('CA-1/CA-2/CA-5: presencia fresca del Sherlock se mergea como agente sintético observacional', () => {
    clearFiles();
    fs.writeFileSync(SHERLOCK_FILE, JSON.stringify({ petitionId: 'sher1', fase: 'verificando', startedAt: Date.now() - 2000 }));

    const out = slices.activeAgents(stateWithRealAgent());
    const card = out.find(a => a.skill === 'sherlock');
    assert.ok(card, 'debe existir la card del Sherlock');
    assert.equal(card.observational, true);
    assert.equal(card.cancelable, false);
    assert.equal(card.hasLog, false);
    assert.equal(card.issue, null);
    assert.equal(card.title, 'Sherlock');
    assert.equal(card.fase, 'verificando');
    assert.equal(card.petitionId, 'sher1');
    assert.ok(card.durationMs >= 2000);
});

test('CA-5: el agente real sigue presente y el merge no inventa entries de fase', () => {
    clearFiles();
    fs.writeFileSync(SHERLOCK_FILE, JSON.stringify({ petitionId: 'sher2', fase: 'verificando', startedAt: Date.now() }));

    const state = stateWithRealAgent();
    const out = slices.activeAgents(state);

    const real = out.find(a => a.issue === '1732');
    assert.ok(real);
    assert.equal(real.skill, 'pipeline-dev');

    const fases = state.issueMatrix['1732'].fases['desarrollo/dev'];
    assert.equal(fases.length, 1, 'no se agregaron entries sintéticos al issueMatrix');
    assert.equal(fases.some(e => e.skill === 'sherlock'), false);

    const sherlocks = out.filter(a => a.skill === 'sherlock');
    assert.equal(sherlocks.length, 1);
    assert.equal(sherlocks[0].issue, null);
});

test('UX-3: Commander primero y Sherlock adyacente cuando coexisten', () => {
    clearFiles();
    fs.writeFileSync(COMMANDER_FILE, JSON.stringify({ petitionId: 'cmd1', fase: 'verificando', startedAt: Date.now() }));
    fs.writeFileSync(SHERLOCK_FILE, JSON.stringify({ petitionId: 'sher3', fase: 'verificando', startedAt: Date.now() }));

    const out = slices.activeAgents(stateWithRealAgent());
    assert.equal(out[0].skill, 'commander', 'Commander va primero');
    assert.equal(out[1].skill, 'sherlock', 'Sherlock inmediatamente al lado');
});

test('CA-4: presencia del Sherlock stale (sobre TTL ~5min) se ignora', () => {
    clearFiles();
    fs.writeFileSync(SHERLOCK_FILE, JSON.stringify({ petitionId: 'old', fase: 'verificando', startedAt: Date.now() - (6 * 60 * 1000) }));
    const out = slices.activeAgents(stateWithRealAgent());
    assert.equal(out.some(a => a.skill === 'sherlock'), false);
});

test('SEC-4: archivo corrupto o fase inválida no rompe el slice', () => {
    clearFiles();
    fs.writeFileSync(SHERLOCK_FILE, '{ corrupto sin cerrar');
    let out;
    assert.doesNotThrow(() => { out = slices.activeAgents(stateWithRealAgent()); });
    assert.ok(out.find(a => a.issue === '1732'));
    assert.equal(out.some(a => a.skill === 'sherlock'), false);

    clearFiles();
    fs.writeFileSync(SHERLOCK_FILE, JSON.stringify({ petitionId: 'x', fase: '<script>', startedAt: Date.now() }));
    const out2 = slices.activeAgents(stateWithRealAgent());
    assert.equal(out2.some(a => a.skill === 'sherlock'), false);
});

test('sin archivo de presencia del Sherlock, no aparece card sherlock', () => {
    clearFiles();
    const out = slices.activeAgents(stateWithRealAgent());
    assert.equal(out.some(a => a.skill === 'sherlock'), false);
});
