const gb = require('C:/Workspaces/Intrale/platform.agent-5220-pipeline-dev/.pipeline/ghostbusters.js');
const scan = require('C:/Workspaces/Intrale/platform.agent-5220-pipeline-dev/.pipeline/lib/secret-leak-scan.js');
const V = '987654321:AASyntheticValueThatMustNeverBePrinted12345';
const c = scan.classifyValue('bot_token', V);
const base = (over={}) => ({ timestamp:'2026-08-01T14:00:00.000Z', dryRun:false, categories:['secrets'],
  zombies:[],emulators:[],bashOrphans:[],extBotZombies:[],duplicateWatchdogs:[],idleClaude:[],idleNodeHooks:[],
  worktrees:[],sessions:[],locks:[],logs:[],qaArtifacts:[],agentInconsistencies:[],envIssues:[],
  staleBranches:[],staleBranchesSkipped:[],leakedSecrets:[],secretsScanErrors:[],secretsUnparseable:0,
  secretsScanMs:0,ramFreedBytes:0,diskFreedBytes:0, ...over });
const f = { root:'C:/Workspaces/Intrale/platform.session-y',
  file:'C:/Workspaces/Intrale/platform.session-y/.claude/hooks/telegram-config.json',
  rel:'.claude/hooks/telegram-config.json', key:'openai_api_key', kind:c.kind,
  hash8:c.hash8, len:c.len, category:'purgable', removed:false };
const out = gb.fmtReport(base({
  leakedSecrets: [f],
  secretsSkippedPurge: 1, secretsPurgeSkips: [{ root: f.root, rel: f.rel, key: f.key, skipReason: 'unlink: EPERM: operation not permitted' }],
}));
console.log('seccion "Purgas omitidas" presente =', /Purgas omitidas/i.test(out));
console.log('motivo del skip impreso (EPERM)   =', out.includes('EPERM'));
console.log('--- lineas relevantes ---');
out.split('\n').filter(l => /omitid|EPERM/i.test(l)).forEach(l => console.log('  ' + l));
console.log('--- CA-3 sobre esta salida ---');
let fugas=0; for(let i=0;i+8<=V.length;i++) if(out.includes(V.slice(i,i+8))) fugas++;
console.log('  subcadenas de 8 chars del valor sintetico filtradas =', fugas);
