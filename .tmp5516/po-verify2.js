const fs=require('fs');
const R=require('../.pipeline/lib/split-orphan-reconciler.js');
const items=JSON.parse(fs.readFileSync('.tmp5516/items.json','utf8'));
const waves=JSON.parse(fs.readFileSync('C:/Workspaces/Intrale/platform/.pipeline/waves.json','utf8'));
const arr=Array.isArray(waves)?waves:(waves.waves||[]);
const active=arr.find(w=>w.status==='active')||arr[arr.length-1];
const waveIssues=(active&&(active.issues||active.issue_numbers)||[]).map(Number);
console.log('OLA productiva: n=%s status=%s issues=%d', active&&(active.number||active.n||active.id), active&&active.status, waveIssues.length);

const RE=/^\s*\[\s*split\s+de\s+#(\d+)\s*\]/i;
const childrenAll=new Set(items.filter(i=>RE.test(i.title||'')).map(i=>i.number));
// escenario incidente: ola SIN los hijos de split (pre-backfill)
const incidente=waveIssues.filter(n=>!childrenAll.has(n));
console.log('OLA simulada pre-backfill: %d issues (se sacaron %d hijos)', incidente.length, waveIssues.length-incidente.length);

const trusted=['leitolarreta'];
const found=R.findSplitOrphans(items,{activeWaveIssues:incidente,trustedLogins:trusted});
const grp=R.groupByParent(found.orphans);
console.log('CA-1 orphans=%d grupos=%d truncated=%s reason=%s', found.orphans.length, grp.length, found.truncated, found.reason);
console.log('grupos: %s', JSON.stringify(grp));
const disc=new Set(found.orphans.map(o=>o.child));
console.log('cadena #5126 citada en el rechazo: %s', [5207,5208,5209,5212,5214].map(n=>`#${n}=${disc.has(n)?'SI':'no'}`).join(' '));
console.log('rejectedByLabel=%d rejectedUntrusted=%d', found.rejectedByLabel.length, found.rejectedUntrusted.length);
console.log('  detalle byLabel: %s', JSON.stringify(found.rejectedByLabel.slice(0,12)));

// CA-5 idempotencia: 2da corrida con hijos ya en la ola
const ola2=[...new Set([...incidente,...disc])];
const f2=R.findSplitOrphans(items,{activeWaveIssues:ola2,trustedLogins:trusted});
console.log('CA-5 2da corrida -> orphans=%d (esperado 0 o cadena mas profunda: %j)', f2.orphans.length, R.groupByParent(f2.orphans));

// CA-6 default-deny: padre fuera de ola / ola vacia
console.log('CA-6 ola vacia -> orphans=%d', R.findSplitOrphans(items,{activeWaveIssues:[],trustedLogins:trusted}).orphans.length);
console.log('CA-6 padre #4200 fuera de ola -> orphans=%d', R.findSplitOrphans(items,{activeWaveIssues:[999999],trustedLogins:trusted}).orphans.length);
