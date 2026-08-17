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

function lineaDelLabel(texto) {
    return texto.split('\n').find((l) => l.includes('--label "enhancement'));
}

for (const rol of ROLES) {
    test(`${rol}: el --label del gh issue create emite ${TRIAGE} y no ${NEEDS_HUMAN}`, () => {
        const linea = lineaDelLabel(leerRol(rol));
        assert.ok(linea, `${rol}.md no tiene la linea del --label`);
        assert.ok(linea.includes(TRIAGE), `${rol}.md no emite ${TRIAGE}`);
        assert.ok(!linea.includes(NEEDS_HUMAN), `${rol}.md sigue emitiendo ${NEEDS_HUMAN}`);
    });

    test(`${rol}: el --label conserva intactos los labels que no cambian`, () => {
        const linea = lineaDelLabel(leerRol(rol));
        for (const label of ['enhancement', 'source:recommendation', TIPO_RECO, 'priority:low']) {
            assert.ok(linea.includes(label), `${rol}.md perdio el label ${label}`);
        }
        // Los placeholders de área/app van entre < > con separadores |.
        assert.match(linea, /<,(area|app):[^>]+>/, `${rol}.md perdio los placeholders de area/app`);
    });

    test(`${rol}: la prosa describe ${APPROVED} como el gate, no ${NEEDS_HUMAN}`, () => {
        const texto = leerRol(rol);
        const prosa = texto.split('\n').find((l) => l.includes('Es una recomendación pendiente'));
        assert.ok(prosa, `${rol}.md no tiene la prosa del flujo de aprobación`);
        assert.ok(prosa.includes(APPROVED), `${rol}.md: la prosa no nombra ${APPROVED}`);
        assert.ok(!prosa.includes(NEEDS_HUMAN), `${rol}.md: la prosa sigue nombrando ${NEEDS_HUMAN}`);
        // UX-3a: el mecanismo real es `tipo:recomendacion` SIN `recommendation:approved`.
        assert.ok(prosa.includes(TIPO_RECO), `${rol}.md: la prosa no explica el mecanismo real`);
    });

    test(`${rol}: el item OBLIGATORIO pide ${TRIAGE} y explica el mecanismo real`, () => {
        const texto = leerRol(rol);
        const item = texto.split('\n').find((l) => l.startsWith('5. **OBLIGATORIO**'));
        assert.ok(item, `${rol}.md no tiene el item OBLIGATORIO`);
        assert.ok(item.includes(TRIAGE), `${rol}.md: el item OBLIGATORIO no pide ${TRIAGE}`);
        assert.ok(!item.includes(NEEDS_HUMAN), `${rol}.md: el item OBLIGATORIO sigue pidiendo ${NEEDS_HUMAN}`);
        // UX-3b: una sola acción humana (agregar), no dos (remover + agregar).
        assert.ok(item.includes(APPROVED), `${rol}.md: el item OBLIGATORIO no nombra el gate real`);
    });

    test(`${rol}: ${NEEDS_HUMAN} figura en la lista de labels prohibidos`, () => {
        const texto = leerRol(rol);
        const prohibidos = texto.split('\n').find((l) => l.startsWith('6. **Prohibido** labels'));
        assert.ok(prohibidos, `${rol}.md no tiene el item de labels prohibidos`);
        assert.ok(
            prohibidos.includes(NEEDS_HUMAN),
            `${rol}.md: sin la prohibición explícita, el próximo agente vuelve a razonar que necesita un label de bloqueo`,
        );
    });
}

test(`ninguna mencion de ${NEEDS_HUMAN} en los roles describe el flujo de recomendaciones`, () => {
    const ofensoras = [];
    for (const rol of ROLES) {
        leerRol(rol).split('\n').forEach((linea, i) => {
            if (!linea.includes(NEEDS_HUMAN)) return;
            // La única mención admitida es la lista de labels prohibidos: no
            // describe el flujo, lo prohíbe.
            if (linea.startsWith('6. **Prohibido** labels')) return;
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
