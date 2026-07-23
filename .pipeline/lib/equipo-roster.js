'use strict';

// =============================================================================
// equipo-roster.js — Dotación del equipo de agentes (#4195, Ola 7.1).
// -----------------------------------------------------------------------------
// Módulo PURO y testeable que arma la "vista de dotación" de la pantalla Equipo
// rediseñada (MIZPÁ): roster de roles por categoría diferenciando despiertos
// (vivos) de dormidos (ociosos) o congelados, más los agregados del banner de
// misión (agentes en vivo, roles despiertos/total, el más veterano, en
// enfriamiento y slots de concurrencia) y la resolución de proveedor por rol.
//
// Fuentes de verdad (no se inventan números):
//   - `skillLoad`        : { skill: { running, max } } derivado de
//                          `config.concurrencia` (dashboard.js:1362). Es el
//                          padrón operativo de roles que el Pulpo agenda.
//   - `liveAgents`       : salida de slices.activeAgents (agentes trabajando).
//   - `agentModels`      : `.pipeline/agent-models.json` (provider por skill).
//   - `cooldowns`        : `.pipeline/agent-cooldowns.json` (enfriamiento).
//   - skill-catalog.js   : categoría canónica compartida con Matriz/Pipeline.
//
// Categorización: se reusa `categoryOf()` del catálogo compartido (fuente única
// — no se duplica el contrato de orden que consumen Matriz/Pipeline) con
// overrides locales SOLO para roles que el catálogo no declara todavía
// (pipeline-dev, architect, linter), para no tocar el test anti-regresión de
// `skill-catalog.test.js` ni reordenar esas vistas.
// =============================================================================

const catalog = require('./skill-catalog');

// Skills de desarrollo congelados (no se agendan, reactivables por issue). En
// línea con la memoria operativa `frozen-skills.md` (ios-dev, desktop-dev). Se
// muestran en el roster como "congelados" para reflejar la dotación completa.
const FROZEN_SKILLS = ['ios-dev', 'desktop-dev'];

// Rol observacional: el Commander es un singleton orquestador, no parte de la
// dotación agendable. Se excluye del grid de roles (aparece como presencia
// protegida en la lista de agentes vivos).
const OBSERVATIONAL_SKILLS = new Set(['commander']);

// Override de categoría SOLO para roles ausentes de skill-catalog.SKILL_CATEGORY
// (que por default caen a 'ops'). Mantiene Matriz/Pipeline intactos y agrupa
// estos roles donde el operador los espera.
const CATEGORY_OVERRIDE = {
    'pipeline-dev': 'dev',
    'ios-dev': 'dev',
    'desktop-dev': 'dev',
    architect: 'product',
    linter: 'quality',
};

// Metadata visual (persona) por rol. Espejo del AGENT_PERSONA de dashboard.js,
// extendido con los roles que la pantalla Equipo necesita y que el persona
// inline no declara (pipeline-dev, architect, linter, frozen devs). icon/color
// para el avatar; tagline corta y descriptiva del oficio del rol.
const ROLE_PERSONA = {
    po:            { icon: '📋', name: 'PO',          tagline: 'Acceptance · flujos de negocio',     color: '#d29922' },
    ux:            { icon: '🎨', name: 'UX',          tagline: 'Experiencia · diseño · benchmarking', color: '#f778ba' },
    planner:       { icon: '📐', name: 'Planner',     tagline: 'Estrategia · roadmap · dependencias', color: '#a371f7' },
    architect:     { icon: '🏛', name: 'Architect',   tagline: 'Recetas · adherencia de diseño',      color: '#a371f7' },
    'backend-dev': { icon: '⚡', name: 'BackendDev',  tagline: 'Ktor · DynamoDB · Cognito · Lambda',  color: '#3fb950' },
    'android-dev': { icon: '📱', name: 'AndroidDev',  tagline: 'Compose · flavors · Material3',        color: '#58a6ff' },
    'web-dev':     { icon: '🌐', name: 'WebDev',      tagline: 'Kotlin/Wasm · PWA · browser APIs',     color: '#79c0ff' },
    'pipeline-dev':{ icon: '🔧', name: 'PipelineDev', tagline: 'Pulpo · dashboard · hooks (Node.js)',  color: '#a371f7' },
    'ios-dev':     { icon: '🍎', name: 'iOSDev',      tagline: 'SwiftUI bridge · congelado',           color: '#8b949e' },
    'desktop-dev': { icon: '🖥', name: 'DesktopDev',  tagline: 'Compose Desktop/JVM · congelado',      color: '#8b949e' },
    tester:        { icon: '🧪', name: 'Tester',      tagline: 'Kover · cobertura · tests Gherkin',    color: '#d2a8ff' },
    qa:            { icon: '✅', name: 'QA',          tagline: 'E2E · emulador · video',               color: '#3fb950' },
    review:        { icon: '👁', name: 'Review',      tagline: 'Code review · buenas prácticas',       color: '#ffa657' },
    security:      { icon: '🔒', name: 'Security',    tagline: 'OWASP · vulnerabilidades · auditoría', color: '#f85149' },
    linter:        { icon: '🧹', name: 'Linter',      tagline: 'Chequeos mecánicos · Node puro',       color: '#8b949e' },
    guru:          { icon: '🧠', name: 'Guru',        tagline: 'Investigación técnica · Context7',     color: '#bc8cff' },
    perf:          { icon: '⚡', name: 'Perf',         tagline: 'Performance · builds · módulos',       color: '#d29922' },
    build:         { icon: '🏗', name: 'Builder',     tagline: 'Gradle · compilación · APKs',          color: '#8b949e' },
    delivery:      { icon: '🚀', name: 'Delivery',    tagline: 'Commit · push · PR · merge',           color: '#f0883e' },
    commander:     { icon: '🤖', name: 'Commander',   tagline: 'Orquestador del pipeline',             color: '#8b949e' },
};

const FALLBACK_PERSONA = { icon: '⚙', name: '', tagline: '', color: '#8b949e' };

// Etiqueta humana corta por proveedor (agent-models.json `providers.<id>`).
const PROVIDER_LABELS = {
    anthropic: 'Claude',
    'openai-codex': 'Codex',
    'gemini-google': 'Gemini',
    cerebras: 'Cerebras',
    'nvidia-nim': 'NVIDIA NIM',
    deterministic: 'Determinístico',
};

// Cap global de agentes simultáneos por default (límite de sprint documentado en
// CLAUDE.md). La concurrencia real es graduada por presión de recursos; este es
// el presupuesto nominal de cupos que muestra el visor de slots.
const DEFAULT_GLOBAL_SLOTS = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function personaFor(skill) {
    return ROLE_PERSONA[skill] || Object.assign({}, FALLBACK_PERSONA, { name: skill });
}

function categoryForRole(skill) {
    return CATEGORY_OVERRIDE[skill] || catalog.categoryOf(skill);
}

/**
 * Resuelve el proveedor configurado para un skill desde agent-models.json.
 * Devuelve { id, label, model } o null si no hay config para el skill.
 */
function resolveProvider(agentModels, skill) {
    if (!agentModels || !agentModels.skills) return null;
    const entry = agentModels.skills[skill];
    if (!entry) return null;
    const id = String(entry.provider || agentModels.default_provider || '').trim();
    if (!id) return null;
    return {
        id,
        label: PROVIDER_LABELS[id] || id,
        model: entry.model_override ? String(entry.model_override) : null,
    };
}

/**
 * Cuenta cooldowns activos (enfriamiento) al momento `now`. El archivo de
 * cooldowns mapea claves → { cooldownUntil, failures }. Tolera formas viejas.
 */
function countActiveCooldowns(cooldowns, now) {
    if (!cooldowns || typeof cooldowns !== 'object') return 0;
    const entries = cooldowns.cooldowns && typeof cooldowns.cooldowns === 'object'
        ? cooldowns.cooldowns
        : cooldowns;
    let n = 0;
    for (const v of Object.values(entries)) {
        if (!v) continue;
        const until = typeof v === 'object'
            ? Date.parse(v.cooldownUntil || v.until || '')
            : Date.parse(v);
        if (!isNaN(until) && until > now) n += 1;
    }
    return n;
}

// ---------------------------------------------------------------------------
// Roster por categoría
// ---------------------------------------------------------------------------

/**
 * Arma el roster de roles agrupado por categoría canónica.
 *
 * @param {object} opts
 * @param {object} opts.skillLoad   - { skill: { running, max } } (concurrencia).
 * @param {array}  opts.liveAgents  - salida de activeAgents (agentes trabajando).
 * @param {array}  [opts.frozen]    - skills congelados a incluir (default FROZEN_SKILLS).
 * @returns {{categories: array, total: number, awake: number}}
 */
function buildRoster(opts) {
    opts = opts || {};
    const skillLoad = opts.skillLoad || {};
    const liveAgents = Array.isArray(opts.liveAgents) ? opts.liveAgents : [];
    const frozen = Array.isArray(opts.frozen) ? opts.frozen : FROZEN_SKILLS;

    // Vivos por skill (excluyendo presencia observacional como el Commander).
    const liveBySkill = {};
    for (const a of liveAgents) {
        if (!a || a.observational === true || a.cancelable === false) continue;
        const s = String(a.skill || '');
        if (!s) continue;
        liveBySkill[s] = (liveBySkill[s] || 0) + 1;
    }

    // Padrón de roles = concurrencia (excluye observacionales) ∪ congelados.
    const rosterSkills = [];
    const seen = new Set();
    for (const s of Object.keys(skillLoad)) {
        if (OBSERVATIONAL_SKILLS.has(s)) continue;
        if (seen.has(s)) continue;
        seen.add(s); rosterSkills.push(s);
    }
    for (const s of frozen) {
        if (seen.has(s)) continue;
        seen.add(s); rosterSkills.push(s);
    }

    // Agrupar por categoría en el orden canónico de CATEGORY_ORDER.
    const byCat = {};
    for (const skill of rosterSkills) {
        const cat = categoryForRole(skill);
        (byCat[cat] = byCat[cat] || []).push(skill);
    }

    const isFrozen = new Set(frozen);
    const categories = [];
    let total = 0, awake = 0;
    const catOrder = catalog.CATEGORY_ORDER.slice();
    // Categorías extra no declaradas (defensivo).
    for (const c of Object.keys(byCat)) if (!catOrder.includes(c)) catOrder.push(c);

    for (const cat of catOrder) {
        const skills = byCat[cat];
        if (!skills || skills.length === 0) continue;
        const meta = catalog.CATEGORY_META[cat] || { label: cat, icon: '⚙', color: '#8b949e' };
        const roles = skills.map((skill) => {
            const p = personaFor(skill);
            const liveCount = liveBySkill[skill] || 0;
            const load = skillLoad[skill] || { running: 0, max: 0 };
            const state = isFrozen.has(skill) ? 'frozen' : (liveCount > 0 ? 'live' : 'idle');
            return {
                skill,
                name: p.name || skill,
                tagline: p.tagline || '',
                icon: p.icon,
                color: p.color,
                max: load.max || 0,
                liveCount,
                state,
            };
        });
        // Despiertos primero, después por nombre.
        roles.sort((a, b) => (b.liveCount - a.liveCount) || a.skill.localeCompare(b.skill));
        const catLive = roles.filter((r) => r.state === 'live').length;
        total += roles.length;
        awake += catLive;
        categories.push({
            key: cat,
            label: meta.label,
            icon: meta.icon,
            color: meta.color,
            roles,
            liveCount: catLive,
            total: roles.length,
        });
    }

    return { categories, total, awake };
}

// ---------------------------------------------------------------------------
// Banner de misión
// ---------------------------------------------------------------------------

/**
 * Agregados del banner de misión.
 *
 * @param {object} opts
 * @param {array}  opts.liveAgents  - activeAgents.
 * @param {object} opts.roster      - salida de buildRoster.
 * @param {object} [opts.cooldowns] - archivo de cooldowns.
 * @param {number} [opts.now]       - epoch ms (default Date.now()).
 * @param {number} [opts.slotsMax]  - cupos globales (default DEFAULT_GLOBAL_SLOTS).
 * @param {number} [opts.tokPerMin] - tok/min agregado (puede ser null).
 * @returns {object}
 */
function buildBanner(opts) {
    opts = opts || {};
    const liveAgents = Array.isArray(opts.liveAgents) ? opts.liveAgents : [];
    const roster = opts.roster || { total: 0, awake: 0 };
    const now = typeof opts.now === 'number' ? opts.now : Date.now();
    const slotsMax = typeof opts.slotsMax === 'number' ? opts.slotsMax : DEFAULT_GLOBAL_SLOTS;

    // Agentes en vivo reales (excluye observacionales como el Commander).
    const real = liveAgents.filter((a) => a && a.observational !== true && a.cancelable !== false);

    // El más veterano: mayor durationMs entre los reales.
    let veteran = null;
    for (const a of real) {
        if (!veteran || (a.durationMs || 0) > (veteran.durationMs || 0)) {
            const p = personaFor(a.skill);
            veteran = {
                issue: a.issue != null ? String(a.issue) : null,
                skill: a.skill,
                name: p.name || a.skill,
                durationMs: a.durationMs || 0,
                fase: a.fase || '',
            };
        }
    }

    const coolingCount = countActiveCooldowns(opts.cooldowns, now);

    return {
        agentsLive: real.length,
        rolesAwake: roster.awake || 0,
        rolesTotal: roster.total || 0,
        tokPerMin: (typeof opts.tokPerMin === 'number' && isFinite(opts.tokPerMin)) ? opts.tokPerMin : null,
        veteran,
        coolingCount,
        slots: { used: Math.min(real.length, slotsMax), max: slotsMax, total: real.length },
    };
}

module.exports = {
    buildRoster,
    buildBanner,
    resolveProvider,
    countActiveCooldowns,
    personaFor,
    categoryForRole,
    ROLE_PERSONA,
    PROVIDER_LABELS,
    FROZEN_SKILLS,
    OBSERVATIONAL_SKILLS,
    DEFAULT_GLOBAL_SLOTS,
};
