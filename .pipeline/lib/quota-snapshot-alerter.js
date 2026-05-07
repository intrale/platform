// =============================================================================
// quota-snapshot-alerter.js — Estado de alertas Telegram para snapshots cuota.
// Issue #3012 (split de #3008, hija 1).
//
// RESPONSABILIDADES
//   - Mantener contador de fallos consecutivos del parser (CA-19).
//   - Disparar alerta Telegram una sola vez al cruzar el umbral (default 3).
//   - Reset del contador al primer parse OK (anti-spam: una sola alerta hasta
//     que vuelva a funcionar).
//   - Disparar alerta Telegram única ante mismatch de cuenta (CA-6).
//
// MICROCOPY (CA-UX-1.hija1, CA-UX-2.hija1)
//   Consumido literal de §4.2 y §4.3 de
//   `.pipeline/assets/mockups/narrativa-quota-real-snapshot.md`.
//   - §4.2 (parser offline): incluye whitelist cerrada de 4 categorías; el
//     valor que no esté en la whitelist colapsa a `unknown` antes de
//     interpolar. El test verifica que un valor inventado quede como
//     `unknown`.
//   - §4.3 (cuenta no esperada): cero interpolación de emails. El test
//     verifica que el body enviado no contenga `@`.
//
// USO
//   const alerter = require('.pipeline/lib/quota-snapshot-alerter');
//   const state = alerter.createAlerter({
//     sendMessage: (text) => telegram.send(text),
//     threshold: 3,
//   });
//   state.recordFailure('layout_drift');
//   state.recordSuccess();
//   state.recordAccountMismatch();
// =============================================================================
'use strict';

const path = require('path');
const fs = require('fs');

const { categorize, FAIL_CATEGORIES } = require('./quota-snapshot-parser');

// Microcopy literal §4.2 (CA-UX-1.hija1).
const PARSER_OFFLINE_TEMPLATE =
  'Lectura del cliente Claude Desktop fallo 3 veces seguidas.\n' +
  'Pipeline cae a heuristico para gates de cuota.\n' +
  'Causa probable: {category} (layout_drift | session_disconnected | account_mismatch | unknown).\n' +
  'Detalle en logs. Una sola alerta hasta que vuelva.';

// Microcopy literal §4.3 (CA-UX-2.hija1). Cero interpolación de emails.
const ACCOUNT_MISMATCH_BODY =
  'Snapshot capturado de una cuenta distinta a la esperada.\n' +
  'Descartado · no se contamina la calibracion.\n' +
  'Verifica login en Claude Desktop.\n' +
  'EXPECTED_CLAUDE_ACCOUNT no coincide con account_handle.';

const DEFAULT_THRESHOLD = parseEnvInt('QUOTA_PARSE_FAIL_ALERT_THRESHOLD', 3, 1, 100);

function parseEnvInt(name, fallback, min, max) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

/**
 * Construye el cuerpo del mensaje §4.2. La categoría se sanitiza con la
 * whitelist cerrada antes de interpolar (CA-UX-1.hija1).
 */
function buildParserOfflineMessage(rawCategory) {
  const safe = categorize(rawCategory);
  return PARSER_OFFLINE_TEMPLATE.replace('{category}', safe);
}

/**
 * Devuelve el cuerpo §4.3 sin interpolar nada (CA-11 + CA-UX-2.hija1).
 */
function buildAccountMismatchMessage() {
  return ACCOUNT_MISMATCH_BODY;
}

/**
 * Crea un alerter con dependencias inyectables para tests.
 *
 * @param {object} deps
 * @param {(text: string) => void} deps.sendMessage   Sender Telegram (sync o async).
 * @param {number} [deps.threshold]                   Umbral de fallos consecutivos.
 * @param {(msg: string) => void} [deps.log]
 * @param {string} [deps.statePath]                   Path JSON del estado persistido.
 */
function createAlerter(deps) {
  if (!deps || typeof deps.sendMessage !== 'function') {
    throw new Error('createAlerter: sendMessage es obligatorio');
  }
  const sendMessage = deps.sendMessage;
  const threshold = Number.isFinite(deps.threshold) ? deps.threshold : DEFAULT_THRESHOLD;
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const statePath = deps.statePath
    || path.resolve(__dirname, '..', '.quota-alerter-state.json');

  function loadState() {
    try {
      if (!fs.existsSync(statePath)) {
        return {
          consecutive_failures: 0,
          parser_offline_alert_sent: false,
          last_category: null,
          account_mismatch_alert_sent: false,
        };
      }
      const raw = fs.readFileSync(statePath, 'utf8');
      const obj = JSON.parse(raw);
      return Object.assign(
        {
          consecutive_failures: 0,
          parser_offline_alert_sent: false,
          last_category: null,
          account_mismatch_alert_sent: false,
        },
        obj
      );
    } catch (e) {
      return {
        consecutive_failures: 0,
        parser_offline_alert_sent: false,
        last_category: null,
        account_mismatch_alert_sent: false,
      };
    }
  }

  function saveState(state) {
    try {
      const dir = path.dirname(statePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {
      log(`alerter: no pude persistir estado: ${e && e.message}`);
    }
  }

  function recordFailure(rawCategory) {
    const state = loadState();
    state.consecutive_failures = Number(state.consecutive_failures) + 1;
    state.last_category = categorize(rawCategory);
    if (state.consecutive_failures >= threshold && !state.parser_offline_alert_sent) {
      try {
        sendMessage(buildParserOfflineMessage(state.last_category));
        state.parser_offline_alert_sent = true;
        log(`alerter: parser_offline disparado (categoria=${state.last_category})`);
      } catch (e) {
        log(`alerter: error al enviar Telegram: ${e && e.message}`);
      }
    }
    saveState(state);
    return state;
  }

  function recordSuccess() {
    const state = loadState();
    if (state.consecutive_failures > 0 || state.parser_offline_alert_sent) {
      log('alerter: parser recovery, reset de contador y flag');
    }
    state.consecutive_failures = 0;
    state.parser_offline_alert_sent = false;
    state.last_category = null;
    saveState(state);
    return state;
  }

  function recordAccountMismatch() {
    const state = loadState();
    if (state.account_mismatch_alert_sent) {
      // Anti-spam: una sola alerta hasta que coincida.
      saveState(state);
      return state;
    }
    try {
      sendMessage(buildAccountMismatchMessage());
      state.account_mismatch_alert_sent = true;
      log('alerter: account_mismatch disparado');
    } catch (e) {
      log(`alerter: error al enviar Telegram: ${e && e.message}`);
    }
    saveState(state);
    return state;
  }

  function recordAccountOk() {
    const state = loadState();
    if (state.account_mismatch_alert_sent) {
      log('alerter: account ok, reset flag');
    }
    state.account_mismatch_alert_sent = false;
    saveState(state);
    return state;
  }

  function getState() {
    return loadState();
  }

  return {
    recordFailure,
    recordSuccess,
    recordAccountMismatch,
    recordAccountOk,
    getState,
  };
}

module.exports = {
  createAlerter,
  buildParserOfflineMessage,
  buildAccountMismatchMessage,
  PARSER_OFFLINE_TEMPLATE,
  ACCOUNT_MISMATCH_BODY,
  FAIL_CATEGORIES,
  DEFAULT_THRESHOLD,
};
