const fs = require('fs');
const path = require('path');
const os = require('os');
const sweep = require('../../.pipeline/lib/commander/orphan-sweep.js');

const NOW = 1787700000000;
const T = NOW - 3 * 3600 * 1000; // turno de hace 3h -> dentro de ventana 48h

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe6459-'));
const logDir = path.join(tmp, 'logs');
fs.mkdirSync(logDir, { recursive: true });
const pipelineDir = tmp;
fs.mkdirSync(path.join(pipelineDir, 'logs'), { recursive: true });

// --- turno A: ENTREGA CONFIRMADA (B-12) — el caso que en rev-1 emitia 0 eventos
const reqA = `-1001234567890-${T}`;
fs.writeFileSync(path.join(logDir, `commander-${reqA}.stages.jsonl`), [
  JSON.stringify({ etapa: 'transcripción', boot_id: 'boot-ANTERIOR', chat_id: '-1001234567890' }),
  JSON.stringify({ etapa: 'dispatch' }),
  JSON.stringify({ etapa: 'envío', correlation_id: 'corr-REAL-A' }),
  // SIN etapa 'resultado'
].join('\n') + '\n');

// --- turno B: HUERFANO (B-13) — entrega no confirmada
const reqB = `-1009999999999-${T + 1}`;
fs.writeFileSync(path.join(logDir, `commander-${reqB}.stages.jsonl`), [
  JSON.stringify({ etapa: 'transcripción', boot_id: 'boot-ANTERIOR', chat_id: '-1009999999999' }),
  JSON.stringify({ etapa: 'envío', correlation_id: 'corr-REAL-B' }),
].join('\n') + '\n');

fs.writeFileSync(path.join(pipelineDir, 'commander-history.jsonl'), '');

const emitidos = [];
const inflight = require('../../.pipeline/lib/commander/inflight-fallback.js');
const deps = {
  outboundStatus: (historyRaw, cid) => (cid === 'corr-REAL-A' ? 'enviado' : 'fallido'),
  noteFallbackDeliveryResolved: (args) => {
    emitidos.push({ req: args.commanderReqId, success: args.success, delivery_state: args.deliveryState, error_code: args.errorCode });
    return inflight.noteFallbackDeliveryResolved(args); // appender REAL -> escribe audit encadenado
  },
  log: (m) => console.log('LOG:', m),
};

const r1 = sweep.runOrphanSweep({ logDir, pipelineDir, nowMs: NOW, currentBootId: 'boot-ACTUAL', deps });
console.log('=== RUN 1 ===');
console.log('resumen   =', JSON.stringify(r1.resumen));
console.log('veredictos=', JSON.stringify(r1.resultados.map(x => ({ v: x.verdict, r: x.reason }))));
console.log('emitidos  =', r1.emitidos.length, JSON.stringify(r1.emitidos));
console.log('emitidosOk=', JSON.stringify(r1.emitidosOk), ' fallidos=', JSON.stringify(r1.emitidosFallidos));
console.log('PAYLOADS  =', JSON.stringify(emitidos, null, 1));

// --- RUN 2: idempotencia (CA-11) contra el audit encadenado REAL
emitidos.length = 0;
const r2 = sweep.runOrphanSweep({ logDir, pipelineDir, nowMs: NOW + 60000, currentBootId: 'boot-ACTUAL', deps });
console.log('=== RUN 2 (mismo tick+1min) ===');
console.log('emitidos  =', r2.emitidos.length, JSON.stringify(r2.emitidos));

// --- entradas reales asentadas en el audit
console.log('=== AUDIT FILES ===');
for (const f of fs.readdirSync(path.join(pipelineDir, 'logs'))) {
  const raw = fs.readFileSync(path.join(pipelineDir, 'logs', f), 'utf8');
  console.log('--', f);
  console.log(raw.trim());
}
