// Prototipo: gate de marco decisorio (doc-level) + co-ocurrencia acotada (segmento)
const SIGNALS = [
  {key:'alternativas-enumeradas', re:/\b(?:alternativas?|opci[oó]n(?:es)?)\b/i,
   q:/\b(?:opci[oó]n\s*[AB1-9]|alternativa\s*[AB1-9]|vs\.?|versus|o\s+bien|elegir\s+entre|trade[-\s]?off)\b/i},
  {key:'servicio-externo', re:/\b(?:servicio|proveedor|provider|SaaS|vault|bucket|base\s+de\s+datos|broker)\s+externo\b|\badoptar\s+(?:un\s+)?(?:servicio|proveedor|provider)\b/i,
   q:/\b(?:adoptar|contratar|integrar|migrar\s+a|depender\s+de|costo|pricing|tier)\b/i},
  {key:'dato-critico', re:/\b(?:credenciales?|secretos?|tokens?|claves?|api\s*keys?|estado\s+operativo)\b/i,
   q:/\b(?:d[oó]nde\s+(?:viven?|se\s+(?:guardan?|almacenan?|persisten?))|almacenamiento|store|vault|persistencia)\b/i},
  {key:'local-vs-distribuido', re:/\b(?:local|en\s+disco|filesystem|single[-\s]host|un\s+solo\s+host)\b/i,
   q:/\b(?:distribuid[oa]|multi[-\s]host|compartid[oa]\s+entre|remot[oa]|centraliz)/i},
];
const FRAME = [
  /\bhay\s+que\s+(?:definir|decidir|elegir|resolver|optar)\b/i,
  /\bqueda\s+(?:por|a)\s+(?:definir|decidir|elegir)\b/i,
  /\b(?:definir|decidir|elegir)\s+(?:si|d[oó]nde|cu[aá]l(?:es)?|qu[eé]|entre)\b/i,
  /\boptar\s+por\b/i,
  /\bopci[oó]n\s*[AB1-9]\b/i, /\balternativa\s*[AB1-9]\b/i,
  /\b(?:dos|tres|varias)\s+(?:alternativas|opciones)\b/i,
  /\btrade[-\s]?off\b/i,
  /\bqueda(?:n)?\s+sin\s+definir\b/i,
  /\bdecisi[oó]n\s+(?:de\s+)?(?:arquitectura|dise[nñ]o|estructural|pendiente)\b/i,
  /\bpor\s+decidir\b/i,
];
const WINDOW = 200;
function strip(t){return String(t).replace(/```[\s\S]*?```/g,' ').replace(/`[^`\n]*`/g,' ');}
function segments(txt){
  const out=[];
  for(const line of String(txt).split(/\r?\n/)){
    for(const s of line.split(/(?<=[.;!?])\s+/)) if(s.trim()) out.push(s);
  }
  return out;
}
function near(seg, re, q){
  const a=seg.match(new RegExp(re.source,re.flags.replace('g','')+'g'));
  if(!a) return false;
  const ra=[...seg.matchAll(new RegExp(re.source,'gi'))].map(m=>m.index);
  const qa=[...seg.matchAll(new RegExp(q.source,'gi'))].map(m=>m.index);
  for(const i of ra) for(const j of qa) if(Math.abs(i-j)<=WINDOW) return true;
  return false;
}
function detect(title,body){
  const txt=`${title||''}\n${body||''}`;
  if(!FRAME.some(re=>re.test(txt))) return {escalate:false,signals:[],why:'sin marco decisorio'};
  const segs=segments(txt); const hit=[];
  for(const s of SIGNALS) if(segs.some(seg=>near(seg,s.re,s.q))) hit.push(s.key);
  return {escalate:hit.length>0, signals:hit, why:hit.length?'':'marco sin señal acotada'};
}
module.exports={detect};
