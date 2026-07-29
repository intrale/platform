// =============================================================================
// config-schema.js — JSON Schema + validador de config.yaml (#3941, #5173)
// =============================================================================
//
// EP5-H4. `config.yaml` (~46KB, >30 módulos) se cargaba sin validar: un typo en
// una clave crítica parsea OK pero produce config errónea silenciosa (ej. un
// umbral de circuit breaker mal escrito → el CB nunca dispara). Este módulo
// valida el objeto ya parseado contra un JSON Schema con `ajv` y devuelve
// errores REDACTADOS (path + tipo esperado, NUNCA el valor crudo — SEC-2).
//
// Estrategia del schema (#5173 — Entrega B de #5111):
//   - RAÍZ CERRADA (`additionalProperties: false`): las 58 secciones top-level
//     están declaradas. Una clave desconocida ya NO pasa desapercibida — es la
//     precondición para que una clave del lado equivocado sea *distinguible*
//     de una clave inexistente (con la raíz abierta ambas pasaban igual).
//     Consecuencia operativa: **agregar una sección a `config.yaml` exige
//     declararla acá en el mismo commit**, o el pipeline arranca pausado.
//   - ESTRICTO (`additionalProperties: false` + `required`) en las secciones
//     clasificadas **autoridad**: son las que gobiernan gates, firma del
//     operador, circuit breaker y alta de productos/repos.
//   - LENIENT (`additionalProperties: true`) dentro de las secciones de lado
//     `kernel` / `producto`: evolucionan seguido y su contenido no decide
//     autonomía.
//
// Lados (#5111): cada clave pertenece a `kernel` (mecanismo de orquestación),
// `producto` (política/calibración del producto) o `autoridad` (decide quién
// puede aprobar qué). El lado NO se implementa como keyword de ajv — vive en
// un mapa sidecar congelado (`SIDE_MAP`) que se consulta DESPUÉS de validar.
// Así el cierre de la raíz se revierte en una línea sin desarmar nada más.
//
// En esta entrega todavía NO se movió ninguna clave de archivo: todo vive
// legítimamente en `config.yaml`. Por eso el chequeo de lado es **opt-in** vía
// `validateConfig(obj, { origin: 'producto' })`. `pulpo.loadConfig` sigue
// llamando `validateConfig(raw)` ⇒ cero cambio de comportamiento.
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

const Ajv = require('ajv');

// -----------------------------------------------------------------------------
// Error tipado de schema-violation (clasificado como 'corruption')
// -----------------------------------------------------------------------------

class ConfigSchemaViolation extends Error {
    /**
     * @param {string} message - mensaje YA redactado (sin valores crudos).
     * @param {Array<object>} [errors] - errores redactados (path + detail).
     */
    constructor(message, errors) {
        super(message);
        this.name = 'ConfigSchemaViolation';
        this.errors = Array.isArray(errors) ? errors : [];
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
// #5173 — Lados: kernel · producto · autoridad
// -----------------------------------------------------------------------------
//
// `AUTHORITY_PREFIXES` se declara por PREFIJO de sección, no por sub-clave
// suelta: si una sección es de autoridad entra ENTERA. Enumerar sub-claves
// dejaría editables justo las que importan (`firma_operador.modo`,
// `operator_signature.nonce_ttl_seconds`, `gates.gate3.timeout_ms`).
//
// Va congelada EN CÓDIGO y nunca en YAML/JSON a propósito: si la lista de
// autoridad fuera configurable, sería auto-referencial — quien puede editar la
// config podría sacarse de encima el control que la config declara. Mismo
// patrón que `PROVIDER_ENUM` acá arriba y que los CAPs hardcodeados de
// `config.yaml` "por defensa anti-config-malicioso".
//
// `architect` NO entra entera: su gate (`enabled`/`gate_mode`/`go_live_date`)
// es autoridad, pero `poll_cap_min` / `poll_interval_seconds` son calibración.
const AUTHORITY_PREFIXES = Object.freeze([
    'admission_gate',
    'circuit_breaker',
    'e2e_evidence',
    'handoff',
    'firma_operador',
    'operator_signoff',
    'operator_signature',
    'deliverable_gate',
    'gates',
    'wave_auto_transition',
    'commander_products',
    'cross_repo_delivery',
    'architect.enabled',
    'architect.gate_mode',
    'architect.go_live_date',
]);

// Clasificación completa de las 58 secciones top-level de `config.yaml`
// (#5173 CA-6). Clave = path punteado (admite `*` como comodín de un segmento);
// valor = 'kernel' | 'producto' | 'autoridad'. El match MÁS ESPECÍFICO gana, así
// una sub-clave puede partirse del lado opuesto a su sección.
const SIDE_MAP = Object.freeze({
    // --- mecanismo de orquestación: se muda al kernel sin conocer el producto -
    pipelines: 'kernel',
    'pipelines.*.skills_por_fase': 'producto',   // el grafo de fases es mecanismo; los skills son del producto
    concurrencia: 'kernel',
    routing: 'kernel',
    intake: 'kernel',
    resource_limits: 'kernel',
    timeouts: 'kernel',
    desync: 'kernel',
    precheck: 'kernel',
    anomaly_detector: 'kernel',
    cost_anomaly_alert: 'kernel',
    ghostbusters_cron: 'kernel',
    rest_mode: 'kernel',
    staleness: 'kernel',
    watchdog: 'kernel',
    wave_watchdog: 'kernel',
    dashboard: 'kernel',
    quota_detector: 'kernel',
    multi_provider: 'kernel',
    'multi_provider.order': 'producto',          // el enum es kernel; el ORDEN es política de producto
    pacing: 'kernel',
    reduced_mode: 'kernel',
    wave_coherence_gate: 'kernel',
    historico: 'kernel',
    logs_history: 'kernel',
    rewind: 'kernel',
    pipeline: 'kernel',
    inflight_fallback: 'kernel',
    sherlock_enabled: 'kernel',
    sherlock_provider_budget_ms: 'kernel',
    sherlock_max_reelaboraciones: 'kernel',
    sherlock_wait_budget_ms: 'kernel',
    telegram_burst_window_ms: 'kernel',
    telegram_outbound: 'kernel',
    deliverable_notifications: 'kernel',
    'deliverable_notifications.skills': 'producto',       // whitelist de skills del producto
    'deliverable_notifications.attachments_per_skill': 'producto',
    cua: 'kernel',
    kernel: 'kernel',
    waves: 'kernel',
    architect: 'kernel',
    'architect.poll_cap_min': 'producto',        // calibración, no gate
    'architect.poll_interval_seconds': 'producto',
    'architect.bot_login': 'producto',

    // --- política / calibración del producto ---------------------------------
    dev_skill_mapping: 'producto',
    dev_skill_partitions: 'producto',
    dev_routing_priority: 'producto',
    pipeline_scope_keywords: 'producto',
    prioridad_labels: 'producto',
    feature_priority: 'producto',
    build: 'producto',                           // contiene paths de JDK de esta máquina
    audio_policy: 'producto',
    telegram: 'producto',

    // --- autoridad: decide quién aprueba qué (entra la sección entera) --------
    admission_gate: 'autoridad',
    e2e_evidence: 'autoridad',
    circuit_breaker: 'autoridad',
    handoff: 'autoridad',
    firma_operador: 'autoridad',
    operator_signoff: 'autoridad',
    operator_signature: 'autoridad',
    deliverable_gate: 'autoridad',
    gates: 'autoridad',
    wave_auto_transition: 'autoridad',
    commander_products: 'autoridad',
    'commander_products.products.*.operators': 'autoridad',
    cross_repo_delivery: 'autoridad',            // declara a qué repos externos puede pushear el pipeline
});

// Patrones pre-segmentados, ordenados de más específico a menos. Se calcula una
// sola vez al require: `resolveSide` se llama por error de validación.
const SIDE_PATTERNS = Object.freeze(
    Object.keys(SIDE_MAP)
        .map((p) => ({ pattern: p, segs: p.split('.'), side: SIDE_MAP[p] }))
        .map((e) => ({ ...e, wilds: e.segs.filter((s) => s === '*').length }))
        .sort((a, b) => (b.segs.length - a.segs.length) || (a.wilds - b.wilds))
);

const AUTHORITY_PATTERNS = Object.freeze(AUTHORITY_PREFIXES.map((p) => p.split('.')));

/** ¿Los segmentos `pat` matchean el prefijo de `segs`? (`*` = un segmento). */
function matchesPrefix(pat, segs) {
    if (pat.length > segs.length) return false;
    for (let i = 0; i < pat.length; i++) {
        if (pat[i] !== '*' && pat[i] !== segs[i]) return false;
    }
    return true;
}

/**
 * Resuelve el lado de un path punteado (`gates.gate3.timeout_ms`).
 *
 * Orden: (1) prefijo de autoridad — la sección entra entera; (2) match más
 * específico de `SIDE_MAP`; (3) default FAIL-CLOSED `kernel` — una clave sin
 * lado declarado NUNCA se asume del producto.
 *
 * @param {string} dottedPath
 * @returns {'kernel'|'producto'|'autoridad'}
 */
function resolveSide(dottedPath) {
    const segs = String(dottedPath == null ? '' : dottedPath).split('.').filter(Boolean);
    if (segs.length === 0) return 'kernel';
    for (const pat of AUTHORITY_PATTERNS) {
        if (matchesPrefix(pat, segs)) return 'autoridad';
    }
    for (const entry of SIDE_PATTERNS) {
        if (matchesPrefix(entry.segs, segs)) return entry.side;
    }
    return 'kernel';
}

/**
 * ¿Existe algún path declarado 'producto' estrictamente por debajo de `segs`?
 *
 * Ojo con la dirección del comodín: el `*` está en el PATRÓN, no en el path
 * concreto, así que hay que recortar el patrón a la longitud de `segs` y
 * comparar en ese sentido (`pipelines.*.skills_por_fase` debe matchear el
 * prefijo `pipelines.desarrollo`, no al revés).
 */
function hasProductoDescendant(segs) {
    return SIDE_PATTERNS.some((e) =>
        e.side === 'producto'
        && e.segs.length > segs.length
        && matchesPrefix(e.segs.slice(0, segs.length), segs));
}

// -----------------------------------------------------------------------------
// JSON Schema (Draft-07 compatible, ajv v8)
// -----------------------------------------------------------------------------

// Sección de lado kernel/producto: declarada (la raíz está cerrada) pero
// permisiva por dentro — evolucionan seguido y su contenido no decide autonomía.
const OBJ = () => ({ type: 'object', additionalProperties: true });

const SCHEMA = {
    type: 'object',
    // #5173 CA-1 — RAÍZ CERRADA. Revertir = poner `true` acá (una línea): el
    // SIDE_MAP queda inerte y el comportamiento vuelve al de #3941.
    additionalProperties: false,
    properties: {
        // === kernel — mecanismo de orquestación ==============================

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

        // --- concurrencia: instancias simultáneas por rol (enteros ≥ 0) ------
        concurrencia: {
            type: 'object',
            additionalProperties: { type: 'integer', minimum: 0 },
        },

        routing: OBJ(),
        intake: OBJ(),

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

        timeouts: OBJ(),
        desync: OBJ(),
        precheck: OBJ(),
        anomaly_detector: OBJ(),
        cost_anomaly_alert: OBJ(),
        ghostbusters_cron: OBJ(),
        rest_mode: OBJ(),
        staleness: OBJ(),
        watchdog: OBJ(),
        wave_watchdog: OBJ(),
        dashboard: OBJ(),
        quota_detector: OBJ(),

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

        pacing: OBJ(),
        reduced_mode: OBJ(),
        wave_coherence_gate: OBJ(),

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

        logs_history: OBJ(),
        rewind: OBJ(),
        pipeline: OBJ(),
        inflight_fallback: OBJ(),

        // --- escalares top-level (sherlock + burst de telegram) --------------
        //     Tiparlas como `object` rompería el arranque: son escalares reales.
        sherlock_enabled: { type: 'boolean' },
        sherlock_provider_budget_ms: { type: 'number', minimum: 0 },
        sherlock_max_reelaboraciones: { type: 'number', minimum: 0 },
        sherlock_wait_budget_ms: { type: 'number', minimum: 0 },
        telegram_burst_window_ms: { type: 'number', minimum: 0 },

        telegram_outbound: OBJ(),
        deliverable_notifications: OBJ(),
        cua: OBJ(),
        kernel: OBJ(),
        waves: OBJ(),

        // --- architect: el GATE es autoridad, la cadencia es calibración -----
        architect: {
            type: 'object',
            additionalProperties: true,
            properties: {
                enabled: { type: 'boolean' },
                gate_mode: { type: 'string' },
                go_live_date: { type: ['string', 'null'] },
                bot_login: { type: 'string' },
                poll_cap_min: { type: 'number', minimum: 0 },
                poll_interval_seconds: { type: 'number', minimum: 0 },
            },
        },

        // === producto — política / calibración ===============================

        dev_skill_mapping: OBJ(),
        dev_skill_partitions: OBJ(),
        dev_routing_priority: { type: 'array' },
        pipeline_scope_keywords: { type: 'array' },
        prioridad_labels: { type: 'array' },
        feature_priority: OBJ(),
        build: OBJ(),
        audio_policy: OBJ(),
        telegram: OBJ(),

        // === autoridad — ESTRICTAS (additionalProperties: false + required) ===
        //     Un typo acá no puede degradar silenciosamente un gate: la clave
        //     desconocida falla y el pipeline queda pausado, no permisivo.

        // --- admission_gate: admisión de issues al pipeline -------------------
        admission_gate: {
            type: 'object',
            additionalProperties: false,
            required: ['sweep_enabled', 'dry_run'],
            properties: {
                sweep_enabled: { type: 'boolean' },
                dry_run: { type: 'boolean' },
                bootstrap_cap: { type: 'number', minimum: 0 },
            },
        },

        // --- e2e_evidence: gobierna la evidencia exigida por el gate de QA ----
        e2e_evidence: {
            type: 'object',
            additionalProperties: false,
            required: ['enabled'],
            properties: {
                enabled: { type: 'boolean' },
            },
        },

        // --- circuit_breaker: umbrales del CB de infra (#2305/#3940) ---------
        circuit_breaker: {
            type: 'object',
            additionalProperties: false,
            required: ['infra_escalate_threshold', 'auto_resume_ok_threshold'],
            properties: {
                infra_escalate_threshold: { type: 'integer', minimum: 1 },
                auto_resume_ok_threshold: { type: 'integer', minimum: 1 },
                rebotes_max: { type: 'integer', minimum: 1 },
                auto_promote_on_convergence: { type: 'boolean' },
                convergence_requires_build_green: { type: 'boolean' },
                convergence_excludes_skills: { type: 'array', items: { type: 'string' } },
            },
        },

        // --- handoff: cross-agente (#2993) — tiene kill_switch ----------------
        handoff: {
            type: 'object',
            additionalProperties: false,
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
        //     Default seguro = firma humana; el schema NO permite que un valor
        //     corrupto habilite auto-aprobación silenciosamente.
        firma_operador: {
            type: 'object',
            additionalProperties: false,
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

        // --- operator_signoff / operator_signature: gates de firma humana -----
        operator_signoff: {
            type: 'object',
            additionalProperties: false,
            required: ['enabled', 'gate_mode'],
            properties: {
                enabled: { type: 'boolean' },
                gate_mode: { type: 'string' },
                go_live_date: { type: ['string', 'null'] },
                preauthorized_classes: { type: 'array', items: { type: 'string' } },
            },
        },

        operator_signature: {
            type: 'object',
            additionalProperties: false,
            required: ['enabled', 'gate_mode'],
            properties: {
                enabled: { type: 'boolean' },
                gate_mode: { type: 'string' },
                go_live_date: { type: ['string', 'null'] },
                preauthorized_classes: { type: 'array', items: { type: 'string' } },
                // nonce_ttl_seconds acota la ventana de replay de una firma.
                nonce_ttl_seconds: { type: 'number', minimum: 0 },
                max_signature_rebotes: { type: 'number', minimum: 0 },
            },
        },

        // --- deliverable_gate: gate de entregables ---------------------------
        deliverable_gate: {
            type: 'object',
            additionalProperties: false,
            required: ['enabled', 'kill_switch'],
            properties: {
                enabled: { type: 'boolean' },
                kill_switch: { type: 'boolean' },
                gate_mode: { type: 'string' },
            },
        },

        // --- gates: política de gate3 + ausencia del operador -----------------
        gates: {
            type: 'object',
            additionalProperties: false,
            properties: {
                gate3: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        policy: { type: 'object', additionalProperties: { type: 'string' } },
                        timeout_ms: { type: 'object', additionalProperties: { type: 'number', minimum: 0 } },
                        timeout_fallback: { type: 'object', additionalProperties: { type: 'string' } },
                    },
                },
                operator_absence: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['kill_switch'],
                    properties: {
                        kill_switch: { type: 'boolean' },
                        allowlist: { type: 'array' },
                        confidence_index_ref: { type: 'string' },
                        non_delegable_gates: { type: 'array', items: { type: 'string' } },
                    },
                },
            },
        },

        // --- wave_auto_transition: transición automática de olas --------------
        wave_auto_transition: {
            type: 'object',
            additionalProperties: false,
            required: ['enabled', 'kill_switch'],
            properties: {
                enabled: { type: 'boolean' },
                kill_switch: { type: 'boolean' },
                mode: { type: 'string' },
                gh_timeout_ms: { type: 'number', minimum: 0 },
            },
        },

        // --- commander_products: alta de productos y sus operadores (D-2) -----
        //     JSON Schema no tiene comodín: los productos se cablean con
        //     patternProperties (el `*` del SIDE_MAP vive en el mapa sidecar).
        commander_products: {
            type: 'object',
            additionalProperties: false,
            required: ['default_product', 'products'],
            properties: {
                default_product: { type: 'string' },
                products: {
                    type: 'object',
                    patternProperties: { '^.+$': { type: 'object', additionalProperties: true } },
                },
            },
        },

        // --- cross_repo_delivery: a qué repos externos puede pushear ----------
        cross_repo_delivery: {
            type: 'object',
            additionalProperties: false,
            required: ['enabled'],
            properties: {
                enabled: { type: 'boolean' },
                repos: { type: 'array' },
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
//
// NO bajar `allErrors` a `false` por el tope de 4096 chars de Telegram: eso
// degradaría el diagnóstico del log. El recorte va SÓLO en la notificación
// (`formatErrorsForHuman`).
const ajv = new Ajv({ allErrors: true, verbose: false });
const validateFn = ajv.compile(SCHEMA);

// -----------------------------------------------------------------------------
// Saneo y sugerencia de nombres de clave
// -----------------------------------------------------------------------------

/**
 * Sanea un nombre de clave que viene del INPUT (no del schema) antes de
 * mostrarlo. Un `*` desbalanceado o un `\n` en el nombre rompen el Markdown de
 * `sendTelegram` y el envío falla ENTERO — el operador no se entera de que el
 * pipeline quedó pausado. Además evita spoofing de texto inyectado.
 *
 * Deja el nombre legible (no lo omite): sólo colapsa lo que no es
 * alfanumérico / `_` / `.` / `-` en `?`, y lo acota a 64 chars.
 *
 * @param {*} name
 * @returns {string}
 */
function sanitizeKeyName(name) {
    return String(name).slice(0, 64).replace(/[^A-Za-z0-9_.\-]/g, '?');
}

/** Sanea cada segmento de un instancePath sin perder su estructura. */
function sanitizePath(instancePath) {
    const segs = String(instancePath || '').split('/').filter(Boolean).map(sanitizeKeyName);
    return segs.length ? '/' + segs.join('/') : '(root)';
}

/** Distancia de edición acotada (implementación local: no sumamos dependencia). */
function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (Math.abs(m - n) > 2) return 99;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
        const cur = [i];
        for (let j = 1; j <= n; j++) {
            cur[j] = Math.min(
                prev[j] + 1,
                cur[j - 1] + 1,
                prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
        }
        prev = cur;
    }
    return prev[n];
}

/** Nodo del SCHEMA en un `instancePath` de ajv, o null si no se puede resolver. */
function schemaNodeAt(instancePath) {
    let node = SCHEMA;
    const segs = String(instancePath || '').split('/').filter(Boolean);
    for (const seg of segs) {
        if (!node || typeof node !== 'object') return null;
        const next = (node.properties && node.properties[seg])
            || (node.additionalProperties && typeof node.additionalProperties === 'object'
                ? node.additionalProperties : null);
        if (!next) return null;
        node = next;
    }
    return node;
}

/**
 * Sugiere UNA sola clave cercana (distancia ≤ 2) entre las declaradas como
 * hermanas. Una sola candidata a propósito: una lista de "quizás" no ayuda al
 * operador y agranda el mensaje.
 */
function suggestKey(instancePath, wrongKey) {
    const node = schemaNodeAt(instancePath);
    if (!node || !node.properties) return null;
    const target = String(wrongKey);
    let best = null, bestD = 3;
    for (const cand of Object.keys(node.properties)) {
        const d = levenshtein(target, cand);
        if (d < bestD) { bestD = d; best = cand; }
    }
    return best;
}

// -----------------------------------------------------------------------------
// Redacción de errores (SEC-2): path + tipo esperado, NUNCA el valor crudo
// -----------------------------------------------------------------------------

/** `/a/b/c` (instancePath de ajv) → `a.b.c`. */
function dottedFrom(instancePath, extraKey) {
    const segs = String(instancePath || '').split('/').filter(Boolean);
    if (extraKey) segs.push(String(extraKey));
    return segs.join('.');
}

/**
 * Transforma los errores crudos de ajv en objetos redactados seguros para
 * loguear o mandar por Telegram. Sólo expone:
 *   - `path`: ubicación de la clave (instancePath), NO el valor.
 *   - `keyword`: regla que falló.
 *   - `detail`: descripción del tipo/enum/clave esperado (sin valor crudo).
 *   - `lado`: lado al que pertenece ese path (`kernel`/`producto`/`autoridad`).
 *
 * NUNCA incluye el valor que falló. Los enums permitidos provienen del SCHEMA.
 * Los nombres de clave de `additionalProperty` vienen del INPUT y por eso pasan
 * por `sanitizeKeyName` antes de salir.
 *
 * @param {Array<object>} ajvErrors
 * @returns {Array<{path: string, keyword: string, detail: string, lado: string}>}
 */
function redactErrors(ajvErrors) {
    if (!Array.isArray(ajvErrors)) return [];
    return ajvErrors.map((e) => {
        const params = e.params || {};
        const path = sanitizePath(e.instancePath);
        let dotted = dottedFrom(e.instancePath);
        let detail;
        switch (e.keyword) {
            case 'type':
                detail = `tipo esperado: ${params.type}`;
                break;
            case 'enum':
                detail = `valor fuera del enum permitido: [${(params.allowedValues || []).join(', ')}]`;
                break;
            case 'required':
                detail = `falta clave requerida: '${sanitizeKeyName(params.missingProperty)}'`;
                dotted = dottedFrom(e.instancePath, params.missingProperty);
                break;
            case 'additionalProperties': {
                const raw = params.additionalProperty;
                const safe = sanitizeKeyName(raw);
                dotted = dottedFrom(e.instancePath, raw);
                const cand = suggestKey(e.instancePath, raw);
                detail = `clave no permitida: '${safe}'`
                    + (cand ? ` — ¿quisiste decir '${cand}'?` : '');
                break;
            }
            case 'minimum':
                detail = `mínimo permitido: ${params.limit}`;
                break;
            case 'maximum':
                detail = `máximo permitido: ${params.limit}`;
                break;
            case 'side':
                // Error propio (no de ajv) inyectado por el chequeo de lado.
                detail = e.detail;
                break;
            default:
                // `e.message` de ajv describe la regla (ej. "must be integer"),
                // NO incluye el valor crudo cuando verbose:false.
                detail = e.message || e.keyword;
        }
        return { path, keyword: e.keyword, detail, lado: resolveSide(dotted) };
    });
}

// -----------------------------------------------------------------------------
// Chequeo de lado (CA-4) — opt-in por `origin`
// -----------------------------------------------------------------------------

const MAX_SIDE_WALK_DEPTH = 6;

/**
 * Recorre el objeto y reporta toda clave cuyo lado NO sea `producto`. Poda en
 * cuanto un subárbol es del producto; sólo baja donde hay un split declarado.
 *
 * El mensaje nombra la clave y el lado esperado, y NO enumera la lista de
 * autoridad (revelarla entera facilita buscar el hueco).
 */
function collectSideViolations(node, segs, out) {
    if (segs.length > MAX_SIDE_WALK_DEPTH) return;
    for (const key of Object.keys(node || {})) {
        const childSegs = segs.concat(key);
        const dotted = childSegs.join('.');
        const side = resolveSide(dotted);
        if (side === 'producto') continue;                 // subárbol permitido: podamos
        const child = node[key];
        const puedeBajar = child && typeof child === 'object' && !Array.isArray(child)
            && hasProductoDescendant(childSegs);
        if (puedeBajar) { collectSideViolations(child, childSegs, out); continue; }
        out.push({
            path: '/' + childSegs.map(sanitizeKeyName).join('/'),
            keyword: 'side',
            detail: `clave de lado '${side}': no puede vivir en la configuración `
                + `del producto (acá sólo se admite lado 'producto')`,
            lado: side,
        });
    }
}

/**
 * Valida un objeto config ya parseado contra el schema.
 *
 * @param {*} obj
 * @param {{origin?: 'monolito'|'producto'}} [opts]
 *   - `origin` ausente o `'monolito'` (default): SÓLO schema. Es lo que usa
 *     `pulpo.loadConfig` hoy ⇒ cero cambio de comportamiento mientras las
 *     claves siguen todas en `config.yaml`.
 *   - `'producto'`: además falla toda clave cuyo lado sea `kernel` o
 *     `autoridad`. Lo consume la Entrega C (#5174), que sí parte el archivo.
 * @returns {{valid: boolean, errors: Array<{path:string, keyword:string, detail:string, lado:string}>}}
 */
function validateConfig(obj, opts = {}) {
    // Un config que no es objeto (null, array, string) es corrupción de raíz.
    const valid = validateFn(obj);
    const errors = valid ? [] : redactErrors(validateFn.errors);
    if ((opts && opts.origin) === 'producto' && obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const sideErrors = [];
        collectSideViolations(obj, [], sideErrors);
        if (sideErrors.length) return { valid: false, errors: errors.concat(sideErrors) };
    }
    return { valid: !!valid, errors };
}

// -----------------------------------------------------------------------------
// Formateo
// -----------------------------------------------------------------------------

function formatOne(e) {
    return `${e.path}: ${e.detail}${e.lado ? ` [lado: ${e.lado}]` : ''}`;
}

/**
 * Formatea TODOS los errores redactados en una línea legible. Es la vía al log
 * en disco: no recorta, para no perder diagnóstico.
 * @param {Array<{path:string, detail:string}>} errors
 * @returns {string}
 */
function formatErrors(errors) {
    if (!Array.isArray(errors) || errors.length === 0) return '';
    return errors.map(formatOne).join('; ');
}

/**
 * Variante acotada para la NOTIFICACIÓN al operador (Telegram tiene tope de
 * 4096 chars: con la raíz cerrada y `allErrors:true`, un config muy roto genera
 * decenas de errores y el mensaje se vuelve ilegible o no se envía).
 * Muestra los primeros `max` y un contador del resto. El log queda completo.
 *
 * @param {Array<object>} errors
 * @param {number} [max=5]
 * @returns {string}
 */
function formatErrorsForHuman(errors, max = 5) {
    if (!Array.isArray(errors) || errors.length === 0) return '';
    const shown = errors.slice(0, max).map(formatOne).join('; ');
    const rest = errors.length - max;
    return rest > 0 ? `${shown}; (+${rest} error/es más — ver pulpo.log)` : shown;
}

module.exports = {
    validateConfig,
    redactErrors,
    formatErrors,
    formatErrorsForHuman,
    sanitizeKeyName,
    resolveSide,
    ConfigSchemaViolation,
    PROVIDER_ENUM,
    SIDE_MAP,
    AUTHORITY_PREFIXES,
    SCHEMA,
};
