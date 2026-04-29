#!/usr/bin/env node
// delivery.js — Orquestador determinístico del refactor #2870.
//
// Reemplaza la lógica del SKILL.md de /delivery con un script que:
//   1. Lee estado git con git-context
//   2. Clasifica el cambio con change-classifier
//   3. Lee payload del issue (si existe) o cae a fallback
//   4. Construye commit-message con commit-builder
//   5. Construye pr-body con pr-builder
//   6. Ejecuta: git commit + push + gh pr create
//
// Cero LLM. Determinismo total.
//
// Uso:
//   node .pipeline/delivery.js --issue <N> --description "<desc>" [--type <tipo>] [--draft]
//   node .pipeline/delivery.js --description "<desc>" [--type <tipo>]   (sin issue)

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const gitCtx = require('./lib/delivery/git-context');
const classifier = require('./lib/delivery/change-classifier');
const commitBuilder = require('./lib/delivery/commit-builder');
const prBuilder = require('./lib/delivery/pr-builder');

// ---- CLI parsing -----------------------------------------------------------

function parseArgs(argv) {
  const args = {
    issue: null,
    description: null,
    type: null,
    draft: false,
    dryRun: false,
    json: false,
    repo: 'intrale/platform',
    base: 'main',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--issue') args.issue = argv[++i];
    else if (a === '--description') args.description = argv[++i];
    else if (a === '--type') args.type = argv[++i];
    else if (a === '--draft') args.draft = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--json') args.json = true;
    else if (a === '--repo') args.repo = argv[++i];
    else if (a === '--base') args.base = argv[++i];
  }
  return args;
}

// ---- gh CLI helpers --------------------------------------------------------

function gh(ghArgs, opts = {}) {
  const result = spawnSync('gh', ghArgs, {
    stdio: 'pipe',
    encoding: 'utf8',
    windowsHide: true,
    ...opts,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

// Lee body + comments del issue. Devuelve { body, comments: [{body}] }.
function fetchIssue(issueNumber, repo) {
  if (!issueNumber) return { body: null, comments: [] };
  const r = gh([
    'issue', 'view', String(issueNumber),
    '--repo', repo,
    '--json', 'body,comments',
  ]);
  if (!r.ok) return { body: null, comments: [] };
  try {
    const data = JSON.parse(r.stdout);
    return {
      body: data.body || null,
      comments: (data.comments || []).map((c) => ({ body: c.body || '' })),
    };
  } catch {
    return { body: null, comments: [] };
  }
}

// ---- Main ------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv);
  const cwd = process.cwd();

  // 1. Snapshot de git
  const snap = gitCtx.snapshot(cwd, `origin/${args.base}`);
  if (!snap.branch) {
    console.error('❌ No se pudo determinar branch actual');
    process.exit(1);
  }
  if (snap.ahead === 0) {
    console.error(`❌ Branch ${snap.branch} no tiene commits adelante de origin/${args.base}`);
    process.exit(1);
  }

  // 2. Clasificar cambio
  const inferredType = classifier.classify({
    files: snap.files,
    commits: snap.commits,
    status: snap.status,
    override: args.type,
  });

  // 3. Leer issue (si hay) para payload
  const issue = fetchIssue(args.issue, args.repo);

  // 4. Construir commit-message
  const commit = commitBuilder.build({
    issueBody: issue.body,
    issueComments: issue.comments,
    type: inferredType,
    description: args.description,
  });

  // 5. Construir pr-body
  const pr = prBuilder.build({
    issueBody: issue.body,
    issueComments: issue.comments,
    description: args.description,
    diffStat: snap.stat,
    issueNumber: args.issue,
  });

  // Modo --json: emite todo lo computado y termina (no ejecuta git/gh).
  // Útil para que /delivery (SKILL.md) consuma sin perder los gates externos.
  if (args.json) {
    const out = {
      branch: snap.branch,
      base: args.base,
      ahead: snap.ahead,
      stat: snap.stat,
      type: inferredType,
      issue: args.issue,
      commitMessage: commit.message,
      commitSource: commit.source,
      prTitle: commit.message.split('\n')[0],
      prBody: pr.body,
      prSource: pr.source,
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  // Reporte de lo que se va a hacer
  console.log('━━━ /delivery (determinístico) ━━━');
  console.log(`Branch:      ${snap.branch}`);
  console.log(`Base:        origin/${args.base}`);
  console.log(`Ahead:       ${snap.ahead} commits, ${snap.stat.files} archivos`);
  console.log(`Tipo:        ${inferredType || 'N/A'}`);
  console.log(`Issue:       ${args.issue || 'N/A'}`);
  console.log(`Commit src:  ${commit.source}`);
  console.log(`PR src:      ${pr.source}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (args.dryRun) {
    console.log('\n--- COMMIT MESSAGE ---');
    console.log(commit.message);
    console.log('\n--- PR BODY ---');
    console.log(pr.body);
    console.log('\n(--dry-run: no se ejecutó push ni se creó PR)');
    return;
  }

  // 6. Push (asume commits ya hechos por el agente)
  console.log('\n→ git push...');
  const push = spawnSync('git', ['-C', cwd, 'push', '-u', 'origin', snap.branch], {
    stdio: 'inherit',
  });
  if (push.status !== 0) {
    console.error('❌ git push falló');
    process.exit(1);
  }

  // 7. Crear PR (si no existe)
  const existing = gh([
    'pr', 'list',
    '--repo', args.repo,
    '--head', snap.branch,
    '--state', 'open',
    '--json', 'number,url',
  ]);

  let prUrl = null;
  let prNumber = null;
  if (existing.ok && existing.stdout && existing.stdout !== '[]') {
    try {
      const list = JSON.parse(existing.stdout);
      if (list.length > 0) {
        prUrl = list[0].url;
        prNumber = list[0].number;
      }
    } catch {}
  }

  if (!prUrl) {
    console.log('→ gh pr create...');
    const subject = commit.message.split('\n')[0];
    const createArgs = [
      'pr', 'create',
      '--repo', args.repo,
      '--title', subject,
      '--body', pr.body,
      '--base', args.base,
      '--head', snap.branch,
      '--assignee', 'leitolarreta',
    ];
    if (args.draft) createArgs.push('--draft');
    const create = gh(createArgs);
    if (!create.ok) {
      console.error('❌ gh pr create falló:', create.stderr);
      process.exit(1);
    }
    prUrl = create.stdout.split('\n').find((l) => l.startsWith('https://')) || create.stdout;
    const m = prUrl.match(/\/pull\/(\d+)/);
    prNumber = m ? m[1] : null;
  } else {
    console.log(`→ PR ya existe: ${prUrl}`);
  }

  console.log(`\n✅ Delivery completo`);
  console.log(`   PR:     ${prUrl}`);
  console.log(`   Number: ${prNumber || 'N/A'}`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('❌ Error en delivery.js:', err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

module.exports = { parseArgs, fetchIssue, main };
