// =============================================================================
// autonomy-ladder.js — Escalera de autonomía progresiva por bucket.
//
// Issue: #4576 (épico #4570 — gates de firma del operador).
// Diseño: docs/pipeline/gates-firma-operador.md §4.3 / §4.4.
//
// Implementa CA-4, CA-6, CA-7, CA-8 y CA-9 del issue:
//
//   CA-4 · Métrica de calibración por bucket. El acuerdo real
//          (tasa sugerencia==decisión) se calcula por bucket y se deriva
//          SOLO de decisiones humanas registradas en el audit-log tamper-
//          evident (`.pipeline/lib/audit-log.js`, hash-chain SHA-256).
//
//   CA-6 · Auto-aprobación solo por umbral calibrado. Un bucket queda
//          `calibrado` únicamente con ≥ `umbral_acuerdo_pct` de acuerdo sobre
//          ≥ `muestras_minimas` muestras. Fuera de umbral ⇒ firma humana.
//
//   CA-7 · Separación de deberes. SOLO la decisión humana registrada
//          incrementa el acuerdo. Enforcement en el borde del writer
//          (`recordHumanDecision` estampa `fuente: 'decision_humana'` y NO
//          permite override; `computeBucketStats` ignora cualquier entry cuya
//          `fuente !== 'decision_humana'`). La sugerencia del agente jamás
//          cuenta como "acuerdo consigo mismo".
//
//   CA-8 · Anti-envenenamiento. Se aplica `muestras_minimas` (N) y
//          `decay_dias` (antigüedad): muestras fuera de la ventana de decay no
//          cuentan. Las muestras son inmutables (append-only del audit-log).
//
//   CA-9 · Auto-revocación. El estado `calibrado` se RECOMPUTA en cada
//          consulta desde las muestras inmutables. Si el acuerdo cae por
//          debajo del umbral, `resolveBucket` devuelve `calibrado: false` ⇒ el
//          bucket se auto-revoca a firma humana. No hay estado mutable que
//          "recuerde" una autorización previa: la caída del acuerdo revoca por
//          construcción.
//
// El módulo NO decide auto-aprobación por sí solo: expone las stats y el estado
// `calibrado` del bucket. La decisión final (y el fail-closed por chain roto)
// vive en `operator-signature-gate.js`.
// =============================================================================
'use strict';

const audit = require('./audit-log');

// -----------------------------------------------------------------------------
// Constantes de dominio
// -----------------------------------------------------------------------------

// Marca de tipo de las entries de calibración en el audit-log. Permite que el
// mismo archivo tamper-evident mezcle muestras y revocaciones sin ambigüedad.
const ENTRY_TYPE = Object.freeze({
    MUESTRA: 'calibracion_muestra',
    REVOCACION: 'revocacion',
});

// Invariante de separación de deberes (CA-7): SOLO esta fuente cuenta como
// acuerdo. Cualquier otra (ej. una sugerencia de agente) se descarta.
const FUENTE_HUMANA = 'decision_humana';

// Veredictos válidos de una decisión humana registrada.
const DECISIONES_VALIDAS = Object.freeze(['aprobar', 'rechazar', 'ajustar']);

const DAY_MS = 24 * 60 * 60 * 1000;

// -----------------------------------------------------------------------------
// Identidad de bucket
// -----------------------------------------------------------------------------

/**
 * Deriva la clave de bucket a partir de `(fase, tipo de issue)` (§4.4). Es la
 * unidad sobre la que se mide el acuerdo. Determinística y estable.
 *
 * @param {object} args
 * @param {string} args.fase — fase del gate (ej. 'criterios', 'aprobacion').
 * @param {string} args.tipoIssue — tipo/categoría del issue (ej. 'area:pipeline').
 * @returns {string}
 */
function bucketKey({ fase = 'desconocida', tipoIssue = 'desconocido' } = {}) {
    const f = String(fase || 'desconocida').trim() || 'desconocida';
    const t = String(tipoIssue || 'desconocido').trim() || 'desconocido';
    return `${f}::${t}`;
}

// -----------------------------------------------------------------------------
// CA-7 · Writer de decisiones humanas (única fuente de acuerdo)
// -----------------------------------------------------------------------------

/**
 * Registra una decisión HUMANA de firma en el audit-log tamper-evident. Es el
 * ÚNICO camino que alimenta la calibración de un bucket (CA-7). Estampa
 * `fuente: 'decision_humana'` de forma no-overrideable: aunque el caller pase
 * otra `fuente`, se ignora.
 *
 * @param {object} args
 * @param {string} args.chainFile — path al .jsonl del audit-log.
 * @param {object} args.bucket — `{ fase, tipoIssue }` o `{ key }`.
 * @param {number|string} args.issue — issue firmado (trazabilidad).
 * @param {string} args.sugerencia — veredicto sugerido por el sistema.
 * @param {string} args.decision — veredicto real del operador (DECISIONES_VALIDAS).
 * @param {string} args.operador — identidad humana que firmó (requerida, CA-7).
 * @param {string} [args.version] — versión de calibración vigente.
 * @param {number} [args.nowMs] — timestamp inyectable (tests).
 * @param {object} [args.auditImpl] — audit-log inyectable (tests).
 * @returns {{ hash_self: string, acuerdo: boolean }}
 */
function recordHumanDecision({
    chainFile, bucket, issue, sugerencia, decision, operador, version, nowMs, auditImpl,
} = {}) {
    if (!chainFile || typeof chainFile !== 'string') {
        throw new Error('[autonomy-ladder] recordHumanDecision: chainFile requerido.');
    }
    if (!operador || typeof operador !== 'string') {
        // CA-7: sin identidad humana no hay muestra de acuerdo. Un agente que
        // intente alimentar la calibración sin operador humano es rechazado.
        throw new Error('[autonomy-ladder] recordHumanDecision: operador (identidad humana) requerido.');
    }
    if (!DECISIONES_VALIDAS.includes(decision)) {
        throw new Error(`[autonomy-ladder] decisión inválida "${decision}" (válidas: ${DECISIONES_VALIDAS.join(', ')}).`);
    }
    const _audit = auditImpl || audit;
    const key = bucket && bucket.key ? String(bucket.key) : bucketKey(bucket || {});
    const acuerdo = String(sugerencia) === String(decision);

    const entry = {
        type: ENTRY_TYPE.MUESTRA,
        fuente: FUENTE_HUMANA, // NO overrideable — invariante CA-7.
        bucket: key,
        issue: issue != null ? String(issue) : null,
        sugerencia: sugerencia != null ? String(sugerencia) : null,
        decision: String(decision),
        acuerdo,
        operador,
        version: version != null ? String(version) : null,
        created_at: typeof nowMs === 'number' ? nowMs : Date.now(),
    };
    const res = _audit.appendChained({ file: chainFile, entry });
    return { hash_self: res.hash_self, acuerdo };
}

/**
 * Guarda de separación de deberes (CA-7). Lanza si la entry NO es una decisión
 * humana legítima. Usada para rechazar explícitamente el intento de un agente
 * de alimentar su propia calibración con otra `fuente`.
 *
 * @param {object} entry
 * @throws {Error} si `fuente !== 'decision_humana'`.
 */
function assertHumanSource(entry) {
    if (!entry || entry.fuente !== FUENTE_HUMANA) {
        throw new Error(
            `[autonomy-ladder] CA-7: solo decisiones humanas alimentan la calibración ` +
            `(fuente esperada '${FUENTE_HUMANA}', recibida '${entry && entry.fuente}').`
        );
    }
}

// -----------------------------------------------------------------------------
// CA-4 / CA-8 · Stats de acuerdo por bucket (solo decisiones humanas + decay)
// -----------------------------------------------------------------------------

/**
 * Computa las stats de acuerdo de un bucket a partir de las muestras
 * inmutables del audit-log. Filtra defensivamente:
 *   - `type === 'calibracion_muestra'`,
 *   - `fuente === 'decision_humana'` (CA-7, defensa en profundidad),
 *   - mismo `bucket`,
 *   - dentro de la ventana de decay (CA-8): `created_at >= now - decay_dias`,
 *   - posteriores a la última REVOCACION del bucket (CA-9 revocable): el
 *     LECTOR honra las entradas `type === 'revocacion'` del mismo chain
 *     (patrón permission-validator.js). Una revocación explícita del operador
 *     descarta TODA muestra con `created_at <= ultimaRevocacion`, obligando a
 *     re-acumular N muestras nuevas post-revoke para volver a calibrar. Sin
 *     este filtro, `revoke()` sería fail-open (OWASP A01): dejaría la traza
 *     pero el bucket seguiría auto-aprobando.
 *
 * @param {object} args
 * @param {string} args.chainFile
 * @param {object|string} args.bucket — `{ fase, tipoIssue }`, `{ key }` o string.
 * @param {object} args.config — `{ decay_dias }`.
 * @param {number} [args.nowMs]
 * @param {object} [args.auditImpl]
 * @returns {{ bucket: string, muestras: number, acuerdos: number, acuerdo_pct: number, en_ventana: number, descartadas_decay: number, descartadas_revocacion: number, ultima_revocacion: (number|null) }}
 */
function computeBucketStats({ chainFile, bucket, config = {}, nowMs, auditImpl } = {}) {
    const _audit = auditImpl || audit;
    const key = typeof bucket === 'string'
        ? bucket
        : (bucket && bucket.key ? String(bucket.key) : bucketKey(bucket || {}));
    const now = typeof nowMs === 'number' ? nowMs : Date.now();
    const decayDias = Number(config.decay_dias);
    const decayCutoff = (Number.isFinite(decayDias) && decayDias > 0)
        ? now - decayDias * DAY_MS
        : null; // sin decay configurado ⇒ no se descarta por antigüedad.

    let all = [];
    try {
        all = _audit.readAll(chainFile);
    } catch (_) {
        all = []; // FS ilegible acá ⇒ 0 muestras (el fail-closed lo hace el gate).
    }

    // CA-9 (revocable): el LECTOR honra las revocaciones del mismo chain. Primero
    // se busca el created_at de la ÚLTIMA revocación humana del bucket. Toda
    // muestra en/antes de ese instante queda invalidada (append-only: no se borra
    // nada, se ignora al recomputar). Es el corte que hace efectiva la revocación.
    let ultimaRevocacion = null;
    for (const e of all) {
        if (!e || e.type !== ENTRY_TYPE.REVOCACION) continue;
        if (e.fuente !== FUENTE_HUMANA) continue; // solo revocaciones humanas (CA-7).
        if (String(e.bucket) !== key) continue;
        if (typeof e.created_at !== 'number') continue;
        if (ultimaRevocacion === null || e.created_at > ultimaRevocacion) {
            ultimaRevocacion = e.created_at;
        }
    }

    let muestras = 0;
    let acuerdos = 0;
    let descartadasDecay = 0;
    let descartadasRevocacion = 0;
    for (const e of all) {
        if (!e || e.type !== ENTRY_TYPE.MUESTRA) continue;
        if (e.fuente !== FUENTE_HUMANA) continue; // CA-7 defensa en profundidad.
        if (String(e.bucket) !== key) continue;
        // CA-9: muestra anterior o simultánea a la revocación ⇒ invalidada.
        if (ultimaRevocacion !== null && typeof e.created_at === 'number' && e.created_at <= ultimaRevocacion) {
            descartadasRevocacion++;
            continue;
        }
        if (decayCutoff !== null && typeof e.created_at === 'number' && e.created_at < decayCutoff) {
            descartadasDecay++;
            continue; // CA-8: fuera de ventana ⇒ no cuenta.
        }
        muestras++;
        if (e.acuerdo === true) acuerdos++;
    }

    const acuerdoPct = muestras > 0 ? (acuerdos / muestras) * 100 : 0;
    return {
        bucket: key,
        muestras,
        acuerdos,
        acuerdo_pct: acuerdoPct,
        en_ventana: muestras,
        descartadas_decay: descartadasDecay,
        descartadas_revocacion: descartadasRevocacion,
        ultima_revocacion: ultimaRevocacion,
    };
}

// -----------------------------------------------------------------------------
// CA-6 / CA-9 · Resolución del estado calibrado del bucket
// -----------------------------------------------------------------------------

/**
 * Resuelve si un bucket está `calibrado` para habilitar auto-aprobación. El
 * estado se RECOMPUTA siempre desde las muestras inmutables (CA-9): no hay
 * flag mutable que perpetúe una autorización — si el acuerdo cae, `calibrado`
 * pasa a false automáticamente (auto-revocación).
 *
 * `calibrado === true` sii:
 *   - `muestras >= muestras_minimas` (N, CA-6/CA-8), y
 *   - `acuerdo_pct >= umbral_acuerdo_pct` (X, CA-6).
 *
 * @param {object} args
 * @param {string} args.chainFile
 * @param {object|string} args.bucket
 * @param {object} args.config — `{ umbral_acuerdo_pct, muestras_minimas, decay_dias }`.
 * @param {number} [args.nowMs]
 * @param {object} [args.auditImpl]
 * @returns {{ id: string, calibrado: boolean, acuerdo_pct: number, muestras: number, umbral_acuerdo_pct: number, muestras_minimas: number, version: string, razon: string }}
 */
function resolveBucket({ chainFile, bucket, config = {}, nowMs, auditImpl } = {}) {
    const stats = computeBucketStats({ chainFile, bucket, config, nowMs, auditImpl });
    const umbral = Number(config.umbral_acuerdo_pct);
    const nMin = Number(config.muestras_minimas);

    const umbralOk = Number.isFinite(umbral) ? umbral : Infinity; // sin umbral ⇒ nunca calibra.
    const nOk = Number.isFinite(nMin) ? nMin : Infinity;          // sin N ⇒ nunca calibra.

    const suficientesMuestras = stats.muestras >= nOk;
    const acuerdoSuficiente = stats.acuerdo_pct >= umbralOk;
    const calibrado = suficientesMuestras && acuerdoSuficiente;

    let razon;
    if (calibrado) {
        razon = `calibrado: ${stats.acuerdos}/${stats.muestras} muestras (${stats.acuerdo_pct.toFixed(1)}% ≥ ${umbralOk}%)`;
    } else if (!suficientesMuestras) {
        razon = `sub-muestreo: ${stats.muestras} < ${nOk} muestras mínimas`;
    } else {
        razon = `acuerdo insuficiente: ${stats.acuerdo_pct.toFixed(1)}% < ${umbralOk}% (auto-revocado)`;
    }

    // Versión de calibración: determinística por (bucket, config de umbral/N).
    // No usa timestamps para ser reproducible en la traza de auto-aprobación.
    const version = `${stats.bucket}@X${umbralOk}N${nOk}`;

    return {
        id: stats.bucket,
        calibrado,
        acuerdo_pct: stats.acuerdo_pct,
        muestras: stats.muestras,
        umbral_acuerdo_pct: umbralOk,
        muestras_minimas: nOk,
        version,
        razon,
    };
}

// -----------------------------------------------------------------------------
// CA-9 / CA-12 · Revocación explícita del operador (traza en el chain)
// -----------------------------------------------------------------------------

/**
 * Registra una revocación explícita del operador en el mismo audit-log tamper-
 * evident (CA-9 revocable + CA-12 trazabilidad). No borra muestras (append-
 * only): deja constancia auditable de la revocación manual y, gracias a que
 * `computeBucketStats` honra esta entrada, invalida toda muestra en/antes de
 * `created_at` — el bucket vuelve a `calibrado: false` hasta re-acumular N
 * muestras nuevas de acuerdo posteriores a la revocación (surte efecto, no es
 * sólo una traza).
 *
 * @param {object} args
 * @param {string} args.chainFile
 * @param {object|string} args.bucket
 * @param {string} args.operador — identidad humana que revoca.
 * @param {string} [args.motivo]
 * @param {number} [args.nowMs]
 * @param {object} [args.auditImpl]
 * @returns {{ hash_self: string }}
 */
function revoke({ chainFile, bucket, operador, motivo, nowMs, auditImpl } = {}) {
    if (!chainFile || typeof chainFile !== 'string') {
        throw new Error('[autonomy-ladder] revoke: chainFile requerido.');
    }
    if (!operador || typeof operador !== 'string') {
        throw new Error('[autonomy-ladder] revoke: operador (identidad humana) requerido.');
    }
    const _audit = auditImpl || audit;
    const key = typeof bucket === 'string'
        ? bucket
        : (bucket && bucket.key ? String(bucket.key) : bucketKey(bucket || {}));
    const entry = {
        type: ENTRY_TYPE.REVOCACION,
        fuente: FUENTE_HUMANA,
        bucket: key,
        operador,
        motivo: motivo != null ? String(motivo) : null,
        created_at: typeof nowMs === 'number' ? nowMs : Date.now(),
    };
    const res = _audit.appendChained({ file: chainFile, entry });
    return { hash_self: res.hash_self };
}

module.exports = {
    bucketKey,
    recordHumanDecision,
    assertHumanSource,
    computeBucketStats,
    resolveBucket,
    revoke,
    // Constantes exportadas para tests y callers.
    ENTRY_TYPE,
    FUENTE_HUMANA,
    DECISIONES_VALIDAS,
    DAY_MS,
};
