'use strict';
// =============================================================================
// #6745 rev-2 — CA-7 / CA-6: el hint de infra ya no es un bypass del piso ni
// del circuit breaker, y la prosa de red no se degrada por citar un endpoint.
//
// CONTEXTO (por qué existe este archivo)
// --------------------------------------
// La rev-1 puso el piso de `security` dentro de `resolveInfraVeredicto`, que es
// la RAMA 4 de `classifyRebote`. Pero las ramas 1.4 (`infra_agent_crash`) y 1.5
// (`infra_no_apk`) retornan `category: 'infra'` ANTES de llegar ahí, y se
// disparan con `rebote_categoria` — un campo que escribe el propio agente
// rechazado. Resultado medido sobre HEAD 36a291065, con la allowlist real de 17
// skills: un rechazo de `security` se auto-eximía del circuit breaker con una
// sola línea de YAML, y la rama 1.5 además matcheaba por TEXTO del motivo,
// exactamente el vector que el comentario de #5641 declara prohibido.
//
// Ninguna de las 3 suites vivas cubría el vector: el único `rebote_categoria`
// que aparecía en todas era `'dependency_block'`. Por eso pasaban verdes con el
// bypass abierto. Estos tests son el guard que faltaba.
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const { classifyRebote } = require('../rebote-classifier');
const precheck = require('../../connectivity-precheck');
const workfileName = require('../workfile-name');
const { SKILLS_PISO_GRAVE } = require('../rejection-severity');

// Allowlist REAL del producto — no una lista inventada. El fail-closed de CA-7
// se apoya en `buildSkillAllowlist`, así que testearlo con un Set ad-hoc no
// probaría el camino de producción.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const rawConfig = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'pipeline.config.json'), 'utf8'));
const ALLOWLIST = workfileName.buildSkillAllowlist(rawConfig.productConfig || rawConfig);

// Rechazo de contenido REAL de security: cita archivo:línea y un CA incumplido.
const MOTIVO_SEC = 'Secret hardcodeado en backend/src/Config.kt:88 - token AWS en claro. CA-3 incumplido.';

/** Réplica del call-site de producción (`pulpo.js`, decisor único). */
function clasificarComoPulpo({ skill, motivo, rebote_categoria = null, veredictoSintetizadoPorPulpo = false }) {
    const detalle = precheck.classifyErrorDetailed(motivo);
    return classifyRebote({
        motivo,
        classifyErrorDetail: detalle,
        skill,
        skillAllowlist: ALLOWLIST,
        classifyErrorResult: detalle.clasificacion || 'codigo',
        isRoutingMismatch: false,
        rebote_categoria,
        dependsOn: null,
        veredictoSintetizadoPorPulpo,
    });
}

// -----------------------------------------------------------------------------
// CA-7 — la tabla completa del rechazo, caso por caso.
// -----------------------------------------------------------------------------

test('CA-7 caso A (baseline) — security sin hint sigue siendo code y penaliza', () => {
    const v = clasificarComoPulpo({ skill: 'security', motivo: MOTIVO_SEC });
    assert.equal(v.category, 'code');
    assert.equal(v.counts_against_circuit_breaker, true);
});

test('CA-7 caso B — security + rebote_categoria=infra_agent_crash NO puede clasificar infra', () => {
    const v = clasificarComoPulpo({
        skill: 'security', motivo: MOTIVO_SEC, rebote_categoria: 'infra_agent_crash',
    });
    assert.equal(v.category, 'code', 'el hint del agente no puede saltear el piso de security');
    assert.equal(v.counts_against_circuit_breaker, true);
});

test('CA-7 caso C — security + rebote_categoria=infra_no_apk NO puede clasificar infra', () => {
    const v = clasificarComoPulpo({
        skill: 'security', motivo: MOTIVO_SEC, rebote_categoria: 'infra_no_apk',
    });
    assert.equal(v.category, 'code');
    assert.equal(v.counts_against_circuit_breaker, true);
});

test('CA-7 caso D — citar el literal `infra-no-apk` en PROSA no clasifica infra', () => {
    // La rama 1.5 matcheaba `/infra[-_]no[-_]apk/i` sobre el texto del motivo.
    // Se eliminó: el `motivo` lo escribe el agente rechazado.
    for (const motivo of [
        MOTIVO_SEC + ' (infra-no-apk)',
        MOTIVO_SEC + ' el pipeline reporto infra_no_apk en el log',
    ]) {
        const v = clasificarComoPulpo({ skill: 'security', motivo });
        assert.equal(v.category, 'code', `no debe clasificar por texto: ${motivo}`);
        assert.equal(v.counts_against_circuit_breaker, true);
    }
});

test('CA-7 caso D bis — el match por texto tampoco funciona para un skill NO-security', () => {
    // Sin el piso de por medio: el vector del texto está muerto por construcción.
    const v = clasificarComoPulpo({ skill: 'qa', motivo: 'Falla la pantalla de login (infra-no-apk)' });
    assert.equal(v.category, 'code');
    assert.equal(v.counts_against_circuit_breaker, true);
});

test('CA-7 caso E — CUALQUIER skill del allowlist necesita procedencia del Pulpo para el hint', () => {
    // El bypass no era exclusivo de `security`: `rebote_categoria` lo escribe el
    // agente, así que un `qa`/`po`/`review` podía auto-eximirse del breaker.
    for (const skill of ['qa', 'po', 'review', 'tester', 'architect']) {
        const v = clasificarComoPulpo({
            skill, motivo: MOTIVO_SEC, rebote_categoria: 'infra_agent_crash',
        });
        assert.equal(v.category, 'code', `${skill} no puede auto-declararse infra`);
        assert.equal(v.counts_against_circuit_breaker, true);
    }
});

test('CA-7 — con procedencia REAL del Pulpo, la caída del agente SÍ es infra y no penaliza', () => {
    // El contrapeso: los tests de arriba no deben cerrarse "apagando" el carril
    // de #5641. Un crash genuino (exit code != 0) lo marca el Pulpo, no el agente.
    const v = clasificarComoPulpo({
        skill: 'qa',
        motivo: 'Agente terminó con código 1',
        rebote_categoria: 'infra_agent_crash',
        veredictoSintetizadoPorPulpo: true,
    });
    assert.equal(v.category, 'infra');
    assert.equal(v.counts_against_circuit_breaker, false);
});

test('CA-7 — ni siquiera la procedencia del Pulpo levanta el piso de security', () => {
    // El piso es del REBOTE completo y es lo primero que se evalúa (SEC-C).
    const v = clasificarComoPulpo({
        skill: 'security',
        motivo: MOTIVO_SEC,
        rebote_categoria: 'infra_agent_crash',
        veredictoSintetizadoPorPulpo: true,
    });
    assert.equal(v.category, 'code');
    assert.equal(v.counts_against_circuit_breaker, true);
});

test('CA-7 fail-closed — skill fuera del allowlist tampoco alcanza infra vía hint', () => {
    // `skillFromFile` es leniente: `6745.secur1ty` -> 'secur1ty', no null.
    for (const skill of ['secur1ty', '', 'no-existe']) {
        const v = clasificarComoPulpo({
            skill, motivo: MOTIVO_SEC, rebote_categoria: 'infra_agent_crash',
            veredictoSintetizadoPorPulpo: true,
        });
        assert.equal(v.category, 'code', `skill indeterminable (${JSON.stringify(skill)}) => NO infra`);
    }
});

test('CA-7 — el piso se consume de rejection-severity, sin duplicar la lista', () => {
    assert.ok(Array.isArray(SKILLS_PISO_GRAVE) && SKILLS_PISO_GRAVE.includes('security'));
    const fuente = fs.readFileSync(path.join(__dirname, '..', 'rebote-classifier.js'), 'utf8');
    // Ninguna lista literal de skills con piso: se importa la fuente única.
    assert.ok(/SKILLS_PISO_GRAVE/.test(fuente));
    assert.ok(!/=\s*\[\s*'security'\s*\]/.test(fuente), 'no debe redeclararse la lista del piso');
});

// -----------------------------------------------------------------------------
// CA-6 — prosa de red que cita `host:puerto` sigue siendo infra.
// -----------------------------------------------------------------------------

test('CA-6 — la prosa de red se preserva como infra aunque cite el endpoint', () => {
    const casos = [
        'fallo por timeout de red a los 30s',
        'timeout de red a los 30s contra registry.npmjs.org:443',
        'timed out conectando a api.github.com:443',
    ];
    for (const motivo of casos) {
        const d = precheck.classifyErrorDetailed(motivo);
        assert.equal(d.clasificacion, 'infra', `debe seguir siendo infra: ${motivo}`);
        assert.equal(d.evidencia, 'prose');
        assert.equal(d.accionRequerida, null, 'citar un host:puerto no es una acción de código');
    }
});

test('CA-6 — el rebote completo de un fallo de red con endpoint clasifica infra', () => {
    const v = clasificarComoPulpo({
        skill: 'build',
        motivo: 'El build fallo por timeout de red a los 30s contra registry.npmjs.org:443',
    });
    assert.equal(v.category, 'infra');
    assert.equal(v.counts_against_circuit_breaker, false, 'un fallo de infra real no consume el breaker de código');
});

test('CA-6 — la referencia archivo.ext:linea SIGUE siendo señal de código (no se aflojó)', () => {
    const casos = [
        'CA-3 incumplido en pulpo.js:5309',
        'falta commitear resolveDnsCache.js:12',
        'config rota en pipeline.config.json:44',
        'el script muere en restart.sh:12',
        'ver ReboteClassifier.kt:88',
        'timeout declarado mal en build.gradle:31',
    ];
    for (const motivo of casos) {
        assert.equal(precheck.hasCodeSignal(motivo), true, `debe seguir siendo code_signal: ${motivo}`);
    }
});

test('CA-6 — un host:puerto por sí solo NO es señal de código', () => {
    for (const motivo of [
        'no se pudo resolver registry.npmjs.org:443',
        'conexion rechazada por api.github.com:443',
        'proxy corporativo en proxy.intrale.com.ar:8080',
    ]) {
        assert.equal(precheck.hasCodeSignal(motivo), false, `no debe ser code_signal: ${motivo}`);
    }
});

test('CA-6 — la extensión anclada no reabre el falso positivo con TLDs', () => {
    // Guard explícito: si alguien agrega `com`/`org`/`net`/`io` a la lista de
    // extensiones, este test se pone rojo antes de que vuelva el bug.
    const fuente = fs.readFileSync(path.join(__dirname, '..', '..', 'connectivity-precheck.js'), 'utf8');
    assert.ok(!/\.\[a-z\]\{1,5\}:/.test(fuente), 'la extensión genérica [a-z]{1,5} no debe volver');
    const m = /const CODE_FILE_EXT_ALT = \[([^\]]*)\]/.exec(fuente);
    assert.ok(m, 'debe existir la lista cerrada de extensiones');
    for (const tld of ['com', 'org', 'net', 'io', 'co', 'dev', 'app', 'ar', 'es']) {
        assert.ok(
            !new RegExp(`'${tld}'`).test(m[1]),
            `'${tld}' es un TLD: agregarlo reabre el falso positivo de host:puerto`,
        );
    }
});

test('CA-9 — el anclado no reintrodujo superficie ReDoS', () => {
    const adversarial = '`'.repeat(4000) + '_'.repeat(4000) + '.a:1'.repeat(500);
    const t0 = process.hrtime.bigint();
    precheck.classifyErrorDetailed(adversarial);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 50, `debe resolver en < 50ms, tardó ${ms.toFixed(1)}ms`);
});
