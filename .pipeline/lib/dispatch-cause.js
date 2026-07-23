'use strict';

// =============================================================================
// dispatch-cause.js — Causa declarada del NO-despacho de la cola (#4709).
//
// Elimina el estado "cola ociosa sin explicación": cuando el pipeline tiene
// ítems pendientes pero `brazoLanzamiento` no lanza nada en el ciclo, este
// módulo determina y publica la CAUSA de forma legible y consumible por el
// dashboard y por el dead-man's switch (#4708).
//
// DISEÑO — espejo de `lib/infra-health-level.js`:
//   1. `resolveCause(snapshot, nowMs)` es una función PURA (sin I/O): recibe el
//      snapshot del ciclo de despacho y devuelve `{ causa, label, detalle, ts,
//      anomalia }` o `null` (cuando SÍ hubo despacho o la cola está vacía).
//   2. El enum `CAUSAS` es cerrado y la `PRECEDENCIA` es determinística: con
//      varios gates activos simultáneamente gana SIEMPRE el de mayor precedencia
//      (reproducible, testeable).
//   3. Fail-closed (CA-3): si hay pendientes + no se lanzó + ninguna causa
//      conocida aplica → `anomalia_no_determinable` (NUNCA campo en blanco).
//   4. La publicación (`publish`) hace write ATÓMICO (tmp + rename), valida el
//      shape/enum antes de escribir, alerta SOLO en transiciones de causa (con
//      cooldown y re-alerta de anomalía persistente) y, si el write falla, NO
//      deja un artifact stale (lo borra y declara el fallo como su anomalía).
//
// SEGURIDAD (5 requisitos del análisis de security del issue):
//   - `causa` validada contra el enum cerrado; el path destino es CONSTANTE
//     (`<pipelineDir>/dispatch-cause.json`), jamás derivado de input.
//   - `detalle` se redacta con `lib/redact` (sin secrets/tokens) antes de
//     persistir. El escape HTML (XSS) es responsabilidad del render en el
//     dashboard (`escapeHtmlText`/`escapeHtmlAttr`), NO de este módulo.
//   - Write atómico anti-stale + fail-closed.
//   - Alerta solo en transiciones, con re-alerta de anomalía por cooldown.
// =============================================================================

const fs = require('fs');
const path = require('path');

// Redacción de secrets en `detalle` (defensa en profundidad, AC-6). Import
// defensivo: si el módulo no carga, `detalle` se persiste sin redactar (nunca
// se debe volcar contexto libre con secrets a propósito, ver contrato del rol).
let redact = null;
try { redact = require('./redact'); } catch { /* opcional */ }

// ── Enum cerrado de causas (whitelist, AC-6) ──
const CAUSAS = Object.freeze({
    HALT_HUMANO: 'halt_humano',
    CB_INFRA: 'cb_infra',
    PRESION_RECURSOS: 'presion_recursos',
    VENTANA_HORARIA: 'ventana_horaria',
    REST_MODE: 'rest_mode',
    COOLDOWN: 'cooldown',
    BLOQUEO_DEPENDENCIA: 'bloqueo_dependencia',
    DEADLOCK: 'deadlock',
    // #4751 — Modo de ejecución en olas (allowlist / ex "pausa parcial"). Es un
    // estado ESPERADO inducido por el operador: sólo se despachan los issues de
    // la ola activa. Se publica en el banner pero NO alerta a Telegram (causa
    // silenciosa). Antes reusaba HALT_HUMANO, lo que generaba ruido recurrente.
    MODO_OLA: 'modo_ola',
    SIN_AGENTES: 'sin_agentes',
    ANOMALIA: 'anomalia_no_determinable',
});

// Orden de precedencia determinístico: la causa MÁS grave/específica gana cuando
// varios gates están activos simultáneamente. Halt humano manda sobre todo (nada
// se lanza aunque haya recursos); luego el circuit breaker de infra; luego la
// presión de recursos; etc. `anomalia_no_determinable` NO está en la lista: es
// el fallback fail-closed cuando la lista no matchea ningún gate presente.
const PRECEDENCIA = Object.freeze([
    CAUSAS.HALT_HUMANO,
    CAUSAS.CB_INFRA,
    CAUSAS.PRESION_RECURSOS,
    CAUSAS.VENTANA_HORARIA,
    CAUSAS.REST_MODE,
    CAUSAS.COOLDOWN,
    CAUSAS.BLOQUEO_DEPENDENCIA,
    CAUSAS.DEADLOCK,
    // #4751 — MODO_OLA estrictamente POR DEBAJO de PRESION_RECURSOS/DEADLOCK (R4):
    // si coexisten modo ola + saturación, gana la causa alertable y la alerta se
    // emite. Un orden invertido escondería el problema real.
    CAUSAS.MODO_OLA,
    CAUSAS.SIN_AGENTES,
]);

// Labels humanos legibles por el operador (UX-1): NUNCA exponer el enum crudo.
// El dashboard reutiliza este mapa al renderizar; el dev de dashboard puede
// ajustar el copy sin tocar el enum.
const LABELS = Object.freeze({
    [CAUSAS.HALT_HUMANO]: 'Detenido por humano',
    [CAUSAS.CB_INFRA]: 'Circuit breaker de infraestructura',
    [CAUSAS.PRESION_RECURSOS]: 'Presión de recursos',
    [CAUSAS.VENTANA_HORARIA]: 'Fuera de ventana horaria',
    [CAUSAS.REST_MODE]: 'Modo descanso',
    [CAUSAS.COOLDOWN]: 'En cooldown',
    [CAUSAS.BLOQUEO_DEPENDENCIA]: 'Bloqueado por dependencia',
    [CAUSAS.DEADLOCK]: 'Deadlock detectado',
    [CAUSAS.MODO_OLA]: 'Modo de ejecución en olas',
    [CAUSAS.SIN_AGENTES]: 'Sin agentes disponibles',
    [CAUSAS.ANOMALIA]: '⚠ Anomalía: causa no determinable',
});

// #4751 — Clasificación de causas ALERTABLES (envían Telegram). Las demás sólo
// publican el banner del dashboard (silenciosas). El objetivo es que la
// notificación de "cola ociosa" signifique SIEMPRE algo que amerita atención del
// operador (saturación de recursos, deadlock, bloqueo real, infra caída) y no se
// dispare por estados esperados como el modo de ejecución en olas (allowlist).
// La ANOMALÍA (fail-closed, R1) se trata aparte y SIEMPRE alerta.
// Silenciosas (sólo banner): MODO_OLA, VENTANA_HORARIA, REST_MODE, COOLDOWN,
// SIN_AGENTES.
const CAUSAS_ALERTABLES = Object.freeze(new Set([
    CAUSAS.HALT_HUMANO,        // pausa/desync/needs-human real → requiere intervención
    CAUSAS.CB_INFRA,           // circuit breaker de infra abierto
    CAUSAS.PRESION_RECURSOS,   // saturación → "hace rato sin ejecución por recursos"
    CAUSAS.BLOQUEO_DEPENDENCIA,
    CAUSAS.DEADLOCK,
]));

// Conjunto de valores válidos del enum (para validación O(1)).
const CAUSAS_VALIDAS = new Set(Object.values(CAUSAS));

// Nombre CONSTANTE del artifact publicado. Jamás derivado de input (anti path
// traversal, AC-6).
const ARTIFACT_FILENAME = 'dispatch-cause.json';

// Cooldown de re-alerta para una anomalía persistente (AC-6): tras la primera
// alerta, si la MISMA anomalía sigue vigente, se re-alerta recién pasado este
// intervalo (no silencio permanente, pero tampoco spam por tick).
const ANOMALY_REALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 min

// ── Helpers ──

function redactDetalle(detalle) {
    if (typeof detalle !== 'string' || detalle.length === 0) return '';
    if (redact && typeof redact.redactRagContent === 'function') {
        try { return redact.redactRagContent(detalle); } catch { /* fail-open al string original */ }
    }
    return detalle;
}

function artifactPath(pipelineDir) {
    return path.join(pipelineDir, ARTIFACT_FILENAME);
}

/**
 * Función PURA — determina la causa declarada del no-despacho.
 *
 * @param {object} snapshot
 *   - `anyLaunched` (bool): true si el ciclo lanzó al menos un agente.
 *   - `hayPendientes` (bool): true si había ítems pendientes en la cola.
 *   - `gatesActivos` (Set<string>): causas (valores de CAUSAS) que se activaron
 *     durante el ciclo (observacional).
 *   - `detalles` (object): mapa causa→string con el detalle textual del gate.
 *   - `progressInFlight` (bool): true si algún candidato se saltó porque su
 *     issue YA tiene un agente vivo (dedup / proceso activo). En ese caso NO es
 *     una cola ociosa: hay progreso en curso aunque no se haya lanzado nada
 *     nuevo este tick → no se declara causa ni anomalía.
 * @param {number} nowMs — timestamp inyectable (epoch ms).
 * @returns {{causa,label,detalle,ts,anomalia}|null}
 */
function resolveCause(snapshot, nowMs) {
    const s = snapshot || {};
    const now = Number.isFinite(nowMs) ? nowMs : 0;

    // Hubo despacho → no hay ociosidad que explicar.
    if (s.anyLaunched === true) return null;
    // Cola vacía → no hay nada pendiente que justificar.
    if (!s.hayPendientes) return null;

    const gates = s.gatesActivos instanceof Set
        ? s.gatesActivos
        : new Set(Array.isArray(s.gatesActivos) ? s.gatesActivos : []);
    const detalles = s.detalles && typeof s.detalles === 'object' ? s.detalles : {};

    // Primera causa presente según precedencia determinística.
    for (const causa of PRECEDENCIA) {
        if (gates.has(causa)) {
            return {
                causa,
                label: LABELS[causa],
                detalle: redactDetalle(detalles[causa] || ''),
                ts: now,
                anomalia: false,
            };
        }
    }

    // No hubo gate conocido. Si hay progreso en vuelo (issues ya siendo
    // trabajados), la cola NO está realmente ociosa → no se declara nada.
    if (s.progressInFlight === true) return null;

    // Fail-closed (CA-3): pendientes + sin despacho + ninguna causa conocida →
    // anomalía declarada explícitamente. NUNCA queda en blanco.
    return {
        causa: CAUSAS.ANOMALIA,
        label: LABELS[CAUSAS.ANOMALIA],
        detalle: redactDetalle(detalles.anomalia
            || 'Cola con ítems pendientes, sin despacho y ninguna causa conocida aplicable.'),
        ts: now,
        anomalia: true,
    };
}

/**
 * Valida el shape del objeto de causa antes de persistirlo (AC-6). Rechaza
 * causas fuera del enum cerrado.
 * @throws {Error} si el shape/enum es inválido.
 */
function validateCause(obj) {
    if (!obj || typeof obj !== 'object') {
        throw new Error('dispatch-cause: objeto de causa inválido (no-objeto)');
    }
    if (!CAUSAS_VALIDAS.has(obj.causa)) {
        throw new Error(`dispatch-cause: causa fuera del enum cerrado: ${JSON.stringify(obj.causa)}`);
    }
    if (typeof obj.anomalia !== 'boolean') {
        throw new Error('dispatch-cause: campo anomalia debe ser boolean');
    }
    return true;
}

/**
 * Lee el artifact publicado. Devuelve null si no existe o está corrupto
 * (validación de shape defensiva, AC-4).
 */
function readArtifact(pipelineDir) {
    try {
        const raw = fs.readFileSync(artifactPath(pipelineDir), 'utf8');
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object') return null;
        return obj;
    } catch {
        return null;
    }
}

/**
 * Write ATÓMICO (tmp + rename) del artifact. Valida el enum antes de escribir.
 * `rename` es atómico dentro del mismo filesystem → el dashboard / dead-man's
 * switch nunca lee un JSON a medio escribir (AC-1, AC-3, SEC-4).
 * @throws {Error} si la validación falla o el write falla.
 */
function writeArtifact(pipelineDir, obj) {
    validateCause(obj);
    const dest = artifactPath(pipelineDir);
    const tmp = path.join(pipelineDir, `.${ARTIFACT_FILENAME}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, dest);
}

/**
 * Borra el artifact si existe (idempotente). Se usa cuando el ciclo SÍ despachó
 * o la cola quedó vacía: la ausencia del archivo significa "sin problema de
 * ociosidad" para el consumidor.
 */
function clearArtifact(pipelineDir) {
    try {
        fs.unlinkSync(artifactPath(pipelineDir));
        return true;
    } catch {
        return false; // ya no existía
    }
}

/**
 * Orquesta la publicación de la causa declarada del ciclo.
 *
 * - Resuelve la causa desde el snapshot (pura).
 * - Si no hay causa (despachó / cola vacía / progreso en vuelo) → limpia el
 *   artifact stale y no alerta.
 * - Si hay causa → detecta transición vs. el artifact previo, preserva `ts` de
 *   inicio de la causa, actualiza `lastSeenTs`, escribe atómicamente y alerta
 *   SOLO en transición (o re-alerta de anomalía persistente por cooldown).
 * - Si el write falla → NO deja stale (borra) y declara el fallo como anomalía
 *   vía alerta (fail-closed, AC-3 / SEC-4).
 *
 * @param {object} opts
 *   - `pipelineDir` (string): raíz del pipeline (path del artifact es constante).
 *   - `snapshot` (object): ver resolveCause.
 *   - `now` (number): epoch ms.
 *   - `alert` (fn): callback para alerta (ej. Telegram). Opcional.
 *   - `log` (fn): callback de log. Opcional.
 * @returns {{causa,label,detalle,ts,lastSeenTs,anomalia}|null} el artifact
 *   publicado (o null si se limpió).
 */
function publish(opts) {
    const { pipelineDir, snapshot, now, alert, log } = opts || {};
    const nowMs = Number.isFinite(now) ? now : 0;
    const logFn = typeof log === 'function' ? log : () => {};
    const alertFn = typeof alert === 'function' ? alert : null;

    const resolved = resolveCause(snapshot, nowMs);

    // Sin causa: el ciclo despachó, la cola está vacía o hay progreso en vuelo.
    // Limpiar cualquier artifact previo para que el watchdog no lea causa stale.
    if (resolved === null) {
        clearArtifact(pipelineDir);
        return null;
    }

    const prev = readArtifact(pipelineDir);
    const mismaCausa = prev && prev.causa === resolved.causa;

    // `ts` = cuándo EMPEZÓ esta causa (transición); se preserva mientras la causa
    // no cambie. `lastSeenTs` = último tick en que seguía vigente (freshness para
    // el dead-man's switch).
    const ts = mismaCausa && Number.isFinite(prev.ts) ? prev.ts : nowMs;
    const prevAlertTs = mismaCausa && Number.isFinite(prev.lastAlertTs) ? prev.lastAlertTs : 0;

    // ¿Alertar? En transición de causa siempre. Si la causa persiste y es
    // anomalía, re-alertar pasado el cooldown (no silencio permanente, AC-6).
    let debeAlertar = !mismaCausa;
    if (mismaCausa && resolved.anomalia && (nowMs - prevAlertTs) >= ANOMALY_REALERT_COOLDOWN_MS) {
        debeAlertar = true;
    }

    const artifact = {
        causa: resolved.causa,
        label: resolved.label,
        detalle: resolved.detalle,
        ts,
        lastSeenTs: nowMs,
        anomalia: resolved.anomalia,
        lastAlertTs: debeAlertar ? nowMs : prevAlertTs,
    };

    try {
        writeArtifact(pipelineDir, artifact);
    } catch (e) {
        // Fail-closed anti-stale (SEC-4 / AC-3): si no pudimos escribir la causa,
        // NO dejamos el artifact viejo como "vigente". Lo borramos y declaramos
        // el fallo como su propia anomalía vía alerta (no la suprimimos).
        clearArtifact(pipelineDir);
        logFn(`dispatch-cause: fallo de escritura (${e.message}) — artifact removido para evitar stale`);
        if (alertFn) {
            try {
                alertFn(`⚠ Pipeline: no se pudo publicar la causa de cola ociosa (${e.message}). Estancamiento sin causa declarada — anomalía.`);
            } catch { /* alerta best-effort */ }
        }
        return null;
    }

    // #4751 — Sólo alertar a Telegram si la causa es ALERTABLE (o anomalía
    // fail-closed). El banner/artifact se publica SIEMPRE (writeArtifact arriba);
    // acá se filtra únicamente el envío al canal externo. Un estado esperado como
    // MODO_OLA se ve en el dashboard pero no genera ruido de notificación.
    const esAlertable = resolved.anomalia || CAUSAS_ALERTABLES.has(resolved.causa);
    if (debeAlertar && esAlertable && alertFn) {
        try {
            const prefijo = resolved.anomalia ? '⚠ ANOMALÍA de despacho' : 'Cola ociosa';
            const detTxt = resolved.detalle ? ` — ${resolved.detalle}` : '';
            alertFn(`${prefijo}: ${resolved.label}${detTxt}`);
        } catch (e) {
            logFn(`dispatch-cause: alerta falló (${e.message})`);
        }
    }

    return artifact;
}

module.exports = {
    CAUSAS,
    PRECEDENCIA,
    LABELS,
    CAUSAS_ALERTABLES,
    CAUSAS_VALIDAS,
    ARTIFACT_FILENAME,
    ANOMALY_REALERT_COOLDOWN_MS,
    resolveCause,
    validateCause,
    readArtifact,
    writeArtifact,
    clearArtifact,
    publish,
    // Exportado para tests / consumidores que quieran el path canónico.
    artifactPath,
};
