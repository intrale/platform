// =============================================================================
// orphan-sweep.test.js — Cobertura del barrido de rescate de turnos huérfanos
// del Commander (#6459).
//
// CA-15 · ENUMERACIÓN DE RAMAS DE DECISIÓN → TEST QUE LA CUBRE.
// El repo todavía no tiene `c8`/`nyc` (deuda #6510), así que la cobertura de
// ramas se acredita nombrando cada rama y su test. Las etiquetas B-01..B-14 son
// literalmente las del bloque de comentario de `classifyRequest`.
//
//   B-01 req_id_invalido ........... T-B01
//   B-02 fuera_de_ventana .......... T-B02  (+ T-CA8 en la capa de I/O)
//   B-03 ya_resuelto ............... T-B03  (+ T-CA11 idempotencia real)
//   B-04 sin_canal_reciente ........ T-B04
//   B-05 sin_canal_estructurado .... T-B05
//   B-06 boot_actual ............... T-B06  (+ T-CA5 "no se abre")
//   B-07 legacy_reciente ........... T-B07
//   B-08 sin_transcripcion ......... T-B08
//   B-09 cerro_solo ................ T-B09  (CA-6, early-return; T-CA3c: no emite)
//   B-10 sin_saliente .............. T-B10  (huérfano canónico del episodio)
//   B-11 correlacion_directa ....... T-B11  (R-2)
//   B-12 entrega_confirmada ........ T-B12  (CA-10, turno sano)
//                                     T-CA3a/b/d/e: desenlace terminal EXITOSO
//   B-13 entrega_no_confirmada ..... T-B13  (fallido / encolado)
//   B-14 correlacion_sin_rastro .... T-B14  (O-1: 'unknown' NO es huérfano)
//
// Ramas de la capa de I/O y del parser:
//   T-CA8   ventana decidida por el nombre ANTES de abrir (lector espiado)
//   T-CA11  N barridos ⇒ 1 solo evento por commander_req_id
//   T-CA3a  entrega confirmada ⇒ evento EXITOSO por el camino REAL (runOrphanSweep)
//   T-CA3b  idempotencia (CA-11) también en la rama de éxito
//   T-CA3c  `cerro_solo` no emite nada
//   T-CA3d  `entregados` del núcleo puro = exactamente B-12
//   T-CA3e  los DOS desenlaces conviven en un mismo barrido
//   T-CA14  readdirSync que tira ⇒ rastro logueado y sin excepción
//   T-SEC0  cabecera de etapa FORJADA en el .log no cambia el veredicto
//   T-SEC1  nombres con `..` / separadores ⇒ descartados
//   T-SEC2  dirent que no es archivo ⇒ salteado
//   T-SEC4  el evento lleva sólo identificadores seudonimizados
//   T-PARSE chat de grupo negativo + suffix hex, y suffix puramente numérico
//
// Wiring en `pulpo.js` (requiere pulpo con `PULPO_NO_AUTOSTART=1`):
//   T-CA12   M iteraciones del mainLoop ⇒ floor(M/10) barridos
//   T-WIRING el runner cablea outboundStatus + emisor reales y no tira
//   integración · el barrido contra el `commanderOutboundStatus` REAL
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sweep = require('../orphan-sweep');
const { detectOrphans, runOrphanSweep, OrphanVerdict, ORPHAN_WINDOW_MS } = sweep;
const { buildAuditReqRef, stagesFileName } = require('../request-log');

// Reloj fijo del suite. Nada acá mira `Date.now()`: el núcleo es puro y la capa
// de I/O recibe `nowMs`.
const NOW = 1756000000000;                 // 2025-08-24T02:26:40Z
const HORA = 60 * 60 * 1000;
const CHAT = '-1001234567890';             // supergrupo real: negativo y largo
const BOOT_ACTUAL = '4242-1755999000000';
const BOOT_VIEJO = '1111-1755000000000';

// --- helpers de fixture -------------------------------------------------------
function reqIdEn(edadMs, suffix) {
  const ms = NOW - edadMs;
  return suffix ? `${CHAT}-${ms}-${suffix}` : `${CHAT}-${ms}`;
}

function etapaTranscripcion(bootId) {
  const e = { etapa: 'transcripción', audios: '0', mensajes: '1', chat_id: CHAT };
  if (bootId !== null) e.boot_id = bootId;
  return e;
}
function etapaEnvio(correlationId) {
  return { etapa: 'envío', canal: 'texto', correlation_id: correlationId, chars: '42' };
}
const ETAPA_DISPATCH = { etapa: 'dispatch', provider: 'anthropic' };
const ETAPA_RESULTADO = { etapa: 'resultado', resultado: 'ok', provider: 'anthropic' };

function correr(entradas, extra = {}) {
  return detectOrphans({
    stagesByReq: entradas,
    historyRaw: extra.historyRaw || '',
    nowMs: NOW,
    currentBootId: BOOT_ACTUAL,
    windowMs: ORPHAN_WINDOW_MS,
    notified: extra.notified || null,
    deps: { outboundStatus: extra.outboundStatus },
  });
}
const soloVeredicto = (r) => ({ verdict: r.resultados[0].verdict, reason: r.resultados[0].reason });

// =============================================================================
// NÚCLEO PURO — una rama, un test.
// =============================================================================

// --- B-01 ---------------------------------------------------------------------
test('B-01 · un reqId sin epochms derivable no se evalúa', () => {
  const r = correr([{ reqId: 'sinformato', stages: [etapaTranscripcion(BOOT_VIEJO)] }]);
  assert.deepEqual(soloVeredicto(r), { verdict: OrphanVerdict.NO_EVALUABLE, reason: 'req_id_invalido' });
  assert.equal(r.huerfanos.length, 0);
});

// --- B-02 ---------------------------------------------------------------------
test('B-02 · un turno fuera de la ventana de 48 h no se evalúa (D-1)', () => {
  const r = correr([{
    reqId: reqIdEn(49 * HORA),
    stages: [etapaTranscripcion(BOOT_VIEJO)], // sería huérfano si estuviera en ventana
  }]);
  assert.deepEqual(soloVeredicto(r), { verdict: OrphanVerdict.NO_EVALUABLE, reason: 'fuera_de_ventana' });
});

// --- B-03 ---------------------------------------------------------------------
test('B-03 · un huérfano ya resuelto/notificado no se re-evalúa (CA-11)', () => {
  const reqId = reqIdEn(3 * HORA);
  const notified = new Set([buildAuditReqRef(reqId)]);
  const r = correr([{ reqId, stages: [etapaTranscripcion(BOOT_VIEJO)] }], { notified });
  assert.deepEqual(soloVeredicto(r), { verdict: OrphanVerdict.NO_EVALUABLE, reason: 'ya_resuelto' });
  assert.equal(r.huerfanos.length, 0);
});

// --- B-04 / B-05 --------------------------------------------------------------
test('B-04 · canal estructurado vacío y turno reciente ⇒ no evaluable (puede seguir vivo)', () => {
  const r = correr([{ reqId: reqIdEn(10 * 60 * 1000), stages: [] }]);
  assert.deepEqual(soloVeredicto(r), { verdict: OrphanVerdict.NO_EVALUABLE, reason: 'sin_canal_reciente' });
});

test('B-05 · log legacy sin canal estructurado ⇒ NO_VERIFICABLE, nunca suprime ni afirma', () => {
  const r = correr([{ reqId: reqIdEn(6 * HORA), stages: [] }]);
  assert.deepEqual(soloVeredicto(r), { verdict: OrphanVerdict.NO_VERIFICABLE, reason: 'sin_canal_estructurado' });
  // "nunca suprime": el turno SÍ aparece en el reporte, no se descarta en silencio.
  assert.equal(r.resumen.no_verificables, 1);
  assert.equal(r.huerfanos.length, 0);
});

// --- B-06 (CA-5) --------------------------------------------------------------
test('B-06 · un turno del boot ACTUAL nunca se evalúa como huérfano (CA-5 / B1)', () => {
  const r = correr([{
    reqId: reqIdEn(2 * HORA),
    stages: [etapaTranscripcion(BOOT_ACTUAL)], // mismo boot ⇒ lo cierra el finally
  }]);
  assert.deepEqual(soloVeredicto(r), { verdict: OrphanVerdict.NO_EVALUABLE, reason: 'boot_actual' });
});

test('B-06b · la guarda de vida es por boot_id, NO por reloj: un turno de 30 h de otro boot sí se evalúa', () => {
  const r = correr([{ reqId: reqIdEn(30 * HORA), stages: [etapaTranscripcion(BOOT_VIEJO)] }]);
  assert.equal(r.resultados[0].verdict, OrphanVerdict.HUERFANO);
});

// --- B-07 ---------------------------------------------------------------------
test('B-07 · legacy sin boot_id y con menos de 45 min ⇒ no evaluable', () => {
  const r = correr([{ reqId: reqIdEn(20 * 60 * 1000), stages: [etapaTranscripcion(null)] }]);
  assert.deepEqual(soloVeredicto(r), { verdict: OrphanVerdict.NO_EVALUABLE, reason: 'legacy_reciente' });
});

test('B-07b · legacy sin boot_id pasados los 45 min ⇒ ya es evaluable', () => {
  const r = correr([{ reqId: reqIdEn(2 * HORA), stages: [etapaTranscripcion(null)] }]);
  assert.equal(r.resultados[0].verdict, OrphanVerdict.HUERFANO);
});

// --- B-08 ---------------------------------------------------------------------
test('B-08 · sin etapa de transcripción el turno no llegó a ejecutarse ⇒ no evaluable', () => {
  const r = correr([{ reqId: reqIdEn(3 * HORA), stages: [ETAPA_DISPATCH] }]);
  assert.deepEqual(soloVeredicto(r), { verdict: OrphanVerdict.NO_EVALUABLE, reason: 'sin_transcripcion' });
});

// --- B-09 (CA-6) --------------------------------------------------------------
test('B-09 · early-return CON etapa resultado y SIN etapa envío NO es huérfano (CA-6)', () => {
  const r = correr([{
    reqId: reqIdEn(3 * HORA),
    stages: [etapaTranscripcion(BOOT_VIEJO), ETAPA_RESULTADO], // cerró solo, sin `envío`
  }]);
  assert.deepEqual(soloVeredicto(r), { verdict: OrphanVerdict.SANO, reason: 'cerro_solo' });
  assert.equal(r.huerfanos.length, 0);
});

// --- B-10 ---------------------------------------------------------------------
test('B-10 · huérfano real: transcripción, sin resultado, sin saliente, boot viejo (CA-1)', () => {
  const reqId = reqIdEn(5 * HORA);
  const r = correr([{ reqId, stages: [etapaTranscripcion(BOOT_VIEJO), ETAPA_DISPATCH] }]);
  assert.deepEqual(soloVeredicto(r), { verdict: OrphanVerdict.HUERFANO, reason: 'sin_saliente' });
  assert.equal(r.huerfanos.length, 1);
  assert.equal(r.huerfanos[0].auditRef, buildAuditReqRef(reqId));
  assert.equal(r.huerfanos[0].chatId, CHAT);
});

// --- B-11 (R-2) ---------------------------------------------------------------
test('B-11 · correlation_id "directo" ⇒ NO_VERIFICABLE, no huérfano (R-2)', () => {
  const r = correr([{
    reqId: reqIdEn(3 * HORA),
    stages: [etapaTranscripcion(BOOT_VIEJO), etapaEnvio('directo')],
  }]);
  assert.deepEqual(soloVeredicto(r), { verdict: OrphanVerdict.NO_VERIFICABLE, reason: 'correlacion_directa' });
  assert.equal(r.huerfanos.length, 0);
});

test('B-11b · etapa envío con correlation_id vacío ⇒ mismo tratamiento que "directo"', () => {
  const r = correr([{
    reqId: reqIdEn(3 * HORA),
    stages: [etapaTranscripcion(BOOT_VIEJO), etapaEnvio('')],
  }]);
  assert.equal(r.resultados[0].verdict, OrphanVerdict.NO_VERIFICABLE);
});

// --- B-12 (CA-10) -------------------------------------------------------------
test('B-12 · turno sano de 4 etapas con entrega confirmada ⇒ CERO detecciones (CA-10)', () => {
  const llamadas = [];
  const r = correr([{
    reqId: reqIdEn(4 * HORA),
    stages: [
      etapaTranscripcion(BOOT_VIEJO),
      ETAPA_DISPATCH,
      { etapa: 'sherlock', verdict: 'ok' },
      etapaEnvio('cid-sano'),
    ],
  }], {
    historyRaw: 'irrelevante: el veredicto lo da outboundStatus',
    outboundStatus: (raw, cid) => { llamadas.push(cid); return 'enviado'; },
  });
  assert.deepEqual(soloVeredicto(r), { verdict: OrphanVerdict.SANO, reason: 'entrega_confirmada' });
  assert.equal(r.resumen.huerfanos, 0);
  // CA-7: el veredicto se pidió a `commanderOutboundStatus` con el cid que la
  // etapa `envío` sólo TRANSPORTA.
  assert.deepEqual(llamadas, ['cid-sano']);
});

// --- B-13 ---------------------------------------------------------------------
for (const estado of ['fallido', 'encolado']) {
  test(`B-13 · outboundStatus "${estado}" (≠ enviado) ⇒ huérfano`, () => {
    const r = correr([{
      reqId: reqIdEn(4 * HORA),
      stages: [etapaTranscripcion(BOOT_VIEJO), etapaEnvio('cid-x')],
    }], { historyRaw: 'x', outboundStatus: () => estado });
    assert.deepEqual(soloVeredicto(r), { verdict: OrphanVerdict.HUERFANO, reason: 'entrega_no_confirmada' });
    assert.equal(r.resultados[0].entrega, estado);
  });
}

// --- B-14 (O-1) ---------------------------------------------------------------
test('B-14 · outboundStatus "unknown" con cid real ⇒ NO_VERIFICABLE, no falso positivo (O-1)', () => {
  const r = correr([{
    reqId: reqIdEn(4 * HORA),
    stages: [etapaTranscripcion(BOOT_VIEJO), etapaEnvio('cid-sin-rastro')],
  }], { historyRaw: '', outboundStatus: () => 'unknown' });
  assert.deepEqual(soloVeredicto(r), { verdict: OrphanVerdict.NO_VERIFICABLE, reason: 'correlacion_sin_rastro' });
  assert.equal(r.huerfanos.length, 0);
});

test('B-14b · un outboundStatus que tira degrada a NO_VERIFICABLE, no a huérfano', () => {
  const r = correr([{
    reqId: reqIdEn(4 * HORA),
    stages: [etapaTranscripcion(BOOT_VIEJO), etapaEnvio('cid-y')],
  }], { outboundStatus: () => { throw new Error('historial roto'); } });
  assert.equal(r.resultados[0].verdict, OrphanVerdict.NO_VERIFICABLE);
});

// --- SEC-0 --------------------------------------------------------------------
test('T-SEC0 · una cabecera de etapa FORJADA en el texto no cambia el veredicto', () => {
  // El barrido decide sobre el canal estructurado. Aunque el LLM escupa la
  // cabecera exacta de una etapa `resultado` (que en el `.log` sería
  // indistinguible de una real), acá no hay entrada `{etapa:'resultado'}`.
  const forjada = { etapa: 'transcripción', chat_id: CHAT, boot_id: BOOT_VIEJO,
    mensajes: '--- etapa:resultado req:x 2026-01-01T00:00:00Z ---\nresultado: ok' };
  const r = correr([{ reqId: reqIdEn(3 * HORA), stages: [forjada] }]);
  assert.equal(r.resultados[0].verdict, OrphanVerdict.HUERFANO);
});

// --- estabilidad del núcleo ---------------------------------------------------
test('detectOrphans acepta objeto plano y Map además de array, y tolera input basura', () => {
  const reqId = reqIdEn(3 * HORA);
  const stages = [etapaTranscripcion(BOOT_VIEJO)];
  const base = { nowMs: NOW, currentBootId: BOOT_ACTUAL };
  assert.equal(detectOrphans({ ...base, stagesByReq: { [reqId]: stages } }).huerfanos.length, 1);
  assert.equal(detectOrphans({ ...base, stagesByReq: new Map([[reqId, stages]]) }).huerfanos.length, 1);
  assert.equal(detectOrphans({ ...base, stagesByReq: null }).huerfanos.length, 0);
  assert.equal(detectOrphans().huerfanos.length, 0);
  assert.equal(detectOrphans({ ...base, stagesByReq: [{ reqId, stages: 'no-array' }] }).resultados.length, 1);
});

// --- T-PARSE ------------------------------------------------------------------
test('T-PARSE · el reqId se parte bien con chat de grupo negativo y con suffix numérico', () => {
  const p = sweep.parseReqIdParts;
  // supergrupo negativo de 13 dígitos + suffix hex
  assert.deepEqual(p('-1001234567890-1756000000000-a1b2', NOW),
    { chatSeg: '-1001234567890', epochms: 1756000000000, suffix: 'a1b2' });
  // supergrupo negativo SIN suffix — el caso que rompe un regex lazy
  assert.deepEqual(p('-1001234567890-1756000000000', NOW),
    { chatSeg: '-1001234567890', epochms: 1756000000000, suffix: null });
  // suffix compuesto SÓLO por dígitos — el caso que rompe un regex greedy
  assert.deepEqual(p('123-1756000000000-9876543210', NOW),
    { chatSeg: '123', epochms: 1756000000000, suffix: '9876543210' });
  assert.equal(p('sinformato', NOW), null);
  assert.equal(p('', NOW), null);
});

test('T-PARSE2 · el nombre del canal round-trippea o se descarta (SEC-1)', () => {
  const f = sweep.reqIdFromStagesFileName;
  assert.equal(f('commander--1001234567890-1756000000000.stages.jsonl'), '-1001234567890-1756000000000');
  assert.equal(f('commander-../../etc/passwd.stages.jsonl'), null);   // no round-trippea
  assert.equal(f('commander-a/b.stages.jsonl'), null);
  assert.equal(f('commander-123-1756000000000.meta.json'), null);     // otro canal
  assert.equal(f('commander-.stages.jsonl'), null);
  assert.equal(f(null), null);
});

// =============================================================================
// CAPA DE I/O — runOrphanSweep sobre un directorio real y efímero.
// =============================================================================

function conDirTemporal(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-sweep-'));
  const logDir = path.join(dir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  try { return fn({ pipelineDir: dir, logDir }); }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

function escribirEtapas(logDir, reqId, etapas) {
  const file = path.join(logDir, stagesFileName(reqId));
  fs.writeFileSync(file, etapas.map((e) => JSON.stringify({ ts: '', req_id: reqId, ...e })).join('\n') + '\n');
  return file;
}

function correrIO({ logDir, pipelineDir }, extra = {}) {
  const emitidos = [];
  const logs = [];
  const r = runOrphanSweep({
    logDir,
    pipelineDir,
    nowMs: NOW,
    currentBootId: BOOT_ACTUAL,
    windowMs: ORPHAN_WINDOW_MS,
    notified: extra.notified || null,
    deps: {
      outboundStatus: extra.outboundStatus || (() => 'unknown'),
      readStages: extra.readStages,
      fsImpl: extra.fsImpl,
      noteFallbackDeliveryResolved: extra.emit || ((o) => { emitidos.push(o); return true; }),
      log: (m) => logs.push(m),
    },
  });
  return { r, emitidos, logs };
}

// --- T-CA8 --------------------------------------------------------------------
test('T-CA8 · el archivo fuera de la ventana NO se abre (decisión por el nombre)', () => {
  conDirTemporal((ctx) => {
    const viejo = reqIdEn(72 * HORA);
    const nuevo = reqIdEn(5 * HORA);
    escribirEtapas(ctx.logDir, viejo, [etapaTranscripcion(BOOT_VIEJO)]);
    escribirEtapas(ctx.logDir, nuevo, [etapaTranscripcion(BOOT_VIEJO)]);

    const abiertos = [];
    const { r, emitidos } = correrIO(ctx, {
      readStages: (dir, reqId) => { abiertos.push(reqId); return [etapaTranscripcion(BOOT_VIEJO)]; },
    });

    assert.deepEqual(abiertos, [nuevo], 'sólo se abre el que está dentro de la ventana');
    assert.equal(r.resumen.huerfanos, 1);
    assert.equal(emitidos.length, 1);
  });
});

// --- T-SEC1 / T-SEC2 ----------------------------------------------------------
test('T-SEC1/T-SEC2 · nombres con traversal y entradas que no son archivo se descartan', () => {
  conDirTemporal((ctx) => {
    const bueno = reqIdEn(5 * HORA);
    escribirEtapas(ctx.logDir, bueno, [etapaTranscripcion(BOOT_VIEJO)]);
    // Un directorio con nombre válido de canal: `isFile()` lo descarta (SEC-2).
    fs.mkdirSync(path.join(ctx.logDir, stagesFileName(reqIdEn(6 * HORA))));

    const abiertos = [];
    const escrituras = [];
    const fsImpl = Object.create(fs);
    fsImpl.readdirSync = () => [
      // nombres hostiles inyectados en la enumeración (SEC-1)
      { name: 'commander-../../../etc/passwd.stages.jsonl', isFile: () => true },
      { name: 'commander-..\\..\\x.stages.jsonl', isFile: () => true },
      { name: stagesFileName(reqIdEn(6 * HORA)), isFile: () => false },   // SEC-2
      { name: 'commander-otro.stages.jsonl', isFile: () => true },        // sin epochms
      { name: 'no-es-del-canal.txt', isFile: () => true },
      { name: stagesFileName(bueno), isFile: () => true },
    ];
    fsImpl.writeFileSync = (p, d) => { escrituras.push(p); return fs.writeFileSync(p, d); };

    const { r, emitidos } = correrIO(ctx, {
      fsImpl,
      readStages: (dir, reqId) => { abiertos.push(reqId); return [etapaTranscripcion(BOOT_VIEJO)]; },
    });

    assert.deepEqual(abiertos, [bueno], 'sólo el nombre que round-trippea llega al lector');
    assert.equal(r.descartados, 5);
    assert.equal(emitidos.length, 1);
    assert.deepEqual(escrituras, [], 'cero escrituras fuera de logDir');
  });
});

// --- T-SEC4 -------------------------------------------------------------------
test('T-SEC4 · el evento terminal lleva sólo identificadores seudonimizados', () => {
  conDirTemporal((ctx) => {
    const reqId = reqIdEn(5 * HORA);
    escribirEtapas(ctx.logDir, reqId, [etapaTranscripcion(BOOT_VIEJO)]);
    const { emitidos } = correrIO(ctx);

    assert.equal(emitidos.length, 1);
    const e = emitidos[0];
    // CA-2: cierre fallido distinguible de `empty_output`, con estado del ENUM
    // real de `inflight-fallback.js` (R-1: 'not_delivered' no existe).
    assert.equal(e.deliveryState, 'delivery_failed');
    assert.equal(e.success, false);
    assert.equal(e.errorCode, 'delivered=false');
    assert.equal(e.resolvedBy, 'orphan_sweep');
    // SEC-4: nunca el reqId crudo (que contiene el chat id de Telegram).
    assert.equal(e.commanderReqId, buildAuditReqRef(reqId));
    assert.ok(!String(e.commanderReqId).includes(CHAT));
    const serializado = JSON.stringify(e);
    assert.ok(!serializado.includes('etapa'), 'no viaja contenido de etapas');
    assert.ok(!serializado.includes(reqId), 'no viaja el reqId crudo');
  });
});

// --- T-CA11 -------------------------------------------------------------------
test('T-CA11 · N barridos sobre el mismo sustrato ⇒ UN solo evento por turno', () => {
  conDirTemporal((ctx) => {
    const reqId = reqIdEn(5 * HORA);
    escribirEtapas(ctx.logDir, reqId, [etapaTranscripcion(BOOT_VIEJO)]);

    // Emisor REAL: escribe en el audit encadenado, que es la fuente de verdad
    // del precheck de idempotencia (R-4). Nada de estado nuevo inventado.
    const inflight = require('../inflight-fallback');
    const total = [];
    for (let i = 0; i < 4; i++) {
      const { r } = correrIO(ctx, {
        emit: (o) => { total.push(o); return inflight.noteFallbackDeliveryResolved(o); },
      });
      assert.equal(r.ok, true);
    }

    assert.equal(total.length, 1, `emitió ${total.length} eventos en 4 barridos`);

    // Y en el audit hay exactamente una entrada para ese commander_req_id.
    const audit = require('../../audit-log');
    const file = sweep.auditDayFiles(ctx.pipelineDir, NOW, ORPHAN_WINDOW_MS)
      .find((f) => fs.existsSync(f));
    const entradas = audit.readAll(file)
      .filter((e) => e.event === sweep.RESOLVED_EVENT && e.commander_req_id === buildAuditReqRef(reqId));
    assert.equal(entradas.length, 1);
    // CA-4: la hash-chain sigue verificando después de que el barrido escribió.
    assert.equal(audit.verifyChain(file).ok, true);
  });
});

// --- T-CA14 -------------------------------------------------------------------
test('T-CA14 · un barrido que falla deja rastro con la causa y NO tira', () => {
  conDirTemporal((ctx) => {
    const fsImpl = Object.create(fs);
    fsImpl.readdirSync = () => { throw new Error('EACCES: logDir ilegible'); };

    let r, logs;
    assert.doesNotThrow(() => { ({ r, logs } = correrIO(ctx, { fsImpl })); });

    assert.equal(r.ok, false, 'un fallo NO se reporta como barrido exitoso');
    assert.match(r.error, /EACCES/);
    assert.equal(r.resumen.huerfanos, 0);
    assert.ok(logs.some((l) => l.includes('[orphan-sweep]') && l.includes('EACCES')),
      'el rastro con la causa tiene que estar en el log');
  });
});

test('T-CA14b · sin logDir el barrido no corre y lo dice', () => {
  const logs = [];
  const r = runOrphanSweep({ deps: { log: (m) => logs.push(m) } });
  assert.equal(r.ok, false);
  assert.equal(r.emitidos.length, 0);
  assert.ok(logs.some((l) => l.includes('sin logDir')));
});

test('T-CA14c · un historial ilegible degrada a no-verificable, deja rastro y no marca huérfanos de más', () => {
  conDirTemporal((ctx) => {
    const reqId = reqIdEn(5 * HORA);
    escribirEtapas(ctx.logDir, reqId, [etapaTranscripcion(BOOT_VIEJO), etapaEnvio('cid-z')]);
    // No existe `commander-history.jsonl` ⇒ readFileSync tira ⇒ historyRaw ''.
    const { r, emitidos, logs } = correrIO(ctx, { outboundStatus: (raw) => (raw ? 'fallido' : 'unknown') });
    assert.equal(r.resumen.huerfanos, 0);
    assert.equal(r.resumen.no_verificables, 1);
    assert.equal(emitidos.length, 0);
    assert.ok(logs.some((l) => l.includes('historial ilegible')));
  });
});

// --- integración con el commanderOutboundStatus REAL --------------------------
// Convención del repo:  permite requerir pulpo.js sin
// arrancar el singleton ni el main loop. Se usa acá para probar que el barrido
// funciona contra la ÚNICA fuente de verdad de entrega, no contra un fake (CA-7).
test('integración · sano, huérfano, fuera de ventana y en vuelo, en el mismo directorio', () => {
  process.env.PULPO_NO_AUTOSTART = '1';
  const pulpo = require('../../../pulpo');
  const { commanderOutboundStatus } = pulpo;

  conDirTemporal((ctx) => {
    const sano = reqIdEn(2 * HORA);
    const huerfano = reqIdEn(6 * HORA, 'a1b2');
    const viejo = reqIdEn(60 * HORA);
    const vivo = reqIdEn(1 * HORA, 'ff01');

    escribirEtapas(ctx.logDir, sano, [
      etapaTranscripcion(BOOT_VIEJO), ETAPA_DISPATCH, etapaEnvio('cid-ok'), ETAPA_RESULTADO,
    ]);
    escribirEtapas(ctx.logDir, huerfano, [etapaTranscripcion(BOOT_VIEJO), ETAPA_DISPATCH]);
    escribirEtapas(ctx.logDir, viejo, [etapaTranscripcion(BOOT_VIEJO)]);
    escribirEtapas(ctx.logDir, vivo, [etapaTranscripcion(BOOT_ACTUAL)]);
    fs.writeFileSync(path.join(ctx.pipelineDir, 'commander-history.jsonl'), [
      JSON.stringify({ direction: 'out', correlation_id: 'cid-ok', chat_id: CHAT }),
      JSON.stringify({ direction: 'reconcile', correlation_id: 'cid-ok', status: 'enviado' }),
      '',
    ].join('\n'));

    const { r, emitidos } = correrIO(ctx, { outboundStatus: commanderOutboundStatus });

    assert.equal(r.resumen.huerfanos, 1);
    assert.equal(r.resumen.sanos, 1);
    assert.equal(emitidos.length, 1);
    assert.equal(emitidos[0].commanderReqId, buildAuditReqRef(huerfano));

    const porReq = Object.fromEntries(r.resultados.map((x) => [x.reqId, x.verdict]));
    assert.equal(porReq[sano], OrphanVerdict.SANO);
    assert.equal(porReq[huerfano], OrphanVerdict.HUERFANO);
    assert.equal(porReq[vivo], OrphanVerdict.NO_EVALUABLE);
    assert.equal(porReq[viejo], undefined, 'el de 60 h ni siquiera entra al núcleo');
  });
});

// --- T-CA12 · cadencia del wiring en el mainLoop ------------------------------
// El punto de wiring (junto a `reconcileTelegramReceipts()`) corre en CADA
// iteración del loop. El barrido se declaró a ~5 min, así que se gatea por
// ticks igual que `desyncEvalTick`. El loop usa la MISMA función que este test.
test('T-CA12 · M iteraciones del loop disparan exactamente floor(M/10) barridos', () => {
  process.env.PULPO_NO_AUTOSTART = '1';
  const pulpo = require('../../../pulpo');
  const { orphanSweepGate, ORPHAN_SWEEP_EVERY_TICKS } = pulpo;

  assert.equal(ORPHAN_SWEEP_EVERY_TICKS, 10, '~5 min con poll_interval de 30s');

  for (const M of [0, 1, 9, 10, 11, 100, 137]) {
    let tick = 0;
    let disparos = 0;
    for (let i = 0; i < M; i++) {
      const g = orphanSweepGate(tick);
      tick = g.tick;
      if (g.due) disparos += 1;
    }
    assert.equal(disparos, Math.floor(M / ORPHAN_SWEEP_EVERY_TICKS),
      `${M} iteraciones deberían disparar ${Math.floor(M / ORPHAN_SWEEP_EVERY_TICKS)} barridos`);
  }

  // El primer disparo NO es en la iteración 1 (si no, el gateo no serviría).
  assert.equal(orphanSweepGate(0).due, false);
  assert.equal(orphanSweepGate(9).due, true);
  // Robustez: un contador basura o un divisor inválido no rompen el loop.
  assert.deepEqual(orphanSweepGate(NaN, 10), { tick: 1, due: false });
  assert.deepEqual(orphanSweepGate(0, 0), { tick: 0, due: true });
});

// --- T-WIRING · el runner cablea las dependencias del proceso -----------------
test('T-WIRING · ejecutarBarridoHuerfanos corre contra el pipeline real sin tirar', () => {
  process.env.PULPO_NO_AUTOSTART = '1';
  const pulpo = require('../../../pulpo');
  let r;
  assert.doesNotThrow(() => { r = pulpo.ejecutarBarridoHuerfanos('test'); });
  assert.equal(typeof r.ok, 'boolean');
  assert.equal(typeof r.resumen.evaluados, 'number');
  assert.ok(Array.isArray(r.emitidos));
});

// =============================================================================
// CA-3 · EL DESENLACE TERMINAL **EXITOSO** (rebote rev-1 de `aprobacion`).
//
// El review rechazó la primera pasada con evidencia empírica: el loop de emisión
// iteraba SÓLO `huerfanos`, así que un turno B-12 `entrega_confirmada` se
// clasificaba SANO y NO emitía nada ⇒ el `delivery_pending` de un fallback que
// SÍ se entregó no se cerraba nunca, y la rama `success:true` del appender era
// código muerto sin caller de producción.
//
// Estos tests ejercitan el CAMINO REAL (`runOrphanSweep`, la capa que corre en
// el pulpo), NO el appender directo: ese fue justamente el modo de falla que
// dejó pasar el escape (un test que prueba que la API acepta el campo, no que
// exista un camino que lo produzca).
//
//   T-CA3a  B-12 vía runOrphanSweep ⇒ evento EXITOSO emitido
//   T-CA3b  N barridos ⇒ UN solo evento exitoso (CA-11 también en el éxito)
//   T-CA3c  B-09 `cerro_solo` NO emite (cerró in-process, CA-6)
//   T-CA3d  núcleo puro: `entregados` es exactamente el conjunto B-12
//   T-CA3e  huérfano y entrega confirmada conviven en un mismo barrido
// =============================================================================

// --- T-CA3a -------------------------------------------------------------------
test('T-CA3a · una entrega confirmada emite el evento terminal EXITOSO por el camino real', () => {
  conDirTemporal((ctx) => {
    const reqId = reqIdEn(5 * HORA);
    // El sustrato EXACTO del rechazo: boot anterior, transcripción + envío con
    // correlation_id real, SIN etapa `resultado`, y outboundStatus 'enviado'.
    escribirEtapas(ctx.logDir, reqId, [etapaTranscripcion(BOOT_VIEJO), etapaEnvio('cid-real-1')]);

    const { r, emitidos } = correrIO(ctx, { outboundStatus: () => 'enviado' });

    assert.equal(r.resumen.huerfanos, 0, 'no es un huérfano: la entrega está confirmada');
    assert.equal(r.resumen.sanos, 1);
    assert.equal(emitidos.length, 1, 'CA-3: el desenlace exitoso TAMBIÉN emite evento terminal');

    const e = emitidos[0];
    assert.equal(e.deliveryState, 'delivery_observed', 'estado del ENUM real (R-1)');
    assert.equal(e.success, true);
    assert.ok(!e.errorCode, 'un cierre exitoso no lleva código de error');
    assert.equal(e.resolvedBy, 'orphan_sweep');
    assert.equal(e.commanderReqId, buildAuditReqRef(reqId));
    assert.deepEqual(r.emitidosOk, [buildAuditReqRef(reqId)]);
    assert.deepEqual(r.emitidosFallidos, []);
    // SEC-4 en la rama de éxito: al emisor va el ref SEUDONIMIZADO, nunca el
    // `reqId` crudo ni contenido de etapas. El `chatId` crudo sí viaja al
    // emisor —igual que en la rama de huérfano— porque `noteFallbackDeliveryResolved`
    // lo hashea con `hashFor()` antes de asentarlo; eso se verifica sobre el
    // AUDIT en T-CA3b, que es donde SEC-4 aplica de verdad.
    const serializado = JSON.stringify(e);
    assert.ok(!serializado.includes(reqId), 'no viaja el reqId crudo');
    assert.ok(!serializado.includes('etapa'), 'no viaja contenido de etapas');
  });
});

// --- T-CA3b -------------------------------------------------------------------
test('T-CA3b · N barridos sobre una entrega confirmada ⇒ UN solo evento exitoso (CA-11)', () => {
  conDirTemporal((ctx) => {
    const reqId = reqIdEn(5 * HORA);
    escribirEtapas(ctx.logDir, reqId, [etapaTranscripcion(BOOT_VIEJO), etapaEnvio('cid-real-2')]);

    // Emisor REAL contra el audit encadenado: la idempotencia del éxito tiene
    // que salir del mismo precheck que la del fallo, no de un set aparte.
    const inflight = require('../inflight-fallback');
    const total = [];
    for (let i = 0; i < 4; i++) {
      const { r } = correrIO(ctx, {
        outboundStatus: () => 'enviado',
        emit: (o) => { total.push(o); return inflight.noteFallbackDeliveryResolved(o); },
      });
      assert.equal(r.ok, true);
    }

    assert.equal(total.length, 1, `emitió ${total.length} eventos exitosos en 4 barridos`);

    const audit = require('../../audit-log');
    const file = sweep.auditDayFiles(ctx.pipelineDir, NOW, ORPHAN_WINDOW_MS)
      .find((f) => fs.existsSync(f));
    const entradas = audit.readAll(file)
      .filter((e) => e.event === sweep.RESOLVED_EVENT && e.commander_req_id === buildAuditReqRef(reqId));
    assert.equal(entradas.length, 1);
    // El evento asentado es el EXITOSO, con los campos aditivos de #6459.
    assert.equal(entradas[0].success, true);
    assert.equal(entradas[0].delivery_state, 'delivery_observed');
    assert.equal(entradas[0].error_code, null);
    // SEC-4 · lo que queda ASENTADO no tiene el chat id crudo ni el reqId crudo:
    // el `chat_id` viaja hasheado y el ref del turno, seudonimizado.
    const asentado = JSON.stringify(entradas[0]);
    assert.ok(!asentado.includes(CHAT), 'el chat id crudo no llega al audit');
    assert.ok(!asentado.includes(reqId), 'el reqId crudo no llega al audit');
    assert.ok(entradas[0].chat_id_hash, 'el chat id va hasheado');
    // CA-4: la hash-chain sigue verificando.
    assert.equal(audit.verifyChain(file).ok, true);
  });
});

// --- T-CA3c -------------------------------------------------------------------
test('T-CA3c · B-09 `cerro_solo` NO emite evento: ese turno cerró in-process (CA-6)', () => {
  conDirTemporal((ctx) => {
    const reqId = reqIdEn(5 * HORA);
    escribirEtapas(ctx.logDir, reqId, [
      etapaTranscripcion(BOOT_VIEJO), ETAPA_DISPATCH, etapaEnvio('cid-x'), ETAPA_RESULTADO,
    ]);

    const { r, emitidos } = correrIO(ctx, { outboundStatus: () => 'enviado' });

    assert.equal(r.resumen.sanos, 1);
    assert.equal(r.resultados[0].verdict, OrphanVerdict.SANO);
    assert.equal(r.resultados[0].reason, 'cerro_solo');
    assert.equal(emitidos.length, 0, 'el barrido de rescate no toca un turno que ya asentó `resultado`');
  });
});

// --- T-CA3d -------------------------------------------------------------------
test('T-CA3d · el núcleo puro expone `entregados` = exactamente el conjunto B-12', () => {
  const confirmado = reqIdEn(4 * HORA, 'aa');
  const cerroSolo = reqIdEn(5 * HORA, 'bb');
  const huerfano = reqIdEn(6 * HORA, 'cc');
  const directo = reqIdEn(7 * HORA, 'dd');

  const r = correr([
    { reqId: confirmado, stages: [etapaTranscripcion(BOOT_VIEJO), etapaEnvio('cid-ok')] },
    { reqId: cerroSolo, stages: [etapaTranscripcion(BOOT_VIEJO), etapaEnvio('cid-ok'), ETAPA_RESULTADO] },
    { reqId: huerfano, stages: [etapaTranscripcion(BOOT_VIEJO)] },
    { reqId: directo, stages: [etapaTranscripcion(BOOT_VIEJO), etapaEnvio('directo')] },
  ], { outboundStatus: () => 'enviado' });

  assert.deepEqual(r.entregados.map((x) => x.reqId), [confirmado],
    'sólo B-12 entra: ni `cerro_solo`, ni el huérfano, ni la correlación directa');
  assert.deepEqual(r.huerfanos.map((x) => x.reqId), [huerfano]);
  // CA-10: el sano NO produce marca de huérfano (que es cosa distinta del
  // evento de cierre exitoso).
  assert.ok(!r.huerfanos.some((x) => x.reqId === confirmado));
});

// --- T-CA3e -------------------------------------------------------------------
test('T-CA3e · un barrido con huérfano y entrega confirmada emite los DOS desenlaces', () => {
  conDirTemporal((ctx) => {
    const confirmado = reqIdEn(4 * HORA, 'aa');
    const huerfano = reqIdEn(6 * HORA, 'cc');
    escribirEtapas(ctx.logDir, confirmado, [etapaTranscripcion(BOOT_VIEJO), etapaEnvio('cid-ok')]);
    escribirEtapas(ctx.logDir, huerfano, [etapaTranscripcion(BOOT_VIEJO)]);

    const { r, emitidos } = correrIO(ctx, { outboundStatus: () => 'enviado' });

    assert.equal(emitidos.length, 2);
    const porRef = new Map(emitidos.map((e) => [e.commanderReqId, e]));
    const ok = porRef.get(buildAuditReqRef(confirmado));
    const ko = porRef.get(buildAuditReqRef(huerfano));

    assert.equal(ok.success, true);
    assert.equal(ok.deliveryState, 'delivery_observed');
    assert.equal(ko.success, false);
    assert.equal(ko.deliveryState, 'delivery_failed');
    assert.equal(ko.errorCode, 'delivered=false', 'CA-2: distinguible de `empty_output`');

    assert.deepEqual(r.emitidosOk, [buildAuditReqRef(confirmado)]);
    assert.deepEqual(r.emitidosFallidos, [buildAuditReqRef(huerfano)]);
  });
});
