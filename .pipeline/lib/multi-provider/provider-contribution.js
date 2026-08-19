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
// 6. NUNCA VACIA LA CADENA. Si el criterio dejara la cadena sin ningun
//    proveedor sobreviviente, no marca a nadie.
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
 *   schedule — gateo por ventana horaria. EXCLUIDO del denominador: es el 50,7%
 *              de los eventos y mide la politica de horarios, no al proveedor.
 *   chain    — evento de cadena, no imputable a ningun proveedor individual.
 */
const EVENT_KIND = Object.freeze({
    fallback_selected: 'win',
    fallback_health_gated: 'block',
    fallback_provider_disabled: 'block',
    fallback_pacing_budget_red: 'block',
    fallback_no_credentials: 'block',
    chain_exhausted: 'chain',
    primary_inactive_by_schedule: 'schedule',
    fallback_also_gated: 'schedule',
    fallback_provider_inactive_by_schedule: 'schedule',
});

/**
 * Familia de bloqueo por evento. `fallback_health_gated` se refina despues
 * segun `health_reason` (ver `blockFamilyForHealthReason`).
 */
const BLOCK_FAMILY_BY_EVENT = Object.freeze({
    fallback_provider_disabled: 'cupo',
    fallback_pacing_budget_red: 'cupo',
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
    CADENA_ROTA: 'cadena rota',
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
function providerOf(entry) {
    if (!entry) return null;
    if (entry.event === 'primary_inactive_by_schedule') {
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
            chainOk: brokenFiles.length === 0 && files.length > 0,
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
 * INVARIANTE DEL DENOMINADOR (riesgo 2 del body, confirmado por `guru`):
 *   evaluables = attempts - gatedBySchedule
 * El 50,7% de los eventos de la ventana real es gateo por ventana horaria.
 * Incluirlo mide la politica de horarios, no al proveedor.
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
                latencyMs: null,
                latencyReason: ABSENCE.NO_INSTRUMENTADO,
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
        if (health && Number.isFinite(health.latency_ms)) {
            m.latencyMs = health.latency_ms;
            m.latencyReason = null;
        } else {
            // CA-1 / prohibicion explicita del PO: NO inventar el numero ni
            // derivarlo de `duration_ms` del activity-log (wall-clock del
            // agente, p50 ~602s). Los proveedores CLI-OAuth no estan
            // instrumentados — se dice, no se estima.
            m.latencyMs = null;
            m.latencyReason = ABSENCE.NO_INSTRUMENTADO;
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
            // REQ-SEC-2 — integridad rota: no se decide sobre NADIE.
            verdict = VERDICT.NO_EVALUABLE;
            reasons.push('cadena de hash rota o ventana sin archivos verificables');
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
    // Si tras marcar candidatos no queda ningun proveedor sobreviviente entre
    // los declarados, se revierten TODOS los candidatos a `rol_acotado`: el
    // criterio no marca nada antes que reproducir el incidente del 19/08 de
    // forma auto-infligida y permanente.
    // -------------------------------------------------------------------------
    const declaredVerdicts = Object.values(out).filter((v) => v.declared);
    const survivors = declaredVerdicts.filter(
        (v) => v.verdict === VERDICT.MANTENER || v.verdict === VERDICT.ROL_ACOTADO,
    );
    const candidates = declaredVerdicts.filter((v) => v.verdict === VERDICT.CANDIDATO_BAJA);

    const minSurvivors = Number.isFinite(t.min_survivors) ? t.min_survivors : 1;
    if (candidates.length > 0 && survivors.length < minSurvivors) {
        for (const c of candidates) {
            c.verdict = VERDICT.ROL_ACOTADO;
            c.verdictLabel = VERDICT_LABEL[VERDICT.ROL_ACOTADO];
            c.reasons.push(
                'invariante de cadena minima: marcarlo dejaria la cadena sin proveedores sanos '
                + `(sobrevivientes=${survivors.length} < min_survivors=${minSurvivors}) — no se marca`,
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

function fmtLatency(m) {
    if (Number.isFinite(m.latencyMs)) {
        return m.latencyMs >= 1000
            ? `${(m.latencyMs / 1000).toFixed(1).replace('.', ',')} s`
            : `${m.latencyMs} ms`;
    }
    return m.latencyReason || ABSENCE.NO_INSTRUMENTADO;
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
        '| Proveedor | Intentos evaluables | Aportes | Tasa | Latencia mediana '
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
        fmtLatency(m),
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
    let total = 0;
    for (const e of entries || []) {
        const kind = EVENT_KIND[e.event];
        if (!kind) continue;
        total += 1;
        counts[e.event] = (counts[e.event] || 0) + 1;
    }
    const sum = (...names) => names.reduce((acc, n) => acc + (counts[n] || 0), 0);

    const schedule = sum(
        'primary_inactive_by_schedule',
        'fallback_also_gated',
        'fallback_provider_inactive_by_schedule',
    );
    const providerBlocks = sum(
        'fallback_health_gated',
        'fallback_provider_disabled',
        'fallback_pacing_budget_red',
        'fallback_no_credentials',
    );
    const wins = sum('fallback_selected');
    const chain = sum('chain_exhausted');
    const pct = (n) => (total > 0 ? Number(((n / total) * 100).toFixed(1)) : null);

    return {
        totalEvents: total,
        byEvent: counts,
        scheduleGating: { events: schedule, pct: pct(schedule) },
        providerBlocking: { events: providerBlocks, pct: pct(providerBlocks) },
        wins: { events: wins, pct: pct(wins) },
        chainExhausted: { events: chain, pct: pct(chain) },
    };
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
