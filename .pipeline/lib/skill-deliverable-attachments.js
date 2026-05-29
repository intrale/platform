// =============================================================================
// skill-deliverable-attachments.js — Helper compartido para recolectar
// adjuntos por skill al cierre de una fase (issue #3647).
//
// Responsabilidad acotada:
//   - Por skill + issue + fase, escanear los roots conocidos del filesystem y
//     devolver `[{ type, path, descriptor }]` con paths relativos al repo.
//   - Estrictamente **issue-scoped** (CA-1.4 / #3658): cada patrón de búsqueda
//     incluye literalmente `<issueNumber>` en el filename o en un segmento del
//     path, así PNGs/PDFs del issue vecino no contaminan la entrega.
//   - Para `ux` aplica orden de lectura visual: actual → esperado → narrativa.
//   - Si no encuentra nada: array vacío, NO error.
//
// Lo que NO hace:
//   - NO valida path traversal, magic bytes ni allowlist final — eso lo hace
//     `deliverable-notify.resolveAttachments` downstream. Si este helper
//     devuelve un path inválido, el notificador lo descarta silenciosamente
//     con audit y cae al text-only (CA-FN-4).
//   - NO genera mockups ni captura screenshots — eso lo hace el agente `/ux`
//     con `ux-mockup-generator.js` + `screenshot-capture.js`.
//   - NO consulta GitHub.
//   - NO modifica el YAML del agente. El caller (pulpo.js) decide cómo
//     fusionar los resultados con `yaml.attachments` ya declarados.
//
// Diseño:
//   - Puro / stateless / sin efectos. Testable con `pipelineRoot` apuntado a
//     un tmpdir.
//   - Sin dependencias externas (sin `glob`, sin Anthropic, sin Telegram).
//   - Determinista: orden estable por skill (CA-UX-7 #3661).
// =============================================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// -----------------------------------------------------------------------------
// Configuración por skill — fuentes a inspeccionar
// -----------------------------------------------------------------------------
//
// Cada entrada describe **un directorio raíz a inspeccionar** y los criterios
// de match. La búsqueda es **no recursiva** dentro del root (queremos paths
// predecibles, no descender por accidente en carpetas con contenido de otros
// issues).
//
// `dirTemplate` puede usar `{issue}` para meter el número de issue como segmento
// del path — esto resulta en directorios issue-scoped en disco (ej:
// `qa/evidence/3647/`).
//
// `nameMustInclude` lista substrings que el filename DEBE contener. Si la lista
// es no vacía, **se exige siempre que aparezca `{issue}`** (CA-1.4) — si el
// directorio padre ya es issue-scoped (`{issue}` en `dirTemplate`), el check
// del filename se relaja a "no exigir {issue} en el name". Sino, exigir
// `{issue}` en filename es obligatorio.
//
// `formats` filtra por extensión (lowercased).
//
// `type` declara el `type` que se enviará a `deliverable-notify`. Debe ser
// uno de document/image/video/animation.

const SKILL_SOURCES = Object.freeze({
    ux: [
        // Caso A — dashboard: PNGs en `.pipeline/assets/mockups/<issue>/...`.
        {
            dirTemplate: '.pipeline/assets/mockups/{issue}',
            nameMustInclude: [],          // dir issue-scoped → no exigir {issue} en filename
            formats: ['.png', '.jpg', '.jpeg', '.gif'],
            type: 'image',
            descriptorHint: 'mockup',
        },
        // Caso B — Android: PNGs en `qa/evidence/<issue>/`.
        {
            dirTemplate: 'qa/evidence/{issue}',
            nameMustInclude: [],
            formats: ['.png', '.jpg', '.jpeg', '.gif'],
            type: 'image',
            descriptorHint: 'evidence',
        },
        // Convención plana legacy — filename DEBE contener `{issue}`.
        {
            dirTemplate: '.pipeline/assets/mockups',
            nameMustInclude: ['{issue}'],
            formats: ['.png', '.jpg', '.jpeg', '.gif'],
            type: 'image',
            descriptorHint: 'mockup',
        },
        // Videos cortos (Caso B con grabación opcional) — issue-scoped.
        {
            dirTemplate: 'qa/evidence/{issue}',
            nameMustInclude: [],
            formats: ['.mp4', '.webm'],
            type: 'video',
            descriptorHint: 'video',
        },
    ],
    po: [
        // Documentos del PO — markdown / PDF con criterios refinados.
        {
            dirTemplate: '.pipeline/assets/docs/{issue}',
            nameMustInclude: [],
            formats: ['.pdf', '.md'],
            type: 'document',
            descriptorHint: 'criterios',
        },
        {
            dirTemplate: '.pipeline/assets/docs',
            nameMustInclude: ['{issue}'],
            formats: ['.pdf', '.md'],
            type: 'document',
            descriptorHint: 'criterios',
        },
    ],
    guru: [
        {
            dirTemplate: '.pipeline/assets/docs/{issue}',
            nameMustInclude: [],
            formats: ['.pdf', '.md'],
            type: 'document',
            descriptorHint: 'analisis',
        },
        {
            dirTemplate: '.pipeline/assets/docs',
            nameMustInclude: ['{issue}'],
            formats: ['.pdf', '.md'],
            type: 'document',
            descriptorHint: 'analisis',
        },
    ],
    planner: [
        {
            dirTemplate: '.pipeline/assets/docs/{issue}',
            nameMustInclude: [],
            formats: ['.pdf', '.md', '.png', '.svg'],
            type: 'document',
            descriptorHint: 'planner',
        },
        {
            dirTemplate: '.pipeline/assets/docs',
            nameMustInclude: ['{issue}'],
            formats: ['.pdf', '.md'],
            type: 'document',
            descriptorHint: 'planner',
        },
    ],
    cua: [
        {
            dirTemplate: '.pipeline/cua-outputs/{issue}',
            nameMustInclude: [],
            formats: ['.png', '.mp4', '.pdf'],
            type: null, // inferido por extensión (ver INFER_TYPE_BY_EXT)
            descriptorHint: 'cua',
        },
    ],
});

// Mapeo extensión → tipo de adjunto. Usado cuando la `source.type` es null
// (caso CUA donde varios tipos conviven en el mismo root).
const INFER_TYPE_BY_EXT = Object.freeze({
    '.pdf':  'document',
    '.md':   'document',
    '.png':  'image',
    '.jpg':  'image',
    '.jpeg': 'image',
    '.gif':  'animation',
    '.mp4':  'video',
    '.webm': 'video',
    '.svg':  'image',
});

// Orden de lectura visual para `ux` (CA-UX-7 refinamiento PO/UX): primero el
// estado actual, después el esperado, narrativa al final como contexto. Si el
// filename no matchea ninguna categoría, va al final del grupo de su tipo.
const UX_ORDER_KEYWORDS = Object.freeze([
    { rank: 0, regex: /actual|baseline/i },
    { rank: 1, regex: /esperado|mockup/i },
    { rank: 2, regex: /narrativa/i },
]);

// Cap defensivo de adjuntos devueltos por el helper. `deliverable-notify`
// también aplica su propio cap (default 5), pero corremos el cap acá temprano
// para no enumerar 200 archivos si un root explota.
const HELPER_MAX_PER_INVOCATION = 12;

// -----------------------------------------------------------------------------
// Helpers internos
// -----------------------------------------------------------------------------

/**
 * Reemplaza el placeholder `{issue}` en un template por el número de issue
 * como string. Es defensivo: si el template no tiene el placeholder, lo
 * devuelve tal cual.
 *
 * @param {string} template
 * @param {string|number} issueNumber
 * @returns {string}
 */
function expandIssue(template, issueNumber) {
    return String(template).replace(/\{issue\}/g, String(issueNumber));
}

/**
 * Determina el `type` final para un archivo dado el `source`.
 *
 * @param {object} source
 * @param {string} ext - extensión lowercased, incluyendo el punto.
 * @returns {string|null}
 */
function resolveType(source, ext) {
    if (source.type) return source.type;
    return INFER_TYPE_BY_EXT[ext] || null;
}

/**
 * Calcula el rank de orden para un filename `ux`. Más bajo = más arriba.
 * Mismo rank → tie-break alfabético.
 *
 * @param {string} name - basename del archivo (con extensión).
 * @returns {number}
 */
function uxOrderRank(name) {
    for (const entry of UX_ORDER_KEYWORDS) {
        if (entry.regex.test(name)) return entry.rank;
    }
    return 999;
}

/**
 * Construye un `descriptor` legible para `buildAttachmentFilename` del
 * notifier. Si el filename tiene `actual` o `esperado`, lo usa; sino cae al
 * hint del source.
 *
 * @param {string} name
 * @param {object} source
 * @returns {string}
 */
function descriptorForFile(name, source) {
    const lower = name.toLowerCase();
    if (lower.includes('actual')) return 'actual';
    if (lower.includes('esperado')) return 'esperado';
    if (lower.includes('mockup'))  return 'mockup';
    if (lower.includes('narrativa')) return 'narrativa';
    if (lower.includes('baseline')) return 'baseline';
    return source.descriptorHint || 'attach';
}

/**
 * Lista archivos regulares del directorio (no recursivo). Si el directorio
 * no existe, devuelve array vacío sin error.
 *
 * @param {string} absDir
 * @returns {string[]} basenames
 */
function listDirSafe(absDir) {
    try {
        if (!fs.existsSync(absDir)) return [];
        const stat = fs.statSync(absDir);
        if (!stat.isDirectory()) return [];
        return fs.readdirSync(absDir).filter((name) => {
            try {
                const full = path.join(absDir, name);
                const s = fs.statSync(full);
                return s.isFile();
            } catch {
                return false;
            }
        });
    } catch {
        return [];
    }
}

/**
 * Aplica filtros del source a un basename (formato + nameMustInclude).
 *
 * `nameMustInclude` puede contener placeholders `{issue}`. CA-1.4: si el dir
 * NO incluye `{issue}` y `nameMustInclude` tampoco, el caller no debería
 * permitirlo (validateSource). En la práctica, este filtro asume que el
 * caller ya validó la fuente.
 *
 * @param {string} basename
 * @param {object} source
 * @param {string|number} issueNumber
 * @returns {boolean}
 */
function matchesSource(basename, source, issueNumber) {
    const ext = path.extname(basename).toLowerCase();
    if (!source.formats.includes(ext)) return false;
    if (Array.isArray(source.nameMustInclude) && source.nameMustInclude.length > 0) {
        for (const needle of source.nameMustInclude) {
            const expanded = expandIssue(needle, issueNumber);
            if (basename.indexOf(expanded) < 0) return false;
        }
    }
    return true;
}

/**
 * Verifica que el `source` cumpla la regla CA-1.4: la fuente DEBE ser
 * issue-scoped (vía `dirTemplate` o vía `nameMustInclude`).
 *
 * Si el source no cumple, se ignora silenciosamente (defensa en profundidad
 * contra modificaciones futuras del catálogo SKILL_SOURCES que omitan el
 * scoping).
 *
 * @param {object} source
 * @returns {boolean}
 */
function sourceIsIssueScoped(source) {
    const dirHasIssue = String(source.dirTemplate || '').includes('{issue}');
    const nameHasIssue = Array.isArray(source.nameMustInclude)
        && source.nameMustInclude.some((n) => String(n).includes('{issue}'));
    return dirHasIssue || nameHasIssue;
}

/**
 * Ordena los resultados de `ux` aplicando `uxOrderRank`. Para otros skills,
 * orden alfabético estable.
 *
 * @param {Array<object>} entries
 * @param {string} skill
 * @returns {Array<object>}
 */
function sortAttachments(entries, skill) {
    const copy = entries.slice();
    if (skill === 'ux') {
        copy.sort((a, b) => {
            const ra = uxOrderRank(a._basename);
            const rb = uxOrderRank(b._basename);
            if (ra !== rb) return ra - rb;
            return a._basename.localeCompare(b._basename);
        });
    } else {
        copy.sort((a, b) => a._basename.localeCompare(b._basename));
    }
    return copy;
}

// -----------------------------------------------------------------------------
// API pública
// -----------------------------------------------------------------------------

/**
 * Recolecta los adjuntos disponibles en disco para un skill+issue+fase dados.
 *
 * @param {string} skill - 'ux' | 'po' | 'guru' | 'planner' | 'cua' | ...
 * @param {string|number} issueNumber
 * @param {string} _phase - reservado para uso futuro (filtrado por fase).
 *     No se usa hoy: las convenciones de filename de cada skill ya separan
 *     por fase implícitamente (ej. el mockup vive en criterios; el video QA
 *     en verificacion). Mantener la firma libera evolución sin romper el
 *     contrato del caller.
 * @param {object} [opts]
 * @param {string} [opts.pipelineRoot] - root del repo (default process.cwd()).
 * @returns {Array<{type:string, path:string, descriptor:string}>}
 *     Array vacío si no se encontraron archivos. NUNCA tira excepción.
 */
function collectAttachmentsForSkill(skill, issueNumber, _phase, opts) {
    if (!skill || typeof skill !== 'string') return [];
    const issueAsNumber = parseInt(issueNumber, 10);
    if (!Number.isFinite(issueAsNumber) || issueAsNumber <= 0) return [];

    const sources = SKILL_SOURCES[skill];
    if (!Array.isArray(sources) || sources.length === 0) return [];

    const pipelineRoot = (opts && typeof opts.pipelineRoot === 'string' && opts.pipelineRoot.length > 0)
        ? opts.pipelineRoot
        : process.cwd();

    const issueStr = String(issueAsNumber);
    const collected = [];
    const seenAbs = new Set();

    for (const source of sources) {
        // CA-1.4: defensa en profundidad — si el catálogo se modifica y un
        // source pierde el issue-scoping, lo descartamos en runtime.
        if (!sourceIsIssueScoped(source)) continue;

        const dirRel = expandIssue(source.dirTemplate, issueStr);
        const absDir = path.resolve(pipelineRoot, dirRel);

        const names = listDirSafe(absDir);
        for (const name of names) {
            if (!matchesSource(name, source, issueStr)) continue;

            const absPath = path.resolve(absDir, name);
            if (seenAbs.has(absPath)) continue; // dedup cross-source

            const ext = path.extname(name).toLowerCase();
            const type = resolveType(source, ext);
            if (!type) continue;

            const relPath = path.relative(pipelineRoot, absPath).replace(/\\/g, '/');
            collected.push({
                _basename: name,
                type,
                path: relPath,
                descriptor: descriptorForFile(name, source),
            });
            seenAbs.add(absPath);

            if (collected.length >= HELPER_MAX_PER_INVOCATION) break;
        }
        if (collected.length >= HELPER_MAX_PER_INVOCATION) break;
    }

    const sorted = sortAttachments(collected, skill);
    // Strip campo privado `_basename` antes de devolver.
    return sorted.map((e) => ({
        type: e.type,
        path: e.path,
        descriptor: e.descriptor,
    }));
}

/**
 * Helper para tests: devuelve el catálogo congelado de sources. Útil para
 * verificar que cada source cumple CA-1.4 sin ejecutar el filesystem.
 *
 * @returns {object}
 */
function getSkillSourcesCatalog() {
    return SKILL_SOURCES;
}

module.exports = {
    collectAttachmentsForSkill,
    getSkillSourcesCatalog,
    // Exporto helpers internos solo para tests granulares.
    __internals: {
        expandIssue,
        sourceIsIssueScoped,
        matchesSource,
        uxOrderRank,
        descriptorForFile,
        resolveType,
        HELPER_MAX_PER_INVOCATION,
    },
};
