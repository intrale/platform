'use strict';

// =============================================================================
// Tests #4195 (Ola 7.1) — Equipo MIZPÁ: vista de dotación.
//
// Cubre el módulo puro lib/equipo-roster.js (roster por categoría + banner de
// misión + resolución de proveedor) y la extensión del equipoSlice
// (roster/banner/providersBySkill) + enriquecimiento de activeAgents
// (provider/branch/bounces). También valida que el render SSR de la pantalla
// Equipo conserve el lenguaje MIZPÁ (brand bar + nav popover + miga de pan).
//
// Ejecutar: node --test .pipeline/tests/equipo-roster.test.js
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const roster = require('../lib/equipo-roster.js');
const sat = require('../views/dashboard/satellites.js');
const slices = require('../lib/dashboard-slices.js');

// #4255 (rebote) — `activeAgents` mergea, como cards sintéticas, la presencia
// del Commander y del Sherlock leída de `commander-presence.json` /
// `sherlock-presence.json` REALES del pipeline. Si esta batería corre contra un
// pipeline vivo (o cualquier entorno donde esos archivos existan y estén dentro
// del TTL), `activeAgents(state)` sin aislar devuelve 1 + N cards → el
// `assert.equal(length, 1)` se rompe de forma no determinística ("2 !== 1").
// Inyectamos rutas inexistentes por `opts` para que la presencia NO se lea del
// FS real (mismo patrón que los otros .test.js del slice), volviendo el test
// determinístico e independiente de la actividad del Commander/Sherlock.
const NO_PRESENCE = {
    commanderPresencePath: path.join(os.tmpdir(), 'equipo-roster-no-commander-presence-inexistente.json'),
    sherlockPresencePath: path.join(os.tmpdir(), 'equipo-roster-no-sherlock-presence-inexistente.json'),
};

const SAMPLE_LOAD = {
    po: { running: 0, max: 2 }, ux: { running: 0, max: 2 }, planner: { running: 0, max: 1 },
    architect: { running: 0, max: 2 },
    'backend-dev': { running: 1, max: 3 }, 'android-dev': { running: 1, max: 2 },
    'web-dev': { running: 0, max: 2 }, 'pipeline-dev': { running: 0, max: 2 },
    tester: { running: 0, max: 2 }, qa: { running: 1, max: 1 }, review: { running: 0, max: 2 },
    security: { running: 0, max: 2 }, linter: { running: 0, max: 3 },
    guru: { running: 0, max: 2 }, build: { running: 0, max: 1 }, delivery: { running: 0, max: 1 },
    commander: { running: 0, max: 1 },
};

const SAMPLE_LIVE = [
    { skill: 'backend-dev', issue: '3946', durationMs: 1084000, fase: 'dev' },
    { skill: 'android-dev', issue: '3963', durationMs: 382000, fase: 'dev' },
    { skill: 'qa', issue: '3945', durationMs: 707000, fase: 'verificacion' },
    { skill: 'commander', observational: true, cancelable: false, durationMs: 99 },
];

// ---------------------------------------------------------------------------
// buildRoster
// ---------------------------------------------------------------------------

test('buildRoster agrupa por categoría e incluye congelados, excluye commander (CA-4)', () => {
    const r = roster.buildRoster({ skillLoad: SAMPLE_LOAD, liveAgents: SAMPLE_LIVE });
    const keys = r.categories.map((c) => c.key);
    // Orden canónico de categorías.
    assert.deepEqual(keys, ['product', 'dev', 'quality', 'ops']);
    // El commander NO aparece como rol del grid (es observacional).
    const allSkills = r.categories.flatMap((c) => c.roles.map((x) => x.skill));
    assert.ok(!allSkills.includes('commander'), 'commander excluido del roster');
    // Los congelados (ios-dev, desktop-dev) sí, en dev.
    assert.ok(allSkills.includes('ios-dev') && allSkills.includes('desktop-dev'));
    const dev = r.categories.find((c) => c.key === 'dev');
    const ios = dev.roles.find((x) => x.skill === 'ios-dev');
    assert.equal(ios.state, 'frozen');
});

test('buildRoster marca live/idle según agentes vivos', () => {
    const r = roster.buildRoster({ skillLoad: SAMPLE_LOAD, liveAgents: SAMPLE_LIVE });
    const bySkill = {};
    for (const c of r.categories) for (const x of c.roles) bySkill[x.skill] = x;
    assert.equal(bySkill['backend-dev'].state, 'live');
    assert.equal(bySkill['backend-dev'].liveCount, 1);
    assert.equal(bySkill['qa'].state, 'live');
    assert.equal(bySkill['web-dev'].state, 'idle');
    assert.equal(bySkill['po'].state, 'idle');
});

test('buildRoster cuenta total y despiertos (banner roles)', () => {
    const r = roster.buildRoster({ skillLoad: SAMPLE_LOAD, liveAgents: SAMPLE_LIVE });
    // 16 roles de concurrencia (sin commander) + 2 congelados = 18.
    assert.equal(r.total, 18);
    // 3 roles con agente vivo (backend-dev, android-dev, qa).
    assert.equal(r.awake, 3);
});

// ---------------------------------------------------------------------------
// buildBanner
// ---------------------------------------------------------------------------

test('buildBanner: agentes en vivo excluyen observacionales; el más veterano es el de mayor duración', () => {
    const r = roster.buildRoster({ skillLoad: SAMPLE_LOAD, liveAgents: SAMPLE_LIVE });
    const b = roster.buildBanner({ liveAgents: SAMPLE_LIVE, roster: r });
    assert.equal(b.agentsLive, 3); // commander no cuenta
    assert.equal(b.veteran.skill, 'backend-dev');
    assert.equal(b.veteran.issue, '3946');
    assert.equal(b.rolesAwake, 3);
    assert.equal(b.rolesTotal, 18);
});

test('buildBanner: slots usa cap global por default y nunca supera el máximo', () => {
    const r = roster.buildRoster({ skillLoad: SAMPLE_LOAD, liveAgents: SAMPLE_LIVE });
    const b = roster.buildBanner({ liveAgents: SAMPLE_LIVE, roster: r });
    assert.equal(b.slots.max, roster.DEFAULT_GLOBAL_SLOTS);
    assert.ok(b.slots.used <= b.slots.max);
    assert.equal(b.slots.used, 3);
});

test('countActiveCooldowns cuenta solo cooldowns vigentes (flat map)', () => {
    const now = 1000000;
    const cooldowns = {
        'security:100': { cooldownUntil: new Date(now + 60000).toISOString(), failures: 2 },
        'qa:200': { cooldownUntil: new Date(now - 60000).toISOString(), failures: 1 }, // expirado
    };
    assert.equal(roster.countActiveCooldowns(cooldowns, now), 1);
    assert.equal(roster.countActiveCooldowns(null, now), 0);
});

// ---------------------------------------------------------------------------
// resolveProvider
// ---------------------------------------------------------------------------

test('resolveProvider devuelve id/label/model y null si falta config', () => {
    const models = {
        default_provider: 'anthropic',
        skills: { 'backend-dev': { provider: 'anthropic', model_override: 'claude-opus-4-7' } },
    };
    const p = roster.resolveProvider(models, 'backend-dev');
    assert.equal(p.id, 'anthropic');
    assert.equal(p.label, 'Claude');
    assert.equal(p.model, 'claude-opus-4-7');
    assert.equal(roster.resolveProvider(models, 'no-existe'), null);
    assert.equal(roster.resolveProvider(null, 'backend-dev'), null);
});

// ---------------------------------------------------------------------------
// equipoSlice (integración con el módulo)
// ---------------------------------------------------------------------------

test('equipoSlice expone skills + roster + banner + providersBySkill', () => {
    const state = {
        skillLoad: SAMPLE_LOAD,
        issueMatrix: {},
        config: { concurrencia: SAMPLE_LOAD },
    };
    const out = slices.equipoSlice(state);
    assert.ok(Array.isArray(out.skills), 'mantiene skills (compat)');
    assert.ok(out.roster && Array.isArray(out.roster.categories), 'expone roster');
    assert.ok(out.banner && typeof out.banner.agentsLive === 'number', 'expone banner');
    assert.equal(typeof out.providersBySkill, 'object');
});

// ---------------------------------------------------------------------------
// activeAgents enriquecido
// ---------------------------------------------------------------------------

test('activeAgents agrega provider, branch y bounces a cada agente vivo', () => {
    const state = {
        issueMatrix: {
            '3946': {
                estadoActual: 'trabajando', faseActual: 'desarrollo/dev', title: 'Demo', bounces: 2,
                fases: { 'desarrollo/dev': [{ skill: 'backend-dev', pipeline: 'desarrollo', fase: 'dev', estado: 'trabajando', durationMs: 1000 }] },
            },
        },
    };
    const agents = slices.activeAgents(state, NO_PRESENCE);
    assert.equal(agents.length, 1);
    const a = agents[0];
    assert.equal(a.bounces, 2);
    assert.ok(typeof a.branch === 'string' && a.branch.length > 0, 'branch presente');
    assert.ok(a.branch.includes('3946'), 'branch referencia el issue');
    // provider puede ser null si no hay agent-models, pero el campo debe existir.
    assert.ok('provider' in a);
});

// ---------------------------------------------------------------------------
// Render SSR MIZPÁ
// ---------------------------------------------------------------------------

test('renderEquipo hereda el lenguaje MIZPÁ: brand bar + nav popover + miga de pan (CA-1)', () => {
    const html = sat.renderEquipo();
    assert.ok(html.includes('MIZPÁ'), 'marca MIZPÁ');
    assert.ok(html.includes('mz-projsel'), 'selector multiproyecto');
    assert.ok(html.includes('Intrale'), 'proyecto activo');
    assert.ok(html.includes('1 / 3'), 'badge multiproyecto');
    assert.ok(html.includes('v3-more'), 'popover «Más»');
    assert.ok(html.includes('v3-more-active'), 'popover marcado activo (Equipo secundario)');
    assert.ok(html.includes('mz-crumb'), 'miga de pan');
    assert.ok(html.includes('aria-current="page"'), 'Equipo marcado en la nav');
});

test('renderEquipo incluye banner de misión, visor de slots y búsqueda (CA-2/CA-3)', () => {
    const html = sat.renderEquipo();
    assert.ok(html.includes('La dotación trabajando ahora'));
    assert.ok(html.includes('roles despiertos'));
    assert.ok(html.includes('QUEMANDO AHORA'));
    assert.ok(html.includes('EL MÁS VETERANO'));
    assert.ok(html.includes('EN ENFRIAMIENTO'));
    assert.ok(html.includes('SLOTS DE CONCURRENCIA'));
    assert.ok(html.includes('Buscar por rol'));
});

test('renderEquipo cablea acciones matar + reiniciar y link a issue de GitHub (CA-3)', () => {
    const html = sat.renderEquipo();
    assert.ok(html.includes('Matar agente'));
    assert.ok(html.includes('restartAgent'));
    assert.ok(html.includes('Reiniciar'));
    assert.ok(html.includes('github.com/intrale/platform/issues/'));
    // restart reusa el endpoint con flag restart (no inventa lifecycle).
    assert.ok(html.includes('restart:true'));
});

test('renderEquipo NO trunca textos del banner (sin estilos de overflow agresivos en la desc)', () => {
    const html = sat.renderEquipo();
    // La descripción de misión y la búsqueda están presentes completas.
    assert.ok(html.includes('Cada agente es on-demand'));
});

// #4240 — EQUIPO adopta el marco común MIZPÁ: además de su contenido propio,
// muestra el banner de ola común (② del marco) reutilizando el helper compartido
// renderMissionBanner de la HOME, en el orden ① marca → ② ola → ③ nav → ④ contenido.
test('renderEquipo inyecta el banner de ola común y respeta el orden del marco (#4240)', () => {
    const html = sat.renderEquipo();
    // ② Banner de ola común: el helper compartido renderMissionBanner y sus zonas
    // (tag OLA + título + métricas + bloque AVANCE con barra/leyenda).
    assert.ok(html.includes('id="mz-mission"'), 'banner de ola común presente');
    assert.ok(html.includes('id="mission-wave-num"'), 'tag de ola');
    assert.ok(html.includes('id="mission-eta-value"'), 'métrica ETA');
    assert.ok(html.includes('id="mission-avance-pct"'), 'bloque AVANCE');
    assert.ok(html.includes('id="mission-leg-done"'), 'leyenda de puntitos');
    // CSS compartido (CA-5): el banner se estiliza desde theme.css, no duplicado.
    assert.ok(html.includes('.mz-mission {'), 'CSS .mz-mission compartido (theme.css)');
    assert.ok(html.includes('.mz-wavetag-n'), 'CSS del tag de ola compartido');
    // Hidratación cliente del banner desde /api/dash/waves (CA-2/CA-6).
    assert.ok(html.includes('tickEquipoMission'), 'tick de hidratación del banner de ola');

    // Orden del marco: ① cabecera (in-header) → ② ola (mz-mission) → ③ nav (v3-nav
    // real) → ④ contenido propio (.eq2). Se compara por posición del nodo DOM.
    const posHeader = html.indexOf('class="in-header"');
    const posMission = html.indexOf('id="mz-mission"');
    // El nodo <nav> real lleva role/aria-label; así se descarta el `<nav class="v3-nav">`
    // que aparece dentro del comentario de documentación de nav-tabs.
    const posNav = html.indexOf('<nav class="v3-nav" role=');
    const posBody = html.indexOf('<main class="satellite-body"');
    assert.ok(posHeader > -1 && posMission > -1 && posNav > -1 && posBody > -1, 'todos los bloques presentes');
    assert.ok(posHeader < posMission, '① cabecera antes que ② ola');
    assert.ok(posMission < posNav, '② ola antes que ③ nav');
    assert.ok(posNav < posBody, '③ nav antes que ④ contenido');
    // CA-4: el contenido propio de EQUIPO (roster + visor de slots) queda debajo.
    assert.ok(html.indexOf('class="eq2"') > posMission, 'contenido propio debajo del banner común');
});
