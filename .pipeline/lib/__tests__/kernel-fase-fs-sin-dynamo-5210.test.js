'use strict';

// =============================================================================
// kernel-fase-fs-sin-dynamo-5210.test.js — CA-5 de #5210.
//
// LA PREGUNTA QUE RESPONDE
// ------------------------
// #5210 pobló `kernel.tableName`, `kernel.coordinationTableName` y
// `kernel.region` en `config.yaml`. Antes estaban vacíos, y esa vacuidad
// funcionaba como una segunda red: aunque algo intentara hablar con DynamoDB,
// `normalizeConfig` fallaba fail-closed por falta de tabla. Esa red ya no está.
//
// Entonces: ¿el pipeline sigue completando una fase 100% desde filesystem, sin
// una sola llamada a AWS? Este test lo prueba **con un sensor**, no por lectura
// de código.
//
// CÓMO SE MIDE
// ------------
// Todo el camino a DynamoDB de este repo sale por la AWS CLI
// (`createAwsCliDynamoDriver` → `spawn('aws', …)`, provisioner-infra.js). Se
// instrumenta `child_process` (`spawn`/`spawnSync`/`exec`/`execFile`/`execSync`)
// y se registra cualquier invocación de `aws`. El ciclo de fase se ejecuta con
// `fs.rename` real sobre un directorio temporal — el mismo mecanismo que usa el
// pulpo (pendiente/ → trabajando/ → listo/ → procesado/).
//
// El test NO levanta un pulpo: hacerlo pisaría el pipeline en producción.
// Ejercita el mismo movimiento de archivos y el mismo evaluador de completitud.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const yaml = require('js-yaml');
const { evaluateParallelPhaseCompletion } = require('../phase-completion');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config.yaml');
const FASES = ['pendiente', 'trabajando', 'listo', 'procesado'];

/**
 * Instala el sensor sobre child_process y devuelve `{ awsCalls, restore }`.
 * Cualquier intento de hablar con AWS queda registrado (y bloqueado).
 */
function instalarSensorAws() {
    const awsCalls = [];
    const originales = {};
    const METODOS = ['spawn', 'spawnSync', 'exec', 'execFile', 'execSync'];

    for (const m of METODOS) {
        originales[m] = childProcess[m];
        childProcess[m] = function interceptado(cmd, ...rest) {
            const linea = String(cmd || '');
            const args = Array.isArray(rest[0]) ? rest[0].join(' ') : '';
            const full = `${linea} ${args}`;
            if (/(^|[\\/\s])aws(\.exe)?($|\s)/i.test(full) || /dynamodb|\bkms\b/i.test(full)) {
                awsCalls.push({ metodo: m, comando: full.trim() });
                throw new Error(`SENSOR: llamada AWS no esperada durante la fase FS: ${full.trim()}`);
            }
            return originales[m].call(this, cmd, ...rest);
        };
    }

    return {
        awsCalls,
        restore() {
            for (const m of METODOS) childProcess[m] = originales[m];
        },
    };
}

function crearFaseTmp() {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'fase-5210-'));
    for (const d of FASES) fs.mkdirSync(path.join(raiz, d), { recursive: true });
    return raiz;
}

/** Mueve un archivo de trabajo entre carpetas de estado con rename atómico. */
function mover(raiz, archivo, desde, hacia) {
    const origen = path.join(raiz, desde, archivo);
    const destino = path.join(raiz, hacia, archivo);
    fs.renameSync(origen, destino);
    return destino;
}

// -----------------------------------------------------------------------------

test('CA-5: una fase completa el ciclo pendiente→procesado desde filesystem sin tocar AWS', () => {
    // La config REAL, con las tres claves ya pobladas: es el escenario que
    // introduce este issue, no un fixture conveniente.
    const cfg = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')).kernel;
    // #5208 — La precondición era `durable === false`. Se quitó a propósito: lo
    // que este test verifica es que el ciclo pendiente→procesado de una fase
    // resuelve ENTERO desde filesystem, y eso tiene que valer con el switch
    // durable encendido TAMBIÉN. Atado a `false`, el test dejaba de cubrir el
    // escenario justo cuando pasaba a ser el real.
    assert.equal(typeof cfg.durable, 'boolean', 'precondición: el switch durable es un booleano exacto');
    assert.ok(cfg.tableName, 'precondición: la tabla de no-repudio ESTÁ configurada');
    assert.ok(cfg.coordinationTableName, 'precondición: la tabla de coordinación ESTÁ configurada');
    assert.ok(cfg.region, 'precondición: la región ESTÁ configurada');

    const sensor = instalarSensorAws();
    const raiz = crearFaseTmp();
    try {
        const archivo = '5210.pipeline-dev';
        const trabajo = { issue: 5210, fase: 'dev', pipeline: 'desarrollo' };

        // 1. Encolado en pendiente/
        fs.writeFileSync(path.join(raiz, 'pendiente', archivo), yaml.dump(trabajo), 'utf8');

        // 2. El agente lo toma → trabajando/
        mover(raiz, archivo, 'pendiente', 'trabajando');
        assert.ok(fs.existsSync(path.join(raiz, 'trabajando', archivo)));

        // 3. El agente escribe su resultado y sale → listo/
        fs.writeFileSync(
            path.join(raiz, 'trabajando', archivo),
            yaml.dump({ ...trabajo, resultado: 'aprobado' }),
            'utf8',
        );
        mover(raiz, archivo, 'trabajando', 'listo');

        // 4. El evaluador de completitud decide con lo que hay EN DISCO.
        const enListo = yaml.load(fs.readFileSync(path.join(raiz, 'listo', archivo), 'utf8'));
        const evaluacion = evaluateParallelPhaseCompletion({
            skillsRequeridos: ['pipeline-dev'],
            listo: [{ skill: 'pipeline-dev', yaml: enListo }],
            procesado: [],
            pendienteSkills: [],
            trabajandoSkills: [],
        });
        assert.equal(evaluacion.todosCompletos, true, 'la fase debe cerrar con el artefacto aprobado');
        assert.deepEqual(evaluacion.skillsCompletados, ['pipeline-dev']);
        assert.equal(evaluacion.origenPorSkill['pipeline-dev'], 'listo');

        // 5. Promoción → procesado/
        mover(raiz, archivo, 'listo', 'procesado');
        assert.ok(fs.existsSync(path.join(raiz, 'procesado', archivo)));
        assert.ok(!fs.existsSync(path.join(raiz, 'listo', archivo)));

        // El veredicto del criterio: cero llamadas a AWS en todo el ciclo.
        assert.deepEqual(sensor.awsCalls, [], 'la fase no debe emitir NINGUNA llamada a DynamoDB/AWS');
    } finally {
        sensor.restore();
        fs.rmSync(raiz, { recursive: true, force: true });
    }
});

test('CA-5: cargar la config del kernel no dispara por sí sola ninguna llamada AWS', () => {
    // Poblar los nombres es declarativo. Si `require` + lectura de config
    // alcanzaran para abrir una conexión, este test lo delataría.
    const sensor = instalarSensorAws();
    try {
        delete require.cache[require.resolve('../project-bootstrap')];
        const bootstrap = require('../project-bootstrap');
        const cfg = bootstrap.readKernelConfig({});
        assert.ok(cfg.tableName, 'la tabla está configurada…');

        const verify = require('../kernel-table-verify');
        const leida = verify.readKernelTablesConfig({ configPath: CONFIG_PATH });
        // #5208 — Los dos lectores tienen que coincidir. Antes la aserción era
        // `=== false` en ambos, lo que también los comparaba, pero se rompía al
        // encender el switch. Comparándolos entre sí, el invariante sobrevive al
        // cambio de valor: dos lectores que difieren serían un split-brain sobre
        // la autoridad de la decisión.
        assert.equal(leida.durable, cfg.durable,
            'los dos lectores de config deben coincidir sobre el switch durable');

        // Y el veredicto real del test, que #5208 vuelve MÁS importante: con el
        // camino durable encendido, LEER la config sigue sin hablar con AWS. El
        // driver es lazy y sólo lo construye el boot.
        assert.deepEqual(sensor.awsCalls, [], 'leer config NUNCA debe hablar con AWS');
    } finally {
        sensor.restore();
    }
});

test('CA-5: el sensor detecta de verdad una llamada AWS (contra-prueba)', () => {
    // Un sensor que no dispara nunca no prueba nada. Se verifica que reacciona.
    const sensor = instalarSensorAws();
    try {
        assert.throws(
            () => childProcess.spawn('aws', ['dynamodb', 'describe-table', '--table-name', 'x']),
            /SENSOR: llamada AWS no esperada/,
        );
        assert.equal(sensor.awsCalls.length, 1);
        assert.match(sensor.awsCalls[0].comando, /dynamodb describe-table/);
    } finally {
        sensor.restore();
    }
});
