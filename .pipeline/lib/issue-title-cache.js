// =============================================================================
// issue-title-cache.js — Enriquecimiento del título (y labels) de un issue
// desde el cache local que el pipeline ya mantiene.
//
// #6190 — POR QUÉ ESTE MÓDULO EXISTE (y no es una función suelta de
// `human-block.js`):
//
// El título del issue se cita literal en la ficha de decisión, y es el
// identificador que el operador reconoce: sin él el aviso dice
// "#6150 (sin título)" y el operador tiene que ir a buscar de qué se trata,
// que es exactamente el trabajo que #6190 le vino a sacar de encima.
//
// `listBlockedIssues()` NO trae título (el marker es un archivo vacío con el
// número en el nombre), así que el enriquecimiento tiene que pasar SIEMPRE
// antes de armar la ficha — en el aviso inicial Y en el recordatorio. Cuando
// esto vivía dentro de `human-block.js` sin exportar, el recordatorio no lo
// podía usar y emitía "(sin título)" para el 100 % de los issues mientras el
// aviso inicial, con el mismo dato y en el mismo instante, emitía el título
// real. Eso rompía CA-1 ("el recordatorio no tiene copy propio": mismo cuerpo
// que el aviso agrupado) y CA-2.
//
// Vive en un módulo aparte, y no exportado desde `human-block`, por la garantía
// estructural de `human-block-reminder.js`: ese módulo NO puede requerir
// `human-block` ni alcanzar `unblockIssue`/`dismissBlockedIssue` ni por vía
// indirecta (test en `human-block-notificacion.test.js`). Un módulo compartido
// que sólo LEE un cache no le da al recordatorio ninguna capacidad de destrabe.
//
// SÓLO LECTURA, SIN RED: el aviso de un bloqueo no puede depender de GitHub.
//
// DEFENSIVO POR DISEÑO: si el cache no existe, está corrupto o no tiene la
// entrada, se devuelve el `raw` tal cual y la ficha degrada a "(sin título)".
// Un aviso de bloqueo nunca puede perderse porque falló una lectura decorativa.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const trace = require('./traceability');

const TITLE_CACHE_FILE = '.issue-title-cache.json';

// El cache vive en el `.pipeline/` del REPO PRINCIPAL, no en el del worktree
// del agente: es el mismo del que leen el dashboard, el commander y el
// reconciliador. Resolverlo por `__dirname` haría que un agente corriendo en
// su worktree leyera un cache inexistente y volviera a emitir "(sin título)".
const DEFAULT_PIPELINE_DIR = path.join(trace.REPO_ROOT, '.pipeline');

/**
 * Lee el cache de títulos. Nunca lanza.
 * @param {string} [pipelineDir] — dir de `.pipeline` (inyectable en tests).
 * @returns {object} mapa `issue -> { title, labels }`, `{}` si no se puede leer.
 */
function leerTitleCache(pipelineDir) {
    try {
        const dir = typeof pipelineDir === 'string' && pipelineDir ? pipelineDir : DEFAULT_PIPELINE_DIR;
        const raw = fs.readFileSync(path.join(dir, TITLE_CACHE_FILE), 'utf8');
        const obj = JSON.parse(raw);
        return obj && typeof obj === 'object' ? obj : {};
    } catch (_) {
        // Ausente o corrupto: no es un error, es un aviso sin título.
        return {};
    }
}

/**
 * Devuelve los `raw` con `titulo` y `labels` completados desde el cache, sin
 * pisar nunca lo que el call-site ya sabía: si el emisor trae el título (porque
 * lo tiene fresco), ése manda.
 *
 * Nunca lanza: ante cualquier problema devuelve la lista de entrada.
 *
 * @param {Array}  raws          — items con al menos `{ issue }`.
 * @param {object} [opts]
 * @param {string} [opts.pipelineDir] — dir de `.pipeline` (inyectable en tests).
 * @returns {Array} nueva lista; los items sin parche se devuelven por identidad.
 */
function enriquecerConTitulo(raws, opts) {
    if (!Array.isArray(raws)) return [];
    const pipelineDir = opts && opts.pipelineDir;
    let cache = null;
    try {
        return raws.map((r) => {
            const yaTiene = r && typeof r.titulo === 'string' && r.titulo.trim();
            const yaLabels = r && Array.isArray(r.labels) && r.labels.length;
            if (yaTiene && yaLabels) return r;
            if (cache === null) cache = leerTitleCache(pipelineDir);
            const e = cache[String(r && r.issue)];
            if (!e || typeof e !== 'object') return r;
            const parche = {};
            if (!yaTiene && typeof e.title === 'string' && e.title.trim()) parche.titulo = e.title;
            if (!yaLabels && Array.isArray(e.labels)) parche.labels = e.labels;
            return Object.keys(parche).length ? Object.assign({}, r, parche) : r;
        });
    } catch (_) {
        // Enriquecer es decorativo: si falla, el aviso sale igual sin título.
        return raws;
    }
}

module.exports = {
    TITLE_CACHE_FILE,
    DEFAULT_PIPELINE_DIR,
    leerTitleCache,
    enriquecerConTitulo,
};
