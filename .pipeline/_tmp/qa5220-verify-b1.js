const realFs = require('fs');
const S = require('/c/Workspaces/Intrale/platform.agent-5220-pipeline-dev/.pipeline/lib/secret-leak-scan.js'.replace('/c/','C:/'));
const MAIN = 'C:/Workspaces/Intrale/platform';

const roots = S.enumerateScanRoots({ mainRepo: MAIN });
const scan = S.scanLeakedSecrets({ roots });
const findings = S.classifyAll(scan.findings);

const cats = {};
for (const f of findings) cats[f.category] = (cats[f.category] || 0) + 1;
console.log('raices=', roots.length, 'archivos=', scan.filesScanned ?? scan.dirsScanned, 'hallazgos=', findings.length);
console.log('categorias=', JSON.stringify(cats));

const purgables = findings.filter(f => f.category === 'purgable');
const porArchivo = new Map();
for (const f of purgables) porArchivo.set(f.file, (porArchivo.get(f.file) || 0) + 1);
console.log('purgables=', purgables.length, '| archivos distintos=', porArchivo.size,
            '| archivos con >=2 credenciales=', [...porArchivo.values()].filter(n => n >= 2).length);

// fsImpl FAKE: emula el borrado en memoria. El disco real NO se toca.
const borrados = new Set();
const fakeFs = Object.create(realFs);
fakeFs.lstatSync = (p) => { if (borrados.has(p)) { const e = new Error('ENOENT: no such file or directory, lstat'); e.code='ENOENT'; throw e; } return realFs.lstatSync(p); };
fakeFs.unlinkSync = (p) => { borrados.add(p); };

const res = S.purgeFindings(findings, { dryRun: false, fsImpl: fakeFs, mainRepo: MAIN });
const removedTrue = res.purged.filter(p => p.removed).length;
const purgSkipped = res.skipped.filter(s => s.category === 'purgable');
console.log('--- simulacion --run (fsImpl fake, disco intacto) ---');
console.log('purged con removed=true =', removedTrue, '/', purgables.length);
console.log('archivos realmente unlinkeados =', borrados.size, '/', porArchivo.size);
console.log('SKIPPED de categoria purgable =', purgSkipped.length);
if (purgSkipped.length) console.log('  motivos:', [...new Set(purgSkipped.map(s => s.skipReason))]);

// Reconstruyo el report como lo hace ghostbusters tras --run
const byKey = new Map(res.purged.map(p => [p.file + '\u0000' + p.key, p]));
const post = findings.map(f => { const p = byKey.get(f.file + '\u0000' + f.key); return p ? { ...f, removed: p.removed } : f; });

console.log('EXIT solo-purgables tras --run =',
  S.computeExitCode({ leakedSecrets: post.filter(f => f.category === 'purgable'), secretsScanErrors: [], secretsUnparseable: 0 }),
  '(la review rev-1 medía 2 = PURGABLE_PENDING; esperado 0 = CLEAN)');
console.log('EXIT global tras --run =',
  S.computeExitCode({ leakedSecrets: post, secretsScanErrors: [], secretsUnparseable: 0 }));

// Verificacion de que el disco NO fue tocado
console.log('archivos que SIGUEN en disco real =', [...porArchivo.keys()].filter(f => realFs.existsSync(f)).length, '/', porArchivo.size);
