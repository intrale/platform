// =============================================================================
// backup-agent-branch.test.js — Tests para el helper de backup (#2405 CA-2)
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const {
  backupAgentBranch,
  cleanBackupTags,
  __forTestsOnly__,
} = require(path.join(__dirname, '..', 'backup-agent-branch.js'));

const { timestampUtcCompact, randomHex } = __forTestsOnly__;

function mkTmpRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-test-'));
  execSync('git init --quiet', { cwd: repo });
  execSync('git config user.email "t@t.t"', { cwd: repo });
  execSync('git config user.name "T"', { cwd: repo });
  execSync('git commit --allow-empty -m "init" --quiet', { cwd: repo });
  return repo;
}

function mkCommit(repo, file, content) {
  fs.writeFileSync(path.join(repo, file), content || 'content');
  execSync(`git add "${file}"`, { cwd: repo });
  execSync(`git commit -m "add ${file}" --quiet`, { cwd: repo });
}

function listTags(repo) {
  return execSync('git tag -l', { cwd: repo, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
}

test('timestampUtcCompact: formato YYYYMMDDTHHMMSSZ sin puntuación', () => {
  const t = timestampUtcCompact(new Date('2026-04-21T12:34:56.789Z'));
  assert.equal(t, '20260421T123456Z');
});

test('randomHex: devuelve N chars hexadecimales', () => {
  const h = randomHex(4);
  assert.equal(h.length, 4);
  assert.match(h, /^[0-9a-f]{4}$/);
});

test('backupAgentBranch: crea tag si hay commits locales no pusheados', () => {
  const repo = mkTmpRepo();
  try {
    // Estamos en main. Checkout a agent/9999-test.
    execSync('git checkout -q -b agent/9999-test', { cwd: repo });
    mkCommit(repo, 'a.txt', 'a');
    mkCommit(repo, 'b.txt', 'b');

    // No hay upstream → el helper debe usar fallback contra origin/main
    // (que tampoco existe en este repo). countUnpushedCommits devuelve 1
    // como posición conservadora.
    const result = backupAgentBranch({
      issue: 9999,
      skill: 'pipeline-dev',
      cwd: repo,
    });
    assert.equal(result.ok, true);
    assert.equal(result.created, true);
    assert.match(result.tag, /^backup\/agent-9999-pipeline-dev-\d{8}T\d{6}Z-[0-9a-f]{4}$/);

    // Verificar que el tag fue creado localmente
    const tags = listTags(repo);
    assert.ok(tags.includes(result.tag), `tag ${result.tag} no aparece en 'git tag -l'`);
  } finally {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch {}
  }
});

test('backupAgentBranch: NO crea tag si la rama no es agent/*', () => {
  const repo = mkTmpRepo();
  try {
    execSync('git checkout -q -b feature/xyz', { cwd: repo });
    mkCommit(repo, 'a.txt', 'a');

    const result = backupAgentBranch({
      issue: 1111,
      skill: 'backend-dev',
      cwd: repo,
    });
    assert.equal(result.ok, true);
    assert.equal(result.created, false);
    assert.equal(result.reason, 'not-agent-branch');
    assert.equal(listTags(repo).length, 0);
  } finally {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch {}
  }
});

test('backupAgentBranch: fail si falta issue o skill', () => {
  const repo = mkTmpRepo();
  try {
    const r1 = backupAgentBranch({ issue: null, skill: 'x', cwd: repo });
    assert.equal(r1.ok, false);
    const r2 = backupAgentBranch({ issue: 1, skill: '', cwd: repo });
    assert.equal(r2.ok, false);
  } finally {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch {}
  }
});

test('cleanBackupTags: dry-run no borra nada, detecta expirados', () => {
  const repo = mkTmpRepo();
  try {
    execSync('git checkout -q -b agent/8888-test', { cwd: repo });
    mkCommit(repo, 'a.txt', 'a');

    // Crear un tag backup "a mano" con fecha antigua via GIT_COMMITTER_DATE
    // (el creatordate de un tag lightweight usa el commit del target).
    // Como el commit actual es nuevo, ageSec será ~0 → no expira con TTL=30.
    execSync('git tag backup/agent-8888-skill-20200101T000000Z-abcd', { cwd: repo });

    // TTL agresivo (0 días) → todos los tags con creatordate < now son expirados.
    const r = cleanBackupTags({ ttlDays: -1, dryRun: true, cwd: repo });
    assert.ok(r.scanned >= 1);
    assert.ok(r.expired.length >= 1);
    assert.equal(r.deleted.length, 0); // dry-run
    assert.ok(listTags(repo).includes('backup/agent-8888-skill-20200101T000000Z-abcd'));
  } finally {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch {}
  }
});

test('cleanBackupTags: sin dry-run sí borra', () => {
  const repo = mkTmpRepo();
  try {
    execSync('git checkout -q -b agent/7777-test', { cwd: repo });
    mkCommit(repo, 'a.txt', 'a');
    execSync('git tag backup/agent-7777-skill-20200101T000000Z-deff', { cwd: repo });

    const r = cleanBackupTags({ ttlDays: -1, dryRun: false, cwd: repo });
    assert.ok(r.deleted.length >= 1);
    assert.ok(!listTags(repo).includes('backup/agent-7777-skill-20200101T000000Z-deff'));
  } finally {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch {}
  }
});

test('backupAgentBranch: tags son locales (no push)', () => {
  const repo = mkTmpRepo();
  try {
    execSync('git checkout -q -b agent/6666-test', { cwd: repo });
    mkCommit(repo, 'a.txt', 'a');

    const result = backupAgentBranch({
      issue: 6666, skill: 'test', cwd: repo,
    });
    assert.equal(result.ok, true);

    // No hay remote 'origin', pero si lo hubiera el helper NO debería haberle
    // pusheado. Verificamos indirectamente que no haya intentado push: el
    // exit code del helper no falla aunque no haya remote.
    assert.equal(result.created, true);
    // El tag está solo en el repo local
    assert.ok(listTags(repo).includes(result.tag));
  } finally {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch {}
  }
});
