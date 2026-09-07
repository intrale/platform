const m = require('./.pipeline/lib/vault-access-audit.js');
const { evaluateAccessEvents, classifyAccessEvent } = m;
const CFG = { burst_threshold: 5, lookback_min: 30, cooldown_min: 10, expected_principals: ['arn:aws:iam::111111111111:role/ok'] };
const ct = (i, ok = true, name='GetParameter') => ({
  EventId: `evt-${i}`, EventName: name, EventTime: '2026-09-07T10:00:00Z',
  CloudTrailEvent: JSON.stringify({ userIdentity:{arn:'arn:aws:iam::111111111111:role/ok'}, eventName:name, ...(ok?{}:{errorCode:'AccessDenied'}) }),
});
const rafaga = r => r.notifications.some(n=>n.causa==='RAFAGA_DE_LECTURAS');
const run = (events, cfg=CFG) => evaluateAccessEvents({ now:new Date('2026-09-07T10:30:00Z'), events, state:{}, config:cfg });

console.log('--- P1: 500 cache_hit + 500 single_flight_join (umbral 5) ---');
const ruido = [...Array(500)].map(()=>({category:'cache_hit'})).concat([...Array(500)].map(()=>({category:'single_flight_join'})));
let r = run(ruido);
console.log('  rafaga?', rafaga(r), '| physical=', r.counters.physical_read, '| cache_hit=', r.counters.cache_hit, '=> ESPERADO: false, 0, 500');

console.log('--- P2: 100 AccessDenied (umbral 5) ---');
r = run([...Array(100)].map((_,i)=>ct(i,false)));
console.log('  rafaga?', rafaga(r), '| physical=', r.counters.physical_read, '| causas=', r.notifications.map(n=>n.causa).join(',') , '=> ESPERADO: false, 0, AUTORIZACION_RECHAZADA');

console.log('--- P3: fronteras estrictas (umbral 5) ---');
for (const n of [4,5,6]) {
  r = run([...Array(n)].map((_,i)=>ct(i)));
  console.log(`  n=${n} -> rafaga=${rafaga(r)} physical=${r.counters.physical_read}`);
}
console.log('  ESPERADO: 4=false, 5=false (estricto), 6=true');

console.log('--- P4: EVASION? evento CloudTrail con `category` inyectada ---');
const evasivo = [...Array(50)].map((_,i)=>({ ...ct(i), category:'cache_hit' }));
r = run(evasivo);
console.log('  rafaga?', rafaga(r), '| physical=', r.counters.physical_read, '=> ESPERADO: true, 50 (no debe evadirse)');

console.log('--- P5: fail-closed, 9 clases invalidas de burst_threshold ---');
const clases = [['ausente',undefined],['null',null],['cero',0],['negativo',-5],['string "12"','12'],['bool true',true],['fraccional',40.5],['Infinity',Infinity],['NaN',NaN],['entero inseguro',Number.MAX_SAFE_INTEGER+2]];
for (const [nombre,val] of clases) {
  const cfg = { ...CFG }; if (val===undefined) delete cfg.burst_threshold; else cfg.burst_threshold=val;
  try { const rr = run([...Array(100)].map((_,i)=>ct(i)), cfg);
    console.log(`  ${nombre}: NO LANZO (rafaga=${rafaga(rr)}) <-- FAIL-OPEN`);
  } catch(e) { console.log(`  ${nombre}: LANZO ok | filtra valor? ${String(e.message).includes(String(val))?'SI <-- LEAK':'no'} | msg="${e.message}"`); }
}
