// QA #5421 — verificacion empirica de CA (script temporal, no versionado)
const P = require('./.pipeline/lib/worktree-guard-policy');
const BS = String.fromCharCode(92); // backslash sin pasar por el heredoc

function line(s) { console.log(s); }

line('=== CA-1/2/3/4: guardExceptionEligible ===');
const casos = [
  ['branch-origin-unverified:agent/5421-x', null, false, 'CA-1'],
  ['branch-origin-unverified', null, false, 'CA-1'],
  ['worktree-path-exists', null, true, 'CA-2'],
  ['worktree-path-exists:C:' + BS + 'tmp' + BS + 'x', null, true, 'CA-2 con sufijo'],
  ['worktree-path-exists-without-git-entry', null, true, 'CA-2'],
  ['worktree-path-exists-without-git-entry:C:' + BS + 'tmp' + BS + 'x', null, true, 'CA-2 con sufijo'],
  ['fetch-failed', true, true, 'CA-3 verified=true'],
  ['fetch-failed', false, false, 'CA-3 verified=false'],
  ['fetch-failed', null, false, 'CA-3 verified=null'],
  ['fetch-failed', undefined, false, 'CA-3 verified=undefined'],
  ['ls-remote-failed', true, true, 'CA-3'],
  ['ls-remote-failed', false, false, 'CA-3'],
  ['remote-branch-missing', true, false, 'nunca elegible'],
  ['invalid-input', true, false, 'nunca elegible'],
  ['motivo-nuevo-desconocido', true, false, 'CA-4 default cerrado'],
  ['branch-origin-unverified-foo', true, false, 'CA-4 anti-prefijo'],
  ['worktree-path-exists-foo', true, false, 'CA-4 anti-prefijo'],
  ['', true, false, 'CA-4 vacio'],
  [null, true, false, 'CA-4 null'],
];
let fails = 0;
for (const [reason, bov, esperado, tag] of casos) {
  const r = P.guardExceptionEligible(reason, { operation: 'commit-push', branchOriginVerified: bov });
  const ok = r.eligible === esperado;
  if (!ok) fails++;
  line((ok ? 'OK   ' : 'FAIL ') + JSON.stringify(String(reason)) + ' bov=' + String(bov) +
    ' => eligible=' + r.eligible + ' (esperado ' + esperado + ')  [' + tag + ']');
}

line('');
line('=== D3: operation no cambia el veredicto ===');
for (const op of ['spawn-agente', 'commit-push', 'merge-server-side', undefined]) {
  const a = P.guardExceptionEligible('worktree-path-exists', { operation: op, branchOriginVerified: false });
  const b = P.guardExceptionEligible('fetch-failed', { operation: op, branchOriginVerified: false });
  line('op=' + String(op) + ' -> worktree-path-exists=' + a.eligible + ' fetch-failed=' + b.eligible);
}

line('');
line('=== resolveOperation ===');
line('fase=entrega        -> ' + P.resolveOperation({ fase: 'entrega', skill: 'x' }));
line('skill=delivery      -> ' + P.resolveOperation({ fase: 'dev', skill: 'delivery' }));
line('fase=dev/pipeline-dev -> ' + P.resolveOperation({ fase: 'dev', skill: 'pipeline-dev' }));

line('');
line('=== CA-6/CA-7: buildAbortLogLine ===');
const pathAbs = 'C:' + BS + 'Workspaces' + BS + 'Intrale' + BS + 'platform.agent-5421-pipeline-dev';
const logMerge = P.buildAbortLogLine({
  issue: 5421, fase: 'entrega', skill: 'delivery',
  reasonStr: 'worktree-path-exists-without-git-entry:' + pathAbs,
  operation: 'merge-server-side', intentos: 1, cap: 3, eligible: true, escalar: false,
  stderr: 'fatal: not a git repository: ' + pathAbs + BS + '.git',
});
line(logMerge);
line('');
const logCommit = P.buildAbortLogLine({
  issue: 5421, fase: 'dev', skill: 'pipeline-dev',
  reasonStr: 'branch-origin-unverified:agent/5421-*',
  operation: 'commit-push', intentos: 3, cap: 3, eligible: false, escalar: true,
});
line(logCommit);
line('');
line('CA-6 nombra operacion merge-server-side?  ' + /merge server-side/i.test(logMerge));
line('CA-6 nombra operacion commit/push?        ' + /commit\/push/i.test(logCommit));
line('CA-6 indica accion que destraba?          ' + (/Acci[oó]n que destraba/i.test(logMerge) && /Acci[oó]n que destraba/i.test(logCommit)));
line('CA-7 path absoluto crudo en el log?       ' + logMerge.includes(pathAbs) + '   (esperado false)');
line('CA-7 marcador de redaccion presente?      ' + /<ABS_PATH>|REDACT/i.test(logMerge));
if (logMerge.includes(pathAbs)) fails++;

line('');
line('=== CA-8: buildOperatorQuestion ===');
const qEmail = P.buildOperatorQuestion({
  issue: 5421, reasonStr: 'branch-origin-unverified:agent/5421-*',
  branchOriginVerified: false, unverifiedAuthors: ['bot-agente@intrale.com'],
});
line(qEmail);
const RAMA_AJENA = /rama ajena|procedencia sospechosa|rama de un tercero|no reconoc[ie].* origen/i;
line('  contiene "rama ajena"/equivalente? ' + RAMA_AJENA.test(qEmail) + '  (esperado false)');
line('  nombra el email?                   ' + qEmail.includes('bot-agente@intrale.com') + '  (esperado true)');
line('  nombra la allowlist?               ' + /worktree_provenance\.committers/.test(qEmail));
if (RAMA_AJENA.test(qEmail) || !qEmail.includes('bot-agente@intrale.com')) fails++;
line('');
const qSinAutor = P.buildOperatorQuestion({
  issue: 5421, reasonStr: 'branch-origin-unverified:agent/5421-*',
  branchOriginVerified: false, unverifiedAuthors: [],
});
line(qSinAutor);
line('  conserva lenguaje de procedencia?  ' + /rama ajena/i.test(qSinAutor) + '  (esperado true)');
if (!/rama ajena/i.test(qSinAutor)) fails++;
line('');
line(P.buildOperatorQuestion({ issue: 5421, reasonStr: 'fetch-failed', branchOriginVerified: true }));

line('');
line('=== CA-9: buildAffectedSkillsLine ===');
line(JSON.stringify(P.buildAffectedSkillsLine(['po', 'review', 'ux'])));
line(JSON.stringify(P.buildAffectedSkillsLine(['po', 'po', ' ux ', '', null])));
line(JSON.stringify(P.buildAffectedSkillsLine([])));

line('');
line('=== D4/D5: pureza del modulo ===');
const src = require('fs').readFileSync('./.pipeline/lib/worktree-guard-policy.js', 'utf8');
const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
line('requires: ' + JSON.stringify(requires));
line('usa fs/child_process/spawnSync en codigo? ' +
  /require\(['"](fs|child_process|path)['"]\)/.test(src));

line('');
line(fails === 0 ? '>>> TODOS LOS CHEQUEOS OK' : '>>> ' + fails + ' CHEQUEOS FALLARON');
process.exit(fails === 0 ? 0 : 1);
