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
// **Reglas de no-leak** (CA-2 + UX guideline G-2, actualizada por #5901):
//   - El mensaje de Telegram NUNCA contiene el valor del secret. Sólo
//     metadata (PROYECTO, provider, env_var, owner, días, runbook). El
//     proyecto se nombra por su SLUG validado, nunca por razón social ni
//     nombre de cliente (UX-3 + UX-5 — ver `safe-project-id.projectLabel`).
//   - El estado persistido NO contiene el valor del secret (sólo dates) y vive
//     FUERA del árbol del repo: el repo es PÚBLICO y publicar el inventario de
//     nombres de variables con su calendario de vencimiento es reconocimiento
//     dirigido gratis (REQ-SEC-1). Además el repo se resetea con `reset --hard`
//     en cada respawn, que es la amnesia de rotación que #5901 reporta.
//   - El logger nunca imprime `process.env[envVar]`.
//
// **Idempotencia**:
//   - Cada threshold (T-14, T-7, T-3, T-1) se notifica UNA sola vez por
//     `(projectId, env_var)` por ciclo de 90 días. **#5901 — el eje del estado
//     es el PAR, no la variable sola**: dos productos que usan la misma
//     `env_var` compartían casillero y rotar la de uno marcaba como rotada la
//     del otro, que quedaba vencida sin aviso.
//   - G-5 (actualizada por #5901 · UX-2): la invariante de mensajería pasa de
//     "un mensaje por tick por entry" a **"un mensaje por `(env_var,
//     threshold)` por tick"**, listando los proyectos afectados. Agrupar el
//     MENSAJE no agrupa el ESTADO: ese se sigue escribiendo por cada
//     `(projectId, env_var)` individual.
//   - T-0 (expirada) se notifica con BACKOFF DIARIO: máximo un recordatorio
//     por día (no en cada tick horario) hasta que el operador rote y commitee
//     `last_rotated`. El piso es 1 alerta/día — nunca "cero para siempre".
//     Se persiste `last_expired_alert` (YYYY-MM-DD) para el backoff.
//   - Filas marcadas como OAuth/no-aplicable (`applies:false`, ej: Anthropic
//     con OAuth Max) se excluyen del cron: no se evalúan thresholds y se deja
//     rastro en el log (metadata-only). No generan recordatorio nunca.
//   - Si después de un commit con `last_rotated` actualizado, el cron
//     detecta que `expires_at` saltó adelante y los thresholds previos ya
//     no aplican, RESETEA el estado para esa env_var (nuevo ciclo).
// =============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// #5901 — punto ÚNICO de identidad de proyecto. El slug se usa como CLAVE del
// estado persistido, así que la validación no es cosmética: `state[projectId]`
// con `constructor` o `__proto__` es prototype pollution.
const { isSafeProjectId, KERNEL_PROJECT_ID, projectLabel } = require('./safe-project-id');

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

// Raiz externa del estado operativo del pipeline. Espeja la del store canonico
// de credenciales (`lib/credentials.js`: `~/.claude/secrets/`) por la misma
// razon: lo que vive dentro del arbol del repo se pierde en cada respawn
// (`reset --hard`) y, en un repo PUBLICO, se publica.
const EXTERNAL_STATE_DIR = path.join(os.homedir(), '.claude', 'pipeline-state');

// Forma logica para los mensajes al operador: nombrar el path resuelto expone
// el home del host y no le sirve a nadie.
const EXTERNAL_STATE_FILE_LOGICO = '~/.claude/pipeline-state/credential-reminder-state.json';

/**
 * Path canonico del archivo de estado (idempotencia entre restarts).
 *
 * #5901 · REQ-SEC-1 — FUERA del arbol del repo. El parametro `pipelineDir` se
 * conserva en la firma (los call-sites lo pasan) pero YA NO participa del
 * calculo: el estado no depende de donde este el checkout. Sacarlo de la firma
 * romperia a los callers sin ganar nada.
 */
function defaultStateFilePath(_pipelineDir) {
  return path.join(EXTERNAL_STATE_DIR, 'credential-reminder-state.json');
}

/**
 * Path LEGACY dentro del repo. Se conserva SOLO para poder detectar y migrar
 * (descartando, ver `migrateLegacyState`) el estado viejo. Nunca se escribe.
 */
function legacyStateFilePath(pipelineDir) {
  return path.join(pipelineDir || '.', 'credential-reminder-state.json');
}

// ---------------------------------------------------------------------------
// Estado ANIDADO por `(projectId, env_var)` — #5901 · CA-5 + REQ-SEC-2.
//
// La clave es ESTRUCTURADA (`state[projectId][envVar]`), nunca concatenada
// (`state[`${projectId}:${envVar}`]`): un slug que contenga el separador
// colisionaria con otro par distinto, y la colision es exactamente el bug que
// este issue viene a cerrar, disimulado un nivel mas abajo.
//
// Los contenedores se crean con `Object.create(null)`: sin prototipo no hay
// superficie de pollution aunque un slug se cuele por la validacion.
// ---------------------------------------------------------------------------

function readSlot(state, projectId, envVar) {
  if (!state || typeof state !== 'object') return undefined;
  if (!Object.prototype.hasOwnProperty.call(state, projectId)) return undefined;
  const byProject = state[projectId];
  if (!byProject || typeof byProject !== 'object') return undefined;
  if (!Object.prototype.hasOwnProperty.call(byProject, envVar)) return undefined;
  return byProject[envVar];
}

function writeSlot(state, projectId, envVar, slot) {
  if (!isSafeProjectId(projectId)) {
    throw new Error(
      `[rotation-cron] projectId invalido '${String(projectId)}' — no se escribe estado. `
      + 'Debe cumplir ^[a-z0-9][a-z0-9-]{1,63}$ y no ser un nombre reservado de prototipo. '
      + 'Accion: corregir la columna `project_id` de docs/secrets-inventory.md.'
    );
  }
  if (!Object.prototype.hasOwnProperty.call(state, projectId)
      || !state[projectId] || typeof state[projectId] !== 'object') {
    state[projectId] = Object.create(null);
  }
  state[projectId][envVar] = slot;
  return slot;
}

/**
 * Migracion FAIL-SAFE del estado legacy plano (#5901 · CA-7 / REQ-SEC-3).
 *
 * El estado persistido hasta este issue era `{ "<ENV_VAR>": { ... } }` — un
 * nivel, sin proyecto. Heredarlo a todos los proyectos SILENCIARIA secretos
 * realmente vencidos, que es justo lo que `shouldNotifyEntry` prohibe en su
 * propia doc ("estado corrupto/ausente => fail-safe = notificar, nunca
 * degradar a nunca"). Por eso se DESCARTA y se deja rastro.
 *
 * Consecuencia asumida y acotada: un tick de recordatorios repetidos, UNA sola
 * vez. Nunca silencio.
 *
 * @returns {{state: object, migrated: boolean, discarded: number}}
 */
function migrateLegacyState(raw) {
  const vacio = () => Object.create(null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { state: vacio(), migrated: false, discarded: 0 };
  }
  // Shape legacy: al menos un valor de PRIMER nivel con campos de slot.
  const CAMPOS_DE_SLOT = ['thresholds_sent', 'last_rotated', 'last_expired_alert', 'last_metadata_alert'];
  let planas = 0;
  for (const clave of Object.keys(raw)) {
    const v = raw[clave];
    if (v && typeof v === 'object' && CAMPOS_DE_SLOT.some((c) => Object.prototype.hasOwnProperty.call(v, c))) {
      planas += 1;
    }
  }
  if (planas > 0) {
    return { state: vacio(), migrated: true, discarded: planas };
  }
  // Shape ya anidado: se adopta tal cual, filtrando slugs que no validen (un
  // estado manipulado no puede sembrar claves peligrosas en el objeto vivo).
  const limpio = vacio();
  for (const projectId of Object.keys(raw)) {
    if (!isSafeProjectId(projectId)) continue;
    const byProject = raw[projectId];
    if (!byProject || typeof byProject !== 'object') continue;
    const destino = vacio();
    for (const envVar of Object.keys(byProject)) destino[envVar] = byProject[envVar];
    limpio[projectId] = destino;
  }
  return { state: limpio, migrated: false, discarded: 0 };
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
 *   { project_id, provider, env_var, owner, last_rotated (Date|null),
 *     expires_at (Date|null), runbook_url, source_line }
 *
 * #5901 * GURU-2 - `project_id` es columna OBLIGATORIA. Celda ausente, vacia o
 * que no pasa `isSafeProjectId` => la fila se emite con `applies:false` y
 * `exclusion_reason` (mismo camino de exclusion-con-rastro que ya se usa para
 * OAuth) y ademas se acumula en `errors[]` de `runRotationTick`. **Prohibido
 * defaultear a `kernel`**: eso reintroduce el casillero compartido que el issue
 * viene a eliminar, disimulado bajo un nivel de anidamiento.
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

    // #5901 - eje de proyecto. Se resuelve ANTES que cualquier otra
    // clasificacion: una fila sin proyecto no puede indexar estado ni nombrar
    // un destinatario, asi que no llega a evaluarse por thresholds.
    const projectIdCrudo = stripBackticks((row.project_id || '').trim());
    if (!isSafeProjectId(projectIdCrudo)) {
      rows.push({
        project_id: null,
        project_id_raw: projectIdCrudo || null,
        provider: row.provider,
        env_var: stripBackticks(row.env_var),
        owner: row.owner,
        applies: false,
        exclusion_reason: 'project_id ausente o invalido',
        invalid_project_id: true,
        source_line: i + 1,
      });
      continue;
    }
    // Exclusión OAuth explícita (fail-safe, con rastro): si `last_rotated` o
    // `expires_at` matchean el sentinel `/oauth/i` (ej: `N/A (OAuth Max)`), la
    // credencial NO se autentica con API key rotable en este entorno. En vez de
    // descartarla en silencio (como hace el skip genérico por no-ISO abajo), la
    // emitimos con `applies:false` para que el evaluador la excluya CON LOG.
    const classification = `${row.last_rotated || ''} ${row.expires_at || ''}`;
    const noAplica = /N\/A\s*\(([^)]+)\)/i.exec(classification);
    const oauthMarked = /oauth/i.test(classification);
    if (noAplica || oauthMarked) {
      rows.push({
        project_id: projectIdCrudo,
        provider: row.provider,
        env_var: stripBackticks(row.env_var),
        owner: row.owner,
        applies: false,
        exclusion_reason: noAplica ? noAplica[1] : 'OAuth',
        source_line: i + 1,
      });
      continue;
    }
    // Una credencial real sin fechas no desaparece del control: queda marcada
    // para recordar diariamente que falta completar su metadata de rotación.
    const lr = parseISODate(row.last_rotated);
    if (!lr && /pendiente\s+(?:registrar|alta)/i.test(row.last_rotated || '')) {
      rows.push({
        project_id: projectIdCrudo,
        provider: row.provider,
        env_var: stripBackticks(row.env_var),
        owner: row.owner,
        metadata_missing: true,
        account_id: row.account_id,
        runbook_url: extractMarkdownLinkUrl(row.rotation_runbook_url),
        source_line: i + 1,
      });
      continue;
    }
    if (!lr) continue;
    const er = row.expires_at ? parseISODate(row.expires_at) : null;
    rows.push({
      project_id: projectIdCrudo,
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
 *   - Si threshold es T-0 (expirada) → notifica con **backoff diario**: máximo
 *     un recordatorio por día (piso, nunca "cero para siempre"). Si ya se avisó
 *     hoy (`last_expired_alert === today`) → silencio hasta el próximo día.
 *   - Si la entrada no existe en `state` → notifica.
 *   - Si `last_rotated` saltó adelante (ej: el operador rotó y commiteó),
 *     el estado del ciclo previo se considera obsoleto y se resetea
 *     (los thresholds vuelven a poder dispararse para el nuevo ciclo).
 *
 * **Requiere `now`** para calcular el día del backoff diario de expiradas.
 */
function shouldNotifyEntry(entry, threshold, state, now) {
  if (!threshold) return { shouldNotify: false, reason: 'fuera de ventana' };

  // #5901 * CA-5 - el casillero se lee por el PAR `(projectId, env_var)`, con
  // clave estructurada. Antes era `state[entry.env_var]`: dos productos con la
  // misma variable compartian slot y rotar la de uno marcaba como rotada la del
  // otro, que quedaba vencida sin aviso.
  const envState = readSlot(state, entry.project_id, entry.env_var);

  // Reset del estado si last_rotated cambió (nuevo ciclo).
  if (envState && envState.last_rotated !== entry.last_rotated.toISOString().slice(0, 10)) {
    return {
      shouldNotify: true,
      reason: 'last_rotated cambió — nuevo ciclo, reset de thresholds',
      resetState: true,
    };
  }

  // T-0 (expirada): backoff diario. Máximo un recordatorio por día hasta rotar.
  // Estado corrupto/ausente → fail-safe = notificar (nunca degradar a "nunca").
  if (threshold.expired) {
    const today = now && typeof now.toISOString === 'function'
      ? now.toISOString().slice(0, 10)
      : null;
    if (today && envState && envState.last_expired_alert === today) {
      return { shouldNotify: false, reason: 'expirada — ya alertado hoy (backoff diario)' };
    }
    return { shouldNotify: true, reason: 'expirada — recordatorio diario' };
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
    // #5901 * UX-1 - `Proyecto` es el PRIMER campo: con varios productos, saber
    // de cual es la credencial es lo primero que necesita el operador para
    // decidir si le toca. `projectLabel` valida el slug y traduce `kernel`;
    // nunca imprime razon social ni nombre de cliente (UX-3 + UX-5).
    `Proyecto:        ${projectLabel(entry.project_id)}`,
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
  const excluded = [];
  const invalidProjects = [];

  // Copia PROFUNDA del primer nivel sobre contenedores sin prototipo: el shallow
  // `{ ...state }` compartiria los objetos por-proyecto con el caller y una
  // escritura de este tick mutaria el estado que el caller todavia tiene en la
  // mano. Con dos niveles eso deja de ser teorico.
  const nextState = Object.create(null);
  for (const pid of Object.keys(state || {})) {
    const byProject = state[pid];
    if (!byProject || typeof byProject !== 'object') continue;
    const destino = Object.create(null);
    for (const envVar of Object.keys(byProject)) destino[envVar] = byProject[envVar];
    nextState[pid] = destino;
  }

  for (const entry of inventoryRows) {
    // Exclusión OAuth/no-aplicable: no se evalúa threshold, se deja rastro.
    // (fail-safe: SÓLO las filas marcadas explícitamente `applies:false` en el
    // parser — el resto de credenciales reales se sigue evaluando).
    if (entry.applies === false) {
      excluded.push({
        project_id: entry.project_id || null,
        env_var: entry.env_var,
        provider: entry.provider,
        reason: `no aplica (${entry.exclusion_reason || 'OAuth'}) — excluida del cron de rotación`,
      });
      // #5901 · GURU-2 — una fila sin proyecto valido NO desaparece en silencio:
      // el operador la ve en `errors[]` del tick, no sólo en el log de excluidas.
      if (entry.invalid_project_id) {
        invalidProjects.push({
          env_var: entry.env_var,
          provider: entry.provider,
          source_line: entry.source_line,
          raw: entry.project_id_raw || null,
        });
      }
      continue;
    }

    if (entry.metadata_missing === true) {
      const today = now.toISOString().slice(0, 10);
      const previous = readSlot(nextState, entry.project_id, entry.env_var) || {};
      if (previous.last_metadata_alert !== today) {
        alerts.push({
          project_id: entry.project_id,
          env_var: entry.env_var,
          provider: entry.provider,
          threshold: 'METADATA-PENDIENTE',
          daysRemaining: null,
          message: [
            '⚠️ Metadata de rotación pendiente',
            `Proyecto: ${projectLabel(entry.project_id)}`,
            `Provider: ${entry.provider}`,
            `Variable: ${entry.env_var}`,
            `Owner: ${entry.owner}`,
            `Runbook: ${entry.runbook_url || 'no registrado'}`,
          ].join('\n'),
          priority: 'normal',
        });
        writeSlot(nextState, entry.project_id, entry.env_var,
          { ...previous, last_metadata_alert: today });
      }
      continue;
    }

    const threshold = thresholdForEntry(entry, now);
    const decision = shouldNotifyEntry(entry, threshold, nextState, now);

    // Reset del ciclo: si last_rotated cambió, limpiar el slot del PAR.
    if (decision.resetState) {
      writeSlot(nextState, entry.project_id, entry.env_var, {
        last_rotated: entry.last_rotated.toISOString().slice(0, 10),
        thresholds_sent: {},
      });
    }

    if (!decision.shouldNotify) continue;

    const message = buildTelegramMessage(entry, threshold);
    alerts.push({
      project_id: entry.project_id,
      env_var: entry.env_var,
      provider: entry.provider,
      threshold: threshold.key,
      daysRemaining: threshold.daysRemaining,
      message,
      priority: threshold.expired ? 'critical' : 'normal',
    });

    // Persistir el threshold disparado, salvo que sea T-0 (donde no marcamos
    // sent — queremos que vuelva a dispararse en cada tick).
    // #5901 — el ESTADO se sigue escribiendo por cada `(projectId, env_var)`
    // individual. La agrupación de UX-2 es del MENSAJE, no del casillero:
    // agrupar el estado reintroduciría la colisión que este issue cierra.
    // El slot se CLONA antes de mutarlo: `readSlot` devuelve el objeto que el
    // caller todavia tiene en la mano (la copia del estado es de dos niveles,
    // no del contenido del slot). Mutarlo in-place le cambiaria el estado por
    // debajo a quien nos lo paso.
    const slotLeido = readSlot(nextState, entry.project_id, entry.env_var);
    const slotNuevo = slotLeido
      ? { ...slotLeido, thresholds_sent: { ...(slotLeido.thresholds_sent || {}) } }
      : {
        last_rotated: entry.last_rotated.toISOString().slice(0, 10),
        thresholds_sent: {},
      };
    if (!threshold.expired) {
      slotNuevo.last_rotated = entry.last_rotated.toISOString().slice(0, 10);
      slotNuevo.thresholds_sent[threshold.key] = now.toISOString().slice(0, 10);
    } else {
      // Expirada: actualizar last_seen para audit trail, no thresholds_sent.
      slotNuevo.last_expired_alert = now.toISOString().slice(0, 10);
    }
    writeSlot(nextState, entry.project_id, entry.env_var, slotNuevo);
  }
  return { alerts, nextState, excluded, invalidProjects };
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

  // 3. Leer estado persistido (best-effort) + migración fail-safe del legacy.
  let raw = null;
  try {
    if (fsImpl.existsSync(statePath)) {
      raw = JSON.parse(fsImpl.readFileSync(statePath, 'utf8'));
    }
  } catch (err) {
    log(`[rotation-cron] estado corrupto (${err.message}), reseteando`);
    raw = null;
  }

  // #5901 · CA-7 — el estado plano `{ "<ENV_VAR>": {...} }` de antes de este
  // issue se DESCARTA (nunca se hereda a todos los proyectos: eso silenciaría
  // secretos realmente vencidos) y dispara recordatorio, con rastro en el log y
  // en `errors[]`. Un tick de recordatorios repetidos, una sola vez.
  // #5901 · CA-7 (segunda mitad) — el estado legacy no sólo cambió de SHAPE:
  // cambió de UBICACIÓN. Un archivo que sigue dentro del árbol del repo ya no
  // se lee, y dejar de leerlo en silencio es la misma falla que heredarlo. Se
  // avisa una vez por tick con la acción concreta.
  try {
    const legacyPath = legacyStateFilePath(pipelineDir);
    if (legacyPath !== statePath && fsImpl.existsSync(legacyPath)) {
      const msg = `estado legacy detectado DENTRO del repo (${legacyPath}) — ya no se lee: `
        + `el estado vive en ${EXTERNAL_STATE_FILE_LOGICO}. Acción: borrar el archivo del repo.`;
      log(`[rotation-cron] ${msg}`);
      result.errors.push({ stage: 'legacy-state-path', message: msg });
    }
  } catch { /* best-effort: un fsImpl de test sin existsSync no rompe el tick */ }

  const migracion = migrateLegacyState(raw);
  const state = migracion.state;
  if (migracion.migrated) {
    const msg = `estado legacy plano descartado (${migracion.discarded} entradas) - se re-evaluan thresholds`;
    log(`[rotation-cron] ${msg}`);
    result.errors.push({ stage: 'migrate-state', message: msg });
    result.legacyStateDiscarded = migracion.discarded;
  }

  // 4. Evaluar.
  const { alerts, nextState, excluded, invalidProjects } =
    evaluateRotationState({ now, inventoryRows: rows, state });
  result.alerts = alerts;
  result.excluded = excluded || [];

  // 4a. #5901 · GURU-2 — filas sin `project_id` valido: el operador las ve en
  //     `errors[]`, no sólo en el log de excluidas. Ninguna fila desaparece en
  //     silencio y ninguna alerta se emite sin proyecto resuelto.
  for (const inv of (invalidProjects || [])) {
    const msg = `fila ${inv.source_line} (${inv.provider}: ${inv.env_var}) sin project_id valido`
      + ' - agregar la columna `project_id` en docs/secrets-inventory.md';
    result.errors.push({ stage: 'parse-inventory', env_var: inv.env_var, message: msg });
    log(`[rotation-cron] ${msg}`);
  }

  // 4b. Loguear filas excluidas por OAuth (metadata-only, nunca el secret).
  //     Deja rastro de POR QUÉ no se evaluó (requisito A05/A09 de security).
  for (const ex of result.excluded) {
    log(`[rotation-cron] skip ${ex.env_var} — ${ex.reason}`);
  }

  // 5. Enviar alertas (best-effort por alerta — un fallo no bloquea las demás).
  // Consolidar por threshold antes de enviar. Completar el inventario puede
  // hacer coincidir varias credenciales el mismo dia; un mensaje por fila
  // convertiria el recordatorio operativo en spam (UX-7 de #5340).
  // #5901 — DOS niveles de agrupación, en este orden:
  //   1. por `(env_var, threshold)` con la lista de proyectos (CA-10 / UX-2),
  //   2. por threshold (UX-7 de #5340, que sigue vigente: varias credenciales
  //      distintas cruzando el mismo threshold no son N mensajes).
  // Invertir el orden perdería el eje de proyecto en el consolidado.
  const outboundAlerts = consolidateAlertsByThreshold(
    groupAlertsByEnvVarAndThreshold(alerts),
  );
  result.notifications = outboundAlerts;
  for (const alert of outboundAlerts) {
    if (typeof sender !== 'function') continue;
    try {
      sender(alert.message);
      log(`[rotation-cron] alerta enviada: ${alert.env_var} ${alert.threshold} (${alert.daysRemaining}d)`);
    } catch (err) {
      result.errors.push({ stage: 'send-telegram', env_var: alert.env_var, message: err.message });
      log(`[rotation-cron] sendTelegram falló para ${alert.env_var}: ${err.message}`);
    }
  }

  // 6. Persistir estado. El directorio vive FUERA del repo, así que puede no
  //    existir en un host recién provisionado: se crea antes de escribir.
  try {
    const dir = path.dirname(statePath);
    if (typeof fsImpl.mkdirSync === 'function' && !fsImpl.existsSync(dir)) {
      fsImpl.mkdirSync(dir, { recursive: true });
    }
    fsImpl.writeFileSync(statePath, JSON.stringify(nextState, null, 2));
  } catch (err) {
    result.errors.push({ stage: 'persist-state', message: err.message });
    log(`[rotation-cron] no se pudo persistir estado: ${err.message}`);
  }

  return result;
}

/**
 * #5901 · CA-10 / UX-2 — agrupa las alertas por `(env_var, threshold)` y emite
 * UNA sola que LISTA los proyectos afectados.
 *
 * Motivo: con N productos usando la misma variable, N mensajes idénticos salvo
 * el nombre del proyecto no le dicen al operador nada que un mensaje con la
 * lista no diga mejor. La invariante G-5 pasa de "un mensaje por tick por
 * entry" a "un mensaje por `(env_var, threshold)` por tick".
 *
 * **Agrupar el MENSAJE no agrupa el ESTADO**: `evaluateRotationState` ya
 * escribió un slot por cada `(projectId, env_var)` antes de que esto corra.
 *
 * La clave del `Map` es interna al proceso (nunca clave de objeto ni de estado
 * persistido), así que la concatenación acá es inocua — la prohibición de
 * REQ-SEC-2 aplica a la clave del ESTADO, que es estructurada.
 */
function groupAlertsByEnvVarAndThreshold(alerts) {
  const grupos = new Map();
  for (const alert of Array.isArray(alerts) ? alerts : []) {
    const clave = `${alert.threshold || 'SIN-THRESHOLD'}\u0000${alert.env_var}`;
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(alert);
  }
  return [...grupos.values()].map((grupo) => {
    const proyectos = [...new Set(grupo.map((a) => a.project_id).filter(Boolean))].sort();
    if (grupo.length === 1) return { ...grupo[0], projects: proyectos };
    const primera = grupo[0];
    const etiquetas = proyectos.map((pid) => projectLabel(pid));
    return {
      ...primera,
      // `project_id` deja de ser un escalar representativo cuando el grupo
      // tiene varios: se anula a propósito para que nadie lo lea como "el"
      // proyecto de la alerta. La lista autoritativa es `projects`.
      project_id: null,
      projects: proyectos,
      message: [
        primera.message,
        '',
        `Proyectos afectados (${proyectos.length}): ${etiquetas.join(', ')}`,
      ].join('\n'),
    };
  });
}

function consolidateAlertsByThreshold(alerts) {
  const groups = new Map();
  for (const alert of Array.isArray(alerts) ? alerts : []) {
    const key = alert.threshold || 'SIN-THRESHOLD';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(alert);
  }
  return [...groups.values()].map((group) => {
    if (group.length === 1) return group[0];
    const first = group[0];
    // #5901 — cada línea nombra el/los proyecto(s) de esa credencial: sin eso,
    // el mensaje consolidado perdería el eje que este issue viene a agregar.
    const etiquetaProyectos = (alert) => {
      const pids = Array.isArray(alert.projects) && alert.projects.length
        ? alert.projects
        : (alert.project_id ? [alert.project_id] : []);
      return pids.length ? ` [${pids.map((pid) => projectLabel(pid)).join(', ')}]` : '';
    };
    return {
      ...first,
      env_var: group.map((alert) => alert.env_var).join(','),
      project_id: null,
      projects: [...new Set(group.flatMap((alert) => (
        Array.isArray(alert.projects) && alert.projects.length
          ? alert.projects
          : (alert.project_id ? [alert.project_id] : [])
      )))].sort(),
      message: [
        `⚠️ Recordatorios de rotación ${first.threshold}`,
        `${group.length} credenciales requieren atención:`,
        ...group.map((alert) => `- ${alert.provider}: ${alert.env_var}${etiquetaProyectos(alert)}`),
        'Revisar fechas, owners y runbooks en docs/secrets-inventory.md.',
      ].join('\n'),
    };
  });
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
  consolidateAlertsByThreshold,
  // #5901 - eje `(projectId, env_var)`.
  groupAlertsByEnvVarAndThreshold,
  migrateLegacyState,
  readSlot,
  writeSlot,
  // Helpers.
  defaultInventoryPath,
  defaultStateFilePath,
  legacyStateFilePath,
  EXTERNAL_STATE_DIR,
  EXTERNAL_STATE_FILE_LOGICO,
  KERNEL_PROJECT_ID,
};
