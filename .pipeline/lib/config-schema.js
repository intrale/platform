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
// El chequeo de lado es **opt-in** vía `validateConfig(obj, { origin })` /
// `checkSide(obj, lado)`. Desde #5172 `lib/config-resolver.resolve()` valida el
// documento MERGEADO sin `origin` (cero cambio de comportamiento en el schema) y
// desde #5174 corre `checkSide` por separado sobre cada lado del archivo partido.
//
// #5174 (Entrega C de #5111) — el chequeo es BIDIRECCIONAL:
//   - `checkSide(productoDoc, 'producto')`: toda clave que NO sea de lado
//     `producto` en el manifiesto del producto es una violación (regla invertida
//     del issue: la autoridad la gana SIEMPRE el kernel).
//   - `checkSide(kernelDoc, 'kernel')`: toda clave de lado `producto` que quedó
//     del lado del kernel es una violación. Esta dirección no existía en #5173
//     (`origin` sólo aceptaba `'producto'`) y sin ella el escenario Gherkin
//     *"clave de producto en la configuración del kernel"* no tenía mensaje —
//     y un modo de falla sin mensaje es peor que un mensaje malo (CA-14.4).
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
        // #5174 — la causa deja de ser fija: la partición agrega modos de falla
        // que NO son "el documento no cumple el schema" (clave del lado
        // equivocado, clave prohibida, override por env). Cada uno necesita su
        // propia acción al operador; reusar la de `schema-invalido` es lo que
        // producía el copy que instruye completar una sección de autoridad.
        // Default intacto ⇒ los llamadores previos a #5174 no cambian.
        this.causa = m.causa || 'schema-invalido';
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
    'brazo',
    'commander_products',
    'cross_repo_delivery',
    'architect.enabled',
    'architect.gate_mode',
    'architect.go_live_date',
]);

// Clasificación completa de las secciones top-level de `config.yaml`
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
    delivery: 'kernel',
    worktree_provenance: 'kernel',
    desync: 'kernel',
    precheck: 'kernel',
    anomaly_detector: 'kernel',
    // #5337 — cadencia del recordatorio de bloqueos humanos. Es mecanismo del
    // pipeline (cuándo insiste), no política de producto.
    human_block_reminder: 'kernel',
    // #6611 — re-chequeo automatico de bloqueos needs-human verificables. Es
    // mecanismo del pipeline (cada cuanto re-evalua y cuantos reintentos
    // tolera), no politica de producto.
    human_block_auto_recheck: 'kernel',
    // #6118 — cuándo se chequean las dependencias faltantes y cuánto dura el
    // silencio del aviso. Es mecanismo del pipeline (cada cuánto insiste), no
    // política de producto.
    partial_pause_deps: 'kernel',
    cost_anomaly_alert: 'kernel',
    ghostbusters_cron: 'kernel',
    // #6708 — presupuesto de disco del guardián. Es mecanismo del pipeline
    // (cuánto margen necesita la máquina para operar), no política de producto.
    disk_budget: 'kernel',
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
    // #5573 — política de reenvío de las PARTES DE AUDIO, separada de la de texto.
    // Es mecanismo de entrega del canal, no producto → kernel.
    telegram_voice_outbound: 'kernel',
    deliverable_notifications: 'kernel',
    'deliverable_notifications.skills': 'producto',       // whitelist de skills del producto
    'deliverable_notifications.attachments_per_skill': 'producto',
    cua: 'kernel',
    kernel: 'kernel',
    // #5352 — el vault direcciona secretos de INFRAESTRUCTURA por host: es
    // mecanismo de orquestación, se muda al kernel sin conocer el producto.
    vault: 'kernel',
    waves: 'kernel',
    // #5110 — el namespaceo del estado operativo por projectId es mecanismo de
    // orquestación puro (aislamiento multi-proyecto), no política de producto.
    operational_state: 'kernel',
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
    brazo: 'autoridad',
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

        delivery: {
            type: 'object',
            additionalProperties: false,
            properties: {
                merge_checks_timeout_ms: { type: 'integer', minimum: 1 },
            },
        },

        worktree_provenance: {
            type: 'object',
            additionalProperties: false,
            required: ['committers'],
            properties: {
                committers: {
                    type: 'array',
                    items: { type: 'string', minLength: 1, pattern: '\\S' },
                },
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

        timeouts: OBJ(),
        desync: OBJ(),
        precheck: OBJ(),
        anomaly_detector: OBJ(),
        human_block_reminder: OBJ(),   // #5337 CA-5
        // #6611 — auto-destrabe de bloqueos con predicado verificable. Sin esta
        // linea, escribir la seccion en `config.yaml` tira ConfigSchemaViolation
        // con la raiz cerrada (#5173) y deja al pipeline sin arrancar.
        human_block_auto_recheck: OBJ(),
        // #6118 CA-13 — cadencia y ventana de silencio del aviso de
        // dependencias faltantes. El Pulpo ya leía `config.partial_pause_deps`
        // desde #2893, pero la sección nunca se había declarado: con la raíz
        // cerrada (#5173), escribirla en `config.yaml` sin esta línea tiraba
        // ConfigSchemaViolation y dejaba al pipeline sin arrancar.
        partial_pause_deps: OBJ(),
        cost_anomaly_alert: OBJ(),
        ghostbusters_cron: OBJ(),
        // #6708 — umbrales del guardián de disco. Los valores se validan y
        // clampean en `lib/disk-guard.js` (CLAMPS + monotonicidad), así que acá
        // alcanza con declarar la sección: duplicar los rangos sería una segunda
        // fuente de verdad que se desincroniza.
        disk_budget: OBJ(),
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
                // --- #6145 CA-6 — criterio de permanencia de proveedores.
                //     Declarado acá porque la raíz es CERRADA: agregar la
                //     subsección a config.yaml sin declararla en el schema deja
                //     al dashboard fail-closed (precedente ya sufrido).
                //     LENIENT en `additionalProperties` como el resto de
                //     multi_provider, pero con TIPOS y RANGOS chequeados: un
                //     umbral con tipo/rango inválido no debe llegar al criterio
                //     que marca candidatos a baja. Los invariantes de seguridad
                //     (nunca vacía la cadena, nunca marca un pago, "sin dato" ⇒
                //     no evaluable) viven en código, NO acá.
                permanence: {
                    type: 'object',
                    additionalProperties: true,
                    properties: {
                        enabled: { type: 'boolean' },
                        window_days: { type: 'number', minimum: 1 },
                        min_sample: { type: 'number', minimum: 0 },
                        min_contribution_rate: { type: 'number', minimum: 0, maximum: 1 },
                        max_days_without_win: { type: 'number', minimum: 0 },
                        min_survivors: { type: 'number', minimum: 1 },
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
        // #5573 — la raíz está CERRADA: `telegram_voice_outbound` en config.yaml
        // SIN esta declaración deja el pipeline arrancando pausado por
        // ConfigSchemaViolation. Va en el MISMO commit que la sección nueva.
        telegram_voice_outbound: OBJ(),
        deliverable_notifications: OBJ(),
        cua: OBJ(),
        kernel: OBJ(),

        // --- #5352 · vault de secretos (lectura) ------------------------------
        // La raíz está CERRADA desde #5173: agregar `vault:` a config.yaml SIN
        // declararlo acá deja el pipeline arrancando pausado. Por eso esta
        // declaración va en el MISMO commit que la sección nueva.
        // Se tipa (en vez de `OBJ()`) porque el gate y el tope de TTL son
        // fail-closed: un `enabled: "false"` string o un TTL de 3600 pasarían
        // como `additionalProperties: true` y sólo se descubrirían en runtime.
        vault: {
            type: 'object',
            additionalProperties: true,
            properties: {
                enabled: { type: 'boolean' },
                prefix: { type: 'string' },
                projectId: { type: 'string' },
                hostId: { type: 'string' },
                // #5426 · CA-11/CA-12 — mecanismo de identidad del host. Se
                // tipan por el mismo motivo que `enabled`: son fail-closed. Un
                // `hostIdFromHostname: "false"` string sería truthy para el
                // YAML, y un `authMode` fuera del enum sólo se descubriría al
                // encender el gate. El enum se declara acá ADEMÁS de en
                // `VAULT_AUTH_MODES` porque los dos controles fallan en momentos
                // distintos: el schema al arrancar, el módulo al leer el vault.
                hostIdFromHostname: { type: 'boolean' },
                authMode: {
                    type: 'string',
                    enum: ['assume-role-chain', 'session-token', 'static-key', 'instance-profile'],
                },
                awsProfile: { type: 'string' },
                // Tope DURO de SEC-6: el módulo también lo rechaza, pero acá el
                // operador se entera al arrancar y no al encender el gate.
                cache_ttl_seconds: { type: 'number', minimum: 1, maximum: 300 },
                required_scopes: { type: 'array', items: { type: 'string' } },
                shared_secrets: { type: 'array', items: { type: 'string' } },
                // #5899 — cota de namespaces cacheados a la vez. Se tipa por el
                // mismo motivo que `cache_ttl_seconds`: es un control de
                // seguridad (acota el plaintext en memoria), no una preferencia.
                // Un `0` o un string dejarían el memo sin cota efectiva y sólo
                // se descubriría el día que corran varias instancias juntas.
                max_cached_tenants: { type: 'number', minimum: 1 },
                // #5353 · B1 — se tipan por el mismo motivo que `enabled`: son
                // fail-closed. Un `bootstrap_fallback: "false"` string sería
                // truthy para el YAML y sólo se descubriría el día que la
                // ventana se abriera sola.
                bootstrap_fallback: { type: 'boolean' },
                bootstrap_fallback_until: { type: 'string' },
                // #5453 — coordinador de la migración por host. Se tipa por el
                // mismo motivo que `enabled`: `migration.enabled` es el gate de
                // rollout y sólo el booleano `true` exacto lo abre; un `"true"`
                // string sería truthy para el YAML y arrancaría el coordinador
                // sin que nadie lo haya decidido. `auto_stages` es un enum
                // CERRADO: una etapa desconocida ahí no se ignora en silencio,
                // se descubre al arrancar. `rotate`/`provision`/`respawn` NO
                // son valores válidos a propósito — son irreversibles o bajan al
                // propio Pulpo, y las dispara el operador con el runbook.
                migration: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        enabled: { type: 'boolean' },
                        tick_minutes: { type: 'number', minimum: 1, maximum: 1440 },
                        auto_stages: {
                            type: 'array',
                            items: { type: 'string', enum: ['observe'] },
                        },
                        auto_cutover: { type: 'boolean' },
                    },
                },
                cut_fallback: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['authorization_ttl_seconds', 'operation_timeout_ms', 'runbook'],
                    properties: {
                        authorization_ttl_seconds: { type: 'number', minimum: 1, maximum: 900 },
                        operation_timeout_ms: { type: 'number', minimum: 100, maximum: 60000 },
                        runbook: { type: 'string', minLength: 1, maxLength: 512 },
                        // #5460 — PRODUCTOR de la propuesta. Se tipan por el
                        // mismo motivo que `enabled`: son fail-closed. Los tres
                        // son OPCIONALES (no van en `required`) para que un
                        // config.yaml anterior a #5460 siga validando: sin
                        // `proposal_enabled: true` el productor no corre y el
                        // boot queda idéntico al de antes.
                        //
                        // `proposal_enabled` es el gate de rollout: sólo el
                        // booleano `true` exacto lo abre. Un `"true"` string
                        // sería truthy para el YAML y encendería el productor
                        // sin que nadie lo haya decidido.
                        proposal_enabled: { type: 'boolean' },
                        // Cuánto se espera al operador antes de declarar
                        // ausencia. Cotas: 1 min .. 72 h. Fuera de rango el
                        // módulo degrada al default (6 h), pero acá el operador
                        // se entera al arrancar y no el día del cutover.
                        proposal_timeout_ms: { type: 'number', minimum: 60000, maximum: 259200000 },
                        // Issue del cutover: destino del label `needs-human` y
                        // binding del token de la capability. `0` significa SIN
                        // CONFIGURAR y se commitea así a propósito (mismo
                        // criterio que `hostId: ""`): un placeholder que apunte
                        // a un issue equivocado etiquetaría trabajo ajeno el
                        // día del corte. El productor trata `0` como
                        // `estado_indeterminado`, no como "propongo igual".
                        proposal_issue: { type: 'number', minimum: 0, maximum: 999999 },
                    },
                },
                // #5448 · CA-21 — misma razón que las dos de arriba. El núcleo
                // igual valida y falla cerrado, pero un `hosts_activos` que es
                // string en vez de lista se descubre acá, al arrancar, y no el
                // día que alguien pregunte por qué la ventana no cierra.
                shadow_window: {
                    type: 'object',
                    additionalProperties: true,
                    properties: {
                        duration_hours: { type: 'number', minimum: 1 },
                        hosts_activos: { type: 'array', items: { type: 'string' } },
                        retention_days: { type: 'number', minimum: 1 },
                    },
                },
            },
        },

        waves: OBJ(),

        // --- operational_state: aislamiento del estado operativo (#5110) -----
        //
        // `namespaced.enabled` es el interruptor del layout:
        //   false (DEFAULT) → layout PLANO `.pipeline/waves.json` — exactamente
        //                     el comportamiento pre-#5110, sin regresión.
        //   true            → `.pipeline/projects/<projectId>/waves.json`.
        //
        // Poner el interruptor en config (y no en código) es lo que hace que R8
        // — "rollback al modelo plano en minutos" — sea real: se baja el flag y
        // se corre el migrador con `--rollback`.
        operational_state: {
            type: 'object',
            additionalProperties: true,
            properties: {
                namespaced: {
                    type: 'object',
                    additionalProperties: true,
                    properties: {
                        enabled: { type: 'boolean' },
                        // `true` → el contexto de proyecto debe venir DECLARADO
                        // (projectId explícito o binding de spawn del pulpo): se
                        // apagan los caminos de compat `single-project` y
                        // `host-fallback`, que resuelven por convención. Lo lee
                        // `project-context.js` (`strictContextEnabled()`).
                        //
                        // NO hay `host_project_id`: la identidad del host sale de
                        // `pipeline.config.json`, fuente única compartida con el
                        // kernel-store. Declararla también acá sería una segunda
                        // verdad que nadie lee.
                        strict_context: { type: 'boolean' },
                    },
                },
            },
        },

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
                // #6746 — breaker de no-progreso. RIESGO-1: este objeto es
                // `additionalProperties: false` y `pulpo.js` valida al arrancar,
                // así que la clave DEBE viajar en el mismo commit que config.yaml.
                noprogreso_max: { type: 'integer', minimum: 2, maximum: 10 },
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
        brazo: {
            type: 'object', additionalProperties: false, required: ['reclaim_merge_race'],
            properties: { reclaim_merge_race: {
                type: 'object', additionalProperties: false, required: ['enabled', 'kill_switch', 'max_attempts', 'child_timeout_ms'],
                properties: {
                    enabled: { type: 'boolean' }, kill_switch: { type: 'boolean' },
                    max_attempts: { type: 'integer', minimum: 1 }, child_timeout_ms: { type: 'integer', minimum: 1000 },
                },
            } },
        },
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

/**
 * Escapa los metacaracteres del Markdown LEGACY de Telegram (`parse_mode:
 * 'Markdown'`, el que usa `sendTelegram`) para texto que va FUERA de un code
 * span.
 *
 * Por qué existe (#5173, rebote de seguridad): `sanitizeKeyName` deja pasar el
 * `_` a propósito — todas las claves del pipeline son snake_case y colapsarlo a
 * `?` destruiría la legibilidad que pide REQ-UX-5. Pero en el Markdown legacy el
 * `_` es delimitador de itálica, así que una clave como
 * `resource_limits/green_max_percent` mete 5 `_` (impar) y Telegram responde
 * `400 Bad Request: can't parse entities`. Como `servicio-telegram` reintenta con
 * el MISMO parse_mode y termina archivando en `fallido/`, la alerta de halt NUNCA
 * llega: el pipeline queda pausado y el operador no se entera de la causa. Es el
 * mismo agujero que el CA-10 cubre para `*`, pero por el `_`.
 *
 * Escapar (y no colapsar) preserva el nombre real de la clave: Telegram renderiza
 * `\_` como `_`.
 *
 * @param {*} s
 * @returns {string}
 */
function escapeMarkdownLegacy(s) {
    return String(s).replace(/([_*`\[])/g, '\\$1');
}

/**
 * Variante para texto que va DENTRO de un code span (`` `...` ``).
 *
 * Ahí el backslash NO escapa nada (el contenido es literal), así que aplicar
 * `escapeMarkdownLegacy` mostraría los `\` crudos y ensuciaría la ruta. El único
 * carácter que rompe es el backtick, que cierra el span antes de tiempo y
 * desbalancea el mensaje entero.
 *
 * @param {*} s
 * @returns {string}
 */
function escapeMarkdownCodeSpan(s) {
    return String(s).replace(/`/g, "'");
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

// #5174 · CA-14 — nombres de los DOS archivos de la partición. El copy tiene que
// nombrar el archivo DESTINO de la clave mal ubicada: sin eso el operador sabe
// que algo está mal pero no adónde moverlo, que es la mitad del problema.
const KERNEL_CONFIG_FILE = '.pipeline/config.yaml';
const PRODUCT_CONFIG_FILE = 'pipeline.config.json';

/** Archivo al que pertenece cada lado (destino de la corrección). */
function archivoDeLado(lado) {
    return lado === 'producto' ? PRODUCT_CONFIG_FILE : KERNEL_CONFIG_FILE;
}

/**
 * #5174 · CA-14 — detalle de una violación de lado con las CUATRO piezas que el
 * operador necesita para actuar sin leer código: qué clave (el `path` del error),
 * en qué lado está, a qué lado/archivo pertenece, y qué hacer / qué NO hacer.
 *
 * El "qué NO hacer" es la pieza cara: el copy genérico de `schema-invalido`
 * ("ajustá las claves que lista el detalle") aplicado a una sección de autoridad
 * infiltrada del lado producto empuja al operador a COMPLETAR esa sección —
 * exactamente la escalada de privilegio que la partición existe para impedir.
 *
 * SEC-2: path + lado + archivo. Nunca el valor.
 */
function detalleDeLado(lado, ladoEsperado) {
    const destino = archivoDeLado(lado);
    const aqui = archivoDeLado(ladoEsperado);
    const porQue = lado === 'autoridad'
        ? ' — es clave de autoridad y la gana siempre el kernel'
        : '';
    return `clave de lado '${lado}': está en ${aqui} y pertenece a ${destino}${porQue}`
        + `. Movela a ${destino}; NO la completes ni la declares acá`;
}

/**
 * Recorre el objeto y reporta toda clave cuyo lado no sea el admitido en este
 * archivo. Poda en cuanto un subárbol es válido; sólo baja donde hay un split
 * declarado (`pipelines.*.skills_por_fase`, `architect.poll_cap_min`, …).
 *
 * El mensaje nombra la clave, el lado y el archivo destino, y NO enumera la
 * lista de autoridad (revelarla entera facilita buscar el hueco).
 *
 * @param {object} node
 * @param {string[]} segs - prefijo recorrido.
 * @param {Array<object>} out - acumulador de errores.
 * @param {'producto'|'kernel'} esperado - lado admitido en este archivo.
 *        `'producto'`: sólo lado `producto`. `'kernel'`: lado `kernel` y
 *        `autoridad` (el kernel es dueño de ambos), nunca `producto`.
 */
function collectSideViolations(node, segs, out, esperado = 'producto') {
    if (segs.length > MAX_SIDE_WALK_DEPTH) return;
    for (const key of Object.keys(node || {})) {
        const childSegs = segs.concat(key);
        const dotted = childSegs.join('.');
        const side = resolveSide(dotted);
        const admitida = esperado === 'producto' ? side === 'producto' : side !== 'producto';
        const child = node[key];
        const esMapa = child && typeof child === 'object' && !Array.isArray(child);
        // Un subárbol admitido puede ESCONDER un split del otro lado más abajo
        // (`pipelines` es kernel pero `pipelines.*.skills_por_fase` es producto).
        // Sólo se baja cuando el SIDE_MAP declara un descendiente de producto;
        // en cualquier otro caso el subárbol entero hereda el lado del padre.
        if (admitida) {
            if (esperado === 'kernel' && esMapa && hasProductoDescendant(childSegs)) {
                collectSideViolations(child, childSegs, out, esperado);
            }
            continue;
        }
        if (esperado === 'producto' && esMapa && hasProductoDescendant(childSegs)) {
            collectSideViolations(child, childSegs, out, esperado);
            continue;
        }
        out.push({
            path: '/' + childSegs.map(sanitizeKeyName).join('/'),
            keyword: 'side',
            detail: detalleDeLado(side, esperado),
            lado: side,
        });
    }
}

/**
 * #5174 — Chequeo de lado AISLADO (sin schema). Lo consume
 * `lib/config-resolver` sobre cada lado del archivo partido.
 *
 * Va separado de `validateConfig` a propósito: post-partición **ningún lado
 * suelto valida contra el schema completo** (el kernel se queda sin
 * `pipelines.*.skills_por_fase`, que es `required`; el producto se queda sin las
 * secciones de autoridad). El schema se corre UNA vez, sobre el documento ya
 * mergeado — que es además lo que garantiza la paridad clave por clave del CA-2.
 *
 * @param {*} obj
 * @param {'producto'|'kernel'} esperado
 * @returns {{valid: boolean, errors: Array<{path:string, keyword:string, detail:string, lado:string}>}}
 */
function checkSide(obj, esperado = 'producto') {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { valid: true, errors: [] };
    const errors = [];
    collectSideViolations(obj, [], errors, esperado === 'kernel' ? 'kernel' : 'producto');
    return { valid: errors.length === 0, errors };
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
    const origin = opts && opts.origin;
    if ((origin === 'producto' || origin === 'kernel') && obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const sideErrors = [];
        collectSideViolations(obj, [], sideErrors, origin);
        // #5174 · CA-14.3 — los errores de LADO van PRIMERO. `formatErrorsForHuman`
        // recorta a los primeros N por el tope de 4096 chars de Telegram: una
        // sección mal ubicada genera además decenas de `required`/`additionalProperties`
        // que son CONSECUENCIA, y si la causa real queda en la posición 8 de 9 el
        // operador recibe una alerta que no nombra el problema.
        if (sideErrors.length) return { valid: false, errors: sideErrors.concat(errors) };
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
        // #5173 CA-13 — con la raíz cerrada (`additionalProperties: false`) la
        // causa más probable de este error es una sección NUEVA que todavía no
        // se declaró en el schema. Sin nombrar el archivo, el operador tiende a
        // borrar la sección buena creyendo que sobra.
        accion: 'ajustá las claves que lista el detalle; si es una sección nueva, declarala también en .pipeline/lib/config-schema.js',
    },
    // #5174 · CA-14.1 — causa PROPIA de la violación de lado. No reusa el texto
    // de `schema-invalido` porque su acción ("ajustá las claves que lista el
    // detalle… declarala en config-schema.js") aplicada a una sección de
    // autoridad infiltrada del lado producto instruye COMPLETARLA ahí, que es
    // exactamente la escalada de privilegio que la partición impide.
    'lado-invalido': {
        texto: 'hay claves en el archivo equivocado de la configuración partida',
        accion: 'mové cada clave al archivo que indica el detalle (la autoridad vive SIEMPRE en '
            + `${KERNEL_CONFIG_FILE}); no la completes ni la declares en el archivo donde está`,
    },
    // #5174 — JSON del manifiesto de producto ilegible. Se distingue del YAML
    // porque el operador tiene que abrir OTRO archivo.
    'json-invalido': {
        texto: 'JSON inválido en el manifiesto de producto',
        accion: `corregí ${PRODUCT_CONFIG_FILE} (suele ser una coma de más o una comilla sin cerrar)`,
    },
    // #5174 · REQ-SEC-C3 — clave con forma de prototype pollution.
    'clave-prohibida': {
        texto: 'el manifiesto de producto declara una clave prohibida',
        accion: `borrá esa clave de ${PRODUCT_CONFIG_FILE}: '__proto__', 'constructor' y 'prototype' `
            + 'no son configuración, contaminan el prototipo y apagan fail-closeds que nadie declaró',
    },
    // #5174 · CA-3 — `PIPELINE_DIR_OVERRIDE` reubica los dos archivos o ninguno.
    'reubicacion-parcial': {
        texto: 'la reubicación de la configuración quedó a medias',
        accion: `el override tiene que llevar ${KERNEL_CONFIG_FILE} y ${PRODUCT_CONFIG_FILE} juntos; `
            + 'apuntar sólo uno mezcla el kernel de un checkout con el producto de otro',
    },
    // #5174 · CA-10 / REQ-SEC-C5 — canal genérico env→config, prohibido.
    'env-prohibida': {
        texto: 'hay una variable de entorno intentando inyectar configuración',
        accion: 'sacá esa variable del entorno: el override por env sale de una allowlist cerrada '
            + 'y enumerada en código, no de un patrón — y la autoridad no se override nunca',
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
    // #5174 · CA-14.5 — post-partición la promesa es sobre LOS DOS archivos: el
    // auto-recovery re-resuelve la configuración completa, así que corregir uno
    // solo NO levanta la pausa. Prometer "~30s" sin decirlo dejaba al operador
    // esperando una reanudación que no iba a llegar.
    'halt-auto': `la pausa se levanta sola en el próximo ciclo (~30s) cuando ${KERNEL_CONFIG_FILE} `
        + `y ${PRODUCT_CONFIG_FILE} parseen bien LOS DOS — no hace falta borrar ningún archivo`,
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
 * @param {{contexto?: string, repoRoot?: string, archivo?: string, via?: string,
 *          maxErrores?: number}} [opts]
 *        `contexto` ∈ {'halt-auto','halt-preexistente','cli'}; sin contexto la
 *        acción es sólo la de la tabla de causas (caso dashboard).
 *        `maxErrores` (#5173 CA-11) acota la lista de errores de schema para
 *        superficies con tope de tamaño (Telegram). Sin él sale completa, que
 *        es lo que consume el log en disco.
 * @returns {{ok: false, archivo: string, via: string, causa: string,
 *            linea: number|null, columna: number|null, detalle: string,
 *            accion: string, ts: string}}
 */
function describeConfigFailure(err, opts = {}) {
    const e = err && typeof err === 'object' ? err : {};
    // #5174 · CA-14.2 — PRECEDENCIA DE CAUSA. Una sección mal ubicada arrastra
    // detrás una cascada de `required` / `additionalProperties` de la sección que
    // quedó incompleta. Esos son CONSECUENCIA; la causa es el lado. Si no se
    // prioriza, el operador recibe "falta clave requerida 'enabled' en
    // firma_operador" y, siguiendo la instrucción al pie de la letra, completa
    // una sección de autoridad del lado producto.
    const hayLado = Array.isArray(e.errors) && e.errors.some((x) => x && x.keyword === 'side');
    const causa = hayLado ? 'lado-invalido' : (CAUSA_COPY[e.causa] ? e.causa : 'config-ilegible');
    const copy = CAUSA_COPY[causa];
    const linea = typeof e.linea === 'number' ? e.linea : null;
    const columna = typeof e.columna === 'number' ? e.columna : null;
    const archivoAbs = opts.archivo || e.archivo || null;
    const via = opts.via || e.via || 'default';

    // `detalle` sale YA redactado: la UI lo renderiza tal cual (CA-UX-5) y no
    // re-deriva copy desde `causa`.
    let detalle = copy.texto;
    if ((causa === 'yaml-invalido' || causa === 'json-invalido') && linea !== null) {
        detalle += ` — línea ${linea}` + (columna !== null ? `, col ${columna}` : '');
    } else if (causa === 'lado-invalido') {
        // #5174 · CA-14.3 — los errores de lado ya vienen al frente de la lista
        // (`validateConfig` / `checkSide` los anteponen), así que sobreviven al
        // recorte de `maxErrores`. Acá se los vuelve a filtrar para que la
        // superficie ACOTADA no gaste sus 5 líneas en consecuencias.
        const soloLado = e.errors.filter((x) => x && x.keyword === 'side');
        const lista = typeof opts.maxErrores === 'number'
            ? formatErrorsForHuman(soloLado, opts.maxErrores)
            : formatErrors(soloLado);
        if (lista) detalle += `: ${lista}`;
    } else if (causa === 'clave-prohibida' || causa === 'env-prohibida' || causa === 'reubicacion-parcial') {
        const lista = typeof opts.maxErrores === 'number'
            ? formatErrorsForHuman(e.errors, opts.maxErrores)
            : formatErrors(e.errors);
        if (lista) detalle += `: ${lista}`;
    } else if (causa === 'schema-invalido') {
        // `formatErrors(redactErrors(...))`: path + regla, nunca el valor crudo.
        // #5173 CA-11 — con `opts.maxErrores` la lista sale ACOTADA (superficies
        // con tope de tamaño: Telegram corta en 4096 chars y, con la raíz del
        // schema cerrada y `allErrors: true`, un config muy roto genera decenas
        // de errores). Sin `maxErrores` sale COMPLETA: es lo que consume el log
        // en disco, que es la vía de diagnóstico a la que apunta el copy.
        const detalleSchema = (typeof opts.maxErrores === 'number'
            ? formatErrorsForHuman(e.errors, opts.maxErrores)
            : formatErrors(e.errors)) || e.message || '';
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
    // #5173 — TODO lo interpolado acá deriva del INPUT (nombres de clave del
    // config.yaml del usuario, rutas de archivo). Sale con `parse_mode:
    // 'Markdown'` legacy, donde un metacaracter impar (`_` de snake_case, `*`,
    // backtick) tumba el mensaje ENTERO con 400 y la alerta del halt no llega.
    // `archivo` va dentro de un code span → sanitizado distinto (ver helpers).
    const via = opts.pausaPreexistente
        ? ''
        : `\n_(ruta resuelta vía ${escapeMarkdownLegacy(estado.via)})_`;
    return `${encabezado}\n\n`
        + `*Archivo:* \`${escapeMarkdownCodeSpan(estado.archivo)}\`${via}\n`
        + `*Causa:* ${escapeMarkdownLegacy(estado.detalle)}\n\n`
        + `*Qué hacer:* ${escapeMarkdownLegacy(estado.accion)}.`;
}

/**
 * Alerta Telegram de reanudación por auto-recovery (#4832).
 * @param {string} archivo - ruta ya formateada por `formatConfigPath`.
 * @returns {string}
 */
function formatConfigRecoveryTelegram(archivo) {
    return '✅ *Pipeline reanudado* — la configuración volvió a ser válida.\n\n'
        + `*Archivo:* \`${escapeMarkdownCodeSpan(archivo || '(desconocido)')}\`\n`
        + 'La pausa automática por configuración inválida se levantó sola (auto-recovery #4832).';
}

module.exports = {
    validateConfig,
    redactErrors,
    formatErrors,
    formatErrorsForHuman,
    sanitizeKeyName,
    escapeMarkdownLegacy,
    escapeMarkdownCodeSpan,
    resolveSide,
    checkSide,
    archivoDeLado,
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
    SIDE_MAP,
    AUTHORITY_PREFIXES,
    SCHEMA,
    KERNEL_CONFIG_FILE,
    PRODUCT_CONFIG_FILE,
};
