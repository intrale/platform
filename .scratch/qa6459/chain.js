'use strict';
// CA-4 — hash-chain sobre el audit REAL que dejo el barrido, con firma posicional.
const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const auditLog = require(path.join(ROOT, '.pipeline/lib/audit-log.js'));
const inflight = require(path.join(ROOT, '.pipeline/lib/commander/inflight-fallback.js'));

const file = process.argv[2];
console.log('archivo =', file, '| existe =', fs.existsSync(file));
console.log('lineas  =', fs.readFileSync(file, 'utf8').trim().split('\n').length);
console.log('verifyChain (posicional) =', JSON.stringify(auditLog.verifyChain(file)));

// Entrada VIEJA (sin success/error_code): la simulo appendeando una entry legacy
// a mano por el mismo appender encadenado, y vuelvo a verificar.
auditLog.appendChained({
  file,
  entry: {
    event: 'inflight_fallback_delivery_resolved',
    skill: 'commander',
    primary_provider: 'anthropic',
    secondary_provider: 'openai',
    request_id: null,
    chat_id_hash: 'deadbeefcafe',
    resolved_by: 'telegram_receipt',
    commander_req_id: 'deadbeefcafe-1787000000000',
    delivery_state: 'delivery_observed',
    // SIN success ni error_code — forma previa a #6459
  },
});
console.log('tras appendear una entry LEGACY sin los campos nuevos:');
console.log('verifyChain =', JSON.stringify(auditLog.verifyChain(file)));

// Y una entry NUEVA despues de la legacy: la cadena tiene que seguir cerrando.
inflight.noteFallbackDeliveryResolved({
  pipelineDir: path.resolve(file, '..', '..'),
  commanderReqId: 'deadbeefcafe-1787000000001',
  chatId: 'x',
  deliveryState: 'delivery_failed',
  success: false,
  errorCode: 'delivered=false',
  resolvedBy: 'orphan_sweep',
  now: Date.parse('2026-08-25T18:00:00Z'),
});
console.log('tras appendear una entry NUEVA despues de la legacy:');
console.log('verifyChain =', JSON.stringify(auditLog.verifyChain(file)));
const last = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-2);
last.forEach(l => { const e = JSON.parse(l); console.log('  entry:', JSON.stringify({ commander_req_id: e.commander_req_id, success: e.success, error_code: e.error_code, delivery_state: e.delivery_state })); });
