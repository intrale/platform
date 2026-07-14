'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const gb = require('../ghostbusters-worktrees');

const MAIN = 'C:/Workspaces/Intrale/platform';

function fakeFs(realpaths = {}) {
  return {
    realpathSync(p) {
      return realpaths[String(p)] || String(p);
    },
    existsSync() {
      return false;
    },
  };
}

test('rebote #4694: guard permite el prefijo derivado de projectId aunque no coincida con basename(mainRepo)', () => {
  const worktree = 'C:/Workspaces/Intrale/acme-shop.agent-4694-pipeline-dev';
  const r = gb.isForbiddenTarget(worktree, {
    mainRepo: MAIN,
    projectId: 'acme-shop',
    fsImpl: fakeFs({ [worktree]: worktree }),
  });
  assert.equal(r.forbidden, false);
});

test('rebote #4694: guard conserva compatibilidad con worktrees legacy aunque projectId sea distinto', () => {
  const worktree = `${MAIN}.agent-4694-pipeline-dev`;
  const r = gb.isForbiddenTarget(worktree, {
    mainRepo: MAIN,
    projectId: 'acme-shop',
    fsImpl: fakeFs({ [worktree]: worktree }),
  });
  assert.equal(r.forbidden, false);
});

test('rebote #4694: guard bloquea prefijos fuera del derivado y del legacy', () => {
  const worktree = 'C:/Workspaces/Intrale/otroproyecto.agent-4694-pipeline-dev';
  const r = gb.isForbiddenTarget(worktree, {
    mainRepo: MAIN,
    projectId: 'acme-shop',
    fsImpl: fakeFs({ [worktree]: worktree }),
  });
  assert.equal(r.forbidden, true);
  assert.match(r.reason, /acme-shop\.\*|platform\.\*/);
});

test('rebote #4694: cleanup destructivo aborta aunque el path contenga el needle del issue', () => {
  const worktree = 'C:/tmp/platform.agent-4694-pipeline-dev';
  const spawnCalls = [];
  const logs = [];

  const removed = gb.removeWorktree(worktree, {
    mainRepo: MAIN,
    configOverride: { projectId: 'intrale-platform' },
    fsImpl: fakeFs({ [worktree]: worktree }),
    spawnImpl(cmd, args, opts) {
      spawnCalls.push({ cmd, args, opts });
      return { status: 0, stdout: '', stderr: '' };
    },
    logger(msg) {
      logs.push(msg);
    },
  });

  assert.equal(removed, false);
  assert.equal(spawnCalls.length, 0, 'no debe ejecutar git worktree remove fuera del guard compartido');
  assert.ok(logs.some((msg) => msg.includes('ABORT')));
});
