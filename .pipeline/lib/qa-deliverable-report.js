'use strict';

// =============================================================================
// qa-deliverable-report.js — #4512
//
// Builder PURO (sin side-effects, testeable) del reporte de QA E2E que el Pulpo
// materializa SIEMPRE al cerrar la fase `verificacion` del skill `qa`, vía
// `writeDeliverable('qa', issue, { fase: 'verificacion', md, sensible: true })`.
//
// Este módulo NO toca el FS ni notifica: sólo arma el markdown estructurado a
// partir del YAML de resultado del agente QA. La escritura, redacción de
// secrets, cap de tamaño e indexación las hace `writeDeliverable` (choke point).
//
// Dos formas del reporte:
//   - buildQaReport(...)          → cierre normal (passed / failed).
//   - buildQaExceptionReport(...) → caso "no aplica" (CA-4): qa:skipped / modo
//                                   api / structural. El MOTIVO ocupa el lugar
//                                   del veredicto para que el humano no confunda
//                                   "no aplica" con "faltó generar".
//
// Orden de secciones (F-pattern de ux — CA-UX-1..4 / CA-2):
//   1. Título con veredicto/motivo inequívoco.
//   2. Criterios PO — estado individual por criterio (cumple/falla/no-aplica).
//   3. Entorno — modo + backend + APK/flavor.
//   4. Defectos — resumen accionable (qué esperado / qué pasó / dónde), o
//      `ninguno`. NUNCA logs crudos (CA-2 / security).
//   5. Evidencia — paths/links a video y screenshot, referenciados.
//
// Doctrina de referencia: docs/pipeline/entregables-multimedia-por-agente.md
// =============================================================================

// Marcadores de estado por criterio. ASCII-safe salvo el emoji, que es seguro
// en UTF-8 (el .md se persiste en utf8). Se usan como prefijo del ítem.
const ESTADO_MARK = Object.freeze({
    cumple: '✅',
    falla: '❌',
    'no-aplica': '➖',
});

/**
 * Normaliza un valor de veredicto libre a `passed` / `failed`.
 * @param {string} value
 * @returns {'passed'|'failed'}
 */
function normalizeVeredicto(value) {
    const v = String(value == null ? '' : value).trim().toLowerCase();
    if (v === 'passed' || v === 'aprobado' || v === 'ok' || v === 'pass') return 'passed';
    if (v === 'failed' || v === 'rechazado' || v === 'fail') return 'failed';
    // Default defensivo: si el agente no reporta veredicto legible, tratamos el
    // reporte como `failed` (nunca inflar un passed sin dato).
    return 'failed';
}

/**
 * Devuelve el marcador de estado de un criterio, tolerando valores libres.
 * @param {string} estado
 * @returns {string}
 */
function markFor(estado) {
    const e = String(estado == null ? '' : estado).trim().toLowerCase();
    if (ESTADO_MARK[e]) return ESTADO_MARK[e];
    if (e === 'cumple' || e === 'ok' || e === 'pass' || e === 'passed') return ESTADO_MARK.cumple;
    if (e === 'falla' || e === 'fail' || e === 'failed') return ESTADO_MARK.falla;
    if (e === 'no-aplica' || e === 'no aplica' || e === 'na' || e === 'n/a') return ESTADO_MARK['no-aplica'];
    // Estado no reportado / desconocido → no-aplica visual, sin romper.
    return ESTADO_MARK['no-aplica'];
}

/**
 * Limpia un texto libre para embeberlo en el markdown SIN volcar logs crudos.
 * Colapsa saltos de línea a espacios y recorta longitud (defensa anti-dump,
 * CA-2 / security). La redacción de secrets la hace `writeDeliverable` aguas
 * abajo; acá sólo evitamos el ruido estructural de un dump multilínea.
 * @param {*} value
 * @param {number} [maxLen=500]
 * @returns {string}
 */
function oneLine(value, maxLen = 500) {
    let s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    if (s.length > maxLen) s = `${s.slice(0, maxLen - 1)}…`;
    return s;
}

/**
 * Renderiza la sección de criterios PO con estado individual (CA-2 / CA-UX-2).
 * @param {Array<{id?: string, estado?: string, detalle?: string}>} criterios
 * @returns {string}
 */
function renderCriterios(criterios) {
    if (!Array.isArray(criterios) || criterios.length === 0) {
        return '_Criterios no reportados por el agente QA._';
    }
    const lines = [];
    for (const c of criterios) {
        if (!c || typeof c !== 'object') continue;
        const id = oneLine(c.id || 'criterio', 80);
        const mark = markFor(c.estado);
        const detalle = c.detalle != null && String(c.detalle).trim().length > 0
            ? ` — ${oneLine(c.detalle, 300)}`
            : '';
        lines.push(`- ${mark} **${id}**${detalle}`);
    }
    return lines.length > 0 ? lines.join('\n') : '_Criterios no reportados por el agente QA._';
}

/**
 * Renderiza la sección de entorno/modo de prueba (CA-2).
 * @param {object|string} entorno
 * @returns {string}
 */
function renderEntorno(entorno) {
    if (entorno == null) return '_Entorno no reportado por el agente QA._';
    if (typeof entorno === 'string') {
        const s = oneLine(entorno, 200);
        return s.length > 0 ? `- **Modo:** ${s}` : '_Entorno no reportado por el agente QA._';
    }
    if (typeof entorno !== 'object') return '_Entorno no reportado por el agente QA._';
    const lines = [];
    if (entorno.modo != null && String(entorno.modo).trim().length > 0) {
        lines.push(`- **Modo:** ${oneLine(entorno.modo, 80)}`);
    }
    if (entorno.backend != null && String(entorno.backend).trim().length > 0) {
        lines.push(`- **Backend:** ${oneLine(entorno.backend, 200)}`);
    }
    if (entorno.apk != null && String(entorno.apk).trim().length > 0) {
        lines.push(`- **APK/Flavor:** ${oneLine(entorno.apk, 120)}`);
    }
    if (entorno.flavor != null && String(entorno.flavor).trim().length > 0) {
        lines.push(`- **Flavor:** ${oneLine(entorno.flavor, 80)}`);
    }
    return lines.length > 0 ? lines.join('\n') : '_Entorno no reportado por el agente QA._';
}

/**
 * Renderiza la sección de defectos accionables (CA-2 / CA-UX-3). NUNCA logs
 * crudos: cada defecto se resume en una línea (qué esperado / qué pasó / dónde).
 * @param {Array<object|string>|string} defectos
 * @returns {string}
 */
function renderDefectos(defectos) {
    if (defectos == null) return '_Ninguno._';
    if (typeof defectos === 'string') {
        const s = oneLine(defectos, 500);
        if (s.length === 0 || s.toLowerCase() === 'ninguno') return '_Ninguno._';
        return `- ${s}`;
    }
    if (!Array.isArray(defectos)) return '_Ninguno._';
    if (defectos.length === 0) return '_Ninguno._';
    const lines = [];
    for (const d of defectos) {
        if (d == null) continue;
        if (typeof d === 'string') {
            const s = oneLine(d, 400);
            if (s.length > 0) lines.push(`- ${s}`);
            continue;
        }
        if (typeof d !== 'object') continue;
        const esperado = d.esperado != null ? oneLine(d.esperado, 200) : '';
        const paso = (d.paso != null ? d.paso : d.actual) != null
            ? oneLine(d.paso != null ? d.paso : d.actual, 200)
            : '';
        const donde = d.donde != null ? oneLine(d.donde, 200) : '';
        const partes = [];
        if (esperado) partes.push(`esperado: ${esperado}`);
        if (paso) partes.push(`pasó: ${paso}`);
        if (donde) partes.push(`dónde: ${donde}`);
        if (partes.length > 0) {
            lines.push(`- ${partes.join(' · ')}`);
        } else if (d.detalle != null) {
            const s = oneLine(d.detalle, 400);
            if (s.length > 0) lines.push(`- ${s}`);
        }
    }
    return lines.length > 0 ? lines.join('\n') : '_Ninguno._';
}

/**
 * Renderiza la sección de evidencia con referencias (no incrustadas) al video y
 * screenshot final (CA-2 / CA-UX).
 * @param {string} evidencia - path/link al video E2E.
 * @param {string} screenshot - path/link al screenshot final.
 * @returns {string}
 */
function renderEvidencia(evidencia, screenshot) {
    const lines = [];
    if (evidencia != null && String(evidencia).trim().length > 0) {
        lines.push(`- **Video E2E:** \`${oneLine(evidencia, 300)}\``);
    }
    if (screenshot != null && String(screenshot).trim().length > 0) {
        lines.push(`- **Screenshot final:** \`${oneLine(screenshot, 300)}\``);
    }
    return lines.length > 0 ? lines.join('\n') : '_Sin evidencia referenciada._';
}

/**
 * Arma el reporte de QA E2E para el cierre normal (passed / failed).
 *
 * @param {object} params
 * @param {string|number} params.issue - número de issue.
 * @param {string} params.veredicto - 'passed' | 'failed' (o alias legibles).
 * @param {Array} [params.criterios] - lista `{id, estado, detalle}`.
 * @param {object|string} [params.entorno] - `{modo, backend, apk, flavor}` o string.
 * @param {Array|string} [params.defectos] - lista accionable o 'ninguno'.
 * @param {string} [params.evidencia] - path/link al video E2E.
 * @param {string} [params.screenshot] - path/link al screenshot final.
 * @returns {string} markdown estructurado (utf8-safe).
 */
function buildQaReport({ issue, veredicto, criterios, entorno, defectos, evidencia, screenshot } = {}) {
    const veredictoNorm = normalizeVeredicto(veredicto);
    const titulo = veredictoNorm === 'passed'
        ? `# ✅ QA E2E passed — #${issue}`
        : `# ❌ QA E2E failed — #${issue}`;

    return [
        titulo,
        '',
        `**Veredicto:** ${veredictoNorm}`,
        '',
        '## Criterios PO',
        '',
        renderCriterios(criterios),
        '',
        '## Entorno',
        '',
        renderEntorno(entorno),
        '',
        '## Defectos',
        '',
        renderDefectos(defectos),
        '',
        '## Evidencia',
        '',
        renderEvidencia(evidencia, screenshot),
        '',
    ].join('\n');
}

/**
 * Arma el reporte de excepción "no aplica" (CA-4). El MOTIVO ocupa el lugar del
 * veredicto para que quede explícito que el entregable no corresponde — no que
 * faltó generarlo.
 *
 * @param {object} params
 * @param {string|number} params.issue - número de issue.
 * @param {string} params.motivo - por qué el entregable QA no aplica.
 * @param {string} [params.modo] - modo autoritativo (`api`/`structural`) o
 *     `qa:skipped` que justifica la excepción.
 * @returns {string} markdown estructurado (utf8-safe).
 */
function buildQaExceptionReport({ issue, motivo, modo } = {}) {
    const motivoTxt = motivo != null && String(motivo).trim().length > 0
        ? oneLine(motivo, 500)
        : 'No se registró un motivo explícito.';
    const modoTxt = modo != null && String(modo).trim().length > 0
        ? oneLine(modo, 80)
        : 'no especificado';

    return [
        `# ➖ QA E2E no aplica — #${issue}`,
        '',
        `**Motivo:** ${motivoTxt}`,
        '',
        '## Entorno',
        '',
        `- **Modo:** ${modoTxt}`,
        '',
        '## Detalle',
        '',
        'La fase QA E2E no produce evidencia audiovisual para este issue por su '
            + 'naturaleza (infra/pipeline sin UI de producto, o modo `api`/`structural`). '
            + 'La excepción queda registrada explícitamente en el store de entregables '
            + '(no es un silencio ni un entregable faltante).',
        '',
    ].join('\n');
}

module.exports = {
    buildQaReport,
    buildQaExceptionReport,
    // Exportados para testeo unitario de los renderers puros.
    normalizeVeredicto,
    markFor,
    renderCriterios,
    renderEntorno,
    renderDefectos,
    renderEvidencia,
};
