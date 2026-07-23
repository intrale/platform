// =============================================================================
// phases-alias.js — Mapping de jerga coloquial → fase oficial del pipeline.
// Issue #3415 · CA-6 / CA-7 / CA-11 / SEC-1.4
//
// El operador (Leo) no piensa en nombres internos del pipeline (`definicion/
// criterios`, `desarrollo/validacion`). Habla con jerga corta: "rechazá el UX",
// "que vuelva al plan", "rebobiná el refinar". Este módulo cierra esa brecha.
//
// Reglas inquebrantables:
//   - El enum de fases oficiales se deriva de `.pipeline/config.yaml`
//     (`pipelines.*.fases`). El módulo NO inventa fases; si una fase ya no existe
//     en el config, se considera inválida.
//   - El mapping coloquial es ADITIVO sobre el enum oficial. Si el operador usa
//     un nombre oficial exacto (`definicion/criterios`), también funciona.
//   - Validación contra enum cerrado mitiga SEC-1.4 (path traversal por `<fase>`).
//   - `resolvePhase()` jamás devuelve `undefined` para inputs válidos — devuelve
//     `{ok:true, pipeline, phase, official}` o `{ok:false, message, suggestions}`.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

// -----------------------------------------------------------------------------
// Carga del enum oficial desde config.yaml (best-effort: parser regex liviano,
// suficiente para extraer `pipelines.*.fases:[a, b, c]`).
// -----------------------------------------------------------------------------

let CACHED_OFFICIAL = null;

/**
 * Lee `.pipeline/config.yaml` y devuelve la lista de fases oficiales en forma
 * `pipeline/fase`. Si el config no es legible, devuelve fallback hardcoded
 * (mismo valor que el config a la fecha del issue #3415).
 *
 * @param {object} [opts]
 * @param {string} [opts.configPath] - path al config.yaml. Si se omite resuelve
 *                                      `.pipeline/config.yaml` relativo a este módulo.
 * @param {boolean} [opts.refresh=false] - si true, ignora la cache. Útil en tests.
 * @returns {{pipeline: string, phase: string, full: string}[]}
 */
function loadOfficialPhases(opts) {
    const options = opts || {};
    if (CACHED_OFFICIAL && !options.refresh) return CACHED_OFFICIAL;

    const configPath = options.configPath
        || path.resolve(__dirname, '..', '..', 'config.yaml');

    let raw;
    try { raw = fs.readFileSync(configPath, 'utf8'); }
    catch (_) {
        // Fallback hardcoded — sincronizado con config.yaml al cierre de #3415.
        // Si el config no es legible (test aislado, restore en curso), igual
        // queremos que el comando funcione con fases conocidas.
        CACHED_OFFICIAL = HARDCODED_FALLBACK.slice();
        return CACHED_OFFICIAL;
    }

    const out = [];
    // Sub-bloque por pipeline. Captura cada `<pipeline>:` con sus líneas indentadas.
    const pipelinesBlockMatch = raw.match(/^pipelines:\s*\n((?:[ \t]+.*\n)+)/m);
    if (!pipelinesBlockMatch) {
        CACHED_OFFICIAL = HARDCODED_FALLBACK.slice();
        return CACHED_OFFICIAL;
    }
    const block = pipelinesBlockMatch[1];

    // Cada pipeline aparece como `  <nombre>:` y su `fases: [a, b, c]` indentado.
    const lines = block.split('\n');
    let currentPipeline = null;
    for (const line of lines) {
        const pipMatch = line.match(/^ {2}([A-Za-z_-]+):\s*$/);
        if (pipMatch) {
            currentPipeline = pipMatch[1];
            continue;
        }
        const fasesMatch = line.match(/^ {4}fases:\s*\[([^\]]*)\]/);
        if (fasesMatch && currentPipeline) {
            const fases = fasesMatch[1].split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            for (const f of fases) {
                if (/^[a-z][a-z0-9_-]*$/i.test(f)) {
                    out.push({
                        pipeline: currentPipeline,
                        phase: f,
                        full: `${currentPipeline}/${f}`,
                    });
                }
            }
        }
    }

    CACHED_OFFICIAL = out.length > 0 ? out : HARDCODED_FALLBACK.slice();
    return CACHED_OFFICIAL;
}

// Fallback hardcoded en sync con `.pipeline/config.yaml` al cierre del issue #3415.
// Si el config no se puede leer en tests/standalone, igual respondemos válido.
const HARDCODED_FALLBACK = [
    { pipeline: 'definicion', phase: 'analisis', full: 'definicion/analisis' },
    { pipeline: 'definicion', phase: 'criterios', full: 'definicion/criterios' },
    { pipeline: 'definicion', phase: 'sizing', full: 'definicion/sizing' },
    { pipeline: 'desarrollo', phase: 'validacion', full: 'desarrollo/validacion' },
    { pipeline: 'desarrollo', phase: 'dev', full: 'desarrollo/dev' },
    { pipeline: 'desarrollo', phase: 'build', full: 'desarrollo/build' },
    { pipeline: 'desarrollo', phase: 'verificacion', full: 'desarrollo/verificacion' },
    { pipeline: 'desarrollo', phase: 'linteo', full: 'desarrollo/linteo' },
    { pipeline: 'desarrollo', phase: 'aprobacion', full: 'desarrollo/aprobacion' },
    { pipeline: 'desarrollo', phase: 'entrega', full: 'desarrollo/entrega' },
];

// -----------------------------------------------------------------------------
// Mapping coloquial → fase oficial.
//
// La regla: cada alias mapea a UNA fase oficial. Si en el futuro un alias se
// vuelve ambiguo (ej. "validar" podría ser definicion/criterios O desarrollo/
// validacion según contexto), conviene clarificar al operador antes de inferir.
//
// La lista inicial cubre el lenguaje usado en los issues #3414/#3415/#3416 y
// las memorias `feedback_telegram-messages-natural`. Ampliable sin tocar lógica.
// -----------------------------------------------------------------------------
const ALIAS_MAP = {
    // Definición — análisis técnico (guru/security)
    'analisis': 'definicion/analisis',
    'análisis': 'definicion/analisis',
    'refinar': 'definicion/analisis',
    'refinamiento': 'definicion/analisis',
    'análisis técnico': 'definicion/analisis',
    'analisis tecnico': 'definicion/analisis',

    // Definición — criterios (po + ux)
    'criterios': 'definicion/criterios',
    'po': 'definicion/criterios',
    'ux': 'definicion/criterios',
    'mockup': 'definicion/criterios',
    'mockups': 'definicion/criterios',
    'definicion': 'definicion/criterios',
    'definición': 'definicion/criterios',

    // Definición — sizing (planner)
    'sizing': 'definicion/sizing',
    'plan': 'definicion/sizing',
    'planning': 'definicion/sizing',
    'planner': 'definicion/sizing',
    'planificacion': 'definicion/sizing',
    'planificación': 'definicion/sizing',

    // Desarrollo — validación previa al dev
    'validar': 'desarrollo/validacion',
    'validacion': 'desarrollo/validacion',
    'validación': 'desarrollo/validacion',

    // Desarrollo — código
    'dev': 'desarrollo/dev',
    'desarrollo': 'desarrollo/dev',
    'codear': 'desarrollo/dev',
    'codeo': 'desarrollo/dev',
    'implementar': 'desarrollo/dev',
    'implementacion': 'desarrollo/dev',
    'implementación': 'desarrollo/dev',

    // Desarrollo — build
    'build': 'desarrollo/build',
    'compilar': 'desarrollo/build',
    'compilacion': 'desarrollo/build',
    'compilación': 'desarrollo/build',
    'gradle': 'desarrollo/build',

    // Desarrollo — verificación (tester/security/qa)
    'verificacion': 'desarrollo/verificacion',
    'verificación': 'desarrollo/verificacion',
    'verificar': 'desarrollo/verificacion',
    'tests': 'desarrollo/verificacion',
    'qa': 'desarrollo/verificacion',
    'test': 'desarrollo/verificacion',
    'tester': 'desarrollo/verificacion',

    // Desarrollo — linteo
    'linteo': 'desarrollo/linteo',
    'linter': 'desarrollo/linteo',
    'lint': 'desarrollo/linteo',

    // Desarrollo — aprobación (review + po + ux)
    'aprobacion': 'desarrollo/aprobacion',
    'aprobación': 'desarrollo/aprobacion',
    'review': 'desarrollo/aprobacion',
    'revisar': 'desarrollo/aprobacion',
    'aprobar': 'desarrollo/aprobacion',

    // Desarrollo — entrega final
    'entrega': 'desarrollo/entrega',
    'delivery': 'desarrollo/entrega',
    'mergear': 'desarrollo/entrega',
    'merge': 'desarrollo/entrega',
    'pr': 'desarrollo/entrega',
};

// -----------------------------------------------------------------------------
// API pública
// -----------------------------------------------------------------------------

/**
 * Normaliza un input del operador y devuelve la fase oficial resuelta.
 *
 * Estrategia:
 *   1. Normalizar a lowercase + trim.
 *   2. ¿Es un nombre oficial exacto (`definicion/criterios`)? → devolver.
 *   3. ¿Es solo el nombre de la fase sin pipeline (`criterios`)? → buscar única
 *      coincidencia en el enum oficial. Si hay ambigüedad (improbable hoy pero
 *      protegido), pedir desambiguación.
 *   4. ¿Está en el mapping coloquial? → devolver la fase oficial.
 *   5. No matchea → `{ok:false, message, suggestions}`.
 *
 * @param {string} input
 * @param {object} [opts]
 * @param {string} [opts.configPath]
 * @returns {{ok: boolean, pipeline?: string, phase?: string, full?: string, alias?: string, message?: string, suggestions?: string[]}}
 */
function resolvePhase(input, opts) {
    const raw = String(input || '').trim().toLowerCase();
    if (!raw) {
        return {
            ok: false,
            message: 'Fase vacía',
            suggestions: listValidAliases(),
        };
    }

    // Defensa SEC-1.4: rechazar inmediatamente caracteres peligrosos antes
    // de cualquier lookup (path traversal, command injection).
    if (/[\\/]/.test(raw) === false && /[.;|`$<>{}*?\[\]"\\']/.test(raw)) {
        return {
            ok: false,
            message: `Caracteres no permitidos en la fase: "${raw}"`,
            suggestions: listValidAliases(),
        };
    }

    const official = loadOfficialPhases(opts);

    // 2 — match exacto `pipeline/fase`.
    const fullMatch = official.find((o) => o.full === raw);
    if (fullMatch) {
        return { ok: true, pipeline: fullMatch.pipeline, phase: fullMatch.phase, full: fullMatch.full, alias: raw };
    }

    // 3 — match por phase sin pipeline (búsqueda de única coincidencia).
    // Si hay más de una, no podemos resolver (improbable hoy pero defensivo).
    const phaseMatches = official.filter((o) => o.phase === raw);
    if (phaseMatches.length === 1) {
        const m = phaseMatches[0];
        return { ok: true, pipeline: m.pipeline, phase: m.phase, full: m.full, alias: raw };
    }
    if (phaseMatches.length > 1) {
        return {
            ok: false,
            message: `Fase ambigua "${raw}" — clarificá: ${phaseMatches.map((m) => m.full).join(', ')}`,
            suggestions: phaseMatches.map((m) => m.full),
        };
    }

    // 4 — alias coloquial.
    const aliasResolved = ALIAS_MAP[raw];
    if (aliasResolved) {
        const m = official.find((o) => o.full === aliasResolved);
        if (m) {
            return { ok: true, pipeline: m.pipeline, phase: m.phase, full: m.full, alias: raw };
        }
        // El alias apunta a una fase que el config ya no incluye (drift).
        // Mejor responder con error claro que silenciar.
        return {
            ok: false,
            message: `Alias "${raw}" apunta a fase "${aliasResolved}" que el config actual no incluye`,
            suggestions: official.map((o) => o.full),
        };
    }

    // 5 — sin match.
    return {
        ok: false,
        message: `Fase inválida: "${raw}"`,
        suggestions: listValidAliases().slice(0, 12),
    };
}

/**
 * Lista de aliases válidos + fases oficiales, ordenada y deduplicada.
 * Útil para construir el mensaje de error "Fase inválida. Válidas: …".
 *
 * @param {object} [opts]
 * @returns {string[]}
 */
function listValidAliases(opts) {
    const officialFulls = loadOfficialPhases(opts).map((o) => o.full);
    const aliases = Object.keys(ALIAS_MAP);
    // Priorizamos: aliases cortos primero, luego nombres oficiales (más útiles
    // para el operador que la fase fully-qualified).
    const seen = new Set();
    const ordered = [];
    for (const a of aliases) {
        if (!seen.has(a)) { seen.add(a); ordered.push(a); }
    }
    for (const f of officialFulls) {
        if (!seen.has(f)) { seen.add(f); ordered.push(f); }
    }
    return ordered;
}

/**
 * Solo para tests/herramientas: limpia la cache para forzar re-lectura del
 * config.yaml en el próximo `resolvePhase`.
 */
function _clearCache() {
    CACHED_OFFICIAL = null;
}

module.exports = {
    resolvePhase,
    loadOfficialPhases,
    listValidAliases,
    ALIAS_MAP,
    HARDCODED_FALLBACK,
    _clearCache,
};
