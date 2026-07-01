// =============================================================================
// Tests `activeAgents` — enganche del log del Commander y del Sherlock a la card
// observacional (#4335).
//
// Cubre:
//   - Commander: presencia fresca + `commander-<id>.log` reciente (mtime dentro
//     del TTL) ⇒ hasLog:true + logFile correcto.
//   - Commander: log fuera del TTL (turno viejo) ⇒ hasLog:false (sin fantasma),
//     aunque la presencia siga fresca.
//   - Sherlock: presencia fresca + `sherlock-<id>.log` reciente ⇒ agente
//     sintético "Sherlock" con hasLog:true.
//   - Sin ejecución (sin presencia) ⇒ no aparecen cards observacionales.
//
// La presencia se aísla monkeypatcheando `presencePath` de ambos módulos (misma
// instancia cacheada que captura el slice), y el dir de logs se inyecta vía el
// nuevo `opts.logDir` de `activeAgents`.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const commanderPresence = require('../commander-presence');
const sherlockPresence = require('../sherlock-presence');
const slices = require('../dashboard-slices');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-cmd-sher-log-'));
const CMD_PRES = path.join(TMP, 'commander-presence.json');
const SHER_PRES = path.join(TMP, 'sherlock-presence.json');
const LOG_DIR = path.join(TMP, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

commanderPresence.presencePath = () => CMD_PRES;
sherlockPresence.presencePath = () => SHER_PRES;

function clearAll() {
    for (const f of [CMD_PRES, SHER_PRES]) { try { fs.rmSync(f, { force: true }); } catch {} }
    for (const f of fs.readdirSync(LOG_DIR)) { try { fs.rmSync(path.join(LOG_DIR, f), { force: true }); } catch {} }
}

function writeLog(name, mtimeMs) {
    const p = path.join(LOG_DIR, name);
    fs.writeFileSync(p, 'contenido real del log\n');
    if (mtimeMs != null) {
        const secs = mtimeMs / 1000;
        fs.utimesSync(p, secs, secs);
    }
}

const emptyState = () => ({ issueMatrix: {}, etaAverages: {} });

test('Commander: presencia fresca + log reciente ⇒ hasLog:true + logFile', () => {
    clearAll();
    const now = 1_700_000_000_000;
    fs.writeFileSync(CMD_PRES, JSON.stringify({ petitionId: 'op1', fase: 'pensando', startedAt: now - 3000 }));
    writeLog('commander-42-1699999999999.log', now - 2000); // dentro del TTL

    const out = slices.activeAgents(emptyState(), { logDir: LOG_DIR, now });
    const cmd = out.find(a => a.skill === 'commander');
    assert.ok(cmd, 'debe existir la card del Commander');
    assert.equal(cmd.observational, true);
    assert.equal(cmd.hasLog, true, 'log reciente ⇒ hasLog true');
    assert.equal(cmd.logFile, 'commander-42-1699999999999.log');
});

test('Commander: log fuera del TTL ⇒ hasLog:false (sin fantasma)', () => {
    clearAll();
    const now = 1_700_000_000_000;
    fs.writeFileSync(CMD_PRES, JSON.stringify({ petitionId: 'op2', fase: 'pensando', startedAt: now - 3000 }));
    writeLog('commander-old.log', now - (6 * 60 * 1000)); // 6 min → fuera del TTL de 5

    const out = slices.activeAgents(emptyState(), { logDir: LOG_DIR, now });
    const cmd = out.find(a => a.skill === 'commander');
    assert.ok(cmd, 'la card aparece por la presencia fresca');
    assert.equal(cmd.hasLog, false, 'log stale ⇒ hasLog false');
    assert.equal(cmd.logFile, undefined);
});

test('Sherlock: presencia fresca + log reciente ⇒ card sintética con hasLog', () => {
    clearAll();
    const now = 1_700_000_000_000;
    fs.writeFileSync(SHER_PRES, JSON.stringify({ petitionId: 'sop1', fase: 'verificando', startedAt: now - 1000 }));
    writeLog('sherlock-42-1699999999999-sherlock.log', now - 500);

    const out = slices.activeAgents(emptyState(), { logDir: LOG_DIR, now });
    const sher = out.find(a => a.skill === 'sherlock');
    assert.ok(sher, 'debe existir la card del Sherlock');
    assert.equal(sher.title, 'Sherlock');
    assert.equal(sher.observational, true);
    assert.equal(sher.cancelable, false);
    assert.equal(sher.hasLog, true);
    assert.equal(sher.logFile, 'sherlock-42-1699999999999-sherlock.log');
    assert.equal(sher.fase, 'verificando');
});

test('Sin presencia ⇒ no hay cards observacionales', () => {
    clearAll();
    const now = 1_700_000_000_000;
    // hay logs viejos en el dir pero sin presencia no deben materializarse cards.
    writeLog('commander-zombie.log', now - 1000);
    writeLog('sherlock-zombie-sherlock.log', now - 1000);

    const out = slices.activeAgents(emptyState(), { logDir: LOG_DIR, now });
    assert.equal(out.find(a => a.skill === 'commander'), undefined);
    assert.equal(out.find(a => a.skill === 'sherlock'), undefined);
});
