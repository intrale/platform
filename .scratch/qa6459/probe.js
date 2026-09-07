'use strict';
// Probe QA #6459 — E2E real: filesystem real, appender real (audit encadenado),
// commanderOutboundStatus REAL extraido del fuente de pulpo.js.
const fs = require('fs'); const path = require('path'); const os = require('os');
const ROOT = path.resolve(__dirname, '..', '..');
const sweep = require(path.join(ROOT, '.pipeline/lib/commander/orphan-sweep.js'));
const inflight = require(path.join(ROOT, '.pipeline/lib/commander/inflight-fallback.js'));
const auditLog = require(path.join(ROOT, '.pipeline/lib/audit-log.js'));
const reqLog = require(path.join(ROOT, '.pipeline/lib/commander/request-log.js'));

// --- commanderOutboundStatus REAL, extraido del fuente de produccion ---
const src = fs.readFileSync(path.join(ROOT, '.pipeline/pulpo.js'), 'utf8');
const ini = src.indexOf('function commanderOutboundStatus(');
const fin = src.indexOf('\n}', ini) + 2;
const fnSrc = src.slice(ini, fin);
console.log('--- fuente extraida de pulpo.js (produccion), primeras lineas ---');
console.log(fnSrc.split('\n').slice(0, 3).join('\n') + '\n  ...');
const outboundStatus = new Function(fnSrc + '; return commanderOutboundStatus;')();

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'qa6459-'));
const LOGDIR = path.join(SB, 'logs');
fs.mkdirSync(LOGDIR, { recursive: true });

const NOW = Date.parse('2026-08-25T18:00:00Z');
const H = 3600000;
const BOOT_VIEJO = '111-1755000000000';
const BOOT_ACTUAL = '999-1756100000000';

function stages(reqId, entries) {
  fs.writeFileSync(path.join(LOGDIR, 'commander-' + reqId + '.stages.jsonl'),
    entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}
const T = (boot) => ({ etapa: 'transcripción', audios: 1, mensajes: 1, chat_id: '-1001234', boot_id: boot });
const ENV = (cid) => ({ etapa: 'envío', canal: 'telegram', correlation_id: cid, voz_ok: true, chars: 120, disclaimer: 'ninguno' });
const RES = () => ({ etapa: 'resultado', resultado: 'ok' });

const ms = (hAtras) => String(NOW - hAtras * H);
const ID_HUERFANO_SIN_ENV = '-1001234-' + ms(2) + '-aa1';   // B-10 sin saliente
const ID_HUERFANO_FALLIDO = '-1001234-' + ms(3) + '-bb2';   // B-13 outbound fallido
const ID_ENTREGADO        = '-1001234-' + ms(4) + '-cc3';   // B-12 entrega confirmada
const ID_VIVO             = '-1001234-' + ms(1) + '-dd4';   // boot actual
const ID_CERRO_SOLO       = '-1001234-' + ms(5) + '-ee5';   // early-return con resultado
const ID_DIRECTO          = '-1001234-' + ms(6) + '-ff6';   // correlation_id 'directo'
const ID_FUERA_VENTANA    = '-1001234-' + ms(72) + '-gg7';  // 72h > 48h

stages(ID_HUERFANO_SIN_ENV, [T(BOOT_VIEJO)]);
stages(ID_HUERFANO_FALLIDO, [T(BOOT_VIEJO), ENV('corr-fallido')]);
stages(ID_ENTREGADO,        [T(BOOT_VIEJO), ENV('corr-ok')]);
stages(ID_VIVO,             [T(BOOT_ACTUAL)]);
stages(ID_CERRO_SOLO,       [T(BOOT_VIEJO), RES()]);
stages(ID_DIRECTO,          [T(BOOT_VIEJO), ENV('directo')]);
stages(ID_FUERA_VENTANA,    [T(BOOT_VIEJO)]);
// SEC: nombre con traversal + un directorio disfrazado de archivo de etapas
try { fs.writeFileSync(path.join(LOGDIR, 'commander-..-..-evil.stages.jsonl'), JSON.stringify(T(BOOT_VIEJO)) + '\n'); } catch (e) { console.log('no pude crear el traversal:', e.message); }
fs.mkdirSync(path.join(LOGDIR, 'commander--1001234-' + ms(2) + '-zz9.stages.jsonl'), { recursive: true });

fs.writeFileSync(path.join(SB, 'commander-history.jsonl'), [
  JSON.stringify({ direction: 'out', correlation_id: 'corr-ok', chat_id: '-1001234' }),
  JSON.stringify({ direction: 'reconcile', correlation_id: 'corr-ok', status: 'enviado' }),
  JSON.stringify({ direction: 'out', correlation_id: 'corr-fallido', chat_id: '-1001234' }),
  JSON.stringify({ direction: 'reconcile', correlation_id: 'corr-fallido', status: 'fallido' }),
].join('\n') + '\n');

const hist = fs.readFileSync(path.join(SB, 'commander-history.jsonl'), 'utf8');
console.log('\noutboundStatus REAL: corr-ok =>', outboundStatus(hist, 'corr-ok'),
  '| corr-fallido =>', outboundStatus(hist, 'corr-fallido'));

const abiertos = [];
const readStagesSpy = (dir, reqId) => { abiertos.push(reqId); return reqLog.readStages(dir, reqId); };

const logs = [];
function correr() {
  return sweep.runOrphanSweep({
    logDir: LOGDIR, pipelineDir: SB, nowMs: NOW, currentBootId: BOOT_ACTUAL,
    deps: {
      outboundStatus,
      noteFallbackDeliveryResolved: inflight.noteFallbackDeliveryResolved,
      readStages: readStagesSpy,
      log: (m) => logs.push(m),
    },
  });
}

console.log('\n=== BARRIDO 1 ===');
const r1 = correr();
console.log('resumen   =', JSON.stringify(r1.resumen));
console.log('veredictos=', JSON.stringify(r1.resultados.map(x => ({ v: x.verdict, r: x.reason }))));
console.log('emitidos  =', r1.emitidos.length, '| con entrega (success:true):', r1.emitidosOk.length, '| sin entrega:', r1.emitidosFallidos.length);

console.log('\n=== BARRIDOS 2 y 3 (idempotencia CA-11) ===');
const r2 = correr(); const r3 = correr();
console.log('emitidos barrido2 =', r2.emitidos.length, '| barrido3 =', r3.emitidos.length);

const d = new Date(NOW);
const auditFile = path.join(SB, 'logs', 'commander-dispatch-' + d.getUTCFullYear() + '-'
  + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0') + '.jsonl');
const raw = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const res = raw.map(e => (e.entry && typeof e.entry === 'object') ? e.entry : e)
  .filter(e => e.event === 'inflight_fallback_delivery_resolved');
console.log('\n=== ENTRIES EN EL AUDIT ENCADENADO REAL ===');
for (const e of res) {
  console.log(JSON.stringify({ commander_req_id: e.commander_req_id, delivery_state: e.delivery_state, success: e.success, error_code: e.error_code, resolved_by: e.resolved_by, chat_id_hash: e.chat_id_hash }));
}
const porId = {};
for (const e of res) porId[e.commander_req_id] = (porId[e.commander_req_id] || 0) + 1;
console.log('entradas por commander_req_id =', JSON.stringify(porId));

console.log('\n=== HASH-CHAIN (CA-4) ===');
console.log(JSON.stringify(auditLog.verifyChain({ file: auditFile })));

console.log('\n=== CA-8: reqIds efectivamente ABIERTOS por el barrido ===');
console.log(JSON.stringify([...new Set(abiertos)]));
console.log('fuera de ventana (72h) abierto?', abiertos.includes(ID_FUERA_VENTANA));
console.log('boot vivo evaluado?', JSON.stringify(r1.resultados.filter(x => x.verdict === 'no_evaluable').map(x => x.reason)));

console.log('\n=== SEC: nada escrito fuera de logDir ===');
console.log('sobrantes en sandbox raiz =', JSON.stringify(fs.readdirSync(SB).filter(f => f !== 'logs' && f !== 'commander-history.jsonl')));

console.log('\n=== LOG DEL BARRIDO (CA-14) ===');
logs.slice(0, 8).forEach(l => console.log(' ' + l));

console.log('\n=== auditRef seudonimizado (SEC-4) ===');
console.log('reqId crudo =', ID_ENTREGADO, '=> auditRef =', reqLog.buildAuditReqRef(ID_ENTREGADO));
console.log('el audit contiene el chat crudo "-1001234"?', fs.readFileSync(auditFile, 'utf8').includes('-1001234'));

console.log('\n=== CA-14: barrido que FALLA deja rastro y no dice "todo sano" ===');
const logsFallo = [];
const rFallo = sweep.runOrphanSweep({
  logDir: LOGDIR, pipelineDir: SB, nowMs: NOW, currentBootId: BOOT_ACTUAL,
  deps: {
    outboundStatus, noteFallbackDeliveryResolved: inflight.noteFallbackDeliveryResolved,
    log: (m) => logsFallo.push(m),
    fsImpl: { readdirSync() { throw new Error('EACCES simulado'); }, readFileSync: fs.readFileSync, existsSync: fs.existsSync },
  },
});
console.log('ok =', rFallo.ok, '| error =', rFallo.error, '| resumen =', JSON.stringify(rFallo.resumen));
console.log('rastro =', JSON.stringify(logsFallo));

console.log('\nSANDBOX:', SB);
