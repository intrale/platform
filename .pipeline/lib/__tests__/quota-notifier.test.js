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
  PROVIDER_LABELS,
  DEFAULT_PROVIDER_KEY,
  formatHHMM,
  formatCountdown,
  interpolate,
  buildVars,
  parseResetsAt,
  providerLabel,
  normalizeProviderKey,
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
  // (#4565: se agrega `provider`, campo de sistema — NO input de usuario).
  const placeholders = [...QUOTA_COPY.cannedFreeText.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
  for (const p of placeholders) {
    assert.ok(['hhmm', 'countdown', 'n', 'isFallback', 'provider'].includes(p),
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

// =============================================================================
// #4565 Bug 2 — parseResetsAt / buildVars con resets_at ISO8601
// =============================================================================
test('#4565 · parseResetsAt acepta ISO8601 (el bug del --:--)', () => {
  const iso = '2026-07-13T00:00:00.000Z';
  assert.equal(parseResetsAt(iso), Date.parse(iso));
  assert.ok(Number.isFinite(parseResetsAt(iso)));
});

test('#4565 · parseResetsAt acepta epoch-ms number (fixtures y flag legacy)', () => {
  assert.equal(parseResetsAt(5_000_000), 5_000_000);
});

test('#4565 · parseResetsAt acepta string numérico epoch-ms', () => {
  assert.equal(parseResetsAt('5000000'), 5_000_000);
});

test('#4565 · parseResetsAt devuelve NaN para basura', () => {
  assert.ok(Number.isNaN(parseResetsAt(undefined)));
  assert.ok(Number.isNaN(parseResetsAt(null)));
  assert.ok(Number.isNaN(parseResetsAt('')));
  assert.ok(Number.isNaN(parseResetsAt('no-es-fecha')));
  assert.ok(Number.isNaN(parseResetsAt(NaN)));
});

test('#4565 · buildVars con resets_at ISO8601 produce hhmm real (NO "--:--")', () => {
  // Reset a las 14:30 hora local, expresado como ISO8601 (como persiste el flag).
  const resetLocal = new Date(2026, 6, 8, 14, 30, 0);
  const nowMs = new Date(2026, 6, 8, 10, 0, 0).getTime();
  const vars = buildVars(
    { resets_at: resetLocal.toISOString() },
    nowMs,
    0
  );
  assert.equal(vars.hhmm, '14:30');
  assert.notEqual(vars.hhmm, '--:--');
  assert.equal(vars.countdown, '4 h 30 min');
});

test('#4565 · regresión: Number() sobre ISO daba NaN → "--:--"; parseResetsAt lo evita', () => {
  const iso = '2026-07-13T00:00:00.000Z';
  // Comportamiento viejo (bug):
  assert.ok(Number.isNaN(Number(iso)));
  assert.equal(formatHHMM(Number(iso)), '--:--');
  // Comportamiento nuevo:
  assert.notEqual(formatHHMM(parseResetsAt(iso)), '--:--');
});

// =============================================================================
// #4565 Bug 1 — provider legible en templates (no hardcodear "Anthropic")
// =============================================================================
test('#4565 · providerLabel mapea claves a labels humanos, nunca la clave cruda', () => {
  assert.equal(providerLabel('anthropic'), 'Anthropic');
  assert.equal(providerLabel('openai-codex'), 'OpenAI Codex');
  assert.equal(providerLabel('gemini-google'), 'Gemini');
  // Aliases
  assert.equal(providerLabel('openai'), 'OpenAI Codex');
  assert.equal(providerLabel('codex'), 'OpenAI Codex');
  // Desconocido / faltante → default anthropic (backward-compat)
  assert.equal(providerLabel(undefined), 'Anthropic');
  assert.equal(providerLabel(''), 'Anthropic');
  assert.equal(providerLabel('proveedor-inexistente'), 'Anthropic');
  // Nunca devuelve la clave cruda
  assert.notEqual(providerLabel('openai-codex'), 'openai-codex');
});

test('#4565 · normalizeProviderKey canoniza aliases y default', () => {
  assert.equal(normalizeProviderKey('openai'), 'openai-codex');
  assert.equal(normalizeProviderKey('claude'), 'anthropic');
  assert.equal(normalizeProviderKey('anthropic'), 'anthropic');
  assert.equal(normalizeProviderKey(undefined), DEFAULT_PROVIDER_KEY);
  assert.equal(normalizeProviderKey('OPENAI-CODEX'), 'openai-codex');
});

test('#4565 · notificacion inicial nombra el provider agotado (Codex, no Anthropic)', () => {
  const clock = makeFakeClock();
  const sender = makeFakeSender();
  clock.nowMs = new Date(2026, 6, 8, 10, 0, 0).getTime();
  const notifier = createQuotaNotifier({
    sendMessage: sender.sendMessage,
    now: () => clock.nowMs,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
    // El commander usa Codex en este escenario, así que el gate igual bloquea.
    getCommanderProvider: () => 'openai-codex',
  });
  notifier.onFlagSet(makeFlag(clock, {
    provider: 'openai-codex',
    resets_at: new Date(2026, 6, 8, 14, 30, 0).toISOString(),
  }));

  assert.equal(sender.sent.length, 1);
  const msg = sender.sent[0].text;
  assert.match(msg, /Cuota OpenAI Codex agotada/);
  assert.doesNotMatch(msg, /Cuota Anthropic agotada/);
  assert.match(msg, /14:30/);
  // Nunca la clave cruda
  assert.doesNotMatch(msg, /openai-codex/);
});

test('#4565 · mensaje de restaurada nombra el provider recuperado', () => {
  const clock = makeFakeClock();
  const sender = makeFakeSender();
  const notifier = createQuotaNotifier({
    sendMessage: sender.sendMessage,
    now: () => clock.nowMs,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
    getQueuedAgentsCount: () => 0,
    getCommanderProvider: () => 'gemini-google',
  });
  notifier.onFlagSet(makeFlag(clock, { provider: 'gemini-google' }));
  clock.advance(10 * 60 * 1000); // > 5min
  notifier.onFlagCleared();
  const closeMsg = sender.sent[sender.sent.length - 1].text;
  assert.match(closeMsg, /Cuota Gemini restaurada/);
});

test('#4565 · sin campo provider, cae a "Anthropic" (backward-compat)', () => {
  const clock = makeFakeClock();
  const sender = makeFakeSender();
  const notifier = createQuotaNotifier({
    sendMessage: sender.sendMessage,
    now: () => clock.nowMs,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
  });
  notifier.onFlagSet(makeFlag(clock)); // sin provider
  assert.match(sender.sent[0].text, /Cuota Anthropic agotada/);
});

// =============================================================================
// #4565 CA-3 — gate selectivo por provider
// =============================================================================
test('#4565 CA-3 · provider agotado != commander → gate NO bloquea (gatesLlm=false)', () => {
  const clock = makeFakeClock();
  const sender = makeFakeSender();
  const notifier = createQuotaNotifier({
    sendMessage: sender.sendMessage,
    now: () => clock.nowMs,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
    // Se agotó Codex; el commander usa Anthropic → NO debe bloquear.
    getCommanderProvider: () => 'anthropic',
  });
  notifier.onFlagSet(makeFlag(clock, { provider: 'openai-codex' }));
  sender.sent.length = 0;

  const st = notifier.getState();
  assert.equal(st.active, true, 'el flag sigue activo (hay notificaciones)');
  assert.equal(st.gatesLlm, false, 'NO gatea el LLM del commander');
  assert.equal(st.provider, 'openai-codex');

  const gate = notifier.handleCommanderFreeText();
  assert.equal(gate.gated, false, 'el LLM sano debe procesar el texto libre');
  assert.equal(sender.sent.length, 0, 'no se envía canned');
});

test('#4565 CA-3 · provider agotado == commander → gate SÍ bloquea', () => {
  const clock = makeFakeClock();
  const sender = makeFakeSender();
  const notifier = createQuotaNotifier({
    sendMessage: sender.sendMessage,
    now: () => clock.nowMs,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
    getCommanderProvider: () => 'anthropic',
  });
  notifier.onFlagSet(makeFlag(clock, {
    provider: 'anthropic',
    resets_at: new Date(2026, 6, 8, 14, 30, 0).toISOString(),
  }));
  sender.sent.length = 0;

  const st = notifier.getState();
  assert.equal(st.gatesLlm, true, 'Anthropic agotado + commander Anthropic → gatea');

  const gate = notifier.handleCommanderFreeText();
  assert.equal(gate.gated, true);
  assert.equal(gate.debounced, false);
  assert.equal(sender.sent.length, 1, 'se envía canned');
  assert.equal(sender.sent[0].opts.plain, true);
});

test('#4565 CA-3 · aliases: commander "claude" == flag "anthropic" → bloquea', () => {
  const clock = makeFakeClock();
  const sender = makeFakeSender();
  const notifier = createQuotaNotifier({
    sendMessage: sender.sendMessage,
    now: () => clock.nowMs,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
    getCommanderProvider: () => 'claude', // alias de anthropic
  });
  notifier.onFlagSet(makeFlag(clock, { provider: 'anthropic' }));
  assert.equal(notifier.getState().gatesLlm, true);
});

test('#4565 CA-3 · sin flag activo, gatesLlm=false y getState.provider=null', () => {
  const clock = makeFakeClock();
  const sender = makeFakeSender();
  const notifier = createQuotaNotifier({
    sendMessage: sender.sendMessage,
    now: () => clock.nowMs,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
  });
  const st = notifier.getState();
  assert.equal(st.active, false);
  assert.equal(st.gatesLlm, false);
  assert.equal(st.provider, null);
  assert.equal(st.providerLabel, null);
});

test('#4565 CA-3 · default getCommanderProvider es anthropic', () => {
  const clock = makeFakeClock();
  const sender = makeFakeSender();
  const notifier = createQuotaNotifier({
    sendMessage: sender.sendMessage,
    now: () => clock.nowMs,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
  });
  // flag anthropic + default commander → bloquea
  notifier.onFlagSet(makeFlag(clock, { provider: 'anthropic' }));
  assert.equal(notifier.getState().gatesLlm, true);
});

// =============================================================================
// #4565 (rebote rev-1) CA-3 — gate por RESOLUCIÓN DE CADENA (isLlmGated)
// Cierra el gap del rechazo de review: cuando Anthropic (primario) está agotado
// pero hay un fallback SANO en la cadena, el gate NO debe pre-emptir con canned;
// debe dejar que `ejecutarClaude` use ese provider sano. La autoridad es la
// resolución de la cadena completa (`isLlmGated`), NO el estado del primario.
// =============================================================================
test('#4565 rebote · Anthropic agotado + fallback SANO → gatesLlm=false (NO pre-emptir canned)', () => {
  const clock = makeFakeClock();
  const sender = makeFakeSender();
  const notifier = createQuotaNotifier({
    sendMessage: sender.sendMessage,
    now: () => clock.nowMs,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
    // La cadena resuelve a un fallback sano → NO gateada, aunque el primario
    // Anthropic esté agotado. Este es exactamente el escenario del rechazo.
    isLlmGated: () => false,
    // Heurístico que, de usarse, bloquearía (anthropic==anthropic). Debe ser
    // IGNORADO cuando isLlmGated resuelve.
    getCommanderProvider: () => 'anthropic',
  });
  notifier.onFlagSet(makeFlag(clock, { provider: 'anthropic' }));
  sender.sent.length = 0;

  const st = notifier.getState();
  assert.equal(st.active, true, 'el flag sigue activo');
  assert.equal(st.gatesLlm, false, 'hay fallback sano → NO gatea el LLM');

  const gate = notifier.handleCommanderFreeText();
  assert.equal(gate.gated, false, 'ejecutarClaude debe usar el fallback sano');
  assert.equal(sender.sent.length, 0, 'no se envía canned determinístico');
});

test('#4565 rebote · cadena ENTERAMENTE gateada → gatesLlm=true (canned)', () => {
  const clock = makeFakeClock();
  const sender = makeFakeSender();
  const notifier = createQuotaNotifier({
    sendMessage: sender.sendMessage,
    now: () => clock.nowMs,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
    // Primario + todos los fallbacks gateados → sí bloquea.
    isLlmGated: () => true,
    getCommanderProvider: () => 'anthropic',
  });
  notifier.onFlagSet(makeFlag(clock, {
    provider: 'anthropic',
    resets_at: new Date(2026, 6, 8, 14, 30, 0).toISOString(),
  }));
  sender.sent.length = 0;

  assert.equal(notifier.getState().gatesLlm, true, 'sin provider sano → gatea');
  const gate = notifier.handleCommanderFreeText();
  assert.equal(gate.gated, true);
  assert.equal(gate.debounced, false);
  assert.equal(sender.sent.length, 1, 'se envía canned');
  assert.equal(sender.sent[0].opts.plain, true);
});

test('#4565 rebote · isLlmGated tiene PRECEDENCIA sobre el heurístico por provider', () => {
  const clock = makeFakeClock();
  const sender = makeFakeSender();
  const notifier = createQuotaNotifier({
    sendMessage: sender.sendMessage,
    now: () => clock.nowMs,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
    // El heurístico diría "bloquear" (exhausted anthropic == commander anthropic),
    // pero la cadena tiene un sano → isLlmGated manda y NO bloquea.
    isLlmGated: () => false,
    getCommanderProvider: () => 'anthropic',
  });
  notifier.onFlagSet(makeFlag(clock, { provider: 'anthropic' }));
  assert.equal(notifier.getState().gatesLlm, false, 'isLlmGated=false gana sobre el heurístico');
});

test('#4565 rebote · isLlmGated que lanza → fail-open (NO bloquea, cae al no-gate)', () => {
  const clock = makeFakeClock();
  const sender = makeFakeSender();
  const logs = [];
  const notifier = createQuotaNotifier({
    sendMessage: sender.sendMessage,
    now: () => clock.nowMs,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
    log: (m) => logs.push(m),
    // Bug del resolver: lanza. Fail-open = NO pre-emptir con canned; que
    // ejecutarClaude re-resuelva y decida (preserva CA-3 en el error path).
    isLlmGated: () => { throw new Error('resolver boom'); },
    getCommanderProvider: () => 'anthropic',
  });
  notifier.onFlagSet(makeFlag(clock, { provider: 'anthropic' }));
  sender.sent.length = 0;

  assert.equal(notifier.getState().gatesLlm, false, 'fail-open: no bloquea ante error del resolver');
  const gate = notifier.handleCommanderFreeText();
  assert.equal(gate.gated, false);
  assert.equal(sender.sent.length, 0, 'no se envía canned');
  assert.ok(logs.some((m) => /isLlmGated lanzó/.test(m)), 'loguea el fail-open');
});

test('#4565 rebote · sin isLlmGated → heurístico por provider (backward-compat)', () => {
  const clock = makeFakeClock();
  const sender = makeFakeSender();
  const notifier = createQuotaNotifier({
    sendMessage: sender.sendMessage,
    now: () => clock.nowMs,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
    // NO se inyecta isLlmGated → cae al heurístico existente.
    getCommanderProvider: () => 'anthropic',
  });
  notifier.onFlagSet(makeFlag(clock, { provider: 'anthropic' }));
  assert.equal(notifier.getState().gatesLlm, true, 'heurístico: anthropic==anthropic → bloquea');
});
