const { evaluateAccessEvents, formatAccessAlert } = require('./.pipeline/lib/vault-access-audit.js');
const CFG = { burst_threshold: 5, lookback_min: 30, cooldown_min: 10, expected_principals: [] };
const run = (events, cfg=CFG) => evaluateAccessEvents({ now:new Date('2026-09-07T10:30:00Z'), events, state:{}, config:cfg });
const rafaga = r => r.notifications.some(n=>n.causa==='RAFAGA_DE_LECTURAS');

console.log('--- P6: 100 eventos SIN EventId, mismo EventName/EventTime/principal (colision de id fallback) ---');
const sinId = [...Array(100)].map(()=>({ EventName:'GetParameter', EventTime:'2026-09-07T10:00:00Z',
  CloudTrailEvent: JSON.stringify({userIdentity:{arn:'arn:aws:iam::111111111111:role/atacante'}, eventName:'GetParameter'}) }));
let r = run(sinId);
console.log('  physical=', r.counters.physical_read, '| rafaga?', rafaga(r), '| records=', r.records.length);
console.log('  >> 100 lecturas reales colapsan a', r.counters.physical_read, '- deflacion del conteo');

console.log('--- P6b: mismo caso pero CON EventId unico (camino real de CloudTrail) ---');
const conId = sinId.map((e,i)=>({ ...e, EventId:`e${i}` }));
r = run(conId);
console.log('  physical=', r.counters.physical_read, '| rafaga?', rafaga(r), '=> detecta bien');

console.log('--- P7: la alerta de rafaga no filtra ARN/account id/IP ---');
const alerta = formatAccessAlert(run(conId).notifications, 'vault-test-abc');
console.log(alerta);
console.log('  contiene ARN o account id?', /arn:aws|\b\d{12}\b/.test(alerta) ? 'SI <-- LEAK' : 'NO ✅');
