// CA-3 — barrido de subcadenas de 8+ chars del valor REAL contra el reporte real.
// NUNCA se imprime el valor: solo hash8, longitud y el veredicto.
const fs = require('fs'); const crypto = require('crypto');
const REPORTE = fs.readFileSync('qa/evidence/5220/render-real-pass3.txt', 'utf8');
const S = require('C:/Workspaces/Intrale/platform.agent-5220-pipeline-dev/.pipeline/lib/secret-leak-scan.js');
const roots = S.enumerateScanRoots({ mainRepo: 'C:/Workspaces/Intrale/platform' });

const valores = new Map(); // hash8 -> {len, kind}
for (const root of roots) {
  const f = root + '/.claude/hooks/telegram-config.json';
  const f2 = root + '/.claude/.claude/hooks/telegram-config.json';
  for (const p of [f, f2]) {
    let j; try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    for (const [k, v] of Object.entries(j)) {
      if (typeof v !== 'string') continue;
      const c = S.classifyValue(k, v);
      if (c.verdict !== 'real') continue;
      if (!valores.has(c.hash8)) valores.set(c.hash8, { v, len: c.len, kind: c.kind, key: k });
    }
  }
}
let totalFiltradas = 0;
console.log('credenciales REALES distintas halladas en disco:', valores.size);
for (const [h8, info] of valores) {
  let fugas = 0;
  for (let i = 0; i + 8 <= info.v.length; i++) if (REPORTE.includes(info.v.slice(i, i + 8))) fugas++;
  totalFiltradas += fugas;
  console.log(`  ${info.kind.padEnd(24)} clave=${info.key.padEnd(28)} len=${String(info.len).padEnd(4)} sha8=${h8}  hash_en_reporte=${REPORTE.includes(h8)}  SUBCADENAS_8_FILTRADAS=${fugas}`);
}
console.log('TOTAL_SUBCADENAS_FILTRADAS =', totalFiltradas, totalFiltradas === 0 ? ' -> CA-3 CUMPLE' : ' -> CA-3 FALLA');
// grep de las 4 formas de secreto sobre el reporte
const formas = { telegram: /\b\d{6,}:[A-Za-z0-9_-]{35,}\b/g, openai: /sk-[A-Za-z0-9_-]{20,}/g, gocspx: /GOCSPX-[A-Za-z0-9_-]{20,}/g, refresh: /1\/\/[A-Za-z0-9_-]{20,}/g };
for (const [n, re] of Object.entries(formas)) console.log(`  forma ${n.padEnd(10)} matches_en_reporte=${(REPORTE.match(re) || []).length}`);
