'use strict';

// =============================================================================
// write-deliverable.js — EP3-H3 (#3929)
//
// Helper compartido que centraliza la escritura del ARTEFACTO FÍSICO de cierre
// de fase que cada productor (guru/po/planner/ux/qa/tester/security/build/
// architect/devs) debe dejar en su root issue-scoped. Absorbe en un único punto
// los requisitos de seguridad de la historia para que ningún SKILL.md tenga que
// reimplementarlos (y reintroducir vulnerabilidades):
//
//   - CA-5 (path traversal): valida `^\d+$` en `issue` antes de construir el path.
//   - CA-6 (fuga de secrets): redacta AWS keys / JWT / API keys / emails / URLs
//     vía `redact.js` ANTES de persistir.
//   - CA-8 (XSS/XXE en SVG): strip de `<script>`, handlers `on*`, `javascript:`,
//     `<!DOCTYPE>`/DTD y `<!ENTITY>` (entidades externas) antes de escribir.
//   - CA-9 (DoS de disco): cap defensivo de tamaño por artefacto.
//
// La RESOLUCIÓN del directorio NO se hardcodea: se lee de `SKILL_SOURCES`
// (catálogo de `skill-deliverable-attachments.js`), única fuente de verdad de
// rutas por perfil. Así, si cambia el catálogo, el helper y el recolector
// quedan siempre alineados.
//
// Doctrina y contexto: docs/pipeline/entregables-multimedia-por-agente.md
// =============================================================================

const fs = require('fs');
const path = require('path');
const { getSkillSourcesCatalog } = require('./skill-deliverable-attachments');
const { redactSecretValue, redactSensitive } = require('./redact');
const { upsertDeliverableIndex, validatePhase } = require('./deliverable-index');

// Cap defensivo de tamaño por artefacto (CA-9). 5 MiB cubre PDFs/MD/SVG ricos
// sin permitir que un productor sature el FS (fuente de verdad del pipeline).
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Resuelve el directorio issue-scoped donde un skill debe escribir su artefacto.
 * NO hardcodea paths: lee el catálogo `SKILL_SOURCES`. Prefiere la fuente
 * issue-scoped (`{issue}` en el `dirTemplate`) cuyo `formats` incluya la
 * extensión pedida; cae a la primera issue-scoped disponible.
 *
 * @param {string} skill - clave del perfil en `SKILL_SOURCES` (ej. 'guru').
 * @param {string|number} issue - número de issue. DEBE ser `^\d+$` (CA-5).
 * @param {object} [opts]
 * @param {string} [opts.ext] - extensión deseada (con punto). Para preferir la
 *     fuente que la soporta. Opcional.
 * @param {string} [opts.pipelineRoot] - root del repo (default process.cwd()).
 *     Debe coincidir con el que usa el recolector para que el archivo se halle.
 * @returns {string} ruta absoluta del directorio issue-scoped.
 */
function resolveDeliverableDir(skill, issue, opts = {}) {
    if (typeof skill !== 'string' || skill.length === 0) {
        throw new Error(`skill inválido: ${skill}`);
    }
    // CA-5 — path traversal: el issue es un segmento de path. Sólo dígitos.
    const issueStr = String(issue);
    if (!/^\d+$/.test(issueStr)) {
        throw new Error(`issue inválido (no ^\\d+$): ${issue}`);
    }

    const catalog = getSkillSourcesCatalog();
    const profile = catalog[skill];
    if (!Array.isArray(profile) || profile.length === 0) {
        throw new Error(`skill sin perfil en SKILL_SOURCES: ${skill}`);
    }

    // Sólo fuentes issue-scoped (defensa: nunca escribir en un dir plano
    // compartido entre issues). Si ninguna lo es, es un perfil mal formado.
    const issueScoped = profile.filter(
        (s) => typeof s.dirTemplate === 'string' && s.dirTemplate.includes('{issue}'),
    );
    if (issueScoped.length === 0) {
        throw new Error(`skill sin fuente issue-scoped: ${skill}`);
    }

    const ext = opts.ext;
    const byFormat = ext
        ? issueScoped.find((s) => Array.isArray(s.formats) && s.formats.includes(ext))
        : null;
    const src = byFormat || issueScoped[0];

    const dirRel = src.dirTemplate.replace(/\{issue\}/g, issueStr);
    const pipelineRoot =
        typeof opts.pipelineRoot === 'string' && opts.pipelineRoot.length > 0
            ? opts.pipelineRoot
            : process.cwd();
    return path.resolve(pipelineRoot, dirRel);
}

/**
 * Sanitiza un SVG/markup antes de persistirlo (CA-8). Elimina vectores de
 * XSS almacenado y XXE:
 *   - `<script>...</script>`
 *   - handlers de evento inline `on*=` (comillas dobles/simples/sin comillas)
 *   - URIs `javascript:` en atributos
 *   - `<!DOCTYPE ...>` (DTD) y `<!ENTITY ...>` (entidades externas → XXE)
 *
 * @param {string} svg
 * @returns {string}
 */
function sanitizeSvg(svg) {
    if (typeof svg !== 'string') return '';
    return svg
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<script[\s\S]*?>/gi, '')              // <script/> o sin cierre
        .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')         // on*="..."
        .replace(/\son\w+\s*=\s*'[^']*'/gi, '')         // on*='...'
        .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')         // on*=valor-sin-comillas
        .replace(/javascript:/gi, '')                   // href="javascript:..."
        .replace(/<!DOCTYPE[\s\S]*?>/gi, '')            // DTD
        .replace(/<!ENTITY[\s\S]*?>/gi, '');            // entidades externas (XXE)
}

/**
 * Redacta secrets y datos sensibles del contenido textual antes de persistir
 * (CA-6). Cubre AWS keys / JWT / API keys de proveedores (`redactSecretValue`)
 * y emails / query-params de URLs (`redactSensitive`).
 *
 * @param {string} content
 * @returns {string}
 */
function redactContent(content) {
    if (typeof content !== 'string' || content.length === 0) return content;
    // 1) Valores de secretos conocidos + heurística de entropía por token.
    let out = redactSecretValue(content);
    // 2) Emails y parámetros sensibles en URLs.
    out = redactSensitive(out);
    return out;
}

/**
 * Escribe el artefacto físico de cierre de fase de un skill en su root
 * issue-scoped, aplicando sanitización (SVG) y redacción de secrets.
 *
 * @param {string} skill - clave del perfil (ej. 'guru', 'tester', 'pipeline-dev').
 * @param {string|number} issue - número de issue (`^\d+$`).
 * @param {object} [payload]
 * @param {string} [payload.md] - contenido markdown del artefacto.
 * @param {string} [payload.svg] - contenido SVG (se sanitiza antes de redactar).
 * @param {boolean} [payload.redact=true] - aplicar redacción de secrets.
 * @param {string} [payload.filename] - nombre de archivo explícito (opcional).
 *     Si se da, se valida que no contenga separadores ni `..`.
 * @param {number} [payload.maxBytes] - cap de tamaño (default 5 MiB).
 * @param {string} [payload.pipelineRoot] - root del repo (default process.cwd()).
 * @param {string} [payload.fase] - fase del pipeline en que se produce el
 *     artefacto (#4255). Si se da: (1) valida contra el enum cerrado (SEC-2),
 *     (2) el filename por defecto pasa a ser `<skill>-<fase>-<issue>.<ext>` para
 *     que dos fases del mismo agente NO colisionen, (3) se actualiza el índice
 *     `.pipeline/deliverables/<issue>.json` en la misma llamada (choke point,
 *     SEC-3). Sin `fase`, mantiene el comportamiento legacy (`<skill>-<issue>`).
 * @param {boolean} [payload.sensible=false] - flag de sensibilidad del artefacto
 *     (SEC-1). Se persiste en el índice para que el canal de consumo decida
 *     visibilidad. Sólo aplica si se pasa `fase`.
 * @param {string} [payload.timestamp] - ISO inyectable para el índice
 *     (determinismo en tests). Sólo aplica si se pasa `fase`.
 * @returns {{path: string, bytes: number, indexed: boolean, fase?: string}}
 */
function writeDeliverable(skill, issue, payload = {}) {
    const {
        md, svg, redact = true, filename, maxBytes = DEFAULT_MAX_BYTES, pipelineRoot,
        fase, sensible = false, timestamp,
    } = payload;

    if (md == null && svg == null) {
        throw new Error('writeDeliverable requiere `md` o `svg`');
    }

    // SEC-2: si viene `fase`, validarla contra el enum cerrado ANTES de tocar el
    // FS. `fase` NUNCA es un segmento de path libre — sólo entra al índice.
    if (fase != null) {
        validatePhase(fase, { pipelineRoot });
    }

    const isSvg = svg != null;
    const ext = isSvg ? '.svg' : '.md';

    const dir = resolveDeliverableDir(skill, issue, { ext, pipelineRoot });

    // Contenido: sanitizar SVG (CA-8) → luego redactar (CA-6).
    let content = isSvg ? sanitizeSvg(String(svg)) : String(md);
    if (redact) content = redactContent(content);

    // CA-9 — cap de tamaño por artefacto.
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > maxBytes) {
        throw new Error(`artefacto excede maxBytes (${bytes} > ${maxBytes})`);
    }

    // Nombre de archivo. Si el caller pasa uno explícito, validar basename plano.
    // Sin filename: default phase-scoped `<skill>-<fase>-<issue>.<ext>` cuando
    // hay `fase` (evita la colisión multi-fase — dos fases del mismo agente ya
    // no se pisan), o legacy `<skill>-<issue>.<ext>` cuando no hay fase.
    let name;
    if (filename) {
        if (/[\\/]/.test(filename) || filename.includes('..')) {
            throw new Error(`filename inválido (path traversal): ${filename}`);
        }
        name = filename;
    } else if (fase != null) {
        name = `${skill}-${fase}-${issue}${ext}`;
    } else {
        name = `${skill}-${issue}${ext}`;
    }

    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, content, 'utf8'); // snapshot: overwrite, no append.

    // Choke point del índice (SEC-3): la ÚNICA escritura del store actualiza el
    // manifest en la misma llamada. Ningún SKILL.md debe escribir el índice a
    // mano. Sólo se indexa cuando hay `fase` (dimensión requerida por el índice).
    let indexed = false;
    if (fase != null) {
        const root =
            typeof pipelineRoot === 'string' && pipelineRoot.length > 0
                ? pipelineRoot
                : process.cwd();
        const relPath = path.relative(root, file).replace(/\\/g, '/');
        upsertDeliverableIndex({
            issue,
            fase,
            agente: skill,
            tipo: isSvg ? 'image' : 'document',
            path: relPath,
            bytes,
            sensible,
            timestamp,
            pipelineRoot,
        });
        indexed = true;
    }

    return { path: file, bytes, indexed, ...(fase != null ? { fase } : {}) };
}

module.exports = {
    writeDeliverable,
    resolveDeliverableDir,
    sanitizeSvg,
    redactContent,
    DEFAULT_MAX_BYTES,
};
