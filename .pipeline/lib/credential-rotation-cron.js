// =============================================================================
// credential-rotation-cron.js — Recordatorio de rotación de credenciales
// (#3080 / S1 multi-provider, CA-4 + CA-5).
//
// Lee `docs/secrets-inventory.md` (markdown table), calcula thresholds
// T-14 / T-7 / T-3 / T-1 / T-0 contra `expires_at` (UTC), y notifica al
// owner por Telegram. Idempotente: persiste estado en
// `.pipeline/credential-reminder-state.json` para no spamear si el pulpo
// reinicia entre ticks.
//
// **Arquitectura**:
//   - Función pura `evaluateRotationState({ now, inventoryRows, state })` →
//     devuelve `{ alerts, nextState }` para testing sin filesystem.
//   - Wrapper `runRotationTick({ pipelineDir, ... })` que lee/escribe disco
//     y dispara `sendTelegram`.
//   - Caller (pulpo.js) lo llama vía `setInterval` cada 1h (configurable).
//
// **Reglas de no-leak** (CA-2 + UX guideline G-2):
//   - El mensaje de Telegram NUNCA contiene el valor del secret. Sólo
//     metadata (provider, env_var, owner, días, runbook).
//   - El estado persistido NO contiene el valor del secret (sólo dates).
//   - El logger nunca imprime `process.env[envVar]`.
//
// **Idempotencia**:
//   - Cada threshold (T-14, T-7, T-3, T-1) se notifica UNA sola vez por
//     env_var por ciclo de 90 días.
//   - T-0 (expirada) se notifica en CADA tick hasta que el operador rote
//     y commitee `last_rotated`. El ruido sostenido es deliberado (G-5).
//   - Si después de un commit con `last_rotated` actualizado, el cron
//     detecta que `expires_at` saltó adelante y los thresholds previos ya
//     no aplican, RESETEA el estado para esa env_var (nuevo ciclo).
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

// Días por threshold de notificación. Orden importa: si dos thresholds caen
// el mismo día (ej: el cron arranca tarde y la fecha queda <= T-7 y >= T-3),
// se elige el MÁS URGENTE (índice mayor). G-5: un solo mensaje por tick.
const THRESHOLDS = Object.freeze([
  { key: 'T-14', daysRemaining: 14, icon: '📅', urgency: 1 },
  { key: 'T-7',  daysRemaining: 7,  icon: '⚠️', urgency: 2 },
  { key: 'T-3',  daysRemaining: 3,  icon: '🔔', urgency: 3 },
  { key: 'T-1',  daysRemaining: 1,  icon: '🚨', urgency: 4 },
]);

const ROTATION_POLICY_DAYS = 90;

// Path canónico del archivo de estado (idempotencia entre restarts).
function defaultStateFilePath(pipelineDir) {
  return path.join(pipelineDir, 'credential-reminder-state.json');
}

function defaultInventoryPath(pipelineDir) {
  // El inventario vive en `docs/secrets-inventory.md` relativo al ROOT del
  // repo (pipelineDir = `<root>/.pipeline`).
  return path.join(pipelineDir, '..', 'docs', 'secrets-inventory.md');
}

/**
 * Parsea las filas de la tabla markdown de `secrets-inventory.md`. Es un
 * parser tolerante: ignora líneas que no son fila de tabla, ignora rows
 * con `_no aplica todavía_` o sin `last_rotated` válido (provider opcional).
 *
 * Devuelve array de objetos:
 *   { provider, env_var, owner, last_rotated (Date|null),
 *     expires_at (Date|null), runbook_url, source_line }
 *
 * **No lee env vars** ni hace requests al provider — sólo parsea markdown.
 */
function parseInventoryMarkdown(content) {
  const lines = content.split(/\r?\n/);
  const rows = [];

  // Buscar la fila header (debe tener provider | env_var | ...).
  // Aceptar variaciones de spacing y orden de columnas estricto a partir
  // del header detectado. La estructura del archivo está controlada por
  // este repo (no input externo), así que un parser simple basta.
  let headerCols = null;
  let headerLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) continue;
    const cols = splitMdRow(line);
    if (cols.includes('provider') && cols.includes('env_var')) {
      headerCols = cols;
      headerLineIdx = i;
      break;
    }
  }
  if (!headerCols) return rows;

  // Saltar la línea separadora `|----|----|`.
  for (let i = headerLineIdx + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) break; // fin de tabla
    const cols = splitMdRow(line);
    if (cols.length !== headerCols.length) continue; // fila malformada
    const row = {};
    for (let c = 0; c < headerCols.length; c++) {
      row[headerCols[c]] = cols[c];
    }
    // Skip rows con last_rotated no parseable (ej: `_no aplica todavía_`).
    const lr = parseISODate(row.last_rotated);
    if (!lr) continue;
    const er = row.expires_at ? parseISODate(row.expires_at) : null;
    rows.push({
      provider: row.provider,
      env_var: stripBackticks(row.env_var),
      owner: row.owner,
      last_rotated: lr,
      expires_at: er || addDays(lr, ROTATION_POLICY_DAYS),
      account_id: row.account_id,
      runbook_url: extractMarkdownLinkUrl(row.rotation_runbook_url),
      source_line: i + 1,
    });
  }
  return rows;
}

function splitMdRow(line) {
  // `| provider | env_var | ... |` → ['provider', 'env_var', ...]
  return line
    .split('|')
    .slice(1, -1)        // remover los empties de los pipes externos
    .map((s) => s.trim());
}

function stripBackticks(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/^`|`$/g, '');
}

function extractMarkdownLinkUrl(s) {
  if (typeof s !== 'string') return null;
  const m = /\[([^\]]+)\]\(([^)]+)\)/.exec(s);
  return m ? m[2] : s;
}

function parseISODate(s) {
  if (typeof s !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.trim())) return null;
  const d = new Date(`${s.trim()}T00:00:00Z`);
  if (isNaN(d.getTime())) return null;
  return d;
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function diffDaysUTC(future, now) {
  // Diferencia en días enteros, redondeo hacia abajo cuando >0 y hacia arriba
  // cuando <0. UTC para reproducibilidad cross-timezone.
  const ms = future.getTime() - now.getTime();
  return Math.floor(ms / (24 * 3600 * 1000));
}

/**
 * Determina el threshold aplicable en `now` para una entry. Devuelve `null`
 * si la fecha actual está fuera de cualquier ventana (más de 14d antes del
 * vencimiento → sin recordatorio).
 *
 * La regla "MÁS URGENTE" cuando varios thresholds aplican en el mismo tick:
 * iteramos `THRESHOLDS` ordenados por `urgency` ascendente y elegimos el
 * último que matchee (el de mayor urgencia). G-5: una sola alerta por tick.
 *
 * T-0 (expirada): días restantes ≤ 0 → `expired: true`.
 */
function thresholdForEntry(entry, now) {
  const days = diffDaysUTC(entry.expires_at, now);
  if (days <= 0) {
    return { key: 'T-0', daysRemaining: days, icon: '🔴', urgency: 5, expired: true };
  }
  let chosen = null;
  for (const t of THRESHOLDS) {
    if (days <= t.daysRemaining) {
      // Más urgente entre los que cumplen "días restantes <= threshold".
      if (!chosen || t.urgency > chosen.urgency) chosen = t;
    }
  }
  if (!chosen) return null;
  return { ...chosen, daysRemaining: days, expired: false };
}

/**
 * Evalúa si dispara recordatorio para una entry, dada la fecha actual y el
 * estado persistido. Devuelve `{ shouldNotify, threshold, reason }`.
 *
 * Reglas:
 *   - Si `threshold === null` (más de 14d) → no notifica.
 *   - Si threshold es T-14/T-7/T-3/T-1 y el estado YA tiene `last_reminder_sent_at[threshold]`
 *     → no notifica (idempotencia).
 *   - Si threshold es T-0 (expirada) → notifica SIEMPRE (ruido sostenido G-5).
 *   - Si la entrada no existe en `state` → notifica.
 *   - Si `last_rotated` saltó adelante (ej: el operador rotó y commiteó),
 *     el estado del ciclo previo se considera obsoleto y se resetea
 *     (los thresholds vuelven a poder dispararse para el nuevo ciclo).
 */
function shouldNotifyEntry(entry, threshold, state) {
  if (!threshold) return { shouldNotify: false, reason: 'fuera de ventana' };

  const envState = state && state[entry.env_var];

  // Reset del estado si last_rotated cambió (nuevo ciclo).
  if (envState && envState.last_rotated !== entry.last_rotated.toISOString().slice(0, 10)) {
    return {
      shouldNotify: true,
      reason: 'last_rotated cambió — nuevo ciclo, reset de thresholds',
      resetState: true,
    };
  }

  // T-0 siempre notifica (G-5).
  if (threshold.expired) {
    return { shouldNotify: true, reason: 'expirada — notificación sostenida' };
  }

  // Threshold ya disparado en este ciclo → silencio.
  if (envState && envState.thresholds_sent && envState.thresholds_sent[threshold.key]) {
    return { shouldNotify: false, reason: `${threshold.key} ya notificado` };
  }
  return { shouldNotify: true, reason: `${threshold.key} primer disparo` };
}

/**
 * Genera el mensaje de Telegram para una entry + threshold, con shape
 * G-2 (UX guideline). Markdown V2 escapado básico.
 *
 * **NO incluye el secret**. Si por bug futuro alguien lo intentara meter
 * acá, los tests detectan substrings de la env var presente y abortan.
 */
function buildTelegramMessage(entry, threshold) {
  const isExpired = !!threshold.expired;
  const title = isExpired
    ? `${threshold.icon} Credencial EXPIRADA — rotar AHORA`
    : `${threshold.icon} Credencial próxima a expirar`;

  const daysLine = isExpired
    ? `Días restantes:  *${threshold.daysRemaining}* (vencida)`
    : `Días restantes:  *${threshold.daysRemaining}* días`;

  const lines = [
    title,
    '',
    `Provider:        ${entry.provider}`,
    `Env var:         ${entry.env_var}`,
    `Owner:           ${entry.owner}`,
    daysLine,
    '',
  ];
  if (entry.runbook_url) {
    lines.push(`📖 [Abrir runbook](${entry.runbook_url})`);
  }
  if (isExpired) {
    lines.push('');
    lines.push('_priority:critical — escalado a operador._');
  }
  return lines.join('\n');
}

/**
 * Función pura — evalúa el estado completo del cron para todas las entries
 * del inventario contra la fecha actual y el estado previo. Devuelve los
 * mensajes a enviar y el nuevo estado a persistir.
 *
 * Inputs explícitos para reproducibilidad de tests (no toca disco ni env).
 */
function evaluateRotationState({ now, inventoryRows, state }) {
  const alerts = [];
  const nextState = { ...(state || {}) };

  for (const entry of inventoryRows) {
    const threshold = thresholdForEntry(entry, now);
    const decision = shouldNotifyEntry(entry, threshold, nextState);

    // Reset del ciclo: si last_rotated cambió, limpiar el state del env_var.
    if (decision.resetState) {
      nextState[entry.env_var] = {
        last_rotated: entry.last_rotated.toISOString().slice(0, 10),
        thresholds_sent: {},
      };
    }

    if (!decision.shouldNotify) continue;

    const message = buildTelegramMessage(entry, threshold);
    alerts.push({
      env_var: entry.env_var,
      provider: entry.provider,
      threshold: threshold.key,
      daysRemaining: threshold.daysRemaining,
      message,
      priority: threshold.expired ? 'critical' : 'normal',
    });

    // Persistir el threshold disparado, salvo que sea T-0 (donde no marcamos
    // sent — queremos que vuelva a dispararse en cada tick).
    if (!threshold.expired) {
      nextState[entry.env_var] = nextState[entry.env_var] || {
        last_rotated: entry.last_rotated.toISOString().slice(0, 10),
        thresholds_sent: {},
      };
      nextState[entry.env_var].last_rotated = entry.last_rotated.toISOString().slice(0, 10);
      nextState[entry.env_var].thresholds_sent =
        nextState[entry.env_var].thresholds_sent || {};
      nextState[entry.env_var].thresholds_sent[threshold.key] =
        now.toISOString().slice(0, 10);
    } else {
      // Expirada: actualizar last_seen para audit trail, no thresholds_sent.
      nextState[entry.env_var] = nextState[entry.env_var] || {
        last_rotated: entry.last_rotated.toISOString().slice(0, 10),
        thresholds_sent: {},
      };
      nextState[entry.env_var].last_expired_alert =
        now.toISOString().slice(0, 10);
    }
  }
  return { alerts, nextState };
}

/**
 * Wrapper con I/O — lee inventario + estado, evalúa, envía alertas, persiste.
 * El caller (pulpo.js) inyecta `sendTelegram`. En tests se inyecta un fake.
 *
 * Devuelve `{ alerts, errors }` para que el caller loguee diagnóstico.
 */
function runRotationTick(opts = {}) {
  const {
    pipelineDir,
    now = new Date(),
    sendTelegram,
    sendTelegramFn,         // alias para no chocar con la global
    fsImpl = fs,
    inventoryPath = defaultInventoryPath(pipelineDir),
    statePath = defaultStateFilePath(pipelineDir),
    log = () => {},
  } = opts;

  const sender = sendTelegramFn || sendTelegram;
  const result = { alerts: [], errors: [] };

  // 1. Leer inventario.
  let inventoryRaw;
  try {
    inventoryRaw = fsImpl.readFileSync(inventoryPath, 'utf8');
  } catch (err) {
    result.errors.push({ stage: 'read-inventory', message: err.message });
    log(`[rotation-cron] no se pudo leer inventario: ${err.message}`);
    return result;
  }

  // 2. Parsear inventario.
  let rows;
  try {
    rows = parseInventoryMarkdown(inventoryRaw);
  } catch (err) {
    result.errors.push({ stage: 'parse-inventory', message: err.message });
    log(`[rotation-cron] error parseando inventario: ${err.message}`);
    return result;
  }

  // 3. Leer estado persistido (best-effort).
  let state = {};
  try {
    if (fsImpl.existsSync(statePath)) {
      state = JSON.parse(fsImpl.readFileSync(statePath, 'utf8'));
    }
  } catch (err) {
    log(`[rotation-cron] estado corrupto (${err.message}), reseteando`);
    state = {};
  }

  // 4. Evaluar.
  const { alerts, nextState } = evaluateRotationState({ now, inventoryRows: rows, state });
  result.alerts = alerts;

  // 5. Enviar alertas (best-effort por alerta — un fallo no bloquea las demás).
  for (const alert of alerts) {
    if (typeof sender !== 'function') continue;
    try {
      sender(alert.message);
      log(`[rotation-cron] alerta enviada: ${alert.env_var} ${alert.threshold} (${alert.daysRemaining}d)`);
    } catch (err) {
      result.errors.push({ stage: 'send-telegram', env_var: alert.env_var, message: err.message });
      log(`[rotation-cron] sendTelegram falló para ${alert.env_var}: ${err.message}`);
    }
  }

  // 6. Persistir estado.
  try {
    fsImpl.writeFileSync(statePath, JSON.stringify(nextState, null, 2));
  } catch (err) {
    result.errors.push({ stage: 'persist-state', message: err.message });
    log(`[rotation-cron] no se pudo persistir estado: ${err.message}`);
  }

  return result;
}

module.exports = {
  // Constantes (testing).
  THRESHOLDS,
  ROTATION_POLICY_DAYS,
  // Parser.
  parseInventoryMarkdown,
  parseISODate,
  addDays,
  diffDaysUTC,
  // Lógica pura.
  thresholdForEntry,
  shouldNotifyEntry,
  buildTelegramMessage,
  evaluateRotationState,
  // Wrapper con I/O.
  runRotationTick,
  // Helpers.
  defaultInventoryPath,
  defaultStateFilePath,
};
