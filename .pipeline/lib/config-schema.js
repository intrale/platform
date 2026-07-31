// =============================================================================
// config-schema.js — JSON Schema + validador de config.yaml (#3941)
// =============================================================================
//
// EP5-H4. `config.yaml` (~46KB, >30 módulos) se cargaba sin validar: un typo en
// una clave crítica parsea OK pero produce config errónea silenciosa (ej. un
// umbral de circuit breaker mal escrito → el CB nunca dispara). Este módulo
// valida el objeto ya parseado contra un JSON Schema con `ajv` y devuelve
// errores REDACTADOS (path + tipo esperado, NUNCA el valor crudo — SEC-2).
//
// Estrategia del schema (SEC-4):
//   - LENIENT global: `additionalProperties: true` en la raíz y en cada bloque,
//     para no frenar el boot ante evolución legítima del config (claves nuevas
//     no-críticas pasan sin tocar el schema).
//   - ESTRICTO en claves CRÍTICAS conocidas (control de flujo / seguridad):
//     circuit_breaker, resource_limits (umbrales + priority windows),
//     concurrencia, handoff, pipelines.*.skills_por_fase, multi_provider.order.
//     Un typo que tire una de estas claves la vuelve `required` faltante; un
//     valor del tipo equivocado lo caza la validación de tipo/enum.
//
// SEC-1: este módulo NO toca js-yaml ni su schema de deserialización. Sólo
// valida un objeto ya parseado. La carga segura (safe-by-default v4) es
// responsabilidad de `pulpo.loadConfig`.
//
// El módulo es PURO respecto del FS/red: compila el schema una vez al require y
// expone `validateConfig(obj)`. `ConfigSchemaViolation` se exporta para que el
// clasificador (`lib/error-classifier`) y `pulpo` reconozcan la corrupción.
// =============================================================================
'use strict';

const path = require('node:path');
const Ajv = require('ajv');

// -----------------------------------------------------------------------------
// Error tipado de schema-violation (clasificado como 'corruption')
// -----------------------------------------------------------------------------

class ConfigSchemaViolation extends Error {
    /**
     * @param {string} message - mensaje YA redactado (sin valores crudos).
     * @param {Array<object>} [errors] - errores redactados (path + detail).
     * @param {{archivo?: string, via?: string}} [meta] - #5172: ruta resuelta y
     *        mecanismo de resolución, para que el copy al operador pueda nombrar
     *        el archivo CONCRETO que falló (CA-15 / CA-UX-1). Opcional: los
     *        llamadores previos a #5172 siguen construyendo el error con 2 args.
     */
    constructor(message, errors, meta) {
        super(message);
        this.name = 'ConfigSchemaViolation';
        this.errors = Array.isArray(errors) ? errors : [];
        const m = meta && typeof meta === 'object' ? meta : {};
        this.archivo = m.archivo || null;
        this.via = m.via || null;
        this.causa = 'schema-invalido';
    }
}

// -----------------------------------------------------------------------------
// #5172 · Error tipado de parse-error de config (clasificado como 'corruption')
// -----------------------------------------------------------------------------
//
// SEC-1 / CA-14 — este error expone SÓLO `{ archivo, causa, linea, columna }`.
// NUNCA encadena (`cause`) ni reexpone el error original de `js-yaml`: su
// `.message` incluye el snippet crudo del archivo (y con él, cualquier valor
// con forma de secreto que esté en las líneas adyacentes).
//
// D-G — el `name` es parte del contrato: `lib/error-classifier.js` clasifica por
// lista cerrada de names. Renombrarlo hace que la corrupción de config deje de
// clasificarse como 'corruption' (regresión silenciosa).
//
// NO se setea `err.code`: `error-classifier.classify()` mira `err.code` ANTES
// que `err.name`, y 'ENOENT' está en TRANSIENT_CODES. Un `code: 'ENOENT'` acá
// degradaría la corrupción de config a 'transient'. El código de máquina vive
// en `causa`, que el clasificador no mira.
class ConfigParseViolation extends Error {
    /**
     * @param {string} message - mensaje YA redactado (sin contenido del archivo).
     * @param {{archivo?: string, via?: string, causa?: string,
     *          linea?: number|null, columna?: number|null}} [meta]
     */
    constructor(message, meta) {
        super(message);
        this.name = 'ConfigParseViolation';
        const m = meta && typeof meta === 'object' ? meta : {};
        this.archivo = m.archivo || null;
        this.via = m.via || null;
        this.causa = m.causa || 'config-ilegible';
        this.linea = typeof m.linea === 'number' ? m.linea : null;
        this.columna = typeof m.columna === 'number' ? m.columna : null;
    }
}

// -----------------------------------------------------------------------------
// Providers válidos para multi_provider.order (calidad primero, costo después).
// Acepta tanto los ids cortos como los canónicos usados en agent-models.json.
// -----------------------------------------------------------------------------

const PROVIDER_ENUM = Object.freeze([
    'claude', 'anthropic',
    'codex', 'openai-codex',
    'groq',
    'gemini', 'gemini-google',
    'cerebras',
    'nvidia-nim',
]);

// -----------------------------------------------------------------------------
// JSON Schema (Draft-07 compatible, ajv v8)
// -----------------------------------------------------------------------------

const SCHEMA = {
    type: 'object',
    additionalProperties: true,
    properties: {
        // --- circuit_breaker: umbrales del CB de infra (#2305/#3940) ---------
        circuit_breaker: {
            type: 'object',
            additionalProperties: true,
            required: ['infra_escalate_threshold', 'auto_resume_ok_threshold'],
            properties: {
                infra_escalate_threshold: { type: 'integer', minimum: 1 },
                auto_resume_ok_threshold: { type: 'integer', minimum: 1 },
            },
        },

        // --- resource_limits: umbrales de presión + priority windows ---------
        resource_limits: {
            type: 'object',
            additionalProperties: true,
            required: [
                'green_max_percent',
                'yellow_max_percent',
                'orange_max_percent',
                'red_max_percent',
                'priority_windows_activation_threshold',
                'max_concurrent_devs',
            ],
            properties: {
                green_max_percent: { type: 'integer', minimum: 0, maximum: 100 },
                yellow_max_percent: { type: 'integer', minimum: 0, maximum: 100 },
                orange_max_percent: { type: 'integer', minimum: 0, maximum: 100 },
                red_max_percent: { type: 'integer', minimum: 0, maximum: 100 },
                priority_windows_activation_threshold: { type: 'integer', minimum: 1 },
                priority_windows_safety_timeout_hours: { type: 'number', minimum: 0 },
                max_concurrent_devs: { type: 'integer', minimum: 0 },
            },
        },

        // --- concurrencia: instancias simultáneas por rol (enteros ≥ 0) ------
        concurrencia: {
            type: 'object',
            additionalProperties: { type: 'integer', minimum: 0 },
        },

        // --- handoff: cross-agente (#2993) -----------------------------------
        handoff: {
            type: 'object',
            additionalProperties: true,
            required: ['enabled', 'kill_switch'],
            properties: {
                enabled: { type: 'boolean' },
                kill_switch: { type: 'boolean' },
                max_section_kb: { type: 'integer', minimum: 1 },
                retention_days: { type: 'integer', minimum: 1 },
                inject_in_phases: { type: 'array', items: { type: 'string' } },
            },
        },

        // --- firma_operador: auto-aprobación de firma del operador (#4576) ---
        //     ESTRICTO en claves críticas de seguridad (control de autonomía):
        //     enabled/kill_switch (booleanos), modo (enum), umbrales numéricos
        //     acotados. Un typo que tire una de estas la vuelve `required`
        //     faltante; un valor del tipo/rango equivocado lo caza la validación.
        //     Default seguro = firma humana; el schema NO permite que un valor
        //     corrupto habilite auto-aprobación silenciosamente.
        firma_operador: {
            type: 'object',
            additionalProperties: true,
            required: ['enabled', 'kill_switch', 'modo'],
            properties: {
                enabled: { type: 'boolean' },
                kill_switch: { type: 'boolean' },
                modo: { type: 'string', enum: ['disabled', 'dry-run', 'enforce'] },
                umbral_acuerdo_pct: { type: 'number', minimum: 0, maximum: 100 },
                muestras_minimas: { type: 'integer', minimum: 1 },
                decay_dias: { type: 'integer', minimum: 1 },
                auditoria_pct: { type: 'number', minimum: 0, maximum: 100 },
                // go_live_date: ISO date string o null (grandfathering off).
                go_live_date: { type: ['string', 'null'] },
            },
        },

        // --- historico: frontera activo/histórico (#4136) -------------------
        historico: {
            type: 'object',
            additionalProperties: true,
            properties: {
                enabled: { type: 'boolean' },
                max_per_tick: { type: 'integer', minimum: 1 },
                retention_days: { type: 'integer', minimum: 1 },
            },
        },

        // --- pipelines: cada pipeline DEBE declarar skills_por_fase ----------
        pipelines: {
            type: 'object',
            additionalProperties: {
                type: 'object',
                additionalProperties: true,
                required: ['skills_por_fase'],
                properties: {
                    fases: { type: 'array', items: { type: 'string' } },
                    skills_por_fase: {
                        type: 'object',
                        additionalProperties: { type: 'array', items: { type: 'string' } },
                    },
                },
            },
        },

        // --- multi_provider: orden de fallback (opcional en config.yaml; la
        //     fuente de verdad operativa es agent-models.json, pero si aparece
        //     acá se valida estrictamente el enum de providers — SEC-4) -------
        multi_provider: {
            type: 'object',
            additionalProperties: true,
            properties: {
                order: {
                    type: 'array',
                    items: { type: 'string', enum: PROVIDER_ENUM },
                },
                // --- #4402 CA-3 — cadencia configurable del cron de health.
                //     LENIENT (additionalProperties:true): un typo en la CLAVE
                //     se ignora → default 5 min (health-cron.readTickIntervalMs).
                //     El tipo se valida para cazar un valor no-numérico grosero;
                //     el rango real (clamp [1,240] min, piso ≥60s) lo aplica el
                //     cron, no el schema.
                health: {
                    type: 'object',
                    additionalProperties: true,
                    properties: {
                        interval_minutes: { type: 'number', minimum: 0 },
                    },
                },
            },
        },
    },
};

// -----------------------------------------------------------------------------
// Compilación (una sola vez al require)
// -----------------------------------------------------------------------------

// `verbose: false` (default) → los errores de ajv NO incluyen `error.data` (el
// valor crudo). Defensa SEC-2 en la fuente; igual redactamos al construir el
// mensaje. `allErrors: true` para reportar todos los typos de una.
const ajv = new Ajv({ allErrors: true, verbose: false });
const validateFn = ajv.compile(SCHEMA);

// -----------------------------------------------------------------------------
// Redacción de errores (SEC-2): path + tipo esperado, NUNCA el valor crudo
// -----------------------------------------------------------------------------

/**
 * Transforma los errores crudos de ajv en objetos redactados seguros para
 * loguear o mandar por Telegram. Sólo expone:
 *   - `path`: ubicación de la clave (instancePath), NO el valor.
 *   - `keyword`: regla que falló.
 *   - `detail`: descripción del tipo/enum/clave esperado (sin valor crudo).
 *
 * NUNCA incluye el valor que falló. Los nombres de clave (missingProperty /
 * additionalProperty) y los enums permitidos provienen del SCHEMA, no del
 * input, por lo que son seguros de exponer.
 *
 * @param {Array<object>} ajvErrors
 * @returns {Array<{path: string, keyword: string, detail: string}>}
 */
function redactErrors(ajvErrors) {
    if (!Array.isArray(ajvErrors)) return [];
    return ajvErrors.map((e) => {
        const params = e.params || {};
        const path = e.instancePath && e.instancePath.length ? e.instancePath : '(root)';
        let detail;
        switch (e.keyword) {
            case 'type':
                detail = `tipo esperado: ${params.type}`;
                break;
            case 'enum':
                detail = `valor fuera del enum permitido: [${(params.allowedValues || []).join(', ')}]`;
                break;
            case 'required':
                detail = `falta clave requerida: '${params.missingProperty}'`;
                break;
            case 'additionalProperties':
                detail = `clave no permitida: '${params.additionalProperty}'`;
                break;
            case 'minimum':
                detail = `mínimo permitido: ${params.limit}`;
                break;
            case 'maximum':
                detail = `máximo permitido: ${params.limit}`;
                break;
            default:
                // `e.message` de ajv describe la regla (ej. "must be integer"),
                // NO incluye el valor crudo cuando verbose:false.
                detail = e.message || e.keyword;
        }
        return { path, keyword: e.keyword, detail };
    });
}

/**
 * Valida un objeto config ya parseado contra el schema.
 *
 * @param {*} obj
 * @returns {{valid: boolean, errors: Array<{path:string, keyword:string, detail:string}>}}
 */
function validateConfig(obj) {
    // Un config que no es objeto (null, array, string) es corrupción de raíz.
    const valid = validateFn(obj);
    return {
        valid: !!valid,
        errors: valid ? [] : redactErrors(validateFn.errors),
    };
}

/**
 * Formatea errores redactados en una línea legible (para log/Telegram).
 * @param {Array<{path:string, detail:string}>} errors
 * @returns {string}
 */
function formatErrors(errors) {
    if (!Array.isArray(errors) || errors.length === 0) return '';
    return errors.map((e) => `${e.path}: ${e.detail}`).join('; ');
}

// =============================================================================
// #5172 · Redacción de parse-errors de YAML (SEC-1 / CA-14)
// =============================================================================

/**
 * Reduce un error de `js-yaml` a metadata SEGURA: línea y columna.
 *
 * Extraído de `pulpo.js:1288-1294`, donde vivía inline y era el ÚNICO lector de
 * los 28 que redactaba bien. Los otros 27 se tragaban el error en un `catch`
 * mudo; al pasar todos a reportar, ese redactor tiene que ser reusable o la
 * fuga pasa de cero a veintidós call-sites.
 *
 * `e.message` de js-yaml incluye un snippet del archivo:
 *
 *     bad indentation of a mapping entry (3:17)
 *      1 | gate:
 *      2 |   token: SUPER-SECRETO-ABC123      <-- el valor crudo viaja acá
 *      3 |    mal_indentado: x
 *
 * Por eso esta función NO devuelve nada derivado de `e.message`: sólo `e.mark`,
 * que es posición numérica.
 *
 * @param {*} e - error de js-yaml (YAMLException) o cualquier cosa.
 * @returns {{causa: string, linea: number|null, columna: number|null}}
 */
function redactYamlParseError(e) {
    const mark = e && e.mark && typeof e.mark === 'object' ? e.mark : null;
    const linea = mark && typeof mark.line === 'number' ? mark.line + 1 : null;
    const columna = mark && typeof mark.column === 'number' ? mark.column + 1 : null;
    return { causa: 'yaml-invalido', linea, columna };
}

// =============================================================================
// #5172 · Generador ÚNICO del copy al operador (CA-15 / CA-UX-1..CA-UX-6)
// =============================================================================
//
// Las tres superficies (log, Telegram, `configErrorState` del dashboard) y los
// CLIs dicen lo mismo porque el texto se genera UNA SOLA VEZ acá. Prohibido
// re-redactar por superficie: así es como divergen al primer cambio.
//
// Estructura obligatoria: tríada **archivo · causa · acción**, más el mecanismo
// de resolución (`vía`) — sin él el operador puede estar editando un archivo
// distinto del que el proceso enforza (*wrong-file trap*, motivo de CA-15).

/**
 * Tabla `causa` (contrato de máquina) → texto en español (superficie operador).
 * CA-UX-4: `ENOENT` / `not-a-file` / `empty-or-not-a-map` NUNCA se muestran crudos.
 */
const CAUSA_COPY = Object.freeze({
    'ENOENT': {
        texto: 'no encontré el archivo de configuración',
        accion: 'verificá la ruta; si el proceso corre con override, revisá a qué directorio apunta (el «vía» lo dice)',
    },
    'not-a-file': {
        texto: 'la ruta de configuración no es un archivo regular',
        accion: 'apunta a un directorio o a un link roto — corregí la raíz del pipeline',
    },
    'empty-or-not-a-map': {
        texto: 'el archivo está vacío o no es un mapa de claves',
        accion: '¿quedó a medio guardar? restaurá la última versión buena',
    },
    'yaml-invalido': {
        texto: 'YAML inválido',
        accion: 'corregí esa línea (suele ser indentación o dos puntos sueltos)',
    },
    'schema-invalido': {
        texto: 'la configuración no cumple el esquema',
        accion: 'ajustá las claves que lista el detalle',
    },
    'config-ilegible': {
        texto: 'no pude leer la configuración',
        accion: 'revisá el archivo y sus permisos',
    },
});

/**
 * Frases de contexto que se suman a la acción de la tabla. Cada contexto es una
 * promesa distinta sobre qué pasa después; mezclarlas es lo que produce el copy
 * destructivo que CA-UX-3 viene a matar.
 */
const CONTEXTO_ACCION = Object.freeze({
    // Variante A — la pausa la generó ESTA corrupción ⇒ auto-recovery #4832.
    'halt-auto': 'la pausa se levanta sola en el próximo ciclo (~30s) — no hace falta borrar ningún archivo',
    // Variante B — ya había un marker de pausa preexistente que NO se pisó. El
    // auto-recovery sólo levanta markers con source 'config-corruption-halt', así
    // que acá NO se puede prometer que se levante sola.
    'halt-preexistente': 'la pausa activa no la generó esta corrupción, así que no se levanta sola: si reanudás con la configuración todavía inválida, el pipeline se vuelve a pausar',
    // CLI — nada de defaults silenciosos: el resultado sería ficticio.
    'cli': 'volvé a ejecutar. No se aplicaron defaults',
});

/**
 * Devuelve la ruta lista para mostrar: relativa a la raíz del repo si el archivo
 * está adentro, absoluta si está afuera (tmpdirs, overrides). Legible en el caso
 * normal, inequívoca en el raro, y evita volcar layout de filesystem a Telegram.
 *
 * @param {string} archivo - ruta absoluta.
 * @param {string} [repoRoot] - raíz del repo; por defecto la del checkout actual.
 * @returns {string}
 */
function formatConfigPath(archivo, repoRoot) {
    if (!archivo) return '(desconocido)';
    const root = repoRoot || path.resolve(__dirname, '..', '..');
    const rel = path.relative(root, archivo);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return archivo;
    return rel.split(path.sep).join('/');
}

/**
 * Genera el estado de fallo de configuración: la ÚNICA fuente del copy.
 *
 * @param {Error} err - `ConfigParseViolation` o `ConfigSchemaViolation`.
 * @param {{contexto?: string, repoRoot?: string, archivo?: string, via?: string}} [opts]
 *        `contexto` ∈ {'halt-auto','halt-preexistente','cli'}; sin contexto la
 *        acción es sólo la de la tabla de causas (caso dashboard).
 * @returns {{ok: false, archivo: string, via: string, causa: string,
 *            linea: number|null, columna: number|null, detalle: string,
 *            accion: string, ts: string}}
 */
function describeConfigFailure(err, opts = {}) {
    const e = err && typeof err === 'object' ? err : {};
    const causa = CAUSA_COPY[e.causa] ? e.causa : 'config-ilegible';
    const copy = CAUSA_COPY[causa];
    const linea = typeof e.linea === 'number' ? e.linea : null;
    const columna = typeof e.columna === 'number' ? e.columna : null;
    const archivoAbs = opts.archivo || e.archivo || null;
    const via = opts.via || e.via || 'default';

    // `detalle` sale YA redactado: la UI lo renderiza tal cual (CA-UX-5) y no
    // re-deriva copy desde `causa`.
    let detalle = copy.texto;
    if (causa === 'yaml-invalido' && linea !== null) {
        detalle += ` — línea ${linea}` + (columna !== null ? `, col ${columna}` : '');
    } else if (causa === 'schema-invalido') {
        // `formatErrors(redactErrors(...))`: path + regla, nunca el valor crudo.
        const detalleSchema = formatErrors(e.errors) || e.message || '';
        if (detalleSchema) detalle += `: ${detalleSchema}`;
    }

    const extra = CONTEXTO_ACCION[opts.contexto];
    const accion = extra ? `${copy.accion}; ${extra}` : copy.accion;

    return {
        ok: false,
        archivo: formatConfigPath(archivoAbs, opts.repoRoot),
        via,
        causa,
        linea,
        columna,
        detalle,
        accion,
        ts: new Date().toISOString(),
    };
}

/**
 * Línea única grep-friendly para `logs/*.log` y stderr. Una sola línea a
 * propósito: el visor de logs del dashboard sirve por línea y un bloque
 * multilínea rompe el filtrado.
 *
 * @param {object} estado - salida de `describeConfigFailure`.
 * @param {{titulo?: string}} [opts]
 * @returns {string}
 */
function formatConfigFailureLog(estado, opts = {}) {
    const titulo = opts.titulo || 'CONFIG INVÁLIDA';
    return `${titulo} | archivo: ${estado.archivo} (vía ${estado.via})`
        + ` | causa: ${estado.detalle} | acción: ${estado.accion}`;
}

/**
 * Alerta Telegram de configuración inválida. Dos variantes obligatorias
 * (CA-UX-3), decididas por si la pausa activa la generó ESTA corrupción o ya
 * existía. En ninguna se instruye borrar `.paused` (obsoleto desde #4832 y
 * destructivo si el marker es una pausa manual del operador).
 *
 * @param {object} estado - salida de `describeConfigFailure`.
 * @param {{pausaPreexistente?: boolean}} [opts]
 * @returns {string}
 */
function formatConfigFailureTelegram(estado, opts = {}) {
    const encabezado = opts.pausaPreexistente
        ? '🛑 *Configuración inválida* — el dispatch ya estaba pausado por otro motivo.'
        : '🛑 *Pipeline pausado — configuración inválida*';
    const via = opts.pausaPreexistente ? '' : `\n_(ruta resuelta vía ${estado.via})_`;
    return `${encabezado}\n\n`
        + `*Archivo:* \`${estado.archivo}\`${via}\n`
        + `*Causa:* ${estado.detalle}\n\n`
        + `*Qué hacer:* ${estado.accion}.`;
}

/**
 * Alerta Telegram de reanudación por auto-recovery (#4832).
 * @param {string} archivo - ruta ya formateada por `formatConfigPath`.
 * @returns {string}
 */
function formatConfigRecoveryTelegram(archivo) {
    return '✅ *Pipeline reanudado* — la configuración volvió a ser válida.\n\n'
        + `*Archivo:* \`${archivo || '(desconocido)'}\`\n`
        + 'La pausa automática por configuración inválida se levantó sola (auto-recovery #4832).';
}

module.exports = {
    validateConfig,
    redactErrors,
    formatErrors,
    redactYamlParseError,
    describeConfigFailure,
    formatConfigPath,
    formatConfigFailureLog,
    formatConfigFailureTelegram,
    formatConfigRecoveryTelegram,
    CAUSA_COPY,
    ConfigSchemaViolation,
    ConfigParseViolation,
    PROVIDER_ENUM,
    SCHEMA,
};
