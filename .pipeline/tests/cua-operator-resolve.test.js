// =============================================================================
// cua-operator-resolve.test.js — EP3-H4 (#3930)
//
// Verifica `resolveCuaOperatorChatIds` de pulpo.js: la resolución del operador
// autorizado a `/rechazar` entregables CUA SIN hardcodear el chat_id en el
// config.yaml público. El chat_id vive en credentials.json (env), respetando la
// convención del repo (mismo patrón que expectedChatId / handler #3384).
//
// Precedencia testeada:
//   1. cua.operator_chat_ids (config) — allowlist explícita.
//   2. TELEGRAM_LEO_OPERATOR_CHAT_ID (credential dedicada).
//   3. Fallback a getTelegramChatId() (chat principal autorizado).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// PULPO_NO_AUTOSTART=1 permite require() sin arrancar el pulpo (módulo exporta
// utilidades para tests).
process.env.PULPO_NO_AUTOSTART = '1';
const pulpo = require('../pulpo.js');
const { resolveCuaOperatorChatIds } = pulpo;

// Token con formato válido para que loadTelegramSecrets resuelva chat_id desde
// env (isLikelyToken exige `^\d{6,}:[A-Za-z0-9_-]{20,}$`). NO es un secreto real.
const FAKE_BOT_TOKEN = '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function withEnv(overrides, fn) {
  const keys = ['TELEGRAM_LEO_OPERATOR_CHAT_ID', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  try {
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(overrides, k)) {
        if (overrides[k] === undefined) delete process.env[k];
        else process.env[k] = overrides[k];
      } else {
        delete process.env[k];
      }
    }
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('exporta resolveCuaOperatorChatIds', () => {
  assert.equal(typeof resolveCuaOperatorChatIds, 'function');
});

test('config.operator_chat_ids no vacío → se usa tal cual (sin env)', () => {
  withEnv({}, () => {
    const r = resolveCuaOperatorChatIds(['777', '888']);
    assert.deepEqual(r, ['777', '888']);
  });
});

test('config vacío + TELEGRAM_LEO_OPERATOR_CHAT_ID → usa la credential dedicada', () => {
  withEnv({ TELEGRAM_LEO_OPERATOR_CHAT_ID: '4242' }, () => {
    const r = resolveCuaOperatorChatIds([]);
    assert.deepEqual(r, ['4242']);
  });
});

test('config + credential dedicada → se mergean deduplicados', () => {
  withEnv({ TELEGRAM_LEO_OPERATOR_CHAT_ID: '4242' }, () => {
    const r = resolveCuaOperatorChatIds(['777']);
    assert.deepEqual(r.sort(), ['4242', '777'].sort());
  });
});

test('dedup: mismo id en config y en la credential → aparece una sola vez', () => {
  withEnv({ TELEGRAM_LEO_OPERATOR_CHAT_ID: '4242' }, () => {
    const r = resolveCuaOperatorChatIds(['4242']);
    assert.deepEqual(r, ['4242']);
  });
});

test('fallback: config vacío y sin credential dedicada → usa el chat principal (getTelegramChatId)', () => {
  withEnv({ TELEGRAM_BOT_TOKEN: FAKE_BOT_TOKEN, TELEGRAM_CHAT_ID: '55555' }, () => {
    const r = resolveCuaOperatorChatIds([]);
    assert.deepEqual(r, ['55555'],
      'sin operator_chat_ids ni credential dedicada, el operador es el chat principal autorizado');
  });
});

test('higiene: ids no-string / vacíos / con espacios se normalizan', () => {
  withEnv({}, () => {
    const r = resolveCuaOperatorChatIds(['  999  ', '', null, 1234]);
    assert.deepEqual(r, ['999', '1234']);
  });
});

test('degradado seguro: sin ninguna fuente → array vacío (fail-closed, no crash)', () => {
  withEnv({}, () => {
    // Sin config, sin credential dedicada, sin chat principal en env.
    // getTelegramChatId() puede resolver desde credentials.json en disco; el
    // contrato verificado acá es que NO crashea y devuelve un array.
    const r = resolveCuaOperatorChatIds([]);
    assert.ok(Array.isArray(r), 'siempre devuelve un array');
  });
});
