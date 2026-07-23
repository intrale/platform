'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const gb = require('../../ghostbusters');

test('rebote #4694: ghostbusters top-level no descarta worktrees multi-producto antes del guard', () => {
  const worktreePath = 'C:/Workspaces/Intrale/acme-shop.agent-4694-pipeline-dev';
  const abandoned = gb.findAbandonedWorktrees([], {
    projectId: 'acme-shop',
    myCwd: 'C:/Workspaces/Intrale/platform',
    worktrees: [
      { path: worktreePath, branch: 'agent/4694-pipeline-dev' },
    ],
    pipelineHasActiveWorkImpl: () => false,
    issueIsOpenImpl: () => false,
    isWorktreeSafeToDeleteImpl: () => ({ safe: true }),
    checkAbandonmentImpl: () => ({ abandoned: true, reason: 'rama inexistente en remoto' }),
  });

  assert.equal(abandoned.length, 1);
  assert.equal(abandoned[0].path, worktreePath);
  assert.equal(abandoned[0].issue, 4694);
});

test('rebote #4694: ghostbusters top-level protege worktree multi-producto con proceso vivo', () => {
  const worktreePath = 'C:/Workspaces/Intrale/acme-shop.agent-4694-pipeline-dev';
  const abandoned = gb.findAbandonedWorktrees([
    { cmd: `node ${worktreePath}/.pipeline/pulpo.js` },
  ], {
    projectId: 'acme-shop',
    myCwd: 'C:/Workspaces/Intrale/platform',
    worktrees: [
      { path: worktreePath, branch: 'agent/4694-pipeline-dev' },
    ],
    pipelineHasActiveWorkImpl: () => false,
    issueIsOpenImpl: () => false,
    isWorktreeSafeToDeleteImpl: () => ({ safe: true }),
    checkAbandonmentImpl: () => ({ abandoned: true, reason: 'rama inexistente en remoto' }),
  });

  assert.deepEqual(abandoned, []);
});
