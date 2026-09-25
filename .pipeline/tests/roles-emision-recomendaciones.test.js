// =============================================================================
// roles-emision-recomendaciones.test.js — #5690
//
// Guardrail de documentación: los 5 roles que emiten recomendaciones tienen
// TRES sitios que hablan del mismo mecanismo (el `--label` del `gh issue
// create`, la prosa del "flujo de aprobación" y el ítem OBLIGATORIO). Un rol
// con el `--label` corregido y la prosa vieja es PEOR que no tocar nada:
// enseña dos verdades contradictorias en el mismo archivo (UX-3c).
//
// Este test es la red que evita que la próxima edición desincronice uno de los
// tres. Es documentación, no código — pero es documentación que 5 agentes
// ejecutan literalmente, y la emisión de los roles va por `gh issue create`
// directo, sin pasar por el guardrail de `servicio-github.js`. Acá no hay red
// de contención en runtime: esta doc ES el control.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROLES_DIR = path.resolve(__dirname, '..', 'roles');
const ROLES = ['guru', 'po', 'review', 'security', 'ux'];

const TRIAGE = 'needs:triage-backlog';
const NEEDS_HUMAN = 'needs-human';
const TIPO_RECO = 'tipo:recomendacion';
const APPROVED = 'recommendation:approved';

function leerRol(rol) {
    return fs.readFileSync(path.join(ROLES_DIR, rol + '.md'), 'utf8');
}

// #7673 — corte transitorio de recomendaciones (hasta la Ola Propuestas, #7361).
// La receta `gh issue create … --label "enhancement,source:recommendation,…"` que
// este test sincronizaba (#5690: `--label`, prosa y ítem OBLIGATORIO) se ELIMINÓ
// de los 5 roles a propósito: con `recomendaciones.crear_issues: false` las
// oportunidades van a "Otras oportunidades observadas" del comentario del issue
// origen. Los tres sitios que había que mantener alineados ya no existen; lo
// que sigue valiendo es que ninguno la reintroduzca a medias (receta sin la
// prosa, o con `needs-human`). Cuando #7361 defina el reemplazo, este test se
// redefine con él. La cobertura positiva del corte vive en
// `lib/__tests__/recommendations-cut.test.js`.
for (const rol of ROLES) {
    test(`${rol}: #7673 no queda receta de emisión de recomendaciones (ni --label, ni prosa, ni ítem OBLIGATORIO)`, () => {
        const texto = leerRol(rol);
        assert.ok(!texto.split('\n').some((l) => l.includes('--label "enhancement')), `${rol}.md conserva la línea del --label`);
        assert.ok(!texto.includes('Es una recomendación pendiente'), `${rol}.md conserva la prosa del flujo de aprobación`);
        assert.ok(!texto.split('\n').some((l) => l.startsWith('5. **OBLIGATORIO**')), `${rol}.md conserva el ítem OBLIGATORIO`);
        assert.ok(!texto.includes(TIPO_RECO), `${rol}.md sigue nombrando ${TIPO_RECO}`);
        assert.ok(!texto.includes(TRIAGE), `${rol}.md sigue pidiendo ${TRIAGE}`);
    });

    test(`${rol}: #7673 el protocolo remite a "Otras oportunidades observadas" y no a ${NEEDS_HUMAN} ni ${APPROVED}`, () => {
        const texto = leerRol(rol);
        const protocolo = texto.slice(texto.indexOf('## Protocolo de oportunidades de mejora'));
        assert.ok(protocolo.includes('### Otras oportunidades observadas'), `${rol}.md: falta el formato del bloque`);
        assert.ok(!protocolo.includes(NEEDS_HUMAN), `${rol}.md: el protocolo no puede pedir ${NEEDS_HUMAN}`);
        assert.ok(!protocolo.includes(APPROVED), `${rol}.md: el protocolo no describe aprobaciones de recomendaciones`);
    });
}

test(`ninguna mencion de ${NEEDS_HUMAN} en los roles describe el flujo de recomendaciones`, () => {
    const ofensoras = [];
    for (const rol of ROLES) {
        leerRol(rol).split('\n').forEach((linea, i) => {
            if (!linea.includes(NEEDS_HUMAN)) return;
            // #7673 — la lista de labels prohibidos se fue con la receta: ya no
            // hay ninguna mención admitida en los 5 roles.
            ofensoras.push(`${rol}.md:${i + 1}: ${linea.trim().slice(0, 120)}`);
        });
    }
    assert.deepEqual(ofensoras, [], 'quedaron menciones de needs-human en el flujo de recomendaciones');
});

test('_base.md conserva needs-human: el circuit breaker es un bloqueo REAL, no una recomendacion', () => {
    // Exclusión explícita. El CA "un grep de needs-human sobre .pipeline/roles/
    // no devuelve nada" leído literal borraría también esta línea, que describe
    // el 3er rebote cross-phase → escalado manual. Ese SÍ es un bloqueo humano
    // legítimo y debe seguir emitiendo `needs-human`.
    const base = fs.readFileSync(path.join(ROLES_DIR, '_base.md'), 'utf8');
    const linea = base.split('\n').find((l) => l.includes(NEEDS_HUMAN));
    assert.ok(linea, '_base.md perdio la mencion de needs-human del circuit breaker');
    assert.match(linea, /circuit breaker/);
    assert.ok(!linea.includes(TIPO_RECO), '_base.md no debe mezclar el circuit breaker con recomendaciones');
});
