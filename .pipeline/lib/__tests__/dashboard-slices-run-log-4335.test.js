// =============================================================================
// Tests `activeAgents` — enganche del log de corrida a la card de presencia del
// Commander y del Sherlock (#4335).
//
// Cubre los CA del issue:
//   - Con un `commander-*.log` / `sherlock-*.log` reciente (mtime dentro del TTL)
//     la card expone `hasLog:true` + `logFile` = basename correcto.
//   - Con el log más reciente FUERA del TTL → `hasLog:false` (sin fantasma).
//   - Sin ningún log de corrida → `hasLog:false`.
//   - `resolveRecentRunLog` ignora sidecars (`.meta.json`) y sólo matchea `.log`.
//
// Se aísla LOG_DIR con `slices._setLogDir(tmp)` y las presencias con
// `presencePath` override (mismo patrón que el test de #4332).
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-runlog-4335-'));
const LOGS = path.join(TMP, 'logs');
fs.mkdirSync(LOGS, { recursive: true });
const SHERLOCK_FILE = path.join(TMP, 'sherlock-presence.json');
const COMMANDER_FILE = path.join(TMP, 'commander-presence.json');
sherlock.presencePath = () => SHERLOCK_FILE;
commander.presencePath = () => COMMANDER_FILE;
slices._setLogDir(LOGS);

function clearAll() {
    try { fs.rmSync(SHERLOCK_FILE, { force: true }); } catch { /* noop */ }
    try { fs.rmSync(COMMANDER_FILE, { force: true }); } catch { /* noop */ }
    for (const f of fs.readdirSync(LOGS)) { try { fs.rmSync(path.join(LOGS, f), { force: true }); } catch { /* noop */ } }
}

function writeLog(name, ageMs) {
    const p = path.join(LOGS, name);
    fs.writeFileSync(p, 'contenido de corrida\n');
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(p, t, t); // fijar mtime a "ageMs" en el pasado
}

const baseState = () => ({ issueMatrix: {}, etaAverages: {} });

test('Commander: log reciente dentro del TTL → hasLog:true + logFile correcto', () => {
    clearAll();
    fs.writeFileSync(COMMANDER_FILE, JSON.stringify({ petitionId: 'cmd', fase: 'pensando', startedAt: Date.now() - 1000 }));
    writeLog('commander-123-1751000000000.log', 5000);
    // sidecar que NO debe elegirse
    fs.writeFileSync(path.join(LOGS, 'commander-123-1751000000000.meta.json'), '{}');

    const out = slices.activeAgents(baseState());
    const card = out.find(a => a.skill === 'commander');
    assert.ok(card, 'card commander presente');
    assert.equal(card.hasLog, true);
    assert.equal(card.logFile, 'commander-123-1751000000000.log');
});

test('Sherlock: log reciente dentro del TTL → hasLog:true + logFile correcto', () => {
    clearAll();
    fs.writeFileSync(SHERLOCK_FILE, JSON.stringify({ petitionId: 's', fase: 'verificando', startedAt: Date.now() - 1000 }));
    writeLog('sherlock-123-sherlock.log', 3000);

    const out = slices.activeAgents(baseState());
    const card = out.find(a => a.skill === 'sherlock');
    assert.ok(card);
    assert.equal(card.hasLog, true);
    assert.equal(card.logFile, 'sherlock-123-sherlock.log');
});

test('elige el MÁS reciente por mtime entre varios', () => {
    clearAll();
    fs.writeFileSync(COMMANDER_FILE, JSON.stringify({ petitionId: 'cmd', fase: 'pensando', startedAt: Date.now() }));
    writeLog('commander-viejo.log', 120000);
    writeLog('commander-nuevo.log', 2000);

    const out = slices.activeAgents(baseState());
    const card = out.find(a => a.skill === 'commander');
    assert.equal(card.logFile, 'commander-nuevo.log');
});

test('log fuera del TTL (~5min) → hasLog:false (sin fantasma)', () => {
    clearAll();
    // presencia fresca, pero el log más reciente quedó viejo
    fs.writeFileSync(COMMANDER_FILE, JSON.stringify({ petitionId: 'cmd', fase: 'pensando', startedAt: Date.now() }));
    writeLog('commander-viejo.log', 6 * 60 * 1000);

    const out = slices.activeAgents(baseState());
    const card = out.find(a => a.skill === 'commander');
    assert.ok(card, 'la presencia sigue (TTL de presencia aparte)');
    assert.equal(card.hasLog, false);
    assert.equal(card.logFile, undefined);
});

test('sin logs de corrida → hasLog:false', () => {
    clearAll();
    fs.writeFileSync(SHERLOCK_FILE, JSON.stringify({ petitionId: 's', fase: 'verificando', startedAt: Date.now() }));
    const out = slices.activeAgents(baseState());
    const card = out.find(a => a.skill === 'sherlock');
    assert.equal(card.hasLog, false);
});

test('resolveRecentRunLog: sólo matchea .log, no sidecars .meta.json', () => {
    clearAll();
    fs.writeFileSync(path.join(LOGS, 'commander-x.meta.json'), '{}');
    assert.equal(slices.resolveRecentRunLog('commander', 5 * 60 * 1000), null);
    writeLog('commander-x.log', 1000);
    assert.equal(slices.resolveRecentRunLog('commander', 5 * 60 * 1000), 'commander-x.log');
});
