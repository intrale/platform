'use strict';

// =============================================================================
// check-credential-rotation-gates.test.js — el verificador que decide qué
// camino del runbook de rotación corre hoy (#5802)
//
// El script es el paso de precondición del runbook: es lo que evita que el
// operador elija camino de memoria. Su única obligación es ser fail-closed
// igual que los gates que inspecciona — cualquier valor que no sea el booleano
// `true` exacto tiene que mandar al camino A (con reinicio), que es el
// conservador. Un falso "GATES ABIERTOS" hace que el operador no reinicie
// creyendo que algo invalida la credencial, cuando no hay nada.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkGates, GATES, leerConfig } = require('../check-credential-rotation-gates');

/** Config con los tres gates en el valor pedido. */
function configCon({ snapshot, retry, vault }) {
    return {
        pipeline: { credential_snapshot_enabled: snapshot, credential_retry_enabled: retry },
        vault: { enabled: vault },
    };
}

test('los tres gates en `true` exacto abren el camino sin reinicio', () => {
    const { allOpen, gates } = checkGates(configCon({ snapshot: true, retry: true, vault: true }));
    assert.equal(allOpen, true);
    assert.deepEqual(gates.map((g) => g.open), [true, true, true]);
});

test('cualquier gate cerrado manda al camino con reinicio', () => {
    const combinaciones = [
        { snapshot: false, retry: true, vault: true },
        { snapshot: true, retry: false, vault: true },
        { snapshot: true, retry: true, vault: false },
        { snapshot: false, retry: false, vault: false },
    ];
    for (const c of combinaciones) {
        assert.equal(checkGates(configCon(c)).allOpen, false,
            `deberia estar cerrado con ${JSON.stringify(c)}`);
    }
});

test('fail-closed: los valores truthy que NO son el booleano true no abren', () => {
    // Éste es el modo de falla que importa: un `enabled: "true"` en el YAML
    // (comillas de más) o un `1` leen como verdadero en JS y abrirían el camino
    // sin reinicio sin que ninguna pieza esté cableada.
    for (const impostor of ['true', 1, 'yes', [], {}]) {
        const { allOpen } = checkGates(configCon({ snapshot: impostor, retry: impostor, vault: impostor }));
        assert.equal(allOpen, false,
            `el valor ${JSON.stringify(impostor)} no debe abrir el gate: solo el booleano true exacto`);
    }
});

test('fail-closed: claves ausentes, config vacío o ilegible dejan todo cerrado', () => {
    for (const config of [null, undefined, {}, { pipeline: {} }, { vault: {} }]) {
        const { allOpen, gates } = checkGates(config);
        assert.equal(allOpen, false, `config ${JSON.stringify(config)} deberia dejar los gates cerrados`);
        assert.equal(gates.length, GATES.length);
    }
});

test('un config.yaml ilegible no explota: devuelve null y los gates quedan cerrados', () => {
    assert.equal(leerConfig('/ruta/que/no/existe/config.yaml'), null);
    assert.equal(checkGates(leerConfig('/ruta/que/no/existe/config.yaml')).allOpen, false);
});

test('reporta el valor real de cada gate para que el diagnóstico sea accionable', () => {
    const { gates } = checkGates(configCon({ snapshot: false, retry: true, vault: undefined }));
    const porClave = Object.fromEntries(gates.map((g) => [g.key, g]));

    assert.equal(porClave['pipeline.credential_snapshot_enabled'].value, false);
    assert.equal(porClave['pipeline.credential_retry_enabled'].value, true);
    assert.equal(porClave['vault.enabled'].value, undefined);

    // Los paths tienen que ser los que el operador busca literalmente en el
    // config, no nombres inventados por el script.
    assert.deepEqual(gates.map((g) => g.key), [
        'pipeline.credential_snapshot_enabled',
        'pipeline.credential_retry_enabled',
        'vault.enabled',
    ]);
});

test('el config real del repo se lee sin errores', () => {
    // No se afirma el valor: los gates se van a abrir cuando avance el rollout.
    // Lo que no puede pasar nunca es que el verificador no pueda leerlo.
    const { gates, allOpen } = checkGates();
    assert.equal(gates.length, 3);
    assert.equal(typeof allOpen, 'boolean');
});
