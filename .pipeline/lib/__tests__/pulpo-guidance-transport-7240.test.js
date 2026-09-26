// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// =============================================================================
// pulpo-guidance-transport-7240.test.js — cableado REAL del transporte de la
// orientación de destrabe en `pulpo.moveFile` (#7240, CA-9).
//
// No replica `moveFile`: carga `pulpo.js` como módulo (patrón `withEnv` de
// `pulpo-huerfanos-post-boot.test.js`) y ejercita la función productiva.
// Verifica las tres cosas que un test unitario del módulo puro no puede:
//
//   (a) `moveFile(pendiente/N.skill, trabajando/)` lleva los dos artifacts
//       `.guidance.txt` / `.guidance.agent.txt` a `trabajando/`;
//   (b) el registro de corridas (`activeProcesses`) NO tiene entrada para
//       ningún artifact — sólo el marker es corrida (SEC-2; incidente
//       2026-05-11: un `.guidance.txt` leído como marker);
//   (c) los movimientos hacia `listo/` NO transportan nada: el guard por
//       `trabajando` los excluye.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { withEnv } = require('../test-helpers/with-env');

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'pulpo-guidance-7240-'));

const PIPELINE_NAME = 'desarrollo';
const FASE = 'dev';
const PENDIENTE = path.join(RAIZ, PIPELINE_NAME, FASE, 'pendiente');
const TRABAJANDO = path.join(RAIZ, PIPELINE_NAME, FASE, 'trabajando');
const LISTO = path.join(RAIZ, PIPELINE_NAME, FASE, 'listo');
for (const d of [PENDIENTE, TRABAJANDO, LISTO]) fs.mkdirSync(d, { recursive: true });

let pulpo;
withEnv(
    { PULPO_NO_AUTOSTART: '1', PIPELINE_DIR_OVERRIDE: RAIZ },
    () => { pulpo = require('../../pulpo.js'); },
    {
        permitirApagarControl: ['PULPO_NO_AUTOSTART'],
        motivo: 'cargar pulpo.js como módulo para ejercitar moveFile sin arrancar el loop',
    },
);
const { moveFile, activeProcesses } = pulpo;

const MARKER = '7240.pipeline-dev';
const TEXTO_HUMANO = 'usar la API REST';
const TEXTO_AGENTE = 'guru rechazó: falta el test';

function limpiar() {
    for (const d of [PENDIENTE, TRABAJANDO, LISTO]) {
        for (const f of fs.readdirSync(d)) fs.rmSync(path.join(d, f), { force: true });
    }
    activeProcesses.clear();
}

function sembrarEnPendiente() {
    const src = path.join(PENDIENTE, MARKER);
    fs.writeFileSync(src, 'issue: 7240\nfase: dev\npipeline: desarrollo\n', 'utf8');
    fs.writeFileSync(src + '.guidance.txt', TEXTO_HUMANO, 'utf8');
    fs.writeFileSync(src + '.guidance.agent.txt', TEXTO_AGENTE, 'utf8');
    return src;
}

test('#7240 CA-9 (a): moveFile(pendiente/N.skill, trabajando/) transporta los dos artifacts con su propio nombre', () => {
    limpiar();
    const src = sembrarEnPendiente();

    const dest = moveFile(src, TRABAJANDO);

    assert.equal(dest, path.join(TRABAJANDO, MARKER));
    assert.equal(fs.existsSync(dest), true);
    assert.equal(fs.readFileSync(dest + '.guidance.txt', 'utf8'), TEXTO_HUMANO);
    assert.equal(fs.readFileSync(dest + '.guidance.agent.txt', 'utf8'), TEXTO_AGENTE);
    assert.deepEqual(fs.readdirSync(PENDIENTE), [], 'nada queda en pendiente/');
    assert.deepEqual(
        fs.readdirSync(TRABAJANDO).sort(),
        [MARKER, MARKER + '.guidance.agent.txt', MARKER + '.guidance.txt'].sort(),
    );
});

test('#7240 CA-9 (b): el registro de corridas no contiene entrada para ningún .guidance*', () => {
    limpiar();
    const src = sembrarEnPendiente();
    moveFile(src, TRABAJANDO);

    for (const key of activeProcesses.keys()) {
        assert.equal(String(key).includes('.guidance'), false, `entrada de corrida para un artifact: ${key}`);
    }
    // El marker es el único "vivo" a ojos del barrido de huérfanos: los
    // artifacts son metadata, no work-items (`isMarkerArtifact`).
    const { isMarkerArtifact } = require('../marker-artifact');
    const vivos = fs.readdirSync(TRABAJANDO).filter((f) => !isMarkerArtifact(f));
    assert.deepEqual(vivos, [MARKER]);
});

test('#7240 CA-9 (c): moveFile hacia listo/ NO transporta artifacts (guard por trabajando)', () => {
    limpiar();
    const src = sembrarEnPendiente();
    const enTrabajando = moveFile(src, TRABAJANDO);
    // Simula un agente que terminó sin consumir (p.ej. muerto antes de leer):
    // los artifacts siguen al lado del marker en trabajando/.
    assert.equal(fs.existsSync(enTrabajando + '.guidance.txt'), true);

    const enListo = moveFile(enTrabajando, LISTO);

    assert.equal(enListo, path.join(LISTO, MARKER));
    assert.deepEqual(fs.readdirSync(LISTO), [MARKER], 'sólo el marker viaja a listo/');
    assert.deepEqual(
        fs.readdirSync(TRABAJANDO).sort(),
        [MARKER + '.guidance.agent.txt', MARKER + '.guidance.txt'].sort(),
        'los artifacts quedan donde estaban',
    );
});

test('#7240 CA-9: moveFile sin artifacts sigue siendo el rename de siempre', () => {
    limpiar();
    const src = path.join(PENDIENTE, MARKER);
    fs.writeFileSync(src, 'issue: 7240\n', 'utf8');
    const dest = moveFile(src, TRABAJANDO);
    assert.deepEqual(fs.readdirSync(TRABAJANDO), [MARKER]);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'issue: 7240\n');
});
