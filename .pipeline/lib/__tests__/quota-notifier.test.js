// =============================================================================
// Tests quota-notifier.js — Issue #2975 (split de #2955)
//
// Cubre los CAs del PO en el comentario de criterios:
//   CA-1, CA-2  Notificación inicial (incluyendo branch resets_at_fallback)
//   CA-3..CA-5  Recordatorios FIFO A→B→C→D→A
//   CA-6..CA-8  Mensaje de cierre (con/sin cola N=0, skip <5min)
//   CA-9..CA-11 Gate texto libre + debounce 2 min + sin echo de input
//   CA-12       Redacción obligatoria
//   CA-13       Texto plano (plain=true) en canned response
//   CA-14       Configurabilidad reminder_interval_minutes
//   CA-15       Lifecycle completo y cancelación de setInterval post-reset
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createQuotaNotifier,
  QUOTA_COPY,
  REMINDER_LABELS,
  DEFAULT_REMINDER_INTERVAL_MIN,
  DEBOUNCE_CANNED_MS,
  MIN_BLOCK_DURATION_FOR_RESTORED_MS,
  formatHHMM,
  formatCountdown,
  interpolate,
  buildVars,
} = require('../quota-notifier');

// -- Test helper: clock + setInterval/clearInterval mockeables ----------------
function makeFakeClock() {
  const clock = {
    nowMs: 0,
    intervals: [],
    setIntervalFn(fn, ms) {
      const handle = { fn, ms, lastTick: clock.nowMs, cancelled: false };
      clock.intervals.push(handle);
      return handle;
    },
    clearIntervalFn(handle) {
      if (!handle) return;
      handle.cancelled = true;
    },
    advance(ms) {
      const target = clock.nowMs + ms;
      // Disparar todos los ticks que caen dentro del intervalo, en orden.
      // Bucle conservador: re-evaluar después de cada tick por si el callback
      // arma/cancela intervals.
      let safety = 10000;
      while (safety-- > 0) {
        let nextTickAt = Infinity;
        let next = null;
        for (const h of clock.intervals) {
          if (h.cancelled) continue;
          const at = h.lastTick + h.ms;
          if (at <= target && at < nextTickAt) {
            nextTickAt = at;
            next = h;
          }
        }
        if (!next) break;
        clock.nowMs = nextTickAt;
        next.lastTick = nextTickAt;
        try { next.fn(); } catch (e) { /* el productor loguea */ }
      }
      clock.nowMs = target;
    },
  };
  return clock;
}

function makeFakeSender() {
  const sent = [];
  return {
    sent,
    sendMessage: (text, opts) => {
      sent.push({ text, opts: opts || {} });
    },
  };
}

// Construye un flag fixture válido. `resets_at` por default a 4h del clock.
function makeFlag(clock, overrides) {
  return Object.assign(
    {
      detected_at: clock.nowMs,
      resets_at: clock.nowMs + 4 * 60 * 60 * 1000, // +4h
      error_type: 'usage_limit_error',
      resets_at_fallback: false,
    },
    overrides || {}
  );
}

// =============================================================================
// Helpers puros
// =============================================================================
test('formatHHMM formatea epoch-ms en HH:MM local con padding', () => {
  // 2026-05-05 14:07 local
  const d = new Date(2026, 4, 5, 14, 7, 0).getTime();
  assert.equal(formatHHMM(d), '14:07');
  const d2 = new Date(2026, 4, 5, 0, 5, 0).getTime();
  assert.equal(formatHHMM(d2), '00:05');
});

test('formatHHMM tolera input inválido', () => {
  assert.equal(formatHHMM(undefined), '--:--');
  assert.equal(formatHHMM(NaN), '--:--');
});

test('formatCountdown devuelve "X h Y min" en delta positivo', () => {
  const now = 1000;
  const future = now + (3 * 60 + 25) * 60 * 1000; // 3h 25min
  assert.equal(formatCountdown(future, now), '3 h 25 min');
});

test('formatCountdown colapsa a "0 min" en delta negativo o cero', () => {
  assert.equal(formatCountdown(1000, 5000), '0 min');
  assert.equal(formatCountdown(5000, 5000), '0 min');
});

test('formatCountdown con hoursOnly devuelve solo horas (CA-2 fallback)', () => {
  const now = 1000;
  const future = now + (5 * 60 + 30) * 60 * 1000;
  assert.equal(formatCountdown(future, now, { hoursOnly: true }), '5 h');
});

test('interpolate reemplaza placeholders conocidos y deja intactos los demas', () => {
  const out = interpolate('Hola {nombre}, te debo {monto}', { nombre: 'Leo' });
  assert.equal(out, 'Hola Leo, te debo {monto}');
});

test('buildVars infiere isFallback y formato de countdown', () => {
  const vars = buildVars(
    { resets_at: 5_000_000, resets_at_fallback: true },
    1_000_000,
    7
  );
  assert.equal(vars.isFallback, true);
  assert.equal(vars.n, 7);
  // Countdown debe usar formato hoursOnly cuando isFallback=true
  assert.match(vars.countdown, /^\d+ h$/);
});

// =============================================================================
// Notificación inicial (CA-1, CA-2)
// =============================================================================
test('CA-1 · onFlagSet emite UNA notificación inicial con HH:MM y countdown', () => {
  const clock = makeFakeClock();
  const sender = makeFakeSender();
  clock.nowMs = new Date(2026, 4, 5, 10, 0, 0).getTime();
  const notifier = createQuotaNotifier({
    sendMessage: sender.sendMessage,
    now: () => clock.nowMs,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
    getReminderIntervalMin: () => 120,
  });

  notifier.onFlagSet(makeFlag(clock, {
    resets_at: new Date(2026, 4, 5, 14, 30, 0).getTime(), // 14:30 — 4h 30 min
  }));

  assert.equal(sender.sent.length, 1, 'una sola notificación inicial');
  const msg = sender.sent[0].text;
  assert.match(msg, /Cuota Anthropic agotada/);
  assert.match(msg, /14:30/);
  assert.match(msg, /4 h 30 min/);
});

test('CA-1 · onFlagSet llamado dos veces NO re-envía inicial (idempotente)', () => {
  const clock = makeFakeClock();
  const sender = makeFakeSender();
  const notifier = createQuotaNotifier({
    sendMessage: sender.sendMessage,
    now: () => clock.nowMs,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
  });
  notifier.onFlagSet(makeFlag(clock));
  notifier.onFlagSet(makeFlag(clock));
  assert.equal(sender.sent.length, 1);
});

test('CA-2 · resets_at_fallback usa copy alternativo "proximo reset semanal"', () => {
  const clock = makeFakeClock();
  const sender = makeFakeSender();
  const notifier = createQuotaNotifier({
    sendMessage: sender.sendMessage,
    now: () => clock.nowMs,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
  });

  notifier.onFlagSet(makeFlag(clock, {
    resets_at_fallback: true,
    resets_at: clock.nowMs + 5 * 60 * 60 * 1000, // 5h
  }));

  assert.equal(sender.sent.length, 1);
  const msg = sender.sent[0].text;
  assert.match(msg, /proximo reset semanal/);
  assert.match(msg, /5 h/);
  // No debe interpolar HH:MM de un valor calculado como aproximación
  assert.doesNotMatch(msg, /\d{2}:\d{2}/);
});

// =============================================================================
// Recordatorios A→B→C→D→A (CA-3, CA-4, CA-5)
// =============================================================================
test('CA-5 · recordatorios rotan A→B→C→D→A en ese orden exacto', () => {
  const clock = makeFakeClock();
  const sender = makeFakeSender();
  const intervalMin = 60;
  const notifier = createQuotaNotifier({
    sendMessage: sender.sendMessage,
    now: () => clock.nowMs,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
    getReminderIntervalMin: () => intervalMin,
  });
  notifier.onFlagSet(makeFlag(clock));

  // Avanzamos 5 intervalos → 5 recordatorios
  for (let i = 0; i < 5; i++) {
    clock.advance(intervalMin * 60 * 1000);
  }

  // 1 inicial + 5 recordatorios
  assert.equal(sender.sent.length, 6);

  const reminders = sender.sent.slice(1);
  // Verificar que cada recordatorio coincide con la variante esperada
  const expected = ['A', 'B', 'C', 'D', 'A'];
  for (let i = 0; i < expected.length; i++) {
    const variantIdx = REMINDER_LABELS.indexOf(expected[i]);
    const tpl = QUOTA_COPY.reminders[variantIdx];
    // El template tiene placeholders — extraemos un fragmento único de cada
    // variante para identificarla.
    const uniqueFragments = {
      A: 'Cuota sigue agotada',
      B: 'Recordatorio: pipeline en modo deterministico',
      C: 'Determinisicos siguen avanzando',
      D: 'Si necesitas estado: /status',
    };
    assert.match(reminders[i].text, new RegExp(uniqueFragments[expected[i]]),
      `recordatorio ${i + 1} no es variante ${expected[i]}`);
  }
});

test('CA-4 · constantes QUOTA_COPY tienen exactamente 4 variantes y arrancan en A', () => {
  assert.equal(QUOTA_COPY.reminders.length, 4);
  assert.equal(REMINDER_LABELS.length, 4);
  assert.deepEqual(REMINDER_LABELS, ['A', 'B', 'C', 'D']);
});

test('CA-14 · reminder_interval_minutes configurable se respeta', () => {
  const clock = makeFakeClock();
  const sender = makeFakeSender();
  const notifier = createQuotaNotifier({
    sendMessage: sender.sendMessage,
    now: () => clock.nowMs,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
    getReminderIntervalMin: () => 30, // override a 30 min
  });
  notifier.onFlagSet(makeFlag(clock));

  // En 60 min deberían haberse disparado 2 ticks (cada 30 min)
  clock.advance(60 * 60 * 1000);
  // 1 inicial + 2 recordatorios
  assert.equal(sender.sent.length, 3);
});

test('CA-14 · reminder_interval_minutes <=0 cae al clamp mínimo 1 min', () => {
  const clock = makeFakeClock();
  const sender = makeFakeSender();
  const notifier = createQuotaNotifier({
    sendMessage: sender.sendMessage,
    now: () => clock.nowMs,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
    getReminderIntervalMin: () => 0,
  });
  notifier.onFlagSet(makeFlag(clock));
  // 1 min después debería haber 1 recordatorio (clamp a 1)
  clock.advance(60 * 1000);
  assert.equal(sender.sent.length, 2);
});

test('CA-15 · queued count se interpola en recordatorio (variante A)', () => {
  const clock = makeFakeClock();
  const sender = makeFakeSender();
  let queued = 0;
  const notifier = createQuotaNotifier({
    sendMessage: sender.sendMessage,
    now: () => clock.nowMs,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
    getReminderIntervalMin: () => 60,
    getQueuedAgentsCount: () => queued,
  });
  notifier.onFlagSet(makeFlag(clock));
  queued = 7;
  clock.advance(60 * 60 * 1000);
  // El recordatorio A interpola "{n} skills procesando"
  assert.match(sender.sent[1].text, /7 skills procesando/);
});

// =============================================================================
// Mensaje de cierre (CA-6, CA-7, CA-8)
// =============================================================================
test('CA-6 · onFlagCleared emite UNA notificación de cierre y cancela setInterval', () => {
  const clock = makeFakeClock();
  const sender = makeFakeSender();
  const notifier = createQuotaNotifier({
    sendMessage: sender.sendMessage,
    now: () => clock.nowMs,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
    getReminderIntervalMin: () => 60,
    getQueuedAgentsCount: () => 3,
  });
  notifier.onFlagSet(makeFlag(clock));
  // Bloqueo de 6 minutos → > 5 min, cierre debe enviarse
  clock.advance(6 * 60 * 1000);
  notifier.onFlagCleared();

  // 1 inicial + 0 recordatorios (no llegamos al primer tick de 60min) + 1 cierre = 2
  assert.equal(sender.sent.length, 2);
  const closeMsg = sender.sent[1].text;
  assert.match(closeMsg, /Cuota Anthropic restaurada/);
  assert.match(closeMsg, /Drenando cola de 3 agentes encolados/);

  // Avanzar 10h más — NO debe llegar ningún recordatorio (interval cancelado)
  clock.advance(10 * 60 * 60 * 1000);
  assert.equal(sender.sent.length, 2, 'setInterval fue cancelado, no más ticks');
});

test('CA-7 · queued=0 usa la variante alternativa "No habia agentes encolados"', () => {
  const clock = makeFakeClock();
  const sender = makeFakeSender();
  const notifier = createQuotaNotifier({
    sendMessage: sender.sendMessage,
    now: () => clock.nowMs,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
    getQueuedAgentsCount: () => 0,
  });
  notifier.onFlagSet(makeFlag(clock));
  clock.advance(10 * 60 * 1000); // > 5min
  notifier.onFlagCleared();

  const closeMsg = sender.sent[sender.sent.length - 1].text;
  assert.match(closeMsg, /No habia agentes encolados/);
  assert.doesNotMatch(closeMsg, /Drenando cola de/);
});

test('CA-8 · bloqueo <5min NO emite mensaje de restaurada (anti falso positivo)', () => {
  const clock = makeFakeClock();
  const sender = makeFakeSender();
  const notifier = createQuotaNotifier({
    sendMessage: sender.sendMessage,
    now: () => clock.nowMs,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
  });
  notifier.onFlagSet(makeFlag(clock));
  // 4 minutos — debajo del umbral de 5 min
  clock.advance(4 * 60 * 1000);
  notifier.onFlagCleared();

  // Solo la inicial — sin cierre
  assert.equal(sender.sent.length, 1);
});

test('onFlagCleared sin flag previo es no-op idempotente', () => {
  const clock = makeFakeClock();
  const sender = makeFakeSender();
  const notifier = createQuotaNotifier({
    sendMessage: sender.sendMessage,
    now: () => clock.nowMs,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
  });
  notifier.onFlagCleared(); // sin flag previo
  assert.equal(sender.sent.length, 0);
});

// =============================================================================
// Gate de texto libre (CA-9, CA-10, CA-11)
// =============================================================================
test('CA-9 · sin flag activo, handleCommanderFreeText devuelve gated=false', () => {
  const clock = makeFakeClock();
  const sender = makeFakeSender();
  const notifier = createQuotaNotifier({
    sendMessage: sender.sendMessage,
    now: () => clock.nowMs,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
  });
  const r = notifier.handleCommanderFreeText();
  assert.equal(r.gated, false);
  assert.equal(sender.sent.length, 0);
});

test('CA-10 · con flag activo, handleCommanderFreeText envia canned PLAIN sin echo de input', () => {
  const clock = makeFakeClock();
  const sender = makeFakeSender();
  const notifier = createQuotaNotifier({
    sendMessage: sender.sendMessage,
    now: () => clock.nowMs,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
  });
  notifier.onFlagSet(makeFlag(clock, {
    resets_at: new Date(2026, 4, 5, 14, 30, 0).getTime(),
  }));
  // Reset sender para enfocar en el canned
  sender.sent.length = 0;

  const r = notifier.handleCommanderFreeText();
  assert.equal(r.gated, true);
  assert.equal(r.debounced, false);
  assert.equal(sender.sent.length, 1);
  // CA-13: debe ir como plain
  assert.equal(sender.sent[0].opts.plain, true);
  // Contiene HH:MM y la lista de comandos
  assert.match(sender.sent[0].text, /14:30/);
  assert.match(sender.sent[0].text, /\/status/);
});

test('CA-10 · canned NO contiene caracteres peligrosos del input (CA-S7: prohibido echo)', () => {
  // El gate no recibe input — la firma de handleCommanderFreeText() no acepta
  // texto de usuario, así que por construcción es imposible echo. Validamos
  // que el template tampoco interpola nada que no sea HH:MM/countdown/n.
  const dangerous = ['<', '>', '&', '|', ';', "'", '"', '`', '{', '}', '[', ']', '(', ')', '*', '_', '~'];
  for (const ch of dangerous) {
    assert.ok(!QUOTA_COPY.cannedFreeText.includes(`{${ch}}`),
      `template canned contiene placeholder peligroso ${ch}`);
  }
  // Y los placeholders del canned deben ser solo del set permitido
  const placeholders = [...QUOTA_COPY.cannedFreeText.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
  for (const p of placeholders) {
    assert.ok(['hhmm', 'countdown', 'n', 'isFallback'].includes(p),
      `placeholder no autorizado en canned: ${p}`);
  }
});

test('CA-11 · debounce 2 min — segunda invocación dentro de la ventana NO envia canned', () => {
  const clock = makeFakeClock();
  const sender = makeFakeSender();
  const notifier = createQuotaNotifier({
    sendMessage: sender.sendMessage,
    now: () => clock.nowMs,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
  });
  notifier.onFlagSet(makeFlag(clock));
  sender.sent.length = 0;

  // 1er mensaje → canned
  let r = notifier.handleCommanderFreeText();
  assert.equal(r.gated, true);
  assert.equal(r.debounced, false);
  assert.equal(sender.sent.length, 1);

  // 30s después → debounced
  clock.nowMs += 30 * 1000;
  r = notifier.handleCommanderFreeText();
  assert.equal(r.gated, true);
  assert.equal(r.debounced, true);
  assert.equal(sender.sent.length, 1, 'no se envió segunda canned');

  // 60s más después (90s total) → todavía debounced
  clock.nowMs += 60 * 1000;
  r = notifier.handleCommanderFreeText();
  assert.equal(r.debounced, true);
  assert.equal(sender.sent.length, 1);

  // Avanzar más allá de los 2 min totales → vuelve a enviar
  clock.nowMs += 31 * 1000; // 121s desde el primer envío
  r = notifier.handleCommanderFreeText();
  assert.equal(r.gated, true);
  assert.equal(r.debounced, false);
  assert.equal(sender.sent.length, 2);
});

// =============================================================================
// Redacción obligatoria (CA-12)
// =============================================================================
test('CA-12 · TODOS los mensajes pasan por la función redact inyectada', () => {
  const clock = makeFakeClock();
  const sender = makeFakeSender();
  const calls = [];
  const fakeRedact = (text) => {
    calls.push(text);
    return text + ' [REDACTED]';
  };
  const notifier = createQuotaNotifier({
    sendMessage: sender.sendMessage,
    redact: fakeRedact,
    now: () => clock.nowMs,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
    getReminderIntervalMin: () => 60,
  });

  notifier.onFlagSet(makeFlag(clock));
  clock.advance(60 * 60 * 1000);     // 1 recordatorio
  notifier.handleCommanderFreeText(); // 1 canned
  clock.advance(6 * 60 * 1000);
  notifier.onFlagCleared();          // 1 cierre

  // 1 inicial + 1 recordatorio + 1 canned + 1 cierre = 4 envíos
  assert.equal(sender.sent.length, 4);
  // El sender recibió siempre el texto post-redacción
  for (const s of sender.sent) {
    assert.ok(s.text.endsWith('[REDACTED]'),
      `mensaje sin redacción: ${s.text.slice(0, 80)}`);
  }
  // Y la función fakeRedact fue invocada para CADA envío
  assert.equal(calls.length, 4);
});

test('CA-12 · si redact lanza, el mensaje se envia raw como fallback (no se rompe el lifecycle)', () => {
  const clock = makeFakeClock();
  const sender = makeFakeSender();
  const failingRedact = () => { throw new Error('boom'); };
  const notifier = createQuotaNotifier({
    sendMessage: sender.sendMessage,
    redact: failingRedact,
    now: () => clock.nowMs,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
  });
  notifier.onFlagSet(makeFlag(clock));
  // Mensaje raw (no termina con [REDACTED] porque redact tiró)
  assert.equal(sender.sent.length, 1);
  assert.match(sender.sent[0].text, /Cuota Anthropic agotada/);
});

// =============================================================================
// Texto plano en canned (CA-13)
// =============================================================================
test('CA-13 · sólo la canned response usa opts.plain=true; mensajes lifecycle van con default', () => {
  const clock = makeFakeClock();
  const sender = makeFakeSender();
  const notifier = createQuotaNotifier({
    sendMessage: sender.sendMessage,
    now: () => clock.nowMs,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
    getReminderIntervalMin: () => 60,
  });
  notifier.onFlagSet(makeFlag(clock));            // inicial — opts={}
  clock.advance(60 * 60 * 1000);                  // recordatorio — opts={}
  notifier.handleCommanderFreeText();             // canned — opts.plain=true
  clock.advance(6 * 60 * 1000);
  notifier.onFlagCleared();                       // cierre — opts={}

  assert.equal(sender.sent.length, 4);
  assert.equal(!!sender.sent[0].opts.plain, false, 'inicial NO plain');
  assert.equal(!!sender.sent[1].opts.plain, false, 'recordatorio NO plain');
  assert.equal(!!sender.sent[2].opts.plain, true,  'canned SI plain');
  assert.equal(!!sender.sent[3].opts.plain, false, 'cierre NO plain');
});

// =============================================================================
// Lifecycle completo (CA-15) y disposal
// =============================================================================
test('CA-15 · lifecycle E2E: inicial + 4 recordatorios + 1 mas (rotación) + cierre — sin más ticks', () => {
  const clock = makeFakeClock();
  const sender = makeFakeSender();
  const intervalMin = 30;
  const notifier = createQuotaNotifier({
    sendMessage: sender.sendMessage,
    now: () => clock.nowMs,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
    getReminderIntervalMin: () => intervalMin,
    getQueuedAgentsCount: () => 2,
  });

  notifier.onFlagSet(makeFlag(clock));
  clock.advance(5 * intervalMin * 60 * 1000); // 5 ticks = A, B, C, D, A

  // 1 inicial + 5 recordatorios = 6
  assert.equal(sender.sent.length, 6);

  notifier.onFlagCleared();
  // + 1 cierre = 7
  assert.equal(sender.sent.length, 7);
  assert.match(sender.sent[6].text, /Cuota Anthropic restaurada/);

  // 24h más → no debe llegar nada
  clock.advance(24 * 60 * 60 * 1000);
  assert.equal(sender.sent.length, 7);

  // getState refleja estado limpio
  const state = notifier.getState();
  assert.equal(state.active, false);
  assert.equal(state.hasInterval, false);
});

test('dispose() cancela el setInterval explícitamente (cleanup en SIGINT/SIGTERM)', () => {
  const clock = makeFakeClock();
  const sender = makeFakeSender();
  const notifier = createQuotaNotifier({
    sendMessage: sender.sendMessage,
    now: () => clock.nowMs,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
    getReminderIntervalMin: () => 60,
  });
  notifier.onFlagSet(makeFlag(clock));
  notifier.dispose();
  clock.advance(10 * 60 * 60 * 1000);
  // Solo la inicial — el interval fue disposed
  assert.equal(sender.sent.length, 1);
});

test('createQuotaNotifier sin sendMessage tira error explícito', () => {
  assert.throws(
    () => createQuotaNotifier({}),
    /sendMessage es obligatorio/
  );
});

test('constantes públicas tienen los valores documentados', () => {
  assert.equal(DEFAULT_REMINDER_INTERVAL_MIN, 120);
  assert.equal(DEBOUNCE_CANNED_MS, 2 * 60 * 1000);
  assert.equal(MIN_BLOCK_DURATION_FOR_RESTORED_MS, 5 * 60 * 1000);
});
