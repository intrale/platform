// =============================================================================
// pulpo-huerfanos-post-boot.test.js — regresión del incidente 2026-09-08
//
// Reproduce el escenario REAL contra `brazoHuerfanos` (el brazo del Pulpo, no
// una simulación):
//
//   El Pulpo reinició a las 10:09:23. A las 10:09:43 el barrido encontró
//   `5801.pipeline-dev` en `trabajando/` con 592 minutos de mtime heredado
//   (`renameSync` lo preserva desde que el dropfile esperaba en `pendiente/`) y
//   sin entrada en `activeProcesses` (el Map en memoria nace vacío tras el
//   boot). Lo rebotó a `pendiente/` y le consumió un reintento. Tres barridos
//   después: `excedió 3 reintentos → rechazado`, con el código sano.
//
// El test fija las dos mitades del fix:
//   1. con el registro frío el barrido se abstiene (no rebota);
//   2. pasada la ventana de gracia vuelve a hacer su trabajo (sí rebota), para
//      que la guarda no se convierta en una fuga de corridas colgadas.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { withEnv } = require('../test-helpers/with-env');

// El pipeline temporal tiene que existir ANTES de requerir pulpo.js: `PIPELINE`
// se resuelve al cargar el módulo, igual que `PULPO_NO_AUTOSTART`. Por eso el
// require va DENTRO del `withEnv`: cuando el helper restaura el entorno, el
// módulo ya capturó ambos valores en sus constantes.
const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'pulpo-huerfanos-'));

const PIPELINE_NAME = 'desarrollo';
const FASE = 'dev';
const TRABAJANDO = path.join(RAIZ, PIPELINE_NAME, FASE, 'trabajando');
const PENDIENTE = path.join(RAIZ, PIPELINE_NAME, FASE, 'pendiente');
const LISTO = path.join(RAIZ, PIPELINE_NAME, FASE, 'listo');
for (const d of [TRABAJANDO, PENDIENTE, LISTO]) fs.mkdirSync(d, { recursive: true });

let pulpo;
withEnv(
    { PULPO_NO_AUTOSTART: '1', PIPELINE_DIR_OVERRIDE: RAIZ },
    () => { pulpo = require('../../pulpo.js'); },
    {
        permitirApagarControl: ['PULPO_NO_AUTOSTART'],
        motivo: 'cargar pulpo.js como módulo para ejercitar brazoHuerfanos sin arrancar el loop',
    },
);
const {
    brazoHuerfanos,
    activeProcesses,
    rehidratarRegistroDeCorridas,
    _setBootTsForTesting,
} = pulpo;

const CONFIG = {
    timeouts: { orphan_timeout_minutes: 10 },
    pipelines: { [PIPELINE_NAME]: { fases: [FASE] } },
};

const DROPFILE = '5801.pipeline-dev';

/** Deja el dropfile en `trabajando/` con el mtime heredado del incidente. */
function sembrarCorridaConMtimeHeredado(minutosDeAntiguedad) {
    for (const d of [TRABAJANDO, PENDIENTE, LISTO]) {
        for (const f of fs.readdirSync(d)) fs.rmSync(path.join(d, f), { force: true });
    }
    activeProcesses.clear();
    // `clear()` persiste, así que deja el archivo de estado creado. Lo borramos
    // para partir del escenario real: un Pulpo que arranca SIN registro previo.
    try { fs.rmSync(path.join(RAIZ, 'state', 'active-processes.json'), { force: true }); } catch { /* ok */ }
    const destino = path.join(TRABAJANDO, DROPFILE);
    fs.writeFileSync(destino, 'issue: 5801\nskill: pipeline-dev\n', 'utf8');
    const viejo = new Date(Date.now() - minutosDeAntiguedad * 60000);
    fs.utimesSync(destino, viejo, viejo);
    return destino;
}

test('registro frío tras el reinicio: el barrido NO rebota la corrida', () => {
    sembrarCorridaConMtimeHeredado(592);
    // El Pulpo acaba de bootear, igual que a las 10:09:23 del incidente, y sin
    // registro previo en disco: su vacío no prueba que la corrida haya muerto.
    _setBootTsForTesting(Date.now() - 20 * 1000);
    const rehidratacion = rehidratarRegistroDeCorridas();
    assert.equal(rehidratacion.confiable, false, 'sin archivo previo el registro no es confiable');

    brazoHuerfanos(CONFIG);

    assert.equal(
        fs.existsSync(path.join(TRABAJANDO, DROPFILE)), true,
        'la corrida debe seguir en trabajando/: el registro estaba frío, no se puede afirmar que murió',
    );
    assert.equal(
        fs.existsSync(path.join(PENDIENTE, DROPFILE)), false,
        'no debe haber sido rebotada a pendiente/',
    );
});

test('pasada la ventana de gracia, una corrida sin proceso sí se recupera', () => {
    sembrarCorridaConMtimeHeredado(592);
    // Pulpo con vida de sobra: el desconocimiento ya no tiene excusa.
    _setBootTsForTesting(Date.now() - 120 * 60000);

    brazoHuerfanos(CONFIG);

    assert.equal(
        fs.existsSync(path.join(TRABAJANDO, DROPFILE)), false,
        'la corrida colgada debe salir de trabajando/',
    );
    assert.equal(
        fs.existsSync(path.join(PENDIENTE, DROPFILE)), true,
        'y volver a pendiente/ para reintentarse',
    );
});

test('con el registro rehidratado la gracia no aplica: lo que no figura, no vive', () => {
    // La gracia es la red para cuando el registro NO es confiable. Si el archivo
    // estaba y se rehidrató, su ausencia SÍ es evidencia de muerte y el barrido
    // debe hacer su trabajo aunque el Pulpo acabe de arrancar.
    sembrarCorridaConMtimeHeredado(592);
    fs.mkdirSync(path.join(RAIZ, 'state'), { recursive: true });
    fs.writeFileSync(
        path.join(RAIZ, 'state', 'active-processes.json'),
        JSON.stringify({ version: 1, corridas: {} }),
        'utf8',
    );

    _setBootTsForTesting(Date.now() - 20 * 1000);
    const rehidratacion = rehidratarRegistroDeCorridas();
    assert.equal(rehidratacion.confiable, true);

    brazoHuerfanos(CONFIG);

    assert.equal(
        fs.existsSync(path.join(PENDIENTE, DROPFILE)), true,
        'con registro confiable la corrida colgada se recupera sin esperar la gracia',
    );
});

test('la entrada a trabajando/ refresca el mtime: la corrida deja de nacer vencida', () => {
    // Es la otra mitad del fix: sin esto, el dropfile que vuelve de pendiente/
    // entra a trabajando/ ya por encima del timeout.
    const enPendiente = path.join(PENDIENTE, DROPFILE);
    fs.writeFileSync(enPendiente, 'issue: 5801\n', 'utf8');
    const viejo = new Date(Date.now() - 592 * 60000);
    fs.utimesSync(enPendiente, viejo, viejo);

    const destino = pulpo.moveFile
        ? pulpo.moveFile(enPendiente, TRABAJANDO)
        : (() => { throw new Error('moveFile no expuesto'); })();

    const edadMin = (Date.now() - fs.statSync(destino).mtimeMs) / 60000;
    assert.ok(edadMin < 1, `la corrida debe entrar joven a trabajando/, entró con ${edadMin.toFixed(1)} min`);
});

test.after(() => {
    try { fs.rmSync(RAIZ, { recursive: true, force: true }); } catch { /* best-effort */ }
});
