// =============================================================================
// Tests de lib/ghostbusters-worktrees.js (#3943, EP6-H1)
//
// Cubre los requisitos de seguridad RS-1..RS-4:
//   - Guard anti-suicidio (repo principal, ancestro, junction hacia afuera)
//   - Injection: branch names maliciosos nunca llegan a un shell
//   - Criterio compuesto: seguridad AND abandono
//   - Cap por corrida y dry-run sin borrado real
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const gb = require('../ghostbusters-worktrees');

const MAIN = 'C:/Workspaces/Intrale/platform';

// fake fs que resuelve realpath con un mapa configurable
function fakeFs({ realpaths = {}, stats = {}, existing = new Set() } = {}) {
  return {
    realpathSync(p) {
      const key = String(p);
      if (realpaths[key] !== undefined) return realpaths[key];
      return key;
    },
    statSync(p) {
      if (stats[p]) return stats[p];
      throw new Error(`ENOENT: ${p}`);
    },
    existsSync(p) { return existing.has(p); },
    rmSync() { throw new Error('rmSync no debería llamarse en estos tests'); },
    mkdirSync() {},
    appendFileSync() {},
  };
}

// fake spawnSync que registra invocaciones y responde según un script
function fakeSpawn(responses = []) {
  const calls = [];
  let i = 0;
  const impl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const r = responses[Math.min(i, responses.length - 1)] || {};
    i++;
    return { status: r.status ?? 0, stdout: r.stdout ?? '', stderr: '' };
  };
  impl.calls = calls;
  return impl;
}

// -----------------------------------------------------------------------------
// RS-1 — Guard anti-suicidio
// -----------------------------------------------------------------------------

test('guard: el repo principal es target prohibido', () => {
  const r = gb.isForbiddenTarget(MAIN, { fsImpl: fakeFs() });
  assert.equal(r.forbidden, true);
  assert.match(r.reason, /repo principal/);
});

test('guard: un ancestro del repo principal es target prohibido', () => {
  for (const p of ['C:/Workspaces', 'C:/Workspaces/Intrale', 'C:/']) {
    const r = gb.isForbiddenTarget(p, { fsImpl: fakeFs() });
    assert.equal(r.forbidden, true, `${p} debería estar prohibido`);
  }
});

test('guard: un path fuera del prefijo permitido es prohibido', () => {
  const r = gb.isForbiddenTarget('C:/Workspaces/gh-cli', { fsImpl: fakeFs() });
  assert.equal(r.forbidden, true);
  assert.match(r.reason, /fuera del prefijo/);
});

test('guard: junction que resuelve fuera del prefijo es prohibido (realpath)', () => {
  // El path PARECE un worktree hermano, pero realpath lo resuelve afuera.
  const fsImpl = fakeFs({
    realpaths: { [`${MAIN}.agent-99-evil`]: 'C:/Users/Administrator' },
  });
  const r = gb.isForbiddenTarget(`${MAIN}.agent-99-evil`, { fsImpl });
  assert.equal(r.forbidden, true);
});

test('guard: junction que resuelve AL repo principal es prohibido', () => {
  const fsImpl = fakeFs({
    realpaths: { [`${MAIN}.agent-99-evil`]: 'C:\\Workspaces\\Intrale\\platform' },
  });
  const r = gb.isForbiddenTarget(`${MAIN}.agent-99-evil`, { fsImpl });
  assert.equal(r.forbidden, true);
  assert.match(r.reason, /repo principal/);
});

test('guard: un worktree hermano legítimo está permitido', () => {
  const r = gb.isForbiddenTarget(`${MAIN}.agent-3943-pipeline-dev`, { fsImpl: fakeFs() });
  assert.equal(r.forbidden, false);
});

test('guard: realpath irresoluble → prohibido (conservador)', () => {
  const fsImpl = fakeFs();
  fsImpl.realpathSync = () => { throw new Error('ENOENT'); };
  const r = gb.isForbiddenTarget(`${MAIN}.agent-1-x`, { fsImpl });
  assert.equal(r.forbidden, true);
});

test('removeWorktree: aborta sin tocar git ni fs cuando el guard prohíbe', () => {
  const spawnImpl = fakeSpawn();
  const fsImpl = fakeFs(); // realpath de MAIN → MAIN → prohibido
  const logs = [];
  const ok = gb.removeWorktree(MAIN, { spawnImpl, fsImpl, logger: (m) => logs.push(m) });
  assert.equal(ok, false);
  assert.equal(spawnImpl.calls.length, 0, 'no debe ejecutarse ningún comando');
  assert.ok(logs.some(l => l.includes('ABORT')));
});

// -----------------------------------------------------------------------------
// RS-2 — Injection: branch names maliciosos jamás tocan un shell
// -----------------------------------------------------------------------------

test('injection: branch tipo "3613; rm -rf /" viaja como argumento, sin shell', () => {
  const evil = '3613; rm -rf /';
  const spawnImpl = fakeSpawn([
    { status: 0, stdout: '' },   // git status --porcelain
    { status: 0, stdout: '0' },  // git rev-list --count
  ]);
  const r = gb.isWorktreeSafeToDelete(`${MAIN}.agent-3613-x`, evil, { spawnImpl });
  assert.equal(r.safe, true);
  for (const call of spawnImpl.calls) {
    assert.equal(call.cmd, 'git', 'solo se invoca git directo');
    assert.ok(Array.isArray(call.args), 'argumentos como array, no string');
    assert.ok(!call.opts || call.opts.shell !== true, 'nunca shell:true');
  }
  // El branch malicioso queda contenido en UN argumento del array
  const revList = spawnImpl.calls.find(c => c.args[0] === 'rev-list');
  assert.ok(revList.args.includes(`origin/${evil}..HEAD`));
});

test('injection: paths con metacaracteres viajan como argumento en removeWorktree', () => {
  const wt = `${MAIN}.agent-1-a"; del /q C:\\`;
  const spawnImpl = fakeSpawn();
  const fsImpl = fakeFs({ realpaths: { [wt]: wt } });
  fsImpl.existsSync = (p) => false; // sin .claude, sin residuo post-remove
  const ok = gb.removeWorktree(wt, { spawnImpl, fsImpl });
  assert.equal(ok, true);
  const gitCall = spawnImpl.calls.find(c => c.cmd === 'git');
  assert.deepEqual(gitCall.args, ['worktree', 'remove', wt, '--force']);
});

// -----------------------------------------------------------------------------
// RS-3 — Criterio compuesto: seguridad (todas) AND abandono (al menos una)
// -----------------------------------------------------------------------------

test('seguridad: uncommitted changes → NO safe (aunque sea viejo)', () => {
  const spawnImpl = fakeSpawn([
    { status: 0, stdout: ' M src/algo.kt\n?? otro.txt\n' },
  ]);
  const r = gb.isWorktreeSafeToDelete(`${MAIN}.agent-1-x`, 'agent/1-x', { spawnImpl });
  assert.equal(r.safe, false);
  assert.match(r.reason, /sin commitear/);
});

test('seguridad: cambios solo en .claude/ no cuentan como uncommitted', () => {
  const spawnImpl = fakeSpawn([
    { status: 0, stdout: ' M .claude/settings.json\n' },
    { status: 0, stdout: '0' },
  ]);
  const r = gb.isWorktreeSafeToDelete(`${MAIN}.agent-1-x`, 'agent/1-x', { spawnImpl });
  assert.equal(r.safe, true);
});

test('seguridad: commits sin pushear → NO safe', () => {
  const spawnImpl = fakeSpawn([
    { status: 0, stdout: '' },
    { status: 0, stdout: '2' }, // 2 ahead
  ]);
  const r = gb.isWorktreeSafeToDelete(`${MAIN}.agent-1-x`, 'agent/1-x', { spawnImpl });
  assert.equal(r.safe, false);
  assert.match(r.reason, /ahead/);
});

test('seguridad: rama sin remoto con commits sobre main → NO safe', () => {
  const spawnImpl = fakeSpawn([
    { status: 0, stdout: '' },
    { status: 128, stdout: '' }, // origin/<branch> no existe
    { status: 0, stdout: '3' },  // 3 commits sobre origin/main
  ]);
  const r = gb.isWorktreeSafeToDelete(`${MAIN}.agent-1-x`, 'agent/1-x', { spawnImpl });
  assert.equal(r.safe, false);
  assert.match(r.reason, /no pusheada/);
});

test('abandono: rama inexistente en remoto → abandonado', () => {
  // remoteBranchExists usa ls-remote: stdout vacío = no existe
  const spawnImpl = fakeSpawn([{ status: 0, stdout: '' }]);
  const r = gb.checkAbandonment(`${MAIN}.agent-1-x`, 'agent/1-x', {
    spawnImpl, fsImpl: fakeFs(), nowMs: 1000,
  });
  assert.equal(r.abandoned, true);
  assert.match(r.reason, /inexistente en remoto/);
});

test('abandono: rama viva y worktree reciente → NO abandonado', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = 100 * DAY;
  const wt = `${MAIN}.agent-1-x`;
  const spawnImpl = fakeSpawn([{ status: 0, stdout: 'abc123\trefs/heads/agent/1-x\n' }]);
  const fsImpl = fakeFs({ stats: { [wt]: { birthtimeMs: now - 5 * DAY, mtimeMs: now - 5 * DAY } } });
  const r = gb.checkAbandonment(wt, 'agent/1-x', { spawnImpl, fsImpl, nowMs: now, ageThresholdDays: 30 });
  assert.equal(r.abandoned, false);
});

test('abandono: rama viva pero worktree > umbral → abandonado por antigüedad', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = 100 * DAY;
  const wt = `${MAIN}.session-vieja`;
  const spawnImpl = fakeSpawn([{ status: 0, stdout: 'abc123\trefs/heads/session-vieja\n' }]);
  const fsImpl = fakeFs({ stats: { [wt]: { birthtimeMs: now - 45 * DAY, mtimeMs: now - 45 * DAY } } });
  const r = gb.checkAbandonment(wt, 'session-vieja', { spawnImpl, fsImpl, nowMs: now, ageThresholdDays: 30 });
  assert.equal(r.abandoned, true);
  assert.match(r.reason, /antigüedad/);
});

// -----------------------------------------------------------------------------
// RS-4 — Cap por corrida, dry-run y audit log
// -----------------------------------------------------------------------------

function candidate(n, extra = {}) {
  return {
    path: `${MAIN}.agent-${n}-x`, branch: `agent/${n}-x`, issue: n,
    reason: 'issue cerrado', diskBytes: 1000, ...extra,
  };
}

test('cap: con 8 elegibles y cap=5 solo se procesan 5, el resto queda skipped', () => {
  const candidates = Array.from({ length: 8 }, (_, i) => candidate(i + 1));
  const removed = [];
  const audits = [];
  const entries = gb.sweepWorktrees(candidates, {
    cap: 5, dryRun: false,
    removeImpl: (p) => { removed.push(p); return true; },
    auditImpl: (e) => audits.push(e),
    fsImpl: fakeFs(),
    nowIso: '2026-06-12T00:00:00Z',
  });
  assert.equal(removed.length, 5);
  assert.equal(entries.filter(e => e.removed).length, 5);
  const capped = entries.filter(e => e.skipReason && /cap de 5/.test(e.skipReason));
  assert.equal(capped.length, 3);
  assert.equal(audits.length, 5, 'audit solo de los procesados');
});

test('dry-run: NO ejecuta borrado real pero SÍ audita con dry_run=true', () => {
  const removed = [];
  const audits = [];
  const entries = gb.sweepWorktrees([candidate(1)], {
    cap: 5, dryRun: true,
    removeImpl: (p) => { removed.push(p); return true; },
    auditImpl: (e) => audits.push(e),
    fsImpl: fakeFs(),
    nowIso: '2026-06-12T00:00:00Z',
  });
  assert.equal(removed.length, 0, 'dry-run jamás borra');
  assert.equal(entries[0].removed, false);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].dry_run, true);
});

test('sweep: candidatos con skip (no seguros) no se borran ni cuentan para el cap', () => {
  const candidates = [
    candidate(1, { skip: true, skipReason: '2 archivo(s) sin commitear' }),
    candidate(2),
  ];
  const removed = [];
  const entries = gb.sweepWorktrees(candidates, {
    cap: 1, dryRun: false,
    removeImpl: (p) => { removed.push(p); return true; },
    auditImpl: () => {},
    fsImpl: fakeFs(),
    nowIso: '2026-06-12T00:00:00Z',
  });
  assert.deepEqual(removed, [candidate(2).path]);
  const skippedEntry = entries.find(e => e.issue === 1);
  assert.equal(skippedEntry.skipped, true);
  assert.match(skippedEntry.skipReason, /sin commitear/);
});

test('audit: shape JSONL con timestamp, path_real, branch, motivo, bytes, dry_run', () => {
  const audits = [];
  gb.sweepWorktrees([candidate(7, { diskBytes: 4096 })], {
    cap: 5, dryRun: true,
    removeImpl: () => true,
    auditImpl: (e) => audits.push(e),
    fsImpl: fakeFs(),
    nowIso: '2026-06-12T10:00:00Z',
  });
  assert.deepEqual(Object.keys(audits[0]).sort(),
    ['branch', 'bytes_recuperados', 'dry_run', 'motivo', 'path_real', 'timestamp'].sort());
  assert.equal(audits[0].bytes_recuperados, 4096);
  assert.equal(audits[0].timestamp, '2026-06-12T10:00:00Z');
});

test('appendAudit: escribe una línea JSONL con flag append', () => {
  const writes = [];
  const fsImpl = {
    mkdirSync() {},
    appendFileSync(file, line, opts) { writes.push({ file, line, opts }); },
  };
  const ok = gb.appendAudit({ a: 1 }, { auditFile: '/x/audit.jsonl', fsImpl });
  assert.equal(ok, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].line, '{"a":1}\n');
  assert.equal(writes[0].opts.flag, 'a');
});

test('applyCap: cap inválido cae al default 5', () => {
  const items = Array.from({ length: 10 }, (_, i) => i);
  assert.equal(gb.applyCap(items, 0).selected.length, 5);
  assert.equal(gb.applyCap(items, NaN).selected.length, 5);
  assert.equal(gb.applyCap(items, 3).selected.length, 3);
});
