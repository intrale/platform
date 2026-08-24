// =============================================================================
// provider-contribution.js — Aporte real por proveedor + criterio de
// permanencia de la cadena multi-provider (#6145)
// =============================================================================
//
// QUE RESUELVE
// ------------
// Responde, con datos y de forma reejecutable, la pregunta del operador:
// "¿que proveedores gratuitos de la cadena me estan costando mas de lo que
// aportan?" — incluida la respuesta legitima "ninguno".
//
// Cierra CA-1 (tabla de aporte real), CA-2 (costo atribuido a la causa
// correcta), CA-3 (efecto en el pipeline) y CA-6 (criterio numerico de
// permanencia, apagado por default).
//
// INVARIANTES DE SEGURIDAD (REQ-SEC-1..7 del agente `security`)
// -------------------------------------------------------------
// 1. READ-ONLY ABSOLUTO. Este modulo no escribe NADA: ni config, ni el estado
//    de salud, ni el log de dispatch, ni la cadena de fallbacks. La unica
//    escritura del feature vive en el CLI (audit append-only con hash-chain).
// 2. SOLO METADATOS (REQ-SEC-1). Cada entrada del log se proyecta contra una
//    whitelist cerrada de campos (`ENTRY_FIELD_WHITELIST`). `raw_excerpt` —
//    que SI existe en el log real y puede contener texto de prompt — nunca
//    cruza esta frontera.
// 3. FUENTE UNICA: `.pipeline/logs/cross-provider-dispatch-*.jsonl`, que trae
//    hash-chain (`hash_prev`/`hash_self`). PROHIBIDO leer de
//    `.claude/activity-log.jsonl`: esa fuente mide sesiones de agente ya
//    arrancado y da CERO para tres proveedores que despachan cientos de veces
//    (gemini-google, cerebras, nvidia-nim) — decidir con ella daria de baja
//    justo a los que aportan. Hay un test que falla si este archivo la importa.
// 4. "SIN DATO" => `no_evaluable`, JAMAS "no aporta" (REQ-SEC-2c). Un proveedor
//    no sale de la cadena por silencio del log, por muestra chica ni por
//    cadena de hash rota.
// 5. EL CRITERIO MARCA CANDIDATOS; NUNCA EJECUTA LA BAJA (REQ-SEC-3). La baja
//    efectiva es un PR de configuracion trazable, en issue posterior.
// 6. NUNCA VACIA LA CADENA. Si el criterio dejara sin ningun sobreviviente a
//    la cadena que PUEDE tocar (la de los NO pagos), no marca a nadie. Los
//    pagos no cuentan como sobrevivientes: son `mantener` por construccion y
//    satisfarian el invariante de forma vacua (rev-2, BLOQUEANTE 1 del review).
// 7. NUNCA MARCA A UN PROVEEDOR PAGO por metrica automatica.
//
// El modulo es PURO: todas las dependencias entran por parametro (`fsImpl`,
// `now`, `auditLog`). No hace red, no spawnea procesos, no lee env.
// =============================================================================
'use strict';

const path = require('node:path');
const nodeFs = require('node:fs');
const defaultAuditLog = require('../audit-log');

// -----------------------------------------------------------------------------
// Constantes de dominio
// -----------------------------------------------------------------------------

/** Ventana minima exigida por CA-1. */
const DEFAULT_WINDOW_DAYS = 30;

const DISPATCH_PREFIX = 'cross-provider-dispatch-';
const DISPATCH_RE = /^cross-provider-dispatch-(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

/**
 * REQ-SEC-1 — whitelist cerrada de campos que salen del log. Todo lo demas
 * (en particular `raw_excerpt`, `chain_tried`, `issue`) se descarta en la
 * proyeccion. Si manana el dispatcher agrega un campo con texto libre, este
 * modulo no lo propaga por omision.
 */
const ENTRY_FIELD_WHITELIST = Object.freeze([
    'ts',
    'created_at',
    'event',
    'skill',
    'fallback_provider',
    'primary_provider',
    'fallback_index',
    'health_reason',
    'health_state',
]);

/**
 * Taxonomia de eventos (verificada linea por linea contra
 * `lib/agent-launcher/dispatch-with-fallback.js` por el agente `guru`).
 *
 *   win      — el proveedor efectivamente resolvio el pedido. UNICA senal de
 *              aporte real.
 *   block    — el proveedor fue considerado pero descartado. Cuenta en el
 *              denominador y se imputa a una familia de bloqueo.
 *   schedule — gateo por ventana horaria. EXCLUIDO del denominador: mide la
 *              politica de horarios, no al proveedor.
 *   operativo— salto por decision NUESTRA sobre el proveedor: el kill-switch
 *              operacional (#3811) y el freno de ritmo (#4289). EXCLUIDO del
 *              denominador por la misma razon que `schedule`.
 *   cupo_gate— el flag de cuota agotada de ESE proveedor esta activo
 *              (`quota-exhausted.shouldGateSpawn`). EXCLUIDO del denominador,
 *              con columna y nombre propios (ver nota rev-3 mas abajo).
 *   chain    — evento de cadena, no imputable a ningun proveedor individual.
 *
 * rev-2 (#6145): la taxonomia estaba INCOMPLETA. Sobre los 89 archivos diarios
 * del log real quedaban fuera `gated_no_fallbacks` (261), `provider_disabled`
 * (222) y `forced_provider_override` (2) — el hueco que el review detecto entre
 * `entriesRead` y `failoverCost.totalEvents`. Ahora estan clasificados, y
 * `computeFailoverCost` ademas reconcilia cualquier evento futuro en el bucket
 * `unclassified`: el total SIEMPRE cierra contra las entradas leidas.
 *
 * -----------------------------------------------------------------------------
 * rev-3 (#6145) — REBOTE DE `security`. DOS ERRORES DE CLASIFICACION.
 *
 * (A) BLOQUEANTE / REQ-SEC-3 — el kill-switch del operador bajaba la tasa de
 *     aporte del proveedor y lo empujaba a `candidato_baja`.
 *
 *     `provider_disabled` y `fallback_provider_disabled` son EL MISMO
 *     kill-switch #3811, evaluado por la MISMA funcion `_isProviderDisabled()`:
 *     el primero cuando el proveedor cae como PRIMARIO
 *     (`dispatch-with-fallback.js:1407` -> emision :1460), el segundo cuando cae
 *     como FALLBACK (:1822 -> emision :1829). Lo unico que cambia es la posicion
 *     en la cadena. rev-2 excluia el primero como `operativo` y contaba el
 *     segundo como `block`+`cupo`, es decir DENTRO del denominador.
 *
 *     El descuento era ademas VACUO sobre datos reales: en la ventana de 30 dias
 *     hay 2.661 `fallback_provider_disabled` y CERO `provider_disabled`, con lo
 *     cual `gatedByOperator` daba 0 para los cuatro gratuitos — los unicos que el
 *     criterio puede marcar — y el 100% de los saltos por kill-switch caia en el
 *     denominador. Medido sobre el log real: cerebras 719/3.163 = 22,7% con el
 *     kill-switch adentro contra 719/719 = 100% sin el, y sus 2.444 bloqueos son
 *     TODOS kill-switch. Reproducido en codigo: un proveedor con 10 intentos y 10
 *     exitos (100% de aciertos) mas 400 bloqueos del kill-switch daba
 *     `candidato_baja` por "tasa 2,4% < umbral 5,0%".
 *
 *     Es el modo de falla que REQ-SEC-3 existe para prevenir: apagamos un
 *     proveedor a mano y el criterio automatico lo lee como que el proveedor no
 *     aporta. El incidente del 19/08, auto-infligido y permanente.
 *
 *     `fallback_pacing_budget_red` sale de esa MISMA rama (:1829, es el ternario
 *     que distingue `_disabledSourceOf(fb) === 'pacing'`) y #4289 lo define como
 *     "una preferencia de ritmo, NO un override de permisos". Tambien es una
 *     decision nuestra => tambien `operativo`. Hoy tiene 0 eventos en la ventana,
 *     pero dejarlo como `block` reabriria el mismo agujero apenas se use.
 *     `OPERATOR_GATE_SOURCE` mantiene separados kill-switch y pacing para que el
 *     reporte no los funda en una sola cifra.
 *
 * (B) MEDIA — `fallback_also_gated` (41.600 eventos) se rotulaba `schedule`,
 *     pero NO tiene nada que ver con la ventana horaria: sale de
 *     `quotaModule.shouldGateSpawn(skill, {provider})`
 *     (`dispatch-with-fallback.js:1797` -> emision :1805), que es el flag de
 *     cuota agotada de ESE proveedor (`quota-exhausted.js:1802`). Contarlo como
 *     "politica horaria" le imputaba a la ventana horaria 41.600 eventos que son
 *     de cupo, y el documento publicaba esa suma como tal.
 *
 *     Se le da kind propio `cupo_gate`, columna propia y nombre real. Sigue
 *     FUERA del denominador, y el motivo NO es que sea "politica nuestra" sino
 *     amplificacion: `shouldGateSpawn` lee un flag que queda activo durante toda
 *     la ventana de agotamiento, de modo que CADA intento de dispatch mientras
 *     dura emite un evento. La cuenta mide "duracion del corte x trafico del
 *     pipeline", no cuantas veces el proveedor se nego. Meterla en una tasa mide
 *     lo ocupado que estaba el pipeline durante el corte.
 *
 *     Esto no ciega al criterio frente a un gratuito permanentemente seco: ese
 *     proveedor tiene 0 `wins`, y sin muestra evaluable cae en `no_evaluable`,
 *     que es exactamente lo que manda el invariante 2 del body ("sin dato => NO
 *     EVALUABLE, jamas 'no aporta'").
 * -----------------------------------------------------------------------------
 */
const EVENT_KIND = Object.freeze({
    fallback_selected: 'win',
    fallback_health_gated: 'block',
    fallback_no_credentials: 'block',
    chain_exhausted: 'chain',
    primary_inactive_by_schedule: 'schedule',
    fallback_provider_inactive_by_schedule: 'schedule',
    // --- rev-3: el kill-switch del operador NUNCA entra en el denominador ----
    // Kill-switch operacional #3811, evaluado por `_isProviderDisabled()`:
    //   `provider_disabled`          -> el proveedor caia como PRIMARIO (:1460)
    //   `fallback_provider_disabled` -> el mismo, como FALLBACK       (:1829)
    //   `fallback_pacing_budget_red` -> misma rama, origen 'pacing'   (:1829)
    // Los tres los imputa el OPERADOR/nuestro pacing, no el proveedor.
    provider_disabled: 'operativo',
    fallback_provider_disabled: 'operativo',
    fallback_pacing_budget_red: 'operativo',
    // --- rev-3: cuota del proveedor, NO ventana horaria ----------------------
    fallback_also_gated: 'cupo_gate',
    // --- rev-2: eventos reales que faltaban en la taxonomia ------------------
    // Cadena sin fallbacks declarados (`dispatch-with-fallback.js:1539`): es un
    // evento de cadena, no imputable a un proveedor individual.
    gated_no_fallbacks: 'chain',
    // Forzado manual del smoke-test (`dispatch-with-fallback.js:1238`, :1178,
    // :1202). No es aporte ni bloqueo del proveedor.
    forced_provider_override: 'chain',
    forced_provider_override_ignored: 'chain',
    forced_provider_override_invalid_provider: 'chain',
});

/**
 * rev-3 (#6145) — origen del gateo `operativo`, para que el reporte pueda
 * distinguir "lo apagamos a mano" de "le frenamos el ritmo" en vez de publicar
 * una sola cifra que mezcla dos decisiones distintas del operador.
 */
const OPERATOR_GATE_SOURCE = Object.freeze({
    provider_disabled: 'kill_switch',
    fallback_provider_disabled: 'kill_switch',
    fallback_pacing_budget_red: 'pacing',
});

/**
 * Familia de bloqueo por evento. `fallback_health_gated` se refina despues
 * segun `health_reason` (ver `blockFamilyForHealthReason`).
 *
 * rev-3 (#6145): `fallback_provider_disabled` y `fallback_pacing_budget_red`
 * salieron de aca al dejar de ser `block`. La familia `cupo` sobrevive unicamente
 * por `health_reason` (`quota_exhausted`), que SI es un veredicto del proveedor
 * sobre su propia cuota y no una decision nuestra.
 */
const BLOCK_FAMILY_BY_EVENT = Object.freeze({
    fallback_no_credentials: 'credencial',
});

/**
 * Clasificacion de `health_reason` en tres familias que NO se mezclan (CA-UX y
 * riesgo 3 del body):
 *
 *   observabilidad_local — el rojo es NUESTRO, no del proveedor. Un flag de
 *       entorno o un binario ausente del PATH no son un veredicto sobre el
 *       proveedor. NUNCA habilita la baja: fuerza `rol_acotado` como techo.
 *   credencial — credencial invalida/ausente/403.
 *   cupo — cuota agotada; recuperable por diseno.
 *
 * Los reason_code salen de la allowlist cerrada de `health-alerts` y del set
 * `DURABLE_RED_REASONS` de `dispatch-with-fallback.js:749`.
 */
const HEALTH_REASON_FAMILY = Object.freeze({
    cli_license_unavailable: 'observabilidad_local',
    cli_unavailable: 'observabilidad_local',
    cli_binary_undeclared: 'observabilidad_local',
    unknown_provider: 'observabilidad_local',
    invalid_credentials: 'credencial',
    no_key_configured: 'credencial',
    forbidden: 'credencial',
    quota_exhausted: 'cupo',
    quota_exhausted_real: 'cupo',
});

/** Identificadores internos del veredicto (JSON + audit, nunca UI). */
const VERDICT = Object.freeze({
    MANTENER: 'mantener',
    ROL_ACOTADO: 'rol_acotado',
    CANDIDATO_BAJA: 'candidato_baja',
    NO_EVALUABLE: 'no_evaluable',
    SIN_DECLARAR: 'sin_declarar',
});

/**
 * CA-UX-2 — exactamente cinco literales en espanol, sin abreviar, para el texto
 * que lee el operador. Los ids internos viven en el JSON y en el audit.
 */
const VERDICT_LABEL = Object.freeze({
    [VERDICT.MANTENER]: 'mantener',
    [VERDICT.ROL_ACOTADO]: 'rol acotado',
    [VERDICT.CANDIDATO_BAJA]: 'candidato a baja',
    [VERDICT.NO_EVALUABLE]: 'no evaluable',
    [VERDICT.SIN_DECLARAR]: 'sin declarar',
});

/**
 * CA-UX-1 — vocabulario cerrado de ausencia. Ninguna celda queda vacia ni usa
 * `—`/`n/a`/`0` para representar "no se midio".
 */
const ABSENCE = Object.freeze({
    NO_INSTRUMENTADO: 'sin instrumentar (#6152)',
    SIN_MUESTRA: 'sin muestra',
    SIN_DECLARAR: 'sin declarar (#6153)',
    // rev-2 (#6145): `CADENA_ROTA` estaba declarada y no se usaba, y el reporte
    // decia "la cadena de hash no verifico (0 archivo/s con integridad rota)"
    // cuando la ventana estaba VACIA. "Sin datos" y "cadena rota" son dos cosas
    // distintas y ahora tienen literal propio y camino propio.
    CADENA_ROTA: 'cadena de hash rota',
    SIN_DATOS: 'sin datos en la ventana',
});

/** Defaults del criterio de permanencia (CA-6). Config los sobreescribe. */
const DEFAULT_THRESHOLDS = Object.freeze({
    enabled: false,
    window_days: DEFAULT_WINDOW_DAYS,
    min_sample: 200,
    min_contribution_rate: 0.05,
    max_days_without_win: 14,
    min_survivors: 1,
});

/**
 * El health-cron nombra a OpenAI/Codex como 'openai'; agent-models.json usa
 * 'openai-codex'. Mismo alias que `dispatch-with-fallback.js:772`.
 */
const HEALTH_PROVIDER_ALIAS = Object.freeze({ 'openai-codex': 'openai' });

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// -----------------------------------------------------------------------------
// Helpers puros
// -----------------------------------------------------------------------------

function utcDayKey(ms) {
    const d = new Date(ms);
    return [
        d.getUTCFullYear(),
        String(d.getUTCMonth() + 1).padStart(2, '0'),
        String(d.getUTCDate()).padStart(2, '0'),
    ].join('-');
}

/** Timestamp de una entrada. El log real usa `created_at` (epoch ms). */
function entryTimestamp(entry) {
    if (!entry) return NaN;
    if (Number.isFinite(entry.created_at)) return entry.created_at;
    if (typeof entry.created_at === 'string') {
        const p = Date.parse(entry.created_at);
        if (Number.isFinite(p)) return p;
    }
    if (typeof entry.ts === 'string') {
        const p = Date.parse(entry.ts);
        if (Number.isFinite(p)) return p;
    }
    if (Number.isFinite(entry.ts)) return entry.ts;
    return NaN;
}

/**
 * REQ-SEC-1 — proyecta una entrada cruda contra la whitelist. Devuelve un
 * objeto nuevo: nada que no este en `ENTRY_FIELD_WHITELIST` sobrevive.
 */
function projectEntry(entry) {
    const out = {};
    if (!entry || typeof entry !== 'object') return out;
    for (const field of ENTRY_FIELD_WHITELIST) {
        if (Object.prototype.hasOwnProperty.call(entry, field)) out[field] = entry[field];
    }
    return out;
}

/** Proveedor al que se imputa el evento (o null si no es imputable). */
const PRIMARY_ATTRIBUTED_EVENTS = Object.freeze(new Set([
    'primary_inactive_by_schedule',
    // rev-2: el kill-switch nombra al primario, no trae `fallback_provider`.
    'provider_disabled',
]));

function providerOf(entry) {
    if (!entry) return null;
    if (PRIMARY_ATTRIBUTED_EVENTS.has(entry.event)) {
        return typeof entry.primary_provider === 'string' ? entry.primary_provider : null;
    }
    return typeof entry.fallback_provider === 'string' ? entry.fallback_provider : null;
}

function blockFamilyForHealthReason(reason) {
    if (!reason) return 'salud_sin_causa';
    return HEALTH_REASON_FAMILY[reason] || 'salud_proveedor';
}

function blockFamilyOf(entry) {
    if (entry.event === 'fallback_health_gated') {
        return blockFamilyForHealthReason(entry.health_reason);
    }
    return BLOCK_FAMILY_BY_EVENT[entry.event] || 'otro';
}

/**
 * Reparto por rol (CA-1). Se deriva del campo `skill`, presente en todos los
 * eventos — no requiere fuente nueva.
 *
 * Conversacional = lo que atiende a una persona en tiempo real: el Commander y
 * Sherlock, que en el log real aparecen como `telegram-commander` y
 * `telegram-sherlock` (verificado sobre la ventana: son los dos unicos skills
 * con prefijo `telegram-`). Todo el resto son agentes del pipeline.
 */
const CONVERSATIONAL_SKILLS = Object.freeze(new Set(['commander', 'sherlock']));

function roleOf(skill) {
    if (typeof skill !== 'string') return 'pipeline';
    if (CONVERSATIONAL_SKILLS.has(skill)) return 'conversacional';
    return skill.startsWith('telegram-') ? 'conversacional' : 'pipeline';
}

// -----------------------------------------------------------------------------
// listDispatchFiles — archivos diarios de la ventana
// -----------------------------------------------------------------------------

/**
 * @param {string} pipelineDir  Raiz `.pipeline/`.
 * @param {{from:number,to:number,fsImpl?:object}} opts  Ventana en epoch ms.
 * @returns {string[]} Paths absolutos ordenados por fecha ascendente.
 */
function listDispatchFiles(pipelineDir, opts = {}) {
    const _fs = opts.fsImpl || nodeFs;
    const dir = path.join(pipelineDir, 'logs');
    let names = [];
    try {
        if (!_fs.existsSync(dir)) return [];
        names = _fs.readdirSync(dir);
    } catch {
        return [];
    }
    const fromKey = Number.isFinite(opts.from) ? utcDayKey(opts.from) : null;
    const toKey = Number.isFinite(opts.to) ? utcDayKey(opts.to) : null;

    return names
        .filter((n) => DISPATCH_RE.test(n))
        .filter((n) => {
            const key = n.slice(DISPATCH_PREFIX.length, -'.jsonl'.length);
            if (fromKey && key < fromKey) return false;
            if (toKey && key > toKey) return false;
            return true;
        })
        .sort()
        .map((n) => path.join(dir, n));
}

// -----------------------------------------------------------------------------
// readWindow — lectura + verificacion de integridad (REQ-SEC-2)
// -----------------------------------------------------------------------------

/**
 * Lee la ventana completa y verifica la hash-chain de CADA archivo diario
 * antes de devolver nada. La verificacion es por archivo porque cada dia
 * arranca su propia chain en GENESIS.
 *
 * Devuelve SOLO entradas proyectadas (whitelist) y dentro de la ventana.
 *
 * @returns {{entries:object[], integrity:{chainOk:boolean, filesChecked:number,
 *   brokenFiles:string[], entriesRead:number, from:number, to:number}}}
 */
function readWindow(opts = {}) {
    const _fs = opts.fsImpl || nodeFs;
    const _auditLog = opts.auditLog || defaultAuditLog;
    const { pipelineDir, from, to } = opts;

    const files = listDispatchFiles(pipelineDir, { from, to, fsImpl: _fs });
    const brokenFiles = [];
    const entries = [];

    for (const file of files) {
        let verdict;
        try {
            verdict = _auditLog.verifyChain(file, _fs);
        } catch (err) {
            verdict = { ok: false, reason: err && err.message };
        }
        if (!verdict || !verdict.ok) {
            brokenFiles.push(path.basename(file));
            // Chain rota: NO alimentamos el criterio con este archivo. La
            // decision correcta ante integridad dudosa es `no_evaluable`,
            // no "no aporta".
            continue;
        }
        let raw;
        try {
            raw = _auditLog.readAll(file, _fs);
        } catch {
            brokenFiles.push(path.basename(file));
            continue;
        }
        for (const item of raw) {
            const ts = entryTimestamp(item);
            if (!Number.isFinite(ts)) continue;
            if (Number.isFinite(from) && ts < from) continue;
            if (Number.isFinite(to) && ts > to) continue;
            const projected = projectEntry(item);
            projected._ts = ts;
            entries.push(projected);
        }
    }

    return {
        entries,
        integrity: {
            // rev-2 (#6145): `chainOk:false` con `filesChecked:0` hacia que el
            // reporte dijera "la cadena no verifico (0 archivo/s con integridad
            // rota)" — una frase autocontradictoria. `noData` separa los dos
            // casos: NO HAY VENTANA (nada que verificar) vs LA VENTANA MIENTE.
            // Los dos frenan la decision, pero por razones distintas y con
            // mensajes distintos.
            chainOk: brokenFiles.length === 0 && files.length > 0,
            noData: files.length === 0,
            chainBroken: brokenFiles.length > 0,
            filesChecked: files.length,
            brokenFiles,
            entriesRead: entries.length,
            from: Number.isFinite(from) ? from : null,
            to: Number.isFinite(to) ? to : null,
        },
    };
}

// -----------------------------------------------------------------------------
// computeContribution — CA-1
// -----------------------------------------------------------------------------

/**
 * Agrega las entradas por proveedor.
 *
 * INVARIANTE DEL DENOMINADOR (riesgo 2 y 3 del body, confirmado por `guru`):
 *   evaluables = attempts - gatedBySchedule - gatedByOperator
 *                        - gatedByLocalObservability - gatedByQuotaFlag
 *
 * Los primeros tres descuentos son causas NUESTRAS, no del proveedor: la ventana
 * horaria, el kill-switch/pacing del operador y un chequeo de salud que se pone
 * rojo por un flag de entorno propio. Ninguna puede bajarle la tasa de aporte a
 * un proveedor. El 50,7% de los eventos de la ventana real es gateo por ventana
 * horaria: incluirlo mide la politica de horarios, no al proveedor.
 *
 * rev-3 (#6145) — el cuarto descuento, `gatedByQuotaFlag`, tiene otro motivo: no
 * es una politica nuestra sino una cuenta AMPLIFICADA. `fallback_also_gated` se
 * emite en cada intento de dispatch mientras el flag de cuota del proveedor esta
 * activo, con lo cual mide "duracion del corte x trafico del pipeline" y no
 * cuantas veces el proveedor se nego. Ver la nota rev-3 (B) en `EVENT_KIND`.
 *
 * rev-3 (#6145) — `gatedByOperator` dejo de ser una columna vacia. Antes solo
 * contaba `provider_disabled` (0 eventos reales en la ventana) mientras los
 * 2.661 `fallback_provider_disabled` — el MISMO kill-switch, sobre el mismo
 * proveedor, en posicion de fallback — caian en el denominador y hundian la
 * tasa. Ver la nota rev-3 (A) en `EVENT_KIND`.
 *
 * @param {object[]} entries  Entradas ya proyectadas (salida de `readWindow`).
 * @param {{now?:number, healthSnapshot?:object}} [opts]
 * @returns {Object<string, object>} Metricas por proveedor.
 */
function computeContribution(entries, opts = {}) {
    const byProvider = Object.create(null);
    const healthByProvider = indexHealth(opts.healthSnapshot);

    const ensure = (name) => {
        if (!byProvider[name]) {
            byProvider[name] = {
                provider: name,
                attempts: 0,
                gatedBySchedule: 0,
                gatedByOperator: 0,
                // rev-3 (#6145) — desglose del gateo operativo: el kill-switch
                // manual (#3811) y el freno de ritmo (#4289) son dos decisiones
                // distintas del operador y el reporte no puede fundirlas.
                operatorGates: { kill_switch: 0, pacing: 0 },
                gatedByQuotaFlag: 0,
                gatedByLocalObservability: 0,
                evaluables: 0,
                wins: 0,
                contributionRate: null,
                blocks: Object.create(null),
                dominantBlock: null,
                healthReasons: Object.create(null),
                lastWinAt: null,
                firstSeenAt: null,
                lastSeenAt: null,
                roleWins: { conversacional: 0, pipeline: 0 },
                roleSplitPct: null,
                lastPingMs: null,
                lastPingAt: null,
                lastPingReason: ABSENCE.NO_INSTRUMENTADO,
                skills: Object.create(null),
            };
        }
        return byProvider[name];
    };

    for (const entry of entries || []) {
        const kind = EVENT_KIND[entry.event];
        if (!kind || kind === 'chain') continue;      // no imputable a un proveedor
        const name = providerOf(entry);
        if (!name) continue;

        const m = ensure(name);
        const ts = Number.isFinite(entry._ts) ? entry._ts : entryTimestamp(entry);
        if (Number.isFinite(ts)) {
            if (m.firstSeenAt === null || ts < m.firstSeenAt) m.firstSeenAt = ts;
            if (m.lastSeenAt === null || ts > m.lastSeenAt) m.lastSeenAt = ts;
        }

        m.attempts += 1;
        if (kind === 'schedule') {
            m.gatedBySchedule += 1;
            continue;                                  // fuera del denominador
        }
        if (kind === 'operativo') {
            // Kill-switch / pacing del operador: misma clase que el gateo
            // horario. rev-3 (#6145): incluye `fallback_provider_disabled`, que
            // hasta rev-2 caia en el denominador siendo el MISMO kill-switch.
            m.gatedByOperator += 1;
            const src = OPERATOR_GATE_SOURCE[entry.event] || 'kill_switch';
            m.operatorGates[src] = (m.operatorGates[src] || 0) + 1;
            continue;                                  // fuera del denominador
        }
        if (kind === 'cupo_gate') {
            // rev-3 (#6145): flag de cuota agotada del proveedor. Fuera del
            // denominador por amplificacion (un corte = miles de eventos), con
            // columna propia para no imputarselo a la ventana horaria.
            m.gatedByQuotaFlag += 1;
            continue;                                  // fuera del denominador
        }

        // ---------------------------------------------------------------------
        // rev-2 (#6145) — INVARIANTE 3 DEL BODY, ahora en el DENOMINADOR.
        //
        // "Un gateo durable por observabilidad (p.ej. `cli_license_unavailable`,
        //  que es un flag de env, no un veredicto del proveedor) NO baja la tasa
        //  de aporte: va a la columna `bloqueo_observabilidad`."
        //
        // Hasta rev-1 el gateo por causa NUESTRA si entraba en `evaluables` y
        // solo se compensaba a nivel veredicto (techo `rol_acotado`). Es decir:
        // la tasa SI bajaba, contra lo que manda el body. Se excluye del
        // denominador y se contabiliza en su columna propia; el techo
        // `rol_acotado` se mantiene como segunda linea de defensa.
        // ---------------------------------------------------------------------
        const localObservabilityGate = kind === 'block'
            && entry.event === 'fallback_health_gated'
            && blockFamilyForHealthReason(entry.health_reason) === 'observabilidad_local';
        if (localObservabilityGate) {
            m.gatedByLocalObservability += 1;
            m.blocks.observabilidad_local = (m.blocks.observabilidad_local || 0) + 1;
            if (entry.health_reason) {
                m.healthReasons[entry.health_reason] = (m.healthReasons[entry.health_reason] || 0) + 1;
            }
            continue;                                  // fuera del denominador
        }

        m.evaluables += 1;

        if (kind === 'win') {
            m.wins += 1;
            if (Number.isFinite(ts) && (m.lastWinAt === null || ts > m.lastWinAt)) m.lastWinAt = ts;
            const role = roleOf(entry.skill);
            m.roleWins[role] += 1;
            const sk = entry.skill || 'desconocido';
            m.skills[sk] = (m.skills[sk] || 0) + 1;
            continue;
        }

        // kind === 'block'
        const family = blockFamilyOf(entry);
        m.blocks[family] = (m.blocks[family] || 0) + 1;
        if (entry.event === 'fallback_health_gated' && entry.health_reason) {
            m.healthReasons[entry.health_reason] = (m.healthReasons[entry.health_reason] || 0) + 1;
        }
    }

    for (const m of Object.values(byProvider)) {
        m.contributionRate = m.evaluables > 0 ? m.wins / m.evaluables : null;
        m.dominantBlock = dominantKey(m.blocks);
        m.dominantHealthReason = dominantKey(m.healthReasons);
        m.blockedByLocalObservability = m.dominantBlock === 'observabilidad_local';
        m.roleSplitPct = splitPct(m.roleWins);

        const health = healthByProvider[HEALTH_PROVIDER_ALIAS[m.provider] || m.provider]
            || healthByProvider[m.provider]
            || null;
        // ---------------------------------------------------------------------
        // rev-2 (#6145) — ESTO NO ES UNA MEDIANA, Y AHORA SE LLAMA COMO ES.
        //
        // CA-1 pide "latencia mediana sobre una ventana de al menos 30 dias".
        // El log de dispatch NO trae latencia por invocacion: la unica fuente es
        // `state/multi-provider-health.json`, que guarda el resultado de UN
        // live-ping puntual (el ultimo). Rotularlo "latencia mediana" fue un
        // error de rev-1: el review midio 15,9 s -> 2,3 s -> 1,26 s para
        // nvidia-nim en tres observaciones del mismo dia.
        //
        // Decision (rebote rev-2): NO se estima una mediana que no existe — el
        // body prohibe inventar el numero — se reporta lo que hay con su nombre
        // real (`ultimo live-ping`), su fecha y la advertencia de volatilidad.
        // La mediana real requiere instrumentar latencia por invocacion: #6152.
        // Ningun veredicto ni recomendacion se apoya en este numero.
        // ---------------------------------------------------------------------
        if (health && Number.isFinite(health.latency_ms)) {
            m.lastPingMs = health.latency_ms;
            m.lastPingAt = health.ts || (opts.healthSnapshot && opts.healthSnapshot.ts) || null;
            m.lastPingReason = null;
        } else {
            // Los proveedores CLI-OAuth no estan instrumentados — se dice, no se
            // estima. Prohibido derivarlo de `duration_ms` del activity-log
            // (wall-clock del agente, p50 ~602s).
            m.lastPingMs = null;
            m.lastPingAt = null;
            m.lastPingReason = ABSENCE.NO_INSTRUMENTADO;
        }
        m.healthState = health ? (health.state || null) : null;
        m.healthReasonCode = health ? (health.reason_code || null) : null;
    }

    return byProvider;
}

function indexHealth(snapshot) {
    const idx = Object.create(null);
    if (!snapshot || !Array.isArray(snapshot.providers)) return idx;
    for (const p of snapshot.providers) {
        if (p && typeof p.provider === 'string') idx[p.provider] = p;
    }
    return idx;
}

function dominantKey(counter) {
    let best = null;
    let bestN = 0;
    for (const [k, n] of Object.entries(counter || {})) {
        if (n > bestN || (n === bestN && best !== null && k < best)) {
            best = k;
            bestN = n;
        }
    }
    return best;
}

function splitPct(roleWins) {
    const total = (roleWins.conversacional || 0) + (roleWins.pipeline || 0);
    if (total === 0) return null;                      // CA-UX-1: sin muestra != 0%
    const conv = Math.round((roleWins.conversacional / total) * 100);
    return { conversacional: conv, pipeline: 100 - conv };
}

// -----------------------------------------------------------------------------
// evaluatePermanence — CA-6
// -----------------------------------------------------------------------------

/**
 * Aplica el criterio numerico de permanencia.
 *
 * @param {Object<string,object>} metrics  Salida de `computeContribution`.
 * @param {object} thresholds              Umbrales (config `multi_provider.permanence`).
 * @param {{chainOk:boolean, declared?:Object<string,{billing?:string,declaredInConfig?:boolean}>,
 *   now?:number}} chainCtx
 * @returns {Object<string,object>} Veredicto por proveedor.
 */
function evaluatePermanence(metrics, thresholds, chainCtx = {}) {
    const t = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
    const declared = chainCtx.declared || {};
    const chainOk = chainCtx.chainOk !== false;
    const now = Number.isFinite(chainCtx.now) ? chainCtx.now : null;

    // La union de proveedores es log ∪ config: un proveedor declarado que no
    // aparecio en la ventana tambien tiene que figurar (como `no_evaluable`,
    // nunca como "no aporta").
    const names = new Set([...Object.keys(metrics || {}), ...Object.keys(declared)]);
    const out = Object.create(null);

    for (const name of names) {
        const m = (metrics && metrics[name]) || null;
        const def = declared[name] || null;
        const reasons = [];
        let verdict;

        if (!def || def.declaredInConfig === false) {
            // Participa del dispatch pero no esta declarado en la configuracion
            // operativa (#6153). Se reporta, no se evalua, y jamas es candidato
            // a baja: evaluarlo con umbrales inexistentes seria peor que no
            // evaluarlo.
            verdict = VERDICT.SIN_DECLARAR;
            reasons.push(
                def
                    ? 'declarado en agent-models.json pero ausente de config.yaml (#6153)'
                    : 'ausente de agent-models.json y de config.yaml (#6153)',
            );
        } else if (!chainOk) {
            // REQ-SEC-2 — integridad rota o ventana vacia: no se decide sobre
            // NADIE. rev-2: el motivo distingue los dos casos en vez de
            // fusionarlos en una frase que suena a corrupcion cuando en realidad
            // no hay un solo archivo que leer.
            verdict = VERDICT.NO_EVALUABLE;
            reasons.push(
                chainCtx.noData === true
                    ? `${ABSENCE.SIN_DATOS}: no hay archivos de dispatch que verificar`
                    : `${ABSENCE.CADENA_ROTA}: la ventana no es confiable para decidir`,
            );
        } else if (def.billing === 'paid') {
            // REQ-SEC-3 — un proveedor pago nunca sale por metrica automatica.
            // El chequeo va ANTES del de muestra: el criterio no aplica a los
            // pagos en ninguna circunstancia, con o sin datos.
            verdict = VERDICT.MANTENER;
            reasons.push('proveedor pago: excluido del criterio automatico');
        } else if (!m || m.evaluables < t.min_sample) {
            // REQ-SEC-2c — muestra insuficiente NO es "no aporta".
            verdict = VERDICT.NO_EVALUABLE;
            reasons.push(
                `muestra insuficiente: ${m ? m.evaluables : 0} intentos evaluables < min_sample=${t.min_sample}`,
            );
        } else {
            const rate = m.contributionRate;
            const daysSinceWin = m.lastWinAt !== null && now !== null
                ? (now - m.lastWinAt) / MS_PER_DAY
                : null;

            const lowRate = rate !== null && rate < t.min_contribution_rate;
            const stale = m.lastWinAt === null
                || (daysSinceWin !== null && daysSinceWin > t.max_days_without_win);

            if (lowRate) {
                reasons.push(
                    `tasa de aporte ${(rate * 100).toFixed(1)}% < umbral ${(t.min_contribution_rate * 100).toFixed(1)}%`,
                );
            }
            if (stale) {
                reasons.push(
                    m.lastWinAt === null
                        ? 'sin ningun aporte real en la ventana'
                        : `ultimo aporte hace ${daysSinceWin.toFixed(1)} dias > umbral ${t.max_days_without_win}`,
                );
            }

            if (!lowRate && !stale) {
                verdict = VERDICT.MANTENER;
                reasons.push(
                    `aporta ${m.wins} veces sobre ${m.evaluables} intentos evaluables (${(rate * 100).toFixed(1)}%)`,
                );
            } else if (m.blockedByLocalObservability) {
                // Riesgo 3 del body: el proveedor no rinde porque un problema
                // NUESTRO de observabilidad lo esta gateando (p.ej.
                // `cli_license_unavailable`, que es un flag de env y no un
                // veredicto del proveedor). Techo `rol_acotado`: se reduce su
                // rol, NUNCA se propone la baja sin corregir antes el chequeo.
                verdict = VERDICT.ROL_ACOTADO;
                reasons.push(
                    `bloqueo dominante por observabilidad local (${m.dominantHealthReason || 'sin causa'}): `
                    + 'el bajo aporte es atribuible a un chequeo propio, no al proveedor',
                );
            } else {
                verdict = VERDICT.CANDIDATO_BAJA;
            }
        }

        out[name] = {
            provider: name,
            verdict,
            verdictLabel: VERDICT_LABEL[verdict],
            reasons,
            declared: Boolean(def),
            billing: def ? (def.billing || null) : null,
            evidence: m
                ? {
                    attempts: m.attempts,
                    gatedBySchedule: m.gatedBySchedule,
                    // rev-3 (#6145) — el audit debe dejar constancia de cuanto
                    // del descarte fue decision NUESTRA. Sin estas dos cifras el
                    // registro no permite auditar si un `candidato_baja` estaba
                    // contaminado por el kill-switch (REQ-SEC-3).
                    gatedByOperator: m.gatedByOperator,
                    operatorGates: { ...m.operatorGates },
                    gatedByQuotaFlag: m.gatedByQuotaFlag,
                    evaluables: m.evaluables,
                    wins: m.wins,
                    contributionRate: m.contributionRate,
                    dominantBlock: m.dominantBlock,
                    dominantHealthReason: m.dominantHealthReason || null,
                    lastWinAt: m.lastWinAt,
                }
                : null,
        };
    }

    // -------------------------------------------------------------------------
    // INVARIANTE FINAL (REQ-SEC-3): el criterio NUNCA vacia la cadena.
    //
    // rev-2 (#6145) — BLOQUEANTE 1 DEL REVIEW. Hasta rev-1 los "sobrevivientes"
    // se contaban sobre TODOS los declarados. Como un proveedor pago es
    // `mantener` POR CONSTRUCCION (se excluye del criterio antes que cualquier
    // otro chequeo, unas lineas mas arriba), los 2 pagos satisfacian el
    // invariante de forma VACUA: el contador nunca bajaba de `min_survivors` y
    // el guard no se disparaba NUNCA para los gratuitos. Con el `declared` real
    // de produccion (anthropic + openai-codex pagos; gemini-google + cerebras +
    // nvidia-nim gratuitos) el criterio proponia vaciar la cadena de gratuitos
    // entera de una sola vez, sin que el invariante interviniera.
    //
    // Eso es exactamente el incidente del 19/08 que motiva el issue, pero
    // auto-infligido y permanente: los dos proveedores que "sostenian" el
    // invariante son justamente los que estaban caidos ese dia (Anthropic
    // apagado por horario, OpenAI sin cupo).
    //
    // CORRECCION: los sobrevivientes se cuentan SOLO entre los proveedores que
    // el criterio PUEDE marcar — los no-pagos. Un proveedor que el criterio no
    // puede tocar no puede acreditarse la supervivencia de la cadena.
    //
    // `no_evaluable` y `sin_declarar` NO cuentan como sobrevivientes: el
    // invariante se apoya solo en proveedores de los que SI sabemos que estan
    // aportando (`mantener`) o que se conservan a proposito (`rol_acotado`).
    // Es la direccion conservadora: ante duda, no se marca a nadie.
    // -------------------------------------------------------------------------
    const declaredVerdicts = Object.values(out).filter((v) => v.declared);
    const markable = declaredVerdicts.filter((v) => v.billing !== 'paid');
    const survivors = markable.filter(
        (v) => v.verdict === VERDICT.MANTENER || v.verdict === VERDICT.ROL_ACOTADO,
    );
    const candidates = markable.filter((v) => v.verdict === VERDICT.CANDIDATO_BAJA);

    const minSurvivors = Number.isFinite(t.min_survivors) ? t.min_survivors : 1;
    if (candidates.length > 0 && survivors.length < minSurvivors) {
        for (const c of candidates) {
            c.verdict = VERDICT.ROL_ACOTADO;
            c.verdictLabel = VERDICT_LABEL[VERDICT.ROL_ACOTADO];
            c.reasons.push(
                'invariante de cadena minima: marcarlo dejaria sin proveedores sanos a la cadena '
                + 'que el criterio puede tocar (los NO pagos; un pago es `mantener` por '
                + `construccion y no cuenta) — sobrevivientes=${survivors.length} < `
                + `min_survivors=${minSurvivors}, no se marca`,
            );
            c.chainInvariantApplied = true;
        }
    }

    return out;
}

// -----------------------------------------------------------------------------
// Presentacion — CA-UX-1..6
// -----------------------------------------------------------------------------

function fmtInt(n) {
    if (!Number.isFinite(n)) return ABSENCE.SIN_MUESTRA;
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function fmtRate(rate) {
    if (rate === null || !Number.isFinite(rate)) return ABSENCE.SIN_MUESTRA;
    return `${(rate * 100).toFixed(1).replace('.', ',')} %`;
}

function fmtLastPing(m) {
    if (Number.isFinite(m.lastPingMs)) {
        return m.lastPingMs >= 1000
            ? `${(m.lastPingMs / 1000).toFixed(1).replace('.', ',')} s`
            : `${m.lastPingMs} ms`;
    }
    return m.lastPingReason || ABSENCE.NO_INSTRUMENTADO;
}

function fmtInstant(ms) {
    if (!Number.isFinite(ms)) return ABSENCE.SIN_MUESTRA;
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

function fmtBlock(m) {
    if (!m.dominantBlock) return ABSENCE.SIN_MUESTRA;
    if (m.dominantBlock === 'observabilidad_local') {
        return `observabilidad local (\`${m.dominantHealthReason || 'sin causa'}\`)`;
    }
    return m.dominantBlock;
}

function fmtRole(m) {
    if (!m.roleSplitPct) return ABSENCE.SIN_MUESTRA;
    return `${m.roleSplitPct.conversacional} % / ${m.roleSplitPct.pipeline} %`;
}

/**
 * Tabla markdown de CA-1.
 *
 * CA-UX: filas ordenadas por aportes reales descendente; columnas en el orden
 * identidad -> volumen -> calidad -> causa -> recencia -> reparto -> veredicto;
 * ninguna celda vacia ni con `—`.
 *
 * @param {Object<string,object>} metrics
 * @param {{verdicts?:object, compact?:boolean}} [opts]
 */
function renderMarkdownTable(metrics, opts = {}) {
    const verdicts = opts.verdicts || {};
    const rows = Object.values(metrics || {}).sort((a, b) => {
        if (b.wins !== a.wins) return b.wins - a.wins;
        return a.provider < b.provider ? -1 : 1;
    });

    const verdictCell = (name) => {
        const v = verdicts[name];
        if (!v) return ABSENCE.SIN_MUESTRA;
        return v.verdict === VERDICT.SIN_DECLARAR
            ? `${v.verdictLabel} (#6153)`
            : v.verdictLabel;
    };

    if (opts.compact) {
        const head = '| Proveedor | Aportes | Tasa | Recomendación |\n|---|---:|---:|---|';
        if (!rows.length) {
            return `${head}\n| ${ABSENCE.SIN_MUESTRA} | ${ABSENCE.SIN_MUESTRA} `
                + `| ${ABSENCE.SIN_MUESTRA} | ${ABSENCE.SIN_MUESTRA} |`;
        }
        const body = rows.map((m) => `| ${[
            m.provider,
            fmtInt(m.wins),
            fmtRate(m.contributionRate),
            verdictCell(m.provider),
        ].join(' | ')} |`).join('\n');
        return `${head}\n${body}`;
    }

    const head = [
        '| Proveedor | Intentos evaluables | Aportes | Tasa | Último live-ping (no es mediana) '
        + '| Bloqueo dominante | Último aporte | Rol (conversacional / pipeline) | Recomendación |',
        '|---|---:|---:|---:|---|---|---|---|---|',
    ].join('\n');

    if (!rows.length) {
        return `${head}\n| ${ABSENCE.SIN_MUESTRA} | ${ABSENCE.SIN_MUESTRA} | ${ABSENCE.SIN_MUESTRA} `
            + `| ${ABSENCE.SIN_MUESTRA} | ${ABSENCE.SIN_MUESTRA} | ${ABSENCE.SIN_MUESTRA} `
            + `| ${ABSENCE.SIN_MUESTRA} | ${ABSENCE.SIN_MUESTRA} | ${ABSENCE.SIN_MUESTRA} |`;
    }

    const body = rows.map((m) => `| ${[
        m.provider,
        fmtInt(m.evaluables),
        fmtInt(m.wins),
        fmtRate(m.contributionRate),
        fmtLastPing(m),
        fmtBlock(m),
        fmtInstant(m.lastWinAt),
        fmtRole(m),
        verdictCell(m.provider),
    ].join(' | ')} |`).join('\n');

    return `${head}\n${body}`;
}

/**
 * CA-2 — separa el costo de failover por CAUSA. El entregable no puede
 * presentar el costo total como si fuera culpa de los gratuitos: la mitad es
 * politica horaria.
 */
function computeFailoverCost(entries) {
    const counts = Object.create(null);
    // rev-2 (#6145) — el review encontro 261 eventos que quedaban FUERA del
    // total (`entriesRead` 98.048 vs `totalEvents` 97.787) porque el bucle
    // salteaba todo evento ausente de la taxonomia. Los porcentajes se
    // calculaban entonces sobre un denominador que el propio reporte no
    // declaraba. Ahora `totalEvents` cuenta TODAS las entradas leidas y lo que
    // no encaja en ninguna familia cae, visible, en `unclassified`.
    let total = 0;
    const unclassifiedByEvent = Object.create(null);
    let unclassified = 0;
    for (const e of entries || []) {
        total += 1;
        counts[e.event] = (counts[e.event] || 0) + 1;
        if (!EVENT_KIND[e.event]) {
            unclassified += 1;
            unclassifiedByEvent[e.event] = (unclassifiedByEvent[e.event] || 0) + 1;
        }
    }
    const sum = (...names) => names.reduce((acc, n) => acc + (counts[n] || 0), 0);

    // rev-3 (#6145) — `fallback_also_gated` SALE de la politica horaria: es el
    // flag de cuota del proveedor (`shouldGateSpawn`). Publicar sus 41.600
    // eventos como "ventana horaria" era la mitad del hallazgo MEDIA del rebote.
    const schedule = sum(
        'primary_inactive_by_schedule',
        'fallback_provider_inactive_by_schedule',
    );
    const quotaFlag = sum('fallback_also_gated');
    // rev-3 (#6145) — el bucket del kill-switch publicaba "0 | 0,0%" mientras
    // habia 2.661 saltos por kill-switch contados como bloqueo del proveedor.
    const operator = sum(
        'provider_disabled',
        'fallback_provider_disabled',
        'fallback_pacing_budget_red',
    );
    const providerBlocks = sum(
        'fallback_health_gated',
        'fallback_no_credentials',
    );
    const wins = sum('fallback_selected');
    const chain = sum(
        'chain_exhausted',
        'gated_no_fallbacks',
        'forced_provider_override',
        'forced_provider_override_ignored',
        'forced_provider_override_invalid_provider',
    );
    const pct = (n) => (total > 0 ? Number(((n / total) * 100).toFixed(1)) : null);

    const out = {
        totalEvents: total,
        byEvent: counts,
        scheduleGating: { events: schedule, pct: pct(schedule) },
        quotaFlagGating: { events: quotaFlag, pct: pct(quotaFlag) },
        operatorGating: {
            events: operator,
            pct: pct(operator),
            // rev-3 (#6145) — desglose para que "kill-switch del operador" no se
            // lea como un unico numero opaco.
            killSwitch: sum('provider_disabled', 'fallback_provider_disabled'),
            pacing: sum('fallback_pacing_budget_red'),
        },
        providerBlocking: { events: providerBlocks, pct: pct(providerBlocks) },
        wins: { events: wins, pct: pct(wins) },
        chainExhausted: { events: chain, pct: pct(chain) },
        unclassified: { events: unclassified, pct: pct(unclassified), byEvent: unclassifiedByEvent },
    };
    // Contrato explicito: los buckets cierran contra el total, siempre.
    out.reconciles = (schedule + quotaFlag + operator + providerBlocks + wins + chain + unclassified) === total;
    return out;
}

module.exports = {
    // Contrato declarado por el arquitecto
    DEFAULT_WINDOW_DAYS,
    listDispatchFiles,
    readWindow,
    computeContribution,
    evaluatePermanence,
    renderMarkdownTable,
    // CA-2
    computeFailoverCost,
    // Constantes / helpers exportados para tests y para el CLI
    DEFAULT_THRESHOLDS,
    EVENT_KIND,
    OPERATOR_GATE_SOURCE,
    ENTRY_FIELD_WHITELIST,
    HEALTH_REASON_FAMILY,
    HEALTH_PROVIDER_ALIAS,
    CONVERSATIONAL_SKILLS,
    VERDICT,
    VERDICT_LABEL,
    ABSENCE,
    MS_PER_DAY,
    projectEntry,
    entryTimestamp,
    blockFamilyOf,
    roleOf,
};
