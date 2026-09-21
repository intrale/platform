// =============================================================================
// validate-quota-ceilings.js — Techo de cuota contratada por proveedor (#6559).
//
// Programa "Contabilidad y balanceo de cuota por proveedor" (2 de 10). Este
// módulo es EL HABER del libro contable: declara contra qué se compara el
// consumo real que registra #6558 (`provider-cost.jsonl`, esquema v2).
//
// Dos responsabilidades, ambas PURAS (sin I/O):
//
//   1. `getQuotaCeiling(config, providerId)` — lectura programática del techo
//      declarado en `multi_provider.quota.<provider>` de `config.yaml`. Es la
//      API que consume el cálculo de saldo y ritmo (#6560). Devuelve el bloque
//      normalizado + `tz_offset_min` (la única ancla de zona horaria del
//      pipeline, `QUOTA_TZ_OFFSET_MIN`, la misma de `weekly-quota.js`).
//
//   2. `validateQuotaCeilings(config, agentModels)` — cross-check de boot:
//      todo proveedor ACTIVO en el ruteo tiene que tener techo declarado.
//      "Activo" = `default_provider` ∪ `skills.*.provider` ∪
//      `skills.*.fallbacks[].provider` de `agent-models.json` ∪
//      `multi_provider.order` de `config.yaml` (con alias normalizados), y
//      EXCLUYE a los proveedores sin LLM (`admission.non_llm: true`, hoy sólo
//      `deterministic`): no consumen cuota, exigirles un techo obligaría a
//      declarar uno fantasma para que el pulpo arranque.
//
// Fail-closed (CA-2): un proveedor activo sin techo NO se asume infinito. El
// validador devuelve UN error por proveedor faltante, cada uno con
// `{ path, message, fix }` que NOMBRA al proveedor y dice cómo arreglarlo. El
// llamador (pulpo.js, bloque de boot junto a validate-chains) hace
// `process.exit(2)`.
//
// Qué valida el schema (`config-schema.js`) y qué valida esto:
//   - schema: tipos, enums cerrados (`periodo`, `unidad`), `techo >= 0`, las 5
//     claves requeridas por proveedor declarado, ids de proveedor válidos.
//   - acá: la relación con el RUTEO (activo ⇒ declarado) y los invariantes que
//     cruzan dos campos: `unidad: porcentaje` ⇒ `techo: 100`, y el formato de
//     `reposicion` acorde al `periodo`. También re-chequea las 5 claves para
//     poder correr como CLI sobre cualquier objeto.
//
// Modelo de ventana (decisión de diseño documentada en multi-provider.md §18):
//   se declara UN período por proveedor = la VENTANA LARGA (la que agrega el
//   libro contable por día/semana y la que `provider-quota.js` modela como
//   `kind: 'long'`). La ventana corta (5h de Anthropic, rolling de Codex) la
//   sigue informando el proveedor en `resets_at`; si #6560 necesita declararla,
//   el schema admite crecer a una lista sin romper el modelo plano.
//
// Seguridad (CA-6 de #4407 aplica): los mensajes sólo interpolan ids de
// proveedor, paths y fixes. NUNCA `JSON.stringify(provider)` de agent-models
// (arrastra `credentials_env`) ni valores crudos de config.yaml.
// =============================================================================
'use strict';

const PERIODOS = Object.freeze(['horario', 'diario', 'semanal']);
const UNIDADES = Object.freeze(['tokens', 'mensajes', 'creditos', 'porcentaje']);
const CAMPOS_REQUERIDOS = Object.freeze(['plan', 'periodo', 'techo', 'unidad', 'reposicion']);

// Ids canónicos (los de agent-models.json y de `multi_provider.quota_alert`).
const QUOTA_PROVIDER_IDS = Object.freeze(['anthropic', 'openai-codex', 'antigravity']);

// Alias aceptados en `multi_provider.order` (config-schema.PROVIDER_ENUM).
// `antigravity` no tiene alias (#6861).
const PROVIDER_ALIASES = Object.freeze({
  claude: 'anthropic',
  codex: 'openai-codex',
});

// `reposicion` — formato fijo por período, hora local de `tz_offset_min`.
//   semanal → "dom 21:00"   (día abreviado + HH:MM)
//   diario  → "03:00"       (HH:MM)
//   horario → ":00"         (minuto de corte dentro de la hora)
//   cualquiera → "rolling"  (ventana móvil desde el primer uso: el proveedor
//                            informa el corte en `resets_at`, no hay hora fija)
const ROLLING = 'rolling';
const HHMM = '([01]\\d|2[0-3]):[0-5]\\d';
const REPOSICION_RE = Object.freeze({
  semanal: new RegExp(`^(lun|mar|mie|jue|vie|sab|dom) ${HHMM}$`),
  diario: new RegExp(`^${HHMM}$`),
  horario: new RegExp('^:[0-5]\\d$'),
});
// Patrón único (unión) para el schema ajv: acota el string sin depender del
// período; la coherencia período↔formato se chequea acá.
const REPOSICION_PATTERN = `^(${ROLLING}|(lun|mar|mie|jue|vie|sab|dom) ${HHMM}|${HHMM}|:[0-5]\\d)$`;

const DOC_REF = 'docs/pipeline/multi-provider.md §18';
const CONFIG_REF = '.pipeline/config.yaml';

/**
 * Zona horaria de `reposicion`: la única ancla del pipeline
 * (`QUOTA_TZ_OFFSET_MIN`, default ART = -180), la misma que usa
 * `weekly-quota.js` para el reset semanal. No se duplica en config.yaml a
 * propósito: dos fuentes de verdad de TZ se desincronizan en silencio.
 * @param {object} [env=process.env]
 * @returns {number}
 */
function resolveTzOffsetMin(env = process.env) {
  const n = Number(env && env.QUOTA_TZ_OFFSET_MIN);
  return Number.isFinite(n) && n !== 0 ? n : -180;
}

/**
 * Normaliza un id de proveedor (alias → canónico). Devuelve `null` si no es
 * un string no vacío.
 * @param {*} id
 * @returns {string|null}
 */
function normalizeProviderId(id) {
  if (typeof id !== 'string') return null;
  const t = id.trim();
  if (!t) return null;
  return Object.prototype.hasOwnProperty.call(PROVIDER_ALIASES, t) ? PROVIDER_ALIASES[t] : t;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Proveedores sin LLM (exentos de cuota): `admission.non_llm: true` en
 * agent-models.json. `deterministic` queda exento también por nombre, por si
 * el archivo de pruebas (#7113) no declara `admission`.
 */
function isNonLlmProvider(agentModels, id) {
  if (id === 'deterministic') return true;
  const p = agentModels && isPlainObject(agentModels.providers) ? agentModels.providers[id] : null;
  return !!(p && isPlainObject(p.admission) && p.admission.non_llm === true);
}

/**
 * Conjunto de proveedores ACTIVOS en el ruteo (ids canónicos, orden estable de
 * aparición), excluyendo los sin LLM.
 *
 * @param {object} agentModels - agent-models.json parseado.
 * @param {object} [config] - config.yaml parseado (para `multi_provider.order`).
 * @returns {string[]}
 */
function activeProviders(agentModels, config) {
  const out = [];
  const add = (raw) => {
    const id = normalizeProviderId(raw);
    if (!id || out.includes(id)) return;
    if (isNonLlmProvider(agentModels, id)) return;
    out.push(id);
  };
  if (isPlainObject(agentModels)) {
    add(agentModels.default_provider);
    const skills = isPlainObject(agentModels.skills) ? agentModels.skills : {};
    for (const skill of Object.keys(skills)) {
      const s = skills[skill];
      if (!isPlainObject(s)) continue;
      add(s.provider);
      if (Array.isArray(s.fallbacks)) {
        for (const f of s.fallbacks) if (isPlainObject(f)) add(f.provider);
      }
    }
  }
  const order = config && isPlainObject(config.multi_provider) ? config.multi_provider.order : null;
  if (Array.isArray(order)) for (const o of order) add(o);
  return out;
}

/**
 * Sección `multi_provider.quota` de config.yaml, o `null` si no existe.
 */
function quotaSection(config) {
  const mp = config && isPlainObject(config.multi_provider) ? config.multi_provider : null;
  return mp && isPlainObject(mp.quota) ? mp.quota : null;
}

/**
 * Chequeos semánticos de UN bloque de techo ya localizado. Devuelve la lista de
 * `{ path, message, fix }` (vacía si el bloque es válido).
 */
function validateCeilingBlock(providerId, block) {
  const base = `multi_provider.quota.${providerId}`;
  const errors = [];
  if (!isPlainObject(block)) {
    errors.push({
      path: base,
      message: `proveedor activo sin techo declarado (la clave existe pero no es un bloque)`,
      fix: `declarar plan/periodo/techo/unidad/reposicion bajo ${base} en ${CONFIG_REF} (ver ${DOC_REF})`,
    });
    return errors;
  }
  for (const campo of CAMPOS_REQUERIDOS) {
    const v = block[campo];
    const falta = v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    if (falta) {
      errors.push({
        path: `${base}.${campo}`,
        message: `proveedor "${providerId}" activo con techo incompleto: falta '${campo}'`,
        fix: `agregar '${campo}' bajo ${base} en ${CONFIG_REF} (ver ${DOC_REF})`,
      });
    }
  }
  if (errors.length) return errors;

  if (typeof block.plan !== 'string') {
    errors.push({ path: `${base}.plan`, message: `proveedor "${providerId}": 'plan' debe ser texto`, fix: `ej. plan: "Claude Max" (ver ${DOC_REF})` });
  }
  if (!PERIODOS.includes(block.periodo)) {
    errors.push({ path: `${base}.periodo`, message: `proveedor "${providerId}": 'periodo' fuera del enum [${PERIODOS.join('|')}]`, fix: `usar uno de ${PERIODOS.join('|')} (ver ${DOC_REF})` });
  }
  if (!UNIDADES.includes(block.unidad)) {
    errors.push({ path: `${base}.unidad`, message: `proveedor "${providerId}": 'unidad' fuera del enum [${UNIDADES.join('|')}]`, fix: `usar uno de ${UNIDADES.join('|')} (ver ${DOC_REF})` });
  }
  if (typeof block.techo !== 'number' || !Number.isFinite(block.techo) || block.techo < 0) {
    errors.push({ path: `${base}.techo`, message: `proveedor "${providerId}": 'techo' debe ser un número >= 0`, fix: `declarar la cuota del período en la unidad que expone el proveedor (ver ${DOC_REF})` });
  } else if (block.unidad === 'porcentaje' && block.techo !== 100) {
    errors.push({
      path: `${base}.techo`,
      message: `proveedor "${providerId}": con unidad 'porcentaje' el techo es siempre 100`,
      fix: `poner techo: 100, o cambiar 'unidad' a tokens|mensajes|creditos si el proveedor expone un cupo absoluto (ver ${DOC_REF})`,
    });
  }
  if (typeof block.reposicion !== 'string') {
    errors.push({ path: `${base}.reposicion`, message: `proveedor "${providerId}": 'reposicion' debe ser texto`, fix: `ej. reposicion: "dom 21:00" o "rolling" (ver ${DOC_REF})` });
  } else if (block.reposicion !== ROLLING && PERIODOS.includes(block.periodo)) {
    const re = REPOSICION_RE[block.periodo];
    if (!re.test(block.reposicion)) {
      const ejemplo = block.periodo === 'semanal' ? '"dom 21:00"' : block.periodo === 'diario' ? '"03:00"' : '":00"';
      errors.push({
        path: `${base}.reposicion`,
        message: `proveedor "${providerId}": 'reposicion' no coincide con el formato del periodo '${block.periodo}'`,
        fix: `para periodo ${block.periodo} usar ${ejemplo} (hora local de QUOTA_TZ_OFFSET_MIN) o "rolling" (ver ${DOC_REF})`,
      });
    }
  }
  return errors;
}

/**
 * CA-3 — Lectura programática del techo declarado para un proveedor.
 *
 * @param {object} config - config.yaml parseado.
 * @param {string} providerId - id canónico o alias (`claude`, `codex`).
 * @param {object} [opts]
 * @param {object} [opts.env=process.env] - para `QUOTA_TZ_OFFSET_MIN`.
 * @returns {{provider:string, plan:string, periodo:string, techo:number, unidad:string, reposicion:string, rolling:boolean, tz_offset_min:number}|null}
 *          `null` si el proveedor no tiene techo declarado (el llamador NO debe
 *          asumir infinito: en boot eso es error; en runtime es "sin dato").
 */
function getQuotaCeiling(config, providerId, opts = {}) {
  const id = normalizeProviderId(providerId);
  const q = quotaSection(config);
  if (!id || !q || !isPlainObject(q[id])) return null;
  const b = q[id];
  return Object.freeze({
    provider: id,
    plan: String(b.plan),
    periodo: b.periodo,
    techo: b.techo,
    unidad: b.unidad,
    reposicion: b.reposicion,
    rolling: b.reposicion === ROLLING,
    tz_offset_min: resolveTzOffsetMin(opts.env || process.env),
  });
}

/**
 * Todos los techos declarados, indexados por id canónico.
 * @param {object} config
 * @param {object} [opts]
 * @returns {Object<string, object>}
 */
function listQuotaCeilings(config, opts = {}) {
  const q = quotaSection(config);
  const out = {};
  if (!q) return out;
  for (const id of Object.keys(q)) {
    const c = getQuotaCeiling(config, id, opts);
    if (c) out[c.provider] = c;
  }
  return out;
}

/**
 * Validador PURO del cross-check "proveedor activo ⇒ techo declarado" (CA-2).
 *
 * @param {object} config - config.yaml parseado (ya validado por schema o no).
 * @param {object} agentModels - agent-models.json parseado.
 * @returns {{ ok: boolean, errors: Array<{path:string,message:string,fix:string}>, providers: string[] }}
 *          `providers` = proveedores activos evaluados (ids canónicos).
 */
function validateQuotaCeilings(config, agentModels) {
  const errors = [];
  const providers = activeProviders(agentModels, config);
  const q = quotaSection(config);

  for (const id of providers) {
    if (!q || !Object.prototype.hasOwnProperty.call(q, id)) {
      errors.push({
        path: `multi_provider.quota.${id}`,
        message: `proveedor activo sin techo declarado`,
        fix: `agregá plan/periodo/techo/unidad/reposicion bajo multi_provider.quota.${id} en ${CONFIG_REF} (ver ${DOC_REF})`,
      });
      continue;
    }
    errors.push(...validateCeilingBlock(id, q[id]));
  }

  // Los declarados pero NO activos también se chequean semánticamente: un
  // techo mal formado no debe quedar latente hasta que el proveedor vuelva al
  // ruteo (el schema ya acota tipos; acá van los invariantes cruzados).
  if (q) {
    for (const id of Object.keys(q)) {
      if (providers.includes(id)) continue;
      errors.push(...validateCeilingBlock(id, q[id]));
    }
  }

  return { ok: errors.length === 0, errors, providers };
}

/**
 * Una línea por error, formato coherente con `[validate-chains]`.
 * @param {{path:string,message:string,fix:string}} e
 * @returns {string}
 */
function formatError(e) {
  return `${e.path}: ${e.message} — fix: ${e.fix}`;
}

/**
 * Wrapper CLI standalone: carga `config.yaml` (vía config-resolver, con schema)
 * y `agent-models.json` canónicos y corre el cross-check. Exit 0 si OK; exit 2
 * si hay errores (coherente con validate-chains / EXIT_CODES.INVALID_CONFIG).
 * Paths FIJOS: no se construyen desde argv.
 */
function cliMain() {
  const fs = require('node:fs');
  const path = require('node:path');
  const amv = require('../agent-models-validate');
  const configResolver = require('../config-resolver');
  let config;
  let agentModels;
  try {
    config = configResolver.resolve({ pipelineDir: path.resolve(__dirname, '..', '..'), reload: true });
    agentModels = amv.parseJsonOrJsonc(fs.readFileSync(amv.CANONICAL_JSON_PATH, 'utf8'), amv.CANONICAL_JSON_PATH);
  } catch (err) {
    // El resolver ya redacta sus errores (nunca el snippet crudo del YAML).
    process.stderr.write(`[validate-quota] FATAL no se pudo cargar la configuración: ${err && err.name ? err.name : 'error'}\n`);
    process.exit(1);
    return;
  }
  const result = validateQuotaCeilings(config, agentModels);
  if (result.ok) {
    process.stdout.write(`[validate-quota] Techos validados: ${result.providers.length} proveedores activos (${result.providers.join(', ')}) — ${new Date().toISOString()}\n`);
    process.exit(0);
    return;
  }
  for (const e of result.errors) process.stderr.write(`[validate-quota] ${formatError(e)}\n`);
  process.exit(2);
}

module.exports = {
  PERIODOS,
  UNIDADES,
  CAMPOS_REQUERIDOS,
  QUOTA_PROVIDER_IDS,
  PROVIDER_ALIASES,
  REPOSICION_PATTERN,
  ROLLING,
  normalizeProviderId,
  resolveTzOffsetMin,
  activeProviders,
  getQuotaCeiling,
  listQuotaCeilings,
  validateQuotaCeilings,
  formatError,
};

if (require.main === module) cliMain();
