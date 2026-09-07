// =============================================================================
// orphan-notify.test.js — Cobertura de la capa de AVISO al operador (#6460).
//
// COBERTURA DE RAMAS DE DECISIÓN → TEST QUE LA CUBRE.
// Mismo contrato que B-01..B-14 de #6459: las etiquetas N-01..N-18 son
// literalmente las del bloque de comentario de `orphan-notify.js`, y acá están
// espejadas 1:1. Es el código que decide si el operador recibe o no un mensaje:
// una rama sin test es un aviso falso o un silencio en producción.
//
//   Destino — resolveNoticeTarget
//     N-01 correlación resuelve ................. T-N01
//     N-02 sin cid ⇒ etapa transcripción ........ T-N02
//     N-03 cid 'DIRECTO' se ignora .............. T-N03
//     N-04 destino no resoluble / basura ........ T-N04a (null) T-N04b (basura)
//     N-05 destino ajeno (UX-8) ................. T-N05
//   Payload — decidirPayload
//     N-06 rama por default (sin chat_id) ....... T-N06
//     N-07 rama dirigida (con chat_id) .......... T-N07
//     N-08 rechazado por el ancla ............... T-N08
//     N-09 ancla VACÍA .......................... T-N09 (descarta) / T-N09b (sale
//          por la rama sin chat_id) / T-ANCLA-TABLA / T-ANCLA-E2E
//          Los cuatro usan el predicado REAL (`resolvePrivateChatId`), no un
//          fake: `resolvePrivateChatId(null)` devuelve ok:true INCLUSO con el
//          ancla vacía (su early-return va antes del chequeo del env), y un fake
//          más estricto que la realidad hace pasar el test por el motivo
//          equivocado. Pasó durante la implementación de este issue.
//     N-10 anchorAccepts no inyectado ........... T-N10
//   Plan — planNotices
//     N-11 1 huérfano ⇒ H1 ...................... T-N11
//     N-12 ≥2 huérfanos ⇒ H3 consolidado ........ T-N12
//     N-13 tope excedido ⇒ diferido ............. T-N13
//     N-16 el renderer tira ⇒ descarta .......... T-N16
//   I/O — emitOrphanNotices / reconcileNoticeDelivery
//     N-14 ledger que no se puede escribir ...... T-N14
//     N-15 ref ya en el ledger ⇒ 0 avisos ....... T-N15
//     N-17 saliente 'fallido' ⇒ aviso_entregado:false  T-N17
//     N-18 'enviado'/'encolado'/'unknown' ....... T-N18
//
//   Transversales:
//     T-SEC-A  el destino NUNCA sale del nombre del archivo
//     T-SEC-B  el ledger no guarda reqId ni chat_id crudos
//     T-CA12   la regex literal de jerga contra el texto YA INTERPOLADO
//     T-UX4    el texto de producción === el del renderer de referencia
//     T-REQSEC-A  defaultChatId ≠ ancla ⇒ NO se toma la rama sin chat_id
//     T-LEDGER-FAIL-CLOSED  ledger ilegible ⇒ 0 avisos
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const notify = require('../orphan-notify');
const render = require('../../../assets/copy/orphan-turn/render');
const { buildAuditReqRef, metaFileName } = require('../request-log');

const NOW = 1756000000000;                 // 2025-08-24T02:26:40Z
const HORA = 60 * 60 * 1000;
const CHAT = '-1001234567890';             // supergrupo real: negativo y largo
const OTRO_CHAT = '-1009999999999';

// --- helpers -----------------------------------------------------------------

function huerfano(edadMs, { chatId = CHAT, suffix = null } = {}) {
  const ms = NOW - edadMs;
  const reqId = suffix ? `${chatId}-${ms}-${suffix}` : `${chatId}-${ms}`;
  return {
    verdict: 'huerfano',
    reason: 'sin_saliente',
    reqId,
    epochms: ms,
    auditRef: buildAuditReqRef(reqId),
    chatId,
    entrega: 'sin_saliente',
  };
}

// EL PREDICADO REAL, no un fake. `anchorAccepts` es exactamente lo que el wiring
// de `pulpo.js` inyecta, y es el mismo que va a aplicar `servicio-telegram.js`.
// Usar un fake acá fue un error real durante la implementación: un fake más
// estricto que la realidad (que rechazaba también `null`) hacía pasar el test
// del ancla vacía por el motivo equivocado.
const { resolvePrivateChatId } = require('../../notify-telegram')._internal;
const anchorAcceptsReal = (x) => resolvePrivateChatId(x).ok;

// Corre `fn` con `TELEGRAM_LEO_OPERATOR_CHAT_ID` en el valor dado y lo restaura.
function conAncla(valor, fn) {
  const previo = process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID;
  if (valor === undefined) delete process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID;
  else process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID = valor;
  try { return fn(); }
  finally {
    if (previo === undefined) delete process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID;
    else process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID = previo;
  }
}

// Fake acotado para los tests que sólo necesitan "acepta el default y este chat".
// Espeja la tabla real: `null` siempre pasa, y el resto sólo si es el ancla.
function anclaQueAcepta(anchor) {
  return (x) => (x === null ? true : String(x) === String(anchor));
}

function conDirTemporal(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-notify-'));
  const logDir = path.join(dir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  try { return fn({ pipelineDir: dir, logDir }); }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

function emitir(ctx, { huerfanos, cidPorReq = new Map(), historyRaw = '', deps = {} } = {}) {
  const encolados = [];
  const logs = [];
  const r = notify.emitOrphanNotices({
    pipelineDir: ctx.pipelineDir,
    huerfanos,
    cidPorReq,
    historyRaw,
    nowMs: NOW,
    deps: {
      anchorAccepts: anclaQueAcepta(CHAT),
      defaultChatId: CHAT,
      enqueueOrphanNotice: (payload, opts) => { encolados.push({ payload, opts }); },
      newCorrelationId: (p) => `${p}-${NOW}-${encolados.length}`,
      log: (m) => logs.push(m),
      ...deps,
    },
  });
  return { r, encolados, logs };
}

// =============================================================================
// DESTINO — resolveNoticeTarget (N-01..N-05)
// =============================================================================

test('T-N01 · con correlation_id el destino sale del historial, no de la etapa', () => {
  const r = huerfano(2 * HORA);
  const historyRaw = JSON.stringify({ direction: 'out', correlation_id: 'cmd-1', chat_id: CHAT }) + '\n';
  const t = notify.resolveNoticeTarget({
    result: r,
    cid: 'cmd-1',
    historyRaw,
    deps: { resolveChatIdForCorrelation: (raw, cid) => (cid === 'cmd-1' ? CHAT : null) },
  });
  assert.equal(t.ok, true);
  assert.equal(t.chatId, CHAT);
  assert.equal(t.via, 'correlacion');
});

test('T-N02 · sin correlation_id el destino sale de la etapa transcripción (el caso típico)', () => {
  const r = huerfano(2 * HORA);
  const t = notify.resolveNoticeTarget({ result: r, cid: null, historyRaw: '', deps: {} });
  assert.equal(t.ok, true);
  assert.equal(t.chatId, CHAT);
  assert.equal(t.via, 'etapa');
});

test('T-N03 · el centinela "DIRECTO" no se consulta como correlation_id', () => {
  let consultado = false;
  const t = notify.resolveNoticeTarget({
    result: huerfano(2 * HORA),
    cid: 'DIRECTO',
    historyRaw: '',
    deps: { resolveChatIdForCorrelation: () => { consultado = true; return OTRO_CHAT; } },
  });
  assert.equal(consultado, false, 'DIRECTO no es un correlation_id real');
  assert.equal(t.via, 'etapa');
  assert.equal(t.chatId, CHAT);
});

test('T-N04a · sin chat_id en ninguna fuente ⇒ destino no resoluble', () => {
  const r = { ...huerfano(2 * HORA), chatId: null };
  const t = notify.resolveNoticeTarget({ result: r, cid: null, historyRaw: '', deps: {} });
  assert.equal(t.ok, false);
  assert.equal(t.motivo, 'destino_no_resoluble');
  assert.equal(t.chatId, null);
});

test('T-N04b · chat_id BASURA en la etapa ⇒ descarta, NUNCA cae al nombre del archivo (SEC-A)', () => {
  for (const basura of ['no-soy-un-chat', '007', '', '  ', '12.5', '-0', 'null']) {
    const r = { ...huerfano(2 * HORA), chatId: basura };
    const t = notify.resolveNoticeTarget({ result: r, cid: null, historyRaw: '', deps: {} });
    assert.equal(t.ok, false, `"${basura}" no puede resolver a un destino`);
    assert.equal(t.chatId, null);
    // El reqId SÍ tiene un segmento con pinta de chat id (`-1001234567890`).
    // Que el destino sea null prueba que no se usó.
    assert.ok(r.reqId.startsWith(basura ? basura : '-100') || true);
  }
});

test('T-SEC-A · el destino jamás se deriva del nombre del archivo de log', () => {
  // reqId con un chatSeg perfectamente válido, pero etapa SIN chat_id y sin cid.
  const r = { ...huerfano(2 * HORA), chatId: null };
  assert.ok(r.reqId.startsWith(CHAT), 'el reqId lleva un chat id parseable adentro');
  const t = notify.resolveNoticeTarget({ result: r, cid: null, historyRaw: '', deps: {} });
  assert.equal(t.ok, false, 'aunque el nombre lo tenga a mano, no se usa');
});

test('T-N05 · la correlación apunta a OTRA conversación ⇒ destino ajeno, no se envía (UX-8)', () => {
  const r = huerfano(2 * HORA);                       // el pedido es de CHAT
  const t = notify.resolveNoticeTarget({
    result: r,
    cid: 'cmd-1',
    historyRaw: '',
    deps: { resolveChatIdForCorrelation: () => OTRO_CHAT },
  });
  assert.equal(t.ok, false);
  assert.equal(t.motivo, 'destino_ajeno');
});

test('T-N01b · resolveChatIdForCorrelation devuelve un NÚMERO crudo ⇒ se canonicaliza', () => {
  const r = { ...huerfano(2 * HORA), chatId: '6529617704' };
  const t = notify.resolveNoticeTarget({
    result: r,
    cid: 'cmd-1',
    historyRaw: '',
    deps: { resolveChatIdForCorrelation: () => 6529617704 },
  });
  assert.equal(t.ok, true);
  assert.equal(t.chatId, '6529617704');
  assert.equal(typeof t.chatId, 'string');
});

test('T-N01c · una correlación que TIRA degrada al paso 2, no rompe el barrido', () => {
  const t = notify.resolveNoticeTarget({
    result: huerfano(2 * HORA),
    cid: 'cmd-1',
    historyRaw: '',
    deps: { resolveChatIdForCorrelation: () => { throw new Error('historial roto'); } },
  });
  assert.equal(t.ok, true);
  assert.equal(t.via, 'etapa');
});

// =============================================================================
// PAYLOAD — decidirPayload (N-06..N-10)
// =============================================================================

test('T-N06 · destino === chat por default ⇒ dropfile SIN chat_id (la única rama que el ancla no rechaza)', () => {
  const d = notify.decidirPayload({
    destino: CHAT,
    texto: 'hola',
    defaultChatId: CHAT,
    deps: { anchorAccepts: anclaQueAcepta(CHAT) },
  });
  assert.equal(d.ok, true);
  assert.equal(d.modo, 'default');
  assert.deepEqual(d.payload, { text: 'hola', plain: true });
  assert.ok(!('chat_id' in d.payload), 'estampar chat_id acá lo archivaría en listo/ sin enviar');
  assert.equal(d.payload.plain, true, 'plain va EXPLÍCITO: el servicio hace `parse_mode || Markdown`');
});

test('T-N07 · destino distinto del default y aceptado por el ancla ⇒ dropfile CON chat_id', () => {
  const d = notify.decidirPayload({
    destino: OTRO_CHAT,
    texto: 'hola',
    defaultChatId: CHAT,
    deps: { anchorAccepts: anclaQueAcepta(OTRO_CHAT) },
  });
  assert.equal(d.ok, true);
  assert.equal(d.modo, 'dirigido');
  assert.deepEqual(d.payload, { text: 'hola', plain: true, chat_id: OTRO_CHAT });
});

test('T-N08 · el ancla RECHAZA el destino ⇒ descarta, no encola', () => {
  const d = notify.decidirPayload({
    destino: OTRO_CHAT,
    texto: 'hola',
    defaultChatId: CHAT,
    deps: { anchorAccepts: anclaQueAcepta(CHAT) },   // sólo acepta CHAT y null
  });
  assert.equal(d.ok, false);
  assert.equal(d.motivo, 'destino_rechazado_por_anchor');
});

test('T-ANCLA-TABLA · la tabla REAL de resolvePrivateChatId, que es de donde salen las dos ramas', () => {
  // Si esta tabla cambia, las dos ramas de `decidirPayload` dejan de ser
  // correctas y el aviso vuelve a morir archivado en `listo/`. Por eso se ancla.
  conAncla('', () => {
    assert.equal(anchorAcceptsReal(null), true,
      'el early-return de `requested == null` va ANTES del chequeo del ancla');
    assert.equal(anchorAcceptsReal(CHAT), false, 'no_operator_chat_id');
  });
  conAncla(undefined, () => {
    assert.equal(anchorAcceptsReal(null), true);
    assert.equal(anchorAcceptsReal(CHAT), false);
  });
  conAncla(CHAT, () => {
    assert.equal(anchorAcceptsReal(null), true);
    assert.equal(anchorAcceptsReal(CHAT), true);
    assert.equal(anchorAcceptsReal(OTRO_CHAT), false, 'unauthorized_chat_id');
  });
  conAncla('no-canonico', () => {
    assert.equal(anchorAcceptsReal(CHAT), false, 'invalid_operator_chat_id');
  });
});

test('T-N09 · ancla VACÍA + destino distinto del default ⇒ descarta (predicado REAL)', () => {
  conAncla('', () => {
    const d = notify.decidirPayload({
      destino: OTRO_CHAT,
      texto: 'hola',
      defaultChatId: CHAT,
      deps: { anchorAccepts: anchorAcceptsReal },
    });
    assert.equal(d.ok, false, 'un dropfile con chat_id moriría archivado en listo/ sin recibo');
    assert.equal(d.motivo, 'destino_rechazado_por_anchor');
  });
});

test('T-N09b · ancla VACÍA + destino === default ⇒ SÍ sale, por la rama sin chat_id', () => {
  // Éste es el CA que más fácil se rompe: si `buildDropfile` estampara `chat_id`
  // también acá, con el ancla vacía el aviso se archivaría como enviado sin
  // haberse enviado — el bug de #6440 reintroducido por la puerta de al lado.
  conAncla('', () => {
    const d = notify.decidirPayload({
      destino: CHAT,
      texto: 'hola',
      defaultChatId: CHAT,
      deps: { anchorAccepts: anchorAcceptsReal },
    });
    assert.equal(d.ok, true, 'el operador tiene que enterarse igual');
    assert.equal(d.modo, 'default');
    assert.ok(!('chat_id' in d.payload), 'sin chat_id el ancla no lo puede rechazar');
  });
});

test('T-N10 · sin anchorAccepts inyectado ⇒ fail-closed, no se arma payload', () => {
  const d = notify.decidirPayload({ destino: CHAT, texto: 'hola', defaultChatId: CHAT, deps: {} });
  assert.equal(d.ok, false);
  assert.equal(d.motivo, 'anchor_no_disponible');
});

test('T-REQSEC-A · defaultChatId distinto del ancla ⇒ NO se toma la rama sin chat_id', () => {
  // El canal de salida efectivo es OTRO_CHAT; el ancla sólo acepta CHAT.
  // La igualdad se compara contra el canal efectivo, así que la rama por default
  // NO aplica y el destino cae en la rama dirigida... que el ancla rechaza.
  const d = notify.decidirPayload({
    destino: OTRO_CHAT,
    texto: 'hola',
    defaultChatId: OTRO_CHAT,
    deps: { anchorAccepts: (x) => x !== null && String(x) === CHAT },
  });
  assert.equal(d.ok, false, 'sin acepta(null) la rama por default no se toma');
  assert.equal(d.motivo, 'destino_rechazado_por_anchor');
});

test('T-N07b · un anchorAccepts que TIRA se lee como rechazo (fail-closed)', () => {
  const d = notify.decidirPayload({
    destino: CHAT,
    texto: 'hola',
    defaultChatId: CHAT,
    deps: { anchorAccepts: () => { throw new Error('env rota'); } },
  });
  assert.equal(d.ok, false);
  assert.equal(d.motivo, 'destino_rechazado_por_anchor');
});

test('T-N07c · defaultChatId vacío/no canónico ⇒ rama dirigida, nunca rama por default a ciegas', () => {
  const d = notify.decidirPayload({
    destino: CHAT,
    texto: 'hola',
    defaultChatId: '',
    deps: { anchorAccepts: anclaQueAcepta(CHAT) },
  });
  assert.equal(d.ok, true);
  assert.equal(d.modo, 'dirigido');
  assert.equal(d.payload.chat_id, CHAT);
});

// =============================================================================
// PLAN — planNotices (N-11..N-13, N-16)
// =============================================================================

function planDe(huerfanos, extra = {}) {
  const targets = new Map();
  for (const h of huerfanos) {
    targets.set(h.reqId, { ok: true, chatId: extra.destinoDe ? extra.destinoDe(h) : h.chatId, via: 'etapa', motivo: null });
  }
  return notify.planNotices({
    huerfanos,
    targets: extra.targets || targets,
    nowMs: NOW,
    defaultChatId: CHAT,
    tope: extra.tope,
    deps: { anchorAccepts: extra.anchorAccepts || anclaQueAcepta(CHAT) },
  });
}

test('T-N11 · una conversación con UN huérfano ⇒ H1_respuesta_perdida', () => {
  const p = planDe([huerfano(4 * HORA)]);
  assert.equal(p.avisos.length, 1);
  assert.equal(p.avisos[0].aviso, 'H1_respuesta_perdida');
  assert.equal(p.avisos[0].refs.length, 1);
});

test('T-N12 · varios huérfanos de la MISMA conversación ⇒ UN aviso consolidado (UX-6)', () => {
  const hs = [huerfano(4 * HORA), huerfano(3 * HORA), huerfano(2 * HORA)];
  const p = planDe(hs);
  assert.equal(p.avisos.length, 1, 'un aviso, no tres');
  assert.equal(p.avisos[0].aviso, 'H3_varias_respuestas_perdidas');
  assert.equal(p.avisos[0].refs.length, 3, 'las tres refs viajan en el mismo aviso');
  assert.match(p.avisos[0].texto, /Hay 3 pedidos tuyos/);
});

test('T-N12b · huérfanos de conversaciones DISTINTAS ⇒ un aviso por conversación, nunca mezclados', () => {
  const a = huerfano(4 * HORA, { chatId: CHAT });
  const b = huerfano(3 * HORA, { chatId: OTRO_CHAT });
  const p = planDe([a, b], { anchorAccepts: () => true });
  assert.equal(p.avisos.length, 2);
  const destinos = p.avisos.map((x) => x.destino).sort();
  assert.deepEqual(destinos, [CHAT, OTRO_CHAT].sort());
  // UX-8: el aviso de una conversación no menciona el pedido de la otra.
  for (const av of p.avisos) {
    const ajeno = av.destino === CHAT ? b.reqId : a.reqId;
    assert.ok(!av.texto.includes(ajeno), 'un aviso no puede contar el pedido de otro operador');
  }
});

test('T-N13 · excedido el tope, las conversaciones sobrantes se DIFIEREN (no se resumen)', () => {
  const hs = [];
  for (let i = 0; i < 7; i++) hs.push(huerfano((i + 1) * HORA, { chatId: `-100123456789${i}` }));
  const p = planDe(hs, { tope: 5, anchorAccepts: () => true });
  assert.equal(p.avisos.length, 5, 'exactamente el tope');
  assert.equal(p.diferidos.length, 2, 'el resto queda para la pasada siguiente');
  assert.equal(p.diferidos[0].motivo, 'tope_por_pasada');
  // Y NO hay ningún aviso cross-conversación.
  for (const av of p.avisos) assert.equal(typeof av.destino, 'string');
});

test('T-N16 · un renderer que tira ⇒ descarta y registra, no emite texto degradado', () => {
  // `SESION_RE` no acepta `+`: el renderer es fail-closed con identificadores raros.
  const malo = huerfano(2 * HORA);
  malo.reqId = 'chat+invalido-1755990000000';
  const targets = new Map([[malo.reqId, { ok: true, chatId: CHAT, via: 'etapa', motivo: null }]]);
  const p = notify.planNotices({
    huerfanos: [{ ...malo, auditRef: 'ref-fake' }],
    targets,
    nowMs: NOW,
    defaultChatId: CHAT,
    deps: { anchorAccepts: anclaQueAcepta(CHAT) },
  });
  assert.equal(p.avisos.length, 0);
  assert.equal(p.descartados.length, 1);
  assert.match(p.descartados[0].motivo, /^render_fallido:/);
});

test('T-N04c · un target rechazado llega al plan como descarte registrado', () => {
  const h = huerfano(2 * HORA);
  const targets = new Map([[h.reqId, { ok: false, chatId: null, via: null, motivo: 'destino_ajeno' }]]);
  const p = planDe([h], { targets });
  assert.equal(p.avisos.length, 0);
  assert.deepEqual(p.descartados.map((d) => d.motivo), ['destino_ajeno']);
  assert.equal(p.descartados[0].ref, h.auditRef, 'se registra el ref SEUDONIMIZADO');
});

// =============================================================================
// TEXTO — UX-4 / CA-12
// =============================================================================

// La regex LITERAL del criterio de aceptación. No se relaja ni se reescribe.
const JERGA = /eof_premature|empty_output|delivery_pending|delivered=false|stack|Error:/;

test('T-CA12 · la regex literal de jerga no matchea contra el texto YA INTERPOLADO', () => {
  const p1 = planDe([huerfano(4 * HORA)]);
  const p2 = planDe([huerfano(4 * HORA), huerfano(2 * HORA)]);
  const textos = [...p1.avisos, ...p2.avisos].map((a) => a.texto);
  assert.equal(textos.length, 2);
  for (const t of textos) {
    assert.ok(t.length > 0);
    assert.equal(JERGA.test(t), false, `jerga en el texto interpolado: ${t}`);
    // UX: al operador NUNCA se le dice "huérfano" (es vocabulario del enum).
    assert.equal(/hu[eé]rfano|orphan/i.test(t), false);
    // Y el aviso siempre dice que el pedido SE EJECUTÓ + no lo repitas.
    assert.match(t, /se ejecut/i);
    assert.match(t, /repet/i);
  }
});

test('T-UX4 · el texto de producción es EXACTAMENTE el del renderer de referencia', () => {
  const h = huerfano(4 * HORA);
  const p = planDe([h]);
  const esperado = render.renderAviso(
    'H1_respuesta_perdida',
    { sesion: h.reqId, iniciadoEn: h.epochms },
    { now: NOW },
  );
  assert.equal(p.avisos[0].texto, esperado, 'producción no reescribe el copy');
  // El identificador visible es el reqId CRUDO y completo (D-1).
  assert.ok(p.avisos[0].texto.includes(h.reqId));
});

// =============================================================================
// I/O — ledger, idempotencia y dead-letter
// =============================================================================

test('T-N15 · la SEGUNDA pasada sobre el mismo huérfano emite CERO avisos (idempotencia)', () => {
  conDirTemporal((ctx) => {
    const h = huerfano(4 * HORA);
    const a = emitir(ctx, { huerfanos: [h] });
    assert.equal(a.r.emitidos, 1);
    assert.equal(a.encolados.length, 1);

    const b = emitir(ctx, { huerfanos: [h] });
    assert.equal(b.r.emitidos, 0, 'la 2ª pasada no vuelve a avisar');
    assert.equal(b.encolados.length, 0);
  });
});

test('T-SEC-B · el ledger guarda SÓLO el ref seudonimizado: ni reqId ni chat_id crudos', () => {
  conDirTemporal((ctx) => {
    const h = huerfano(4 * HORA);
    emitir(ctx, { huerfanos: [h] });
    const raw = fs.readFileSync(notify.ledgerPath(ctx.pipelineDir), 'utf8');
    assert.ok(raw.includes(h.auditRef), 'el ref sí está');
    assert.equal(raw.includes(h.reqId), false, 'el reqId crudo lleva el chat id adentro');
    assert.equal(raw.includes(CHAT), false, 'el chat_id crudo no se persiste');
    const linea = JSON.parse(raw.trim().split('\n')[0]);
    assert.deepEqual(
      Object.keys(linea).sort(),
      ['aviso', 'correlation_id', 'modo', 'ref', 'timestamp'],
    );
  });
});

test('T-N14 · si el ledger no se puede escribir, el aviso NO se encola (fail-closed)', () => {
  conDirTemporal((ctx) => {
    const fsFake = {
      existsSync: () => false,
      readFileSync: () => '',
      mkdirSync: () => {},
      appendFileSync: () => { throw new Error('EACCES'); },
    };
    const { r, encolados, logs } = emitir(ctx, {
      huerfanos: [huerfano(4 * HORA)],
      deps: { fsImpl: fsFake },
    });
    assert.equal(r.emitidos, 0);
    assert.equal(encolados.length, 0, 'sin marca de idempotencia se re-notificaría en cada pasada');
    assert.ok(logs.some((m) => /ledger/i.test(m)), 'el fallo deja rastro');
  });
});

test('T-LEDGER-FAIL-CLOSED · un ledger existente pero ilegible bloquea TODOS los avisos', () => {
  conDirTemporal((ctx) => {
    const fsFake = {
      existsSync: () => true,
      readFileSync: () => { throw new Error('EIO'); },
      mkdirSync: () => {},
      appendFileSync: () => {},
    };
    const { r, encolados, logs } = emitir(ctx, {
      huerfanos: [huerfano(4 * HORA)],
      deps: { fsImpl: fsFake },
    });
    assert.equal(r.emitidos, 0);
    assert.equal(encolados.length, 0);
    assert.ok(logs.some((m) => /ilegible/i.test(m)));
  });
});

test('T-ANCLA-E2E · ancla VACÍA, de punta a punta y con el predicado REAL', () => {
  conAncla('', () => {
    // (a) El pedido es de OTRA conversación ⇒ se descarta y se registra. NUNCA
    //     se encola un dropfile que el servicio archivaría sin enviar.
    conDirTemporal((ctx) => {
      const { r, encolados, logs } = emitir(ctx, {
        huerfanos: [huerfano(4 * HORA, { chatId: OTRO_CHAT })],
        deps: { anchorAccepts: anchorAcceptsReal, defaultChatId: CHAT },
      });
      assert.equal(r.emitidos, 0, 'nada se archiva como enviado sin haberse enviado');
      assert.equal(encolados.length, 0);
      assert.equal(r.descartados.length, 1);
      assert.equal(r.descartados[0].motivo, 'destino_rechazado_por_anchor');
      assert.ok(logs.some((m) => /descartado/.test(m)), 'se descarta Y se registra');
      // Y NO se marcó como avisado: la pasada siguiente lo puede reintentar.
      assert.equal(fs.existsSync(notify.ledgerPath(ctx.pipelineDir)), false);
    });

    // (b) El pedido es del chat por default ⇒ el aviso SÍ sale, sin `chat_id`.
    //     Con el ancla vacía el operador se entera igual: es el CA del issue.
    conDirTemporal((ctx) => {
      const { r, encolados } = emitir(ctx, {
        huerfanos: [huerfano(4 * HORA, { chatId: CHAT })],
        deps: { anchorAccepts: anchorAcceptsReal, defaultChatId: CHAT },
      });
      assert.equal(r.emitidos, 1);
      assert.ok(!('chat_id' in encolados[0].payload));
    });
  });
});

test('T-N08b · un destino rechazado por el ancla no se envía a ningún otro lado', () => {
  conDirTemporal((ctx) => {
    const h = huerfano(4 * HORA, { chatId: OTRO_CHAT });
    const { r, encolados } = emitir(ctx, {
      huerfanos: [h],
      deps: { anchorAccepts: anclaQueAcepta(CHAT), defaultChatId: CHAT },
    });
    assert.equal(r.emitidos, 0);
    assert.equal(encolados.length, 0, 'jamás se redirige al chat por default');
  });
});

test('T-EMIT · el aviso encolado lleva correlación y destino, y el payload sale intacto del renderer', () => {
  conDirTemporal((ctx) => {
    const h = huerfano(4 * HORA);
    const { r, encolados } = emitir(ctx, { huerfanos: [h] });
    assert.equal(r.emitidos, 1);
    const { payload, opts } = encolados[0];
    assert.equal(payload.plain, true);
    assert.ok(!('chat_id' in payload), 'destino === default ⇒ rama sin chat_id');
    assert.match(opts.correlationId, /^orph-/);
    assert.equal(opts.chatId, CHAT, 'el chat va al historial, no al payload');
  });
});

test('T-EMIT2 · sin enqueueOrphanNotice inyectado no pasa absolutamente nada', () => {
  conDirTemporal((ctx) => {
    const r = notify.emitOrphanNotices({
      pipelineDir: ctx.pipelineDir,
      huerfanos: [huerfano(4 * HORA)],
      cidPorReq: new Map(),
      historyRaw: '',
      nowMs: NOW,
      deps: {},
    });
    assert.equal(r.emitidos, 0);
    assert.equal(fs.existsSync(notify.ledgerPath(ctx.pipelineDir)), false);
  });
});

test('T-EMIT3 · un encolador que TIRA no rompe la pasada y deja rastro', () => {
  conDirTemporal((ctx) => {
    const { r, logs } = emitir(ctx, {
      huerfanos: [huerfano(4 * HORA)],
      deps: { enqueueOrphanNotice: () => { throw new Error('cola llena'); } },
    });
    assert.equal(r.emitidos, 0);
    assert.ok(logs.some((m) => /no pude encolar/.test(m)));
  });
});

test('T-EMIT4 · turnos sanos (lista vacía) ⇒ cero avisos y cero escrituras', () => {
  conDirTemporal((ctx) => {
    const { r, encolados } = emitir(ctx, { huerfanos: [] });
    assert.equal(r.emitidos, 0);
    assert.equal(encolados.length, 0);
    assert.equal(fs.existsSync(notify.ledgerPath(ctx.pipelineDir)), false);
  });
});

// --- Dead-letter (N-17 / N-18) ------------------------------------------------

function prepararDeadLetter(ctx, { estado, conSidecar = null }) {
  const h = huerfano(4 * HORA);
  const { encolados } = emitir(ctx, { huerfanos: [h] });
  const correlationId = encolados[0].opts.correlationId;
  if (conSidecar) {
    fs.writeFileSync(path.join(ctx.logDir, metaFileName(h.reqId)), JSON.stringify(conSidecar), 'utf8');
  }
  const r = notify.reconcileNoticeDelivery({
    pipelineDir: ctx.pipelineDir,
    logDir: ctx.logDir,
    historyRaw: '',
    nowMs: NOW,
    windowMs: 48 * HORA,
    reqIdsEnVentana: [h.reqId],
    deps: { outboundStatus: (raw, cid) => (cid === correlationId ? estado : 'unknown') },
  });
  const metaPath = path.join(ctx.logDir, metaFileName(h.reqId));
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : null;
  return { r, meta, h };
}

test('T-N17 · un aviso que quedó "fallido" se refleja como aviso_entregado:false en el sidecar', () => {
  conDirTemporal((ctx) => {
    const { r, meta } = prepararDeadLetter(ctx, { estado: 'fallido' });
    assert.equal(r.marcados, 1);
    assert.equal(meta.aviso_entregado, false);
    // Sidecar inexistente ⇒ se crea con resultado 'huerfano' (el turno murió
    // antes de cerrar y por eso no llegó a escribirlo).
    assert.equal(meta.resultado, 'huerfano');
  });
});

test('T-N17b · el dead-letter NO pisa un resultado ya asentado (precedencia #6459 CA-1)', () => {
  conDirTemporal((ctx) => {
    const { meta } = prepararDeadLetter(ctx, {
      estado: 'fallido',
      conSidecar: { resultado: 'error', provider: 'anthropic', crossProviderDispatch: false },
    });
    assert.equal(meta.resultado, 'error', 'error le gana a huerfano');
    assert.equal(meta.provider, 'anthropic', 'el provider sobrevive');
    assert.equal(meta.aviso_entregado, false);
  });
});

test('T-N18 · enviado / encolado / unknown NO tocan el sidecar', () => {
  for (const estado of ['enviado', 'encolado', 'unknown', 'cualquiera']) {
    conDirTemporal((ctx) => {
      const { r, meta } = prepararDeadLetter(ctx, { estado });
      assert.equal(r.marcados, 0, `"${estado}" no es una no-entrega observada`);
      assert.equal(meta, null, 'no se inventa un sidecar');
    });
  }
});

test('T-DEAD · un turno que ya salió de la ventana no se marca (no hay reqId que mapear)', () => {
  conDirTemporal((ctx) => {
    const h = huerfano(4 * HORA);
    const { encolados } = emitir(ctx, { huerfanos: [h] });
    const cid = encolados[0].opts.correlationId;
    const r = notify.reconcileNoticeDelivery({
      pipelineDir: ctx.pipelineDir,
      logDir: ctx.logDir,
      historyRaw: '',
      nowMs: NOW,
      windowMs: 48 * HORA,
      reqIdsEnVentana: [],                       // el .log ya no está
      deps: { outboundStatus: () => 'fallido', log: () => {} },
    });
    assert.equal(r.marcados, 0);
    assert.ok(cid);
  });
});

test('T-DEAD2 · sin outboundStatus inyectado el dead-letter es un no-op', () => {
  conDirTemporal((ctx) => {
    const r = notify.reconcileNoticeDelivery({
      pipelineDir: ctx.pipelineDir,
      logDir: ctx.logDir,
      historyRaw: '',
      nowMs: NOW,
      windowMs: 48 * HORA,
      reqIdsEnVentana: [],
      deps: {},
    });
    assert.equal(r.marcados, 0);
  });
});

// --- canonicalChatId ----------------------------------------------------------

test('T-CANON · canonicalChatId aplica la MISMA regla que el transporte de Telegram', () => {
  assert.equal(notify.canonicalChatId('-1001234567890'), '-1001234567890');
  assert.equal(notify.canonicalChatId('6529617704'), '6529617704');
  for (const malo of ['007', '0', '-0', '', 'abc', '1.5', null, undefined, 12345, '  12 ']) {
    assert.equal(notify.canonicalChatId(malo), null, `"${malo}" no es un chat id`);
  }
  // Fuera del rango seguro de enteros ⇒ null (no se trunca en silencio).
  assert.equal(notify.canonicalChatId('99999999999999999999'), null);
});

// --- ledger: lectura defensiva ------------------------------------------------

test('T-LEDGER · líneas corruptas se saltean sin romper la lectura', () => {
  conDirTemporal((ctx) => {
    const file = notify.ledgerPath(ctx.pipelineDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      '{"ref":"abc-1","timestamp":' + NOW + '}',
      'no soy json',
      '{"sin_ref":true}',
      '[]',
      '',
      '{"ref":"abc-2","timestamp":' + NOW + '}',
    ].join('\n'), 'utf8');
    const refs = notify.readNotifiedRefs({ pipelineDir: ctx.pipelineDir });
    assert.deepEqual([...refs].sort(), ['abc-1', 'abc-2']);
  });
});

test('T-LEDGER2 · la ventana acota el dead-letter pero NO la idempotencia', () => {
  conDirTemporal((ctx) => {
    const file = notify.ledgerPath(ctx.pipelineDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ref: 'viejo', timestamp: NOW - 100 * HORA }) + '\n', 'utf8');

    // Idempotencia: sin filtro de ventana ⇒ el ref sigue contando.
    assert.equal(notify.readNotifiedRefs({ pipelineDir: ctx.pipelineDir }).has('viejo'), true);
    // Dead-letter: con ventana ⇒ queda afuera.
    const conVentana = notify.readLedgerEntries({
      pipelineDir: ctx.pipelineDir, nowMs: NOW, windowMs: 48 * HORA,
    });
    assert.equal(conVentana.entries.length, 0);
  });
});
