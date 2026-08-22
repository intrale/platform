const fs=require('fs'),path=require('path'),crypto=require('crypto');
const txt=fs.readFileSync('.pipeline/_tmp/po5220/render.txt','utf8');
const js=fs.readFileSync('.pipeline/_tmp/po5220/render.json','utf8');
const parent=path.resolve('..');
const SHAPES=[/^\d{6,}:[A-Za-z0-9_-]{35,}$/,/^sk-[A-Za-z0-9-]{20,}$/,/^GOCSPX-[A-Za-z0-9_-]{20,}$/,/^1\/\/[A-Za-z0-9_-]{20,}$/];
const vals=new Set(); let files=0;
function walk(o){if(!o||typeof o!=='object')return;for(const k of Object.keys(o)){const v=o[k];
  if(typeof v==='string'){if(SHAPES.some(r=>r.test(v)))vals.add(v);}else walk(v);}}
for(const d of fs.readdirSync(parent)){
  if(!/^platform\.(session|agent)-/.test(d))continue;
  for(const rel of ['.claude/hooks/telegram-config.json','.claude/.claude/hooks/telegram-config.json']){
    const p=path.join(parent,d,rel);
    if(fs.existsSync(p)){files++;try{walk(JSON.parse(fs.readFileSync(p,'utf8')))}catch(e){}}}}
console.log('archivos leidos:',files,'| valores REALES distintos con forma de secreto:',vals.size);
let leakTxt=0,leakJson=0;
for(const v of vals){const h=crypto.createHash('sha256').update(v).digest('hex').slice(0,8);
  let ft=false,fj=false;
  for(let i=0;i+8<=v.length;i++){const w=v.slice(i,i+8);
    if(!ft&&txt.includes(w)){ft=true;console.log('FUGA TXT sha8='+h+' offset='+i);}
    if(!fj&&js.includes(w)){fj=true;console.log('FUGA JSON sha8='+h+' offset='+i);}}
  if(ft)leakTxt++; if(fj)leakJson++;
  console.log('  valor sha8='+h+' len='+v.length+' -> hash8 presente en reporte? '+txt.includes(h));}
console.log('FUGA_EN_REPORTE_TXT:',leakTxt,'| FUGA_EN_SALIDA_JSON:',leakJson);
console.log('"Sistema sano" en txt:',txt.split('Sistema sano').length-1,'| "No hay fantasmas":',txt.split('No hay fantasmas').length-1);
const r=JSON.parse(js.slice(js.indexOf('{')));
const keys=new Set(); (r.leakedSecrets||[]).forEach(f=>Object.keys(f).forEach(k=>keys.add(k)));
console.log('campos del Finding:',[...keys].join(','),'| tiene campo value?',keys.has('value'));
const cat={}; (r.leakedSecrets||[]).forEach(f=>cat[f.category]=(cat[f.category]||0)+1);
console.log('categorias:',JSON.stringify(cat),'| total:',(r.leakedSecrets||[]).length);
