// =============================================================================
// disk-guard.js — Guardián automático de espacio en disco (#6708).
//
// Por qué existe
// --------------
// El disco de la máquina se llenaba cada 2-3 semanas hasta dejar 167 MB libres
// de 236 GB. Lo grave no es el disco: cuando revienta, el pipeline no dice "me
// quedé sin disco" — dice "el test falló", "el build rompió", "el agente
// murió". Rebota issues sanos como si tuvieran defectos.
//
// #6290 arregló *cómo* se limpia (criterio `merge-base --is-ancestor`,
// `rotate-caches.js`). Este módulo define *cuándo* se limpia solo y quién lo
// decide: un presupuesto con umbrales configurables y una escalera de acciones
// acumulativa, evaluada en cada tick del Pulpo.
//
// La escalera
// -----------
//   green   (> 40 GB)      nada
//   yellow  (25-40 GB)     rotar cachés
//   orange  (12-25 GB)     + reclamar worktrees integrados SIN cap + alerta
//   red     (< 12 GB)      + frenar el despacho de fases pesadas (build/QA)
//
// Es acumulativa a propósito: `red` hace TODO lo de `orange`, que hace todo lo
// de `yellow`. El nivel no elige una acción, elige hasta dónde llega.
//
// Fail-safes duros (nunca configurables)
// --------------------------------------
//   - Un worktree con trabajo en vuelo (fase `trabajando`) no se toca en ningún
//     umbral. Lo garantiza `pipelineHasActiveWork()` en `ghostbusters.js`, que
//     corre ANTES de que un worktree llegue a ser candidato.
//   - `~/.android/avd` (snapshot `qa-ready` del emulador) no se toca. Ningún
//     limpiador de esta cadena lo enumera.
//   - Logs y audios de operación no se podan sin OK del operador.
//   - Si la medición falla, el nivel es `unknown` y NO se ejecuta ninguna
//     acción destructiva. Un guardián ciego no borra.
//
// Contrato con el resto del pipeline
// ----------------------------------
// El módulo es ACCESORIO: nunca tira. Toda función pública devuelve un valor
// utilizable ante cualquier error. Si este módulo se rompe, el Pulpo sigue
// despachando — a lo sumo sin guardián de disco.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DEFAULT_PIPELINE_DIR = path.resolve(__dirname, '..');
const STATE_FILENAME = 'disk-guard-state.json';
const AUDIT_FILENAME = 'disk-guard.jsonl';

const LEVELS = Object.freeze({
  GREEN: 'green',
  YELLOW: 'yellow',
  ORANGE: 'orange',
  RED: 'red',
  UNKNOWN: 'unknown',
});

// Severidad ordinal: sirve para detectar EMPEORAMIENTO (alertar) vs mejora
// (no alertar). `unknown` queda fuera — no es un punto de la escala, es la
// ausencia de medición, y compararlo daría transiciones fantasma.
const SEVERITY = Object.freeze({
  [LEVELS.GREEN]: 0,
  [LEVELS.YELLOW]: 1,
  [LEVELS.ORANGE]: 2,
  [LEVELS.RED]: 3,
});

// Colores del design system del dashboard (mismos que los gauges de CPU/RAM en
// `dashboard.js`). Se centralizan acá para que el indicador de disco no
// invente una paleta propia.
const LEVEL_COLORS = Object.freeze({
  [LEVELS.GREEN]: '#3fb950',
  [LEVELS.YELLOW]: '#d29922',
  [LEVELS.ORANGE]: '#db6d28',
  [LEVELS.RED]: '#f85149',
  [LEVELS.UNKNOWN]: '#8b949e',
});

const LEVEL_EMOJI = Object.freeze({
  [LEVELS.GREEN]: '🟢',
  [LEVELS.YELLOW]: '🟡',
  [LEVELS.ORANGE]: '🟠',
  [LEVELS.RED]: '🔴',
  [LEVELS.UNKNOWN]: '⚪',
});

// #6708 (rebote rev-1) — Etiqueta TEXTUAL del escalón. El color y el emoji
// solos no dicen qué escalón del presupuesto está vigente: el operador ve un
// punto naranja y no sabe si eso significa "rotar cachés" o "despacho frenado".
// La etiqueta se muestra como TEXTO junto al valor (no sólo en el tooltip,
// que no existe en táctil ni lo lee un lector de pantalla al vuelo).
//
// Esta constante es la ÚNICA fuente del rótulo: el header pill, la system card
// y las alertas de Telegram la espejan. Si se agrega un escalón a LEVELS hay
// que agregarlo acá también — `levelLabel()` degrada a 'SIN DATO', nunca
// devuelve undefined ni imprime el nombre interno en inglés en la UI.
const LEVEL_LABELS = Object.freeze({
  [LEVELS.GREEN]: 'NORMAL',
  [LEVELS.YELLOW]: 'ATENCIÓN',
  [LEVELS.ORANGE]: 'ALERTA',
  [LEVELS.RED]: 'CRÍTICO',
  [LEVELS.UNKNOWN]: 'SIN DATO',
});

// levelLabel(level) — rótulo textual del escalón, fail-safe.
// Nunca devuelve undefined: un nivel desconocido (JSON de estado editado a
// mano, escalón futuro) cae a 'SIN DATO' en vez de romper el render o filtrar
// el identificador interno a la pantalla.
function levelLabel(level) {
  return LEVEL_LABELS[level] || LEVEL_LABELS[LEVELS.UNKNOWN];
}

// Propuesta inicial del issue #6708. Editables en `config.yaml` → `disk_budget`.
const DEFAULT_BUDGET = Object.freeze({
  enabled: true,
  green_gb: 40,
  yellow_gb: 25,
  orange_gb: 12,
  // Histéresis para salir del congelamiento de fases pesadas. Sin esto, un
  // disco oscilando alrededor de `orange_gb` prende y apaga el freno en ticks
  // consecutivos y el despacho queda intermitente.
  hysteresis_gb: 2,
  rotate_throttle_min: 60,
  reclaim_throttle_min: 60,
  alert_cooldown_min: 120,
  freeze_heavy_phases: true,
  // Si una corrida libera más que esto, se avisa aunque no haya cambio de
  // nivel: "sin borrado silencioso de cosas grandes".
  alert_freed_gb: 5,
});

// Clamps de seguridad, con el mismo criterio que `ghostbusters_cron`: un valor
// inválido no debe poder desarmar el guardián ni convertirlo en un borrador
// compulsivo.
const CLAMPS = Object.freeze({
  green_gb: [5, 500],
  yellow_gb: [3, 400],
  orange_gb: [1, 300],
  hysteresis_gb: [0, 50],
  rotate_throttle_min: [5, 24 * 60],
  reclaim_throttle_min: [5, 24 * 60],
  alert_cooldown_min: [5, 24 * 60],
  alert_freed_gb: [0.1, 500],
});

// Fases del pipeline que se frenan en `red`. Son las que consumen disco a
// puñados: `build` corre Gradle (artefactos + daemons) y `verificacion` graba
// video de QA y levanta el emulador.
const HEAVY_PHASES = Object.freeze(['build', 'verificacion']);
// Espejo por skill, para call sites que sólo conocen el skill.
const HEAVY_SKILLS = Object.freeze(['build', 'builder', 'qa']);

// -----------------------------------------------------------------------------
// Presupuesto
// -----------------------------------------------------------------------------

function clamp(value, [min, max], fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * Normaliza el bloque `disk_budget` de config.yaml.
 *
 * Reglas:
 *   - Cada campo se clampea a su rango; un valor no numérico usa el default.
 *   - Los umbrales DEBEN ser estrictamente descendientes (green > yellow >
 *     orange). Si no lo son, se descarta la terna entera y se vuelve a los
 *     defaults: corregir sólo el campo ofensor produciría un presupuesto que el
 *     operador no escribió y en el que no puede confiar.
 *
 * Devuelve `{...budget, invalid: string[]}` — `invalid` lista los motivos, para
 * que el caller pueda loguearlos en vez de silenciar la config rota.
 */
function normalizeBudget(raw) {
  const cfg = (raw && typeof raw === 'object') ? raw : {};
  const invalid = [];
  const out = {
    enabled: cfg.enabled !== false,
    freeze_heavy_phases: cfg.freeze_heavy_phases !== false,
  };
  for (const key of Object.keys(CLAMPS)) {
    const fallback = DEFAULT_BUDGET[key];
    if (cfg[key] !== undefined && !Number.isFinite(Number(cfg[key]))) {
      invalid.push(`${key}=${JSON.stringify(cfg[key])} no es numérico`);
    }
    const value = clamp(cfg[key] === undefined ? fallback : cfg[key], CLAMPS[key], fallback);
    if (cfg[key] !== undefined && Number.isFinite(Number(cfg[key])) && value !== Number(cfg[key])) {
      invalid.push(`${key}=${cfg[key]} clampeado a ${value}`);
    }
    out[key] = value;
  }
  if (!(out.green_gb > out.yellow_gb && out.yellow_gb > out.orange_gb)) {
    invalid.push(
      `umbrales no descendientes (green=${out.green_gb} yellow=${out.yellow_gb} orange=${out.orange_gb}) — se usan los defaults`
    );
    out.green_gb = DEFAULT_BUDGET.green_gb;
    out.yellow_gb = DEFAULT_BUDGET.yellow_gb;
    out.orange_gb = DEFAULT_BUDGET.orange_gb;
  }
  out.invalid = invalid;
  return out;
}

/**
 * Convierte una lectura a GB numéricos, o `NaN` si no es una medición válida.
 *
 * Deliberadamente estricto con el TIPO: `Number(null)` y `Number('')` dan 0, y
 * un 0 acá se clasificaría como `red` — el guardián dispararía la escalera
 * entera (borrado de worktrees incluido) porque alguien pasó un null. La
 * ausencia de medición tiene que ser distinguible de un disco lleno.
 */
function toFreeGb(value) {
  if (typeof value !== 'number') return NaN;
  if (!Number.isFinite(value) || value < 0) return NaN;
  return value;
}

/**
 * Clasifica el espacio libre en un nivel del presupuesto.
 *
 * Los intervalos son `(umbral, umbral_superior]`: con exactamente 25 GB y
 * `yellow_gb: 25` el nivel es `orange`, no `yellow`. El umbral marca el piso
 * del nivel de arriba, así que tocarlo ya es estar abajo.
 */
function classify(freeGb, budget) {
  const b = budget && budget.green_gb !== undefined ? budget : normalizeBudget(budget);
  const n = toFreeGb(freeGb);
  if (!Number.isFinite(n)) return LEVELS.UNKNOWN;
  if (n > b.green_gb) return LEVELS.GREEN;
  if (n > b.yellow_gb) return LEVELS.YELLOW;
  if (n > b.orange_gb) return LEVELS.ORANGE;
  return LEVELS.RED;
}

/**
 * Acciones habilitadas por un nivel. Acumulativa: cada escalón agrega, no
 * reemplaza. `unknown` no habilita nada (guardián ciego no borra).
 */
function actionsFor(level, budget) {
  const b = budget || DEFAULT_BUDGET;
  const sev = SEVERITY[level];
  if (sev === undefined) {
    return { rotateCaches: false, reclaimWorktrees: false, freezeHeavyPhases: false };
  }
  return {
    rotateCaches: sev >= SEVERITY[LEVELS.YELLOW],
    reclaimWorktrees: sev >= SEVERITY[LEVELS.ORANGE],
    freezeHeavyPhases: sev >= SEVERITY[LEVELS.RED] && b.freeze_heavy_phases !== false,
  };
}

// -----------------------------------------------------------------------------
// Medición
// -----------------------------------------------------------------------------

const BYTES_PER_GB = 1024 ** 3;

/**
 * Bytes libres del volumen. `fsutil volume diskfree` es el camino barato
 * (~20ms); `Get-PSDrive` levanta PowerShell y cuesta ~600ms, así que sólo se
 * usa de fallback.
 *
 * Devuelve `NaN` si no se pudo medir — nunca 0, que sería indistinguible de un
 * disco realmente lleno y dispararía la escalera entera por un error de
 * herramienta.
 */
function measureFreeBytes({ execImpl = execSync, drive = 'C:' } = {}) {
  try {
    const out = execImpl(`fsutil volume diskfree ${drive}`, {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
    });
    const m = /:\s+([\d.,]+)/.exec(String(out).split('\n')[0]);
    if (m) {
      const n = Number(m[1].replace(/[.,]/g, ''));
      if (Number.isFinite(n) && n >= 0) return n;
    }
  } catch { /* fallback abajo */ }
  try {
    const out = execImpl(
      `powershell -NoProfile -Command "(Get-PSDrive ${String(drive).replace(':', '')}).Free"`,
      { encoding: 'utf8', timeout: 15000, windowsHide: true }
    );
    const n = parseInt(String(out).trim(), 10);
    if (Number.isFinite(n) && n >= 0) return n;
  } catch { /* sin medición */ }
  return NaN;
}

function measureFreeGb(opts) {
  const bytes = measureFreeBytes(opts);
  return Number.isFinite(bytes) ? bytes / BYTES_PER_GB : NaN;
}

/**
 * Tamaño TOTAL del volumen, en bytes. Sólo lo necesita el dashboard para
 * dibujar el porcentaje ocupado; las decisiones del guardián se toman siempre
 * sobre GB libres absolutos, nunca sobre el porcentaje — lo que importa es si
 * entra un build de Gradle, no qué fracción del disco se usó.
 *
 * Devuelve `NaN` si no se pudo medir.
 */
function measureTotalBytes({ execImpl = execSync, drive = 'C:' } = {}) {
  try {
    const out = execImpl(`fsutil volume diskfree ${drive}`, {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
    });
    // Línea 1 = bytes disponibles, línea 2 = bytes totales. Localizado, así que
    // se ancla por POSICIÓN y no por el texto de la etiqueta.
    const m = /:\s+([\d.,]+)/.exec(String(out).split('\n')[1] || '');
    if (m) {
      const n = Number(m[1].replace(/[.,]/g, ''));
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch { /* sin medición */ }
  return NaN;
}

function measureTotalGb(opts) {
  const bytes = measureTotalBytes(opts);
  return Number.isFinite(bytes) ? bytes / BYTES_PER_GB : NaN;
}

// -----------------------------------------------------------------------------
// Estado persistido
// -----------------------------------------------------------------------------

function statePath(pipelineDir) {
  return path.join(pipelineDir || DEFAULT_PIPELINE_DIR, STATE_FILENAME);
}

function auditPath(pipelineDir) {
  return path.join(pipelineDir || DEFAULT_PIPELINE_DIR, 'audit', AUDIT_FILENAME);
}

function emptyState() {
  return {
    level: LEVELS.UNKNOWN,
    free_gb: null,
    total_gb: null,
    measured_at: null,
    frozen: false,
    last_rotate_at: 0,
    last_reclaim_at: 0,
    last_alert_at: 0,
    last_alert_level: null,
    freed_gb_since_alert: 0,
  };
}

/**
 * Lee el estado. Nunca tira: archivo ausente o corrupto ⇒ estado vacío. Un
 * estado ilegible sólo cuesta un throttle de más, no una decisión errónea.
 */
function readState({ pipelineDir, statePath: sp, fsImpl = fs } = {}) {
  const file = sp || statePath(pipelineDir);
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return emptyState();
    return Object.assign(emptyState(), parsed);
  } catch {
    return emptyState();
  }
}

/**
 * Escritura atómica (tmp + rename), como el resto de los módulos de estado del
 * pipeline. Best-effort: devuelve false si no pudo, nunca tira.
 */
function writeState(state, { pipelineDir, statePath: sp, fsImpl = fs } = {}) {
  const file = sp || statePath(pipelineDir);
  try {
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fsImpl.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fsImpl.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Audit JSONL append-only: qué se hizo, cuánto pesó, por qué y cuándo.
 * Mismo patrón que `ghostbusters-worktrees.appendAudit`. Best-effort.
 */
function appendAudit(entry, { pipelineDir, auditFile, fsImpl = fs } = {}) {
  const file = auditFile || auditPath(pipelineDir);
  try {
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    fsImpl.appendFileSync(file, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flag: 'a' });
    return true;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Decisión (pura — sin IO, testeable de punta a punta)
// -----------------------------------------------------------------------------

/**
 * Dado el espacio libre, el presupuesto y el estado previo, decide qué correr
 * en este tick.
 *
 * @returns {{
 *   level: string, freeGb: number|null, color: string, emoji: string,
 *   actions: {rotateCaches: boolean, reclaimWorktrees: boolean, freezeHeavyPhases: boolean},
 *   run: {rotateCaches: boolean, reclaimWorktrees: boolean},
 *   frozen: boolean, alert: {should: boolean, reason: string|null},
 *   nextState: object, budget: object
 * }}
 *
 * `actions` es lo que el nivel HABILITA; `run` es lo que además pasó el
 * throttle y toca ejecutar en este tick. Separarlos importa: el freno de fases
 * pesadas es un estado continuo (se evalúa por `actions`), mientras que rotar
 * cachés es un evento puntual (se dispara por `run`).
 */
function decide({ freeGb, budget, state, now = Date.now(), freedGbThisRun = 0 } = {}) {
  const b = (budget && budget.green_gb !== undefined) ? budget : normalizeBudget(budget);
  const prev = Object.assign(emptyState(), state || {});
  const level = classify(freeGb, b);
  const actions = actionsFor(level, b);
  const measurable = Number.isFinite(toFreeGb(freeGb));

  // Freno de fases pesadas con histéresis. Entra en `red`; sale recién cuando
  // el disco recuperó `orange_gb + hysteresis_gb`. Si no se pudo medir se
  // CONSERVA el estado previo: ni se congela a ciegas ni se descongela a ciegas.
  let frozen;
  if (!measurable) {
    frozen = prev.frozen;
  } else if (actions.freezeHeavyPhases) {
    frozen = true;
  } else if (prev.frozen) {
    frozen = !(freeGb >= b.orange_gb + b.hysteresis_gb);
  } else {
    frozen = false;
  }

  const rotateDue = now - (prev.last_rotate_at || 0) >= b.rotate_throttle_min * 60 * 1000;
  const reclaimDue = now - (prev.last_reclaim_at || 0) >= b.reclaim_throttle_min * 60 * 1000;
  const run = {
    rotateCaches: actions.rotateCaches && rotateDue,
    reclaimWorktrees: actions.reclaimWorktrees && reclaimDue,
  };

  // Alerta: al ENTRAR en orange o red (empeoramiento), con re-alerta por
  // cooldown mientras persiste, y además si se liberó una cantidad grande
  // (nunca borrado silencioso de cosas grandes).
  const prevSev = SEVERITY[prev.level];
  const sev = SEVERITY[level];
  const alertable = sev !== undefined && sev >= SEVERITY[LEVELS.ORANGE];
  const cooldownDue = now - (prev.last_alert_at || 0) >= b.alert_cooldown_min * 60 * 1000;
  let alertReason = null;
  if (alertable && (prevSev === undefined || sev > prevSev)) {
    alertReason = 'escalada';
  } else if (alertable && cooldownDue) {
    alertReason = 'persistencia';
  } else if (Number(freedGbThisRun) >= b.alert_freed_gb) {
    alertReason = 'liberacion-grande';
  }

  const nextState = Object.assign({}, prev, {
    level,
    free_gb: measurable ? Number(freeGb.toFixed(2)) : prev.free_gb,
    measured_at: measurable ? new Date(now).toISOString() : prev.measured_at,
    frozen,
    last_rotate_at: run.rotateCaches ? now : prev.last_rotate_at,
    last_reclaim_at: run.reclaimWorktrees ? now : prev.last_reclaim_at,
    last_alert_at: alertReason ? now : prev.last_alert_at,
    last_alert_level: alertReason ? level : prev.last_alert_level,
  });

  return {
    level,
    freeGb: measurable ? freeGb : null,
    color: LEVEL_COLORS[level],
    emoji: LEVEL_EMOJI[level],
    actions,
    run,
    frozen,
    alert: { should: !!alertReason, reason: alertReason },
    nextState,
    budget: b,
  };
}

// -----------------------------------------------------------------------------
// Gate de despacho
// -----------------------------------------------------------------------------

/**
 * ¿Está frenada esta fase/skill por falta de disco?
 *
 * Lee el estado persistido para que el gate funcione aunque el call site no
 * tenga el snapshot a mano. Fail-open: cualquier error ⇒ NO frena. Un bug acá
 * no puede dejar el pipeline sin despachar.
 */
function isHeavyPhaseFrozen(fase, skill, { pipelineDir, state, statePath: sp } = {}) {
  try {
    const st = state || readState({ pipelineDir, statePath: sp });
    if (!st || !st.frozen) return false;
    const f = String(fase || '').toLowerCase();
    const s = String(skill || '').toLowerCase();
    return HEAVY_PHASES.includes(f) || HEAVY_SKILLS.includes(s);
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Render
// -----------------------------------------------------------------------------

/**
 * Texto de la alerta a Telegram. Sin interpolar nada que venga de afuera: todo
 * son números medidos por este módulo y literales del presupuesto.
 */
function alertText({ level, freeGb, budget, freedGb = 0, frozen = false, reason }) {
  const b = budget || DEFAULT_BUDGET;
  const emoji = LEVEL_EMOJI[level] || '⚪';
  const free = Number.isFinite(Number(freeGb)) ? `${Number(freeGb).toFixed(1)} GB` : 'desconocido';
  const lines = [
    `${emoji} *Disco en ${level}* — ${free} libres`,
    `Presupuesto: verde >${b.green_gb} · amarillo >${b.yellow_gb} · naranja >${b.orange_gb} GB`,
  ];
  if (Number(freedGb) > 0) {
    lines.push(`El guardián liberó ${Number(freedGb).toFixed(1)} GB en esta corrida.`);
  } else {
    lines.push('El guardián ejecutó su escalera de limpieza en background.');
  }
  if (frozen) {
    lines.push('Despacho de `build` y `verificacion` FRENADO hasta recuperar margen.');
  }
  if (reason === 'persistencia') {
    lines.push('_(re-aviso: el umbral sigue cruzado)_');
  }
  return lines.join('\n');
}

module.exports = {
  LEVELS,
  SEVERITY,
  LEVEL_COLORS,
  LEVEL_EMOJI,
  LEVEL_LABELS,
  levelLabel,
  DEFAULT_BUDGET,
  CLAMPS,
  HEAVY_PHASES,
  HEAVY_SKILLS,
  STATE_FILENAME,
  AUDIT_FILENAME,
  toFreeGb,
  normalizeBudget,
  classify,
  actionsFor,
  measureFreeBytes,
  measureFreeGb,
  measureTotalBytes,
  measureTotalGb,
  statePath,
  auditPath,
  emptyState,
  readState,
  writeState,
  appendAudit,
  decide,
  isHeavyPhaseFrozen,
  alertText,
};
