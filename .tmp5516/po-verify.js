const { execSync } = require('child_process');
const GH = 'C:/Workspaces/gh-cli/bin/gh.exe';
const R = require('../.pipeline/lib/split-orphan-reconciler.js');
const Q = 'repo%3Aintrale%2Fplatform+is%3Aissue+is%3Aopen+in%3Atitle+split';
const PAGE=100, MAXP=5;
function gh(u){ return JSON.parse(execSync(`"${GH}" api "${u}"`,{encoding:'utf8',maxBuffer:64*1024*1024})); }

// --- ventana NUEVA (search) — igual que el wire-up
let items=[], pagesFetched=0, lastBatchSize=0, sawIncomplete=false;
for(let p=1;p<=MAXP;p++){
  const r = gh(`search/issues?q=${Q}&per_page=${PAGE}&page=${p}`);
  pagesFetched=p; lastBatchSize=r.items.length;
  if(r.incomplete_results===true) sawIncomplete=true;
  for(const it of r.items) if(it.pull_request===undefined) items.push(it);
  if(r.items.length<PAGE) break;
}
const win = R.classifyDiscoveryWindow({pagesFetched,lastBatchSize,pageSize:PAGE,maxPages:MAXP,incompleteResults:sawIncomplete});
console.log('VENTANA NUEVA: issues(sin PR)=%d pages=%d lastBatch=%d incomplete=%s', items.length,pagesFetched,lastBatchSize,sawIncomplete);
console.log('classifyDiscoveryWindow ->', JSON.stringify(win));

// --- corpus COMPLETO de issues abiertos (listado REST) para medir cobertura
let corpus=[];
for(let p=1;p<=25;p++){
  const r = gh(`repos/intrale/platform/issues?state=open&per_page=100&page=${p}`);
  for(const it of r) if(it.pull_request===undefined) corpus.push(it);
  if(r.length<100) break;
}
const RE=/^\s*\[\s*split\s+de\s+#(\d+)\s*\]/i;
const canonCorpus = corpus.filter(i=>RE.test(i.title||''));
const canonSearch = items.filter(i=>RE.test(i.title||''));
const sSearch=new Set(canonSearch.map(i=>i.number));
const missed = canonCorpus.filter(i=>!sSearch.has(i.number)).map(i=>i.number);
console.log('CORPUS abierto real = %d issues | con titulo canonico = %d', corpus.length, canonCorpus.length);
console.log('canonicos DENTRO de la ventana nueva = %d', canonSearch.length);
console.log('canonicos PERDIDOS por la ventana nueva = %d %j', missed.length, missed.slice(0,20));

// --- payload completeness (guard SO-8 necesita labels)
const sinLabels = items.filter(i=>!Array.isArray(i.labels)).length;
const sinAssoc  = items.filter(i=>!i.author_association).length;
console.log('items sin labels[]=%d sin author_association=%d', sinLabels, sinAssoc);
require('fs').writeFileSync('.tmp5516/items.json', JSON.stringify(items));
require('fs').writeFileSync('.tmp5516/corpus-canon.json', JSON.stringify(canonCorpus.map(i=>({n:i.number,t:i.title}))));
