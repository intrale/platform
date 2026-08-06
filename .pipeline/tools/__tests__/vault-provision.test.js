// =============================================================================
// vault-provision.test.js — contrato de la CLI de provisión (#5466, 3/3 de #5425)
// =============================================================================
//
// QUÉ SE PRUEBA Y POR QUÉ ASÍ
//
// La suite ejercita `run()` COMPLETO — parser, lectura del valor, capability de
// sobrescritura, el provisionador REAL de #5465 y la sanitización — contra
// puertos falsos. No hay un doble de la CLI: si hubiera uno, los tests probarían
// el doble y el código que corre en producción quedaría sin cubrir.
//
// EL CANARIO. Cada test que mueve un valor usa una cadena única e improbable.
// Al terminar, se afirma que esa cadena no aparece en stdout, ni en stderr, ni
// en el mensaje de la excepción, ni en los argumentos del proceso. Un canario
// por test (y no uno global) permite decir CUÁL camino filtró.
//
// "CERO LLAMADAS AWS". Los puertos falsos registran cada invocación. Un camino
// que debía fallar antes de la red se verifica contando `ssm.calls`, no
// leyendo el mensaje de error: el mensaje puede cambiar, el contrato no.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
    run,
    parsearArgs,
    validarValor,
    sanitizarFalla,
    crearSalida,
    restaurarEco,
    instalarHandlers,
    CliError,
    EXIT,
    SENALES,
    MAX_VALUE_BYTES,
    CONFIRMACION,
    AYUDA,
} = require('../vault-provision');

// -----------------------------------------------------------------------------
// Dobles
// -----------------------------------------------------------------------------

// ARN de la documentación de AWS (`123456789012` es el placeholder oficial). No
// es una cuenta real: este repositorio es público.
const PRINCIPAL = 'arn:aws:iam::123456789012:role/vault-provisioning';
const OTRO_PRINCIPAL = 'arn:aws:iam::123456789012:role/pipeline-runtime-readonly';
const CMK = 'arn:aws:kms:us-east-2:123456789012:key/11111111-2222-3333-4444-555555555555';

const CONFIG = Object.freeze({
    prefix: '/testvault',
    projectId: 'proj',
    hostId: 'hostuno',
    region: 'us-east-2',
});

function argsBase(extra = []) {
    return [
        '--tier=shared',
        '--scope=canario',
        '--profile=provisioning',
        `--cmk=${CMK}`,
        `--principal=${PRINCIPAL}`,
        ...extra,
    ];
}

/** Escritor que acumula lo que le mandan. `isTTY` configurable para el color. */
function escritor({ isTTY = false } = {}) {
    const trozos = [];
    return {
        isTTY,
        write(t) { trozos.push(String(t)); return true; },
        get texto() { return trozos.join(''); },
    };
}

/**
 * stdin NO interactivo (para `--stdin`). Entrega los trozos declarados y cierra.
 * La entrega es asíncrona porque el consumidor engancha los listeners después
 * de construirlo.
 */
function stdinPipe(...trozos) {
    const s = new EventEmitter();
    s.isTTY = false;
    s.resume = () => {
        setImmediate(() => {
            for (const t of trozos) s.emit('data', Buffer.from(t, 'utf8'));
            s.emit('end');
        });
    };
    s.pause = () => {};
    return s;
}

// Bytes de control que el lector de TTY interpreta. Se nombran para que los
// tests se lean, y se construyen por código para no meter bytes crudos en el
// fuente (un ESC literal vuelve el archivo "binario" para grep y diff).
const ETX = String.fromCharCode(3);    // Ctrl-C
const ESC = String.fromCharCode(27);
const BACKSPACE = String.fromCharCode(127);

/**
 * stdin de TERMINAL. Registra las transiciones de `setRawMode` para poder
 * afirmar que el eco se apagó y se volvió a encender.
 *
 * ENTREGA UN TROZO POR SUSCRIPCIÓN a `data`, no todos de una. Es lo que hace
 * una terminal real frente a este flujo: primero se suscribe el lector del
 * valor y consume lo que se tipeó, y recién después — si hubo que confirmar —
 * se suscribe el lector de la confirmación y consume la respuesta siguiente.
 * Entregar todo en la primera suscripción haría que el valor y la confirmación
 * se leyeran juntos, y los tests de confirmación no probarían nada.
 *
 * Una suscripción sin trozo pendiente simplemente no recibe nada: así se
 * ejercita el vencimiento del tiempo de espera.
 */
function stdinTty(...trozos) {
    const s = new EventEmitter();
    const pendientes = [...trozos];
    s.isTTY = true;
    s.modos = [];
    s.setRawMode = (v) => { s.modos.push(v); return s; };
    s.setEncoding = () => s;
    s.pause = () => s;
    s.resume = () => s;

    const onOriginal = s.on.bind(s);
    s.on = (evento, fn) => {
        const r = onOriginal(evento, fn);
        if (evento === 'data' && pendientes.length > 0) {
            const trozo = pendientes.shift();
            setImmediate(() => s.emit('data', Buffer.from(trozo, 'utf8')));
        }
        return r;
    };
    return s;
}

/**
 * Port `ssm` falso con la semántica que #5465 espera: `getParameter` devuelve
 * `null` cuando el nombre no existe (no lanza), y `putParameter` avanza la
 * versión.
 */
function ssmFalso({ existente = null } = {}) {
    let guardado = existente ? { ...existente } : null;
    const calls = [];
    return {
        calls,
        get escrituras() { return calls.filter((c) => c.op === 'put'); },
        get guardado() { return guardado; },
        async getParameter({ Name }) {
            calls.push({ op: 'get', Name });
            return guardado ? { ...guardado } : null;
        },
        async putParameter({ Name, Value, Type, KeyId, Overwrite }) {
            calls.push({ op: 'put', Name, Value, Type, KeyId, Overwrite });
            guardado = { Value, Type, Version: (guardado?.Version || 0) + 1 };
            return { Version: guardado.Version };
        },
        async getParameterMetadata({ Name }) {
            calls.push({ op: 'meta', Name });
            return guardado ? { Type: guardado.Type, Version: guardado.Version } : null;
        },
    };
}

function identidadFalsa(arn = PRINCIPAL) {
    const calls = [];
    return { calls, async resolveArn() { calls.push('resolveArn'); return arn; } };
}

/**
 * Corre `fn` y devuelve la excepción. `assert.throws` devuelve `undefined`, así
 * que no sirve cuando además hay que inspeccionar el `exit` o el mensaje.
 */
function capturar(fn) {
    try {
        fn();
    } catch (e) {
        return e;
    }
    assert.fail('se esperaba una excepción y no hubo ninguna');
    return undefined;
}

/**
 * Arma el escenario y corre `run()`. Devuelve todo lo observable de una pasada.
 *
 * `crearSsm`/`crearIdentidad` se cuentan aparte de las llamadas a los puertos:
 * un camino que ni siquiera construye el cliente es más fuerte que uno que lo
 * construye y no lo usa.
 */
async function correr({
    argv = argsBase(),
    stdin = stdinPipe('secreto\n'),
    env = {},
    existente = null,
    arn = PRINCIPAL,
    config = CONFIG,
    stdoutTty = false,
} = {}) {
    const stdout = escritor({ isTTY: stdoutTty });
    const stderr = escritor();
    const ssm = ssmFalso({ existente });
    const identidad = identidadFalsa(arn);
    let fabricasSsm = 0;
    let fabricasId = 0;

    const codigo = await run({
        argv,
        env,
        stdout,
        stderr,
        stdin,
        deps: {
            cargarConfig: () => config,
            crearSsm: () => { fabricasSsm += 1; return ssm; },
            crearIdentidad: () => { fabricasId += 1; return identidad; },
            timeoutMs: 250,
        },
    });

    return {
        codigo,
        stdout: stdout.texto,
        stderr: stderr.texto,
        todo: stdout.texto + stderr.texto,
        ssm,
        identidad,
        stdin,
        fabricasSsm,
        fabricasId,
    };
}

/** Afirma que el canario no aparece en NINGUNA superficie observable. */
function sinCanario(r, canario, contexto) {
    assert.ok(!r.stdout.includes(canario), `el canario apareció en stdout (${contexto})`);
    assert.ok(!r.stderr.includes(canario), `el canario apareció en stderr (${contexto})`);
    assert.ok(
        !process.argv.join(' ').includes(canario),
        `el canario apareció en los argumentos del proceso (${contexto})`,
    );
}

// =============================================================================
// CA-1 — `--help`
// =============================================================================

test('la ayuda documenta los tiers shared y host, y excluye rotating', () => {
    assert.match(AYUDA, /shared/);
    assert.match(AYUDA, /\bhost\b/);
    assert.match(AYUDA, /'rotating' NO se aprovisiona/);
});

test('la ayuda documenta el perfil y por qué es obligatorio', () => {
    assert.match(AYUDA, /--profile=<perfil>/);
    assert.match(AYUDA, /cadena de credenciales por defecto/);
});

test('la ayuda documenta los ocho códigos de salida', () => {
    for (const [nombre, codigo] of Object.entries(EXIT)) {
        assert.match(AYUDA, new RegExp(`^\\s*${codigo}\\s`, 'm'),
            `falta el código ${codigo} (${nombre}) en la ayuda`);
    }
});

test('la ayuda trae ejemplos y ninguno lleva un valor real', () => {
    assert.match(AYUDA, /EJEMPLOS/);
    // Ni cuentas, ni CMK concretas, ni ARNs armados: el repo es público.
    assert.ok(!/\d{12}/.test(AYUDA), 'la ayuda incluye algo con forma de account id');
    assert.ok(!/arn:aws:[a-z]+:[a-z0-9-]+:\d/.test(AYUDA), 'la ayuda incluye un ARN concreto');
    // Los marcadores son placeholders explícitos.
    assert.match(AYUDA, /--cmk=<id>/);
    assert.match(AYUDA, /--principal=<arn>/);
});

test('la ayuda desaconseja explícitamente pasar el valor por argumento', () => {
    assert.match(AYUDA, /Nunca:\s+--value=/);
    assert.match(AYUDA, /El VALOR nunca se pasa por argumento/);
});

test('`--help` sale con 0 y escribe la ayuda por stdout', async () => {
    const r = await correr({ argv: ['--help'] });
    assert.equal(r.codigo, EXIT.OK);
    assert.match(r.stdout, /vault-provision — alta y rotación/);
    assert.equal(r.ssm.calls.length, 0);
});

// =============================================================================
// CA-2 — el valor entra sólo por TTY sin eco o por stdin
// =============================================================================

test('no existe `--value`: se rechaza con un mensaje que explica por qué', () => {
    const err = capturar(() => parsearArgs(argsBase(['--value=x'])));
    assert.ok(err instanceof CliError);
    assert.equal(err.exit, EXIT.USAGE);
    assert.match(err.message, /no va a existir/);
    assert.match(err.message, /tabla de procesos/);
});

test('las variantes de flag que cargarían el valor también se rechazan', () => {
    for (const flag of ['secret', 'password', 'token', 'valor', 'clave', 'pass']) {
        const err = capturar(() => parsearArgs(argsBase([`--${flag}=x`])));
        assert.ok(err instanceof CliError, `--${flag} debería rechazarse`);
        assert.equal(err.exit, EXIT.USAGE, `--${flag} debería rechazarse`);
    }
});

test('el mensaje de rechazo de `--value` NO repite lo que venía después del `=`', () => {
    const canario = 'CANARIO-ARGV-8f3a11d7';
    const err = capturar(() => parsearArgs(argsBase([`--value=${canario}`])));
    assert.ok(!err.message.includes(canario), 'el error repitió el valor tipeado');
});

test('el valor leído por TTY se escribe con el eco deshabilitado y restaurado', async () => {
    const canario = 'CANARIO-TTY-4b91cc02';
    const stdin = stdinTty(`${canario}\r`);
    const r = await correr({ argv: argsBase(), stdin });

    assert.equal(r.codigo, EXIT.OK, r.stderr);
    // El eco se apagó y se volvió a encender.
    assert.ok(stdin.modos.includes(true), 'nunca se apagó el eco');
    assert.equal(stdin.modos.at(-1), false, 'el eco quedó apagado al terminar');
    // El valor llegó intacto al backend...
    assert.equal(r.ssm.escrituras[0].Value, canario);
    // ...y no salió por ninguna superficie.
    sinCanario(r, canario, 'lectura por TTY');
});

test('backspace borra un carácter ASCII completo', async () => {
    const r = await correr({ stdin: stdinTty(`clave-x${BACKSPACE}\r`) });

    assert.equal(r.codigo, EXIT.OK);
    assert.equal(r.ssm.guardado.Value, 'clave-');
});

test('backspace borra un carácter multibyte completo', async (t) => {
    for (const caracter of ['ñ', '😀']) {
        await t.test(JSON.stringify(caracter), async () => {
            const r = await correr({ stdin: stdinTty(`clave-${caracter}${BACKSPACE}\r`) });

            assert.equal(r.codigo, EXIT.OK);
            assert.equal(r.ssm.guardado.Value, 'clave-');
            assert.ok(!r.ssm.guardado.Value.includes('\uFFFD'));
        });
    }
});

test('backspace repetido borra un carácter completo por pulsación', async () => {
    const r = await correr({ stdin: stdinTty(`clave-ñ${BACKSPACE}${BACKSPACE}\r`) });

    assert.equal(r.codigo, EXIT.OK);
    assert.equal(r.ssm.guardado.Value, 'clave');
});

test('backspace con el buffer vacío es inocuo', async () => {
    const r = await correr({ stdin: stdinTty(`${BACKSPACE}clave-${BACKSPACE}\r`) });

    assert.equal(r.codigo, EXIT.OK);
    assert.equal(r.ssm.guardado.Value, 'clave');
});

test('sin terminal y sin `--stdin` no hay forma de ingresar el valor', async () => {
    const r = await correr({ argv: argsBase(), stdin: stdinPipe('x\n') });
    assert.equal(r.codigo, EXIT.INPUT);
    assert.match(r.stderr, /no hay terminal interactiva/);
    assert.equal(r.ssm.calls.length, 0);
    assert.equal(r.fabricasSsm, 0, 'ni siquiera debía construirse el cliente');
});

test('`--stdin` descarta UN salto de línea final y conserva el resto', async () => {
    const canario = 'CANARIO-STDIN-77ab30ff';
    const r = await correr({ argv: argsBase(['--stdin']), stdin: stdinPipe(`${canario}\n`) });
    assert.equal(r.codigo, EXIT.OK, r.stderr);
    assert.equal(r.ssm.escrituras[0].Value, canario);
    sinCanario(r, canario, 'lectura por stdin');
});

test('`--stdin` NO recorta espacios significativos del valor', async () => {
    const conEspacios = '  clave con espacios  ';
    const r = await correr({ argv: argsBase(['--stdin']), stdin: stdinPipe(`${conEspacios}\n`) });
    assert.equal(r.codigo, EXIT.OK, r.stderr);
    assert.equal(r.ssm.escrituras[0].Value, conEspacios);
});

// =============================================================================
// CA-2 / A04 — stdin vacío falla ANTES de AWS
// =============================================================================

test('stdin vacío falla sin emitir una sola llamada a AWS', async () => {
    const r = await correr({ argv: argsBase(['--stdin']), stdin: stdinPipe('') });
    assert.equal(r.codigo, EXIT.INPUT);
    assert.equal(r.ssm.calls.length, 0);
    assert.equal(r.identidad.calls.length, 0);
    assert.equal(r.fabricasSsm, 0);
});

test('stdin con sólo espacios falla sin emitir una sola llamada a AWS', async () => {
    const r = await correr({ argv: argsBase(['--stdin']), stdin: stdinPipe('   \t  \n') });
    assert.equal(r.codigo, EXIT.INPUT);
    assert.match(r.stderr, /sólo espacios en blanco/);
    assert.equal(r.ssm.calls.length, 0);
});

test('un valor que excede el máximo de SSM se rechaza acá, sin mandarlo a AWS', async () => {
    const r = await correr({
        argv: argsBase(['--stdin']),
        stdin: stdinPipe(`${'a'.repeat(MAX_VALUE_BYTES + 1)}\n`),
    });
    assert.equal(r.codigo, EXIT.INPUT);
    assert.equal(r.ssm.calls.length, 0);
});

test('el validador acepta multilínea (PEM) y rechaza otros controles', () => {
    assert.doesNotThrow(() => validarValor('-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----'));
    assert.doesNotThrow(() => validarValor('con\ttab'));
    const err = capturar(() => validarValor(`pegado${String.fromCharCode(7)}sucio`));
    assert.ok(err instanceof CliError);
    assert.equal(err.exit, EXIT.INPUT);
    // ESC se rechaza: podría inyectar secuencias en la terminal de quien lo lea.
    assert.throws(() => validarValor(`x${ESC}[31m`), CliError);
});

// =============================================================================
// CA-3 / A07 — confirmación de sobrescritura
// =============================================================================

const YA_EXISTE = Object.freeze({ Value: 'valor-viejo', Type: 'SecureString', Version: 3 });

test('crear un nombre nuevo NO pregunta nada y reporta `creado`', async () => {
    const r = await correr({ argv: argsBase(['--stdin']), stdin: stdinPipe('nuevo\n') });
    assert.equal(r.codigo, EXIT.OK, r.stderr);
    assert.match(r.stdout, /estado\s+: creado/);
    assert.ok(!r.stderr.includes(CONFIRMACION), 'preguntó por una creación limpia');
});

test('reescribir el MISMO valor no llama a putParameter y reporta `sin cambios`', async () => {
    const r = await correr({
        argv: argsBase(['--stdin']),
        stdin: stdinPipe('valor-viejo\n'),
        existente: YA_EXISTE,
    });
    assert.equal(r.codigo, EXIT.OK, r.stderr);
    assert.match(r.stdout, /estado\s+: sin cambios/);
    assert.equal(r.ssm.escrituras.length, 0, 'escribió pese a ser idéntico');
    assert.match(r.stdout, /versión\s+: 3/, 'la versión no debía avanzar');
});

test('la confirmación EXACTA autoriza la sobrescritura', async () => {
    const canario = 'CANARIO-CONFIRMA-2ce4d918';
    const stdin = stdinTty(`${canario}\r`, `${CONFIRMACION}\n`);
    const r = await correr({ argv: argsBase(), stdin, existente: YA_EXISTE });

    assert.equal(r.codigo, EXIT.OK, r.stderr);
    assert.match(r.stdout, /estado\s+: sobrescrito/);
    assert.equal(r.ssm.escrituras.length, 1);
    assert.equal(r.ssm.escrituras[0].Value, canario);
    assert.match(r.stdout, /versión\s+: 4/, 'la sobrescritura debía avanzar la versión');
    sinCanario(r, canario, 'sobrescritura confirmada');
});

test('el prompt de confirmación identifica el path real que se va a pisar', async () => {
    const stdin = stdinTty('nuevo\r', 'no\n');
    const r = await correr({ argv: argsBase(), stdin, existente: YA_EXISTE });
    assert.match(r.stderr, /\/testvault\/proj\/shared\/canario/);
    assert.match(r.stderr, new RegExp(`Escribí \\\`${CONFIRMACION}\\\``));
});

test('una respuesta distinta aborta y NO escribe', async () => {
    const canario = 'CANARIO-RECHAZO-9a01ffbe';
    const stdin = stdinTty(`${canario}\r`, 'si\n');
    const r = await correr({ argv: argsBase(), stdin, existente: YA_EXISTE });

    assert.equal(r.codigo, EXIT.CANCELLED);
    assert.equal(r.ssm.escrituras.length, 0, 'escribió pese a la confirmación fallida');
    assert.match(r.stderr, /no coincide exactamente/);
    sinCanario(r, canario, 'confirmación incorrecta');
});

test('`sobrescribir` con mayúsculas NO autoriza: la respuesta es exacta', async () => {
    const stdin = stdinTty('nuevo\r', `${CONFIRMACION.toUpperCase()}\n`);
    const r = await correr({ argv: argsBase(), stdin, existente: YA_EXISTE });
    assert.equal(r.codigo, EXIT.CANCELLED);
    assert.equal(r.ssm.escrituras.length, 0);
});

test('un Enter pelado NO autoriza', async () => {
    const stdin = stdinTty('nuevo\r', '\n');
    const r = await correr({ argv: argsBase(), stdin, existente: YA_EXISTE });
    assert.equal(r.codigo, EXIT.CANCELLED);
    assert.equal(r.ssm.escrituras.length, 0);
});

test('sin terminal para confirmar y sin `--yes`, el overwrite aborta sin escribir', async () => {
    const r = await correr({
        argv: argsBase(['--stdin']),
        stdin: stdinPipe('distinto\n'),
        existente: YA_EXISTE,
    });
    assert.equal(r.codigo, EXIT.CANCELLED);
    assert.equal(r.ssm.escrituras.length, 0);
    assert.match(r.stderr, /no hay terminal para confirmar/);
});

test('el Ctrl-C durante la lectura del valor cancela y restaura el eco', async () => {
    const stdin = stdinTty(`abc${ETX}`);
    const r = await correr({ argv: argsBase(), stdin });
    assert.equal(r.codigo, EXIT.CANCELLED);
    assert.equal(r.ssm.calls.length, 0);
    assert.equal(stdin.modos.at(-1), false, 'el eco quedó apagado tras el Ctrl-C');
});

test('el Ctrl-C tras tipear un valor multibyte no escribe ni filtra el canario', async () => {
    // Cierra la asimetría de scrub que detectó la auditoría: el camino feliz y
    // el timeout limpiaban el buffer, pero Ctrl-C no. El scrub vive ahora en
    // `restaurar()`, así que lo ejercita CUALQUIER salida del lector. Acá se
    // afirma el contrato observable de esa salida: cero escrituras y cero
    // apariciones del valor tipeado en las superficies de salida.
    const CANARIO = 'CANARIO-SCRUB-5466-ñ😀';
    const stdin = stdinTty(`${CANARIO}${ETX}`);
    const r = await correr({ argv: argsBase(), stdin });

    assert.equal(r.codigo, EXIT.CANCELLED);
    assert.equal(r.ssm.calls.length, 0, 'se llamó a SSM pese a la cancelación');
    assert.equal(r.ssm.escrituras.length, 0, 'se escribió pese a la cancelación');
    assert.equal(stdin.modos.at(-1), false, 'el eco quedó apagado tras el Ctrl-C');
    assert.ok(!r.stdout.includes(CANARIO), 'el valor tipeado se filtró a stdout');
    assert.ok(!r.stderr.includes(CANARIO), 'el valor tipeado se filtró a stderr');
});

test('el tiempo de espera agotado en la confirmación aborta sin escribir', async () => {
    // Se tipea el valor pero nunca se responde la confirmación: vence el tope.
    const stdin = stdinTty('nuevo\r');
    const r = await correr({ argv: argsBase(), stdin, existente: YA_EXISTE });
    assert.equal(r.codigo, EXIT.CANCELLED);
    assert.equal(r.ssm.escrituras.length, 0);
    assert.match(r.stderr, /tiempo de espera/);
});

// =============================================================================
// A07 — `--yes` es opt-in explícito y NUNCA ambiental
// =============================================================================

test('`--yes` autoriza la sobrescritura sin preguntar', async () => {
    const r = await correr({
        argv: argsBase(['--stdin', '--yes']),
        stdin: stdinPipe('distinto\n'),
        existente: YA_EXISTE,
    });
    assert.equal(r.codigo, EXIT.OK, r.stderr);
    assert.match(r.stdout, /estado\s+: sobrescrito/);
    assert.match(r.stderr, /autorizada por `--yes`/);
});

test('ninguna variable de entorno de CI activa `--yes`', async () => {
    const env = {
        CI: 'true', VAULT_PROVISION_YES: '1', GITHUB_ACTIONS: 'true',
        FORCE: '1', ASSUME_YES: 'true', YES: '1',
    };
    const r = await correr({
        argv: argsBase(['--stdin']),
        stdin: stdinPipe('distinto\n'),
        existente: YA_EXISTE,
        env,
    });
    assert.equal(r.codigo, EXIT.CANCELLED, 'una variable de entorno autorizó la sobrescritura');
    assert.equal(r.ssm.escrituras.length, 0);
});

test('el parser sólo toma `--yes` de argv', () => {
    const conEnv = parsearArgs(argsBase(), { CI: 'true', YES: '1', VAULT_PROVISION_YES: '1' });
    assert.equal(conEnv.yes, false);
    assert.equal(parsearArgs(argsBase(['--yes']), {}).yes, true);
});

// =============================================================================
// A01 / A05 — identidad y CMK explícitas, fail-closed
// =============================================================================

test('la identidad del runtime read-only no puede escribir', async () => {
    const canario = 'CANARIO-IDENT-51de77a0';
    const r = await correr({
        argv: argsBase(['--stdin']),
        stdin: stdinPipe(`${canario}\n`),
        arn: OTRO_PRINCIPAL,
    });
    assert.equal(r.codigo, EXIT.IDENTITY);
    assert.equal(r.ssm.calls.length, 0, 'tocó SSM con una identidad no autorizada');
    // El ARN efectivo NO se filtra al mensaje.
    assert.ok(!r.stderr.includes(OTRO_PRINCIPAL));
    sinCanario(r, canario, 'identidad denegada');
});

test('una identidad no verificable aborta antes de SSM', async () => {
    const stdout = escritor();
    const stderr = escritor();
    const ssm = ssmFalso();
    const codigo = await run({
        argv: argsBase(['--stdin']),
        env: {},
        stdout,
        stderr,
        stdin: stdinPipe('x\n'),
        deps: {
            cargarConfig: () => CONFIG,
            crearSsm: () => ssm,
            crearIdentidad: () => ({ async resolveArn() { throw new Error('sts'); } }),
            timeoutMs: 250,
        },
    });
    assert.equal(codigo, EXIT.IDENTITY);
    assert.equal(ssm.calls.length, 0);
});

test('sin `--cmk` no se construye nada ni se llama a AWS', async () => {
    const argv = ['--tier=shared', '--scope=x', '--profile=p', `--principal=${PRINCIPAL}`];
    const r = await correr({ argv, stdin: stdinPipe('x\n') });
    assert.equal(r.codigo, EXIT.USAGE);
    assert.equal(r.ssm.calls.length, 0);
    assert.equal(r.fabricasSsm, 0);
    assert.match(r.stderr, /sin CMK explícita no se escribe/);
});

test('sin `--profile` se rechaza nombrando el riesgo de la cadena por defecto', () => {
    const argv = ['--tier=shared', '--scope=x', `--cmk=${CMK}`, `--principal=${PRINCIPAL}`];
    const err = capturar(() => parsearArgs(argv, {}));
    assert.ok(err instanceof CliError);
    assert.equal(err.exit, EXIT.USAGE);
    assert.match(err.message, /READ-ONLY del runtime/);
});

test('la CMK y el principal pueden venir del entorno, el perfil NO', () => {
    const opts = parsearArgs(['--tier=host', '--scope=x', '--profile=p'], {
        VAULT_PROVISION_CMK: CMK,
        VAULT_PROVISION_PRINCIPAL: PRINCIPAL,
    });
    assert.equal(opts.cmk, CMK);
    assert.equal(opts.principal, PRINCIPAL);

    assert.throws(() => parsearArgs(['--tier=host', '--scope=x'], {
        AWS_PROFILE: 'provisioning',
        VAULT_PROVISION_CMK: CMK,
        VAULT_PROVISION_PRINCIPAL: PRINCIPAL,
    }), CliError);
});

test('la escritura siempre es SecureString con la CMK declarada', async () => {
    const r = await correr({ argv: argsBase(['--stdin']), stdin: stdinPipe('x1234\n') });
    assert.equal(r.codigo, EXIT.OK, r.stderr);
    const put = r.ssm.escrituras[0];
    assert.equal(put.Type, 'SecureString');
    assert.equal(put.KeyId, CMK);
    assert.equal(put.Overwrite, true);
});

// =============================================================================
// A03 / A04 — contrato canónico antes de la red
// =============================================================================

test('`--tier=rotating` se rechaza como error de USO, sin tocar AWS', async () => {
    const argv = ['--tier=rotating', '--scope=x', '--profile=p', `--cmk=${CMK}`,
        `--principal=${PRINCIPAL}`];
    const r = await correr({ argv, stdin: stdinPipe('x\n') });
    assert.equal(r.codigo, EXIT.USAGE);
    assert.match(r.stderr, /Secrets Manager/);
    assert.equal(r.ssm.calls.length, 0);
});

test('un nombre lógico inválido lo rechaza el contrato canónico, no un regex local', async () => {
    const r = await correr({
        argv: argsBase(['--stdin']).map((a) => (a.startsWith('--scope') ? '--scope=no/valido' : a)),
        stdin: stdinPipe('x1234\n'),
    });
    assert.equal(r.codigo, EXIT.CONFIG);
    // El mensaje viene de `secret-vault.js` y nombra la CLAVE de configuración.
    assert.match(r.stderr, /vault\.scope/);
    assert.equal(r.ssm.calls.length, 0);
});

test('el tier `host` resuelve el path segmentado por host', async () => {
    const r = await correr({
        argv: argsBase(['--stdin']).map((a) => (a === '--tier=shared' ? '--tier=host' : a)),
        stdin: stdinPipe('x1234\n'),
    });
    assert.equal(r.codigo, EXIT.OK, r.stderr);
    assert.match(r.stdout, /path\s+: \/testvault\/proj\/hosts\/hostuno\/canario/);
});

test('no se admiten posicionales ni flags desconocidas', () => {
    assert.throws(() => parsearArgs([...argsBase(), 'suelto'], {}), CliError);
    assert.throws(() => parsearArgs([...argsBase(), '--desconocida=1'], {}), CliError);
    assert.throws(() => parsearArgs([...argsBase(), '--tier'], {}), CliError);
});

// =============================================================================
// CA-4 / A02 / A09 — redacción y frontera de fuga
// =============================================================================

test('un fallo del backend no filtra el valor ni el error del SDK', async () => {
    const canario = 'CANARIO-BACKEND-6d2e04ac';
    const stdout = escritor();
    const stderr = escritor();
    const ssm = {
        calls: [],
        async getParameter() {
            const err = new Error(`AWS falló procesando Value=${canario} en el request`);
            err.name = 'ThrottlingException';
            throw err;
        },
        async putParameter() { throw new Error('no debería llegar'); },
        async getParameterMetadata() { throw new Error('no debería llegar'); },
    };
    const codigo = await run({
        argv: argsBase(['--stdin']),
        env: {},
        stdout,
        stderr,
        stdin: stdinPipe(`${canario}\n`),
        deps: {
            cargarConfig: () => CONFIG,
            crearSsm: () => ssm,
            crearIdentidad: () => identidadFalsa(),
            timeoutMs: 250,
        },
    });
    assert.equal(codigo, EXIT.BACKEND);
    assert.ok(!stdout.texto.includes(canario), 'el valor salió por stdout');
    assert.ok(!stderr.texto.includes(canario), 'el valor salió por stderr');
    // El mensaje del SDK tampoco se reenvía.
    assert.ok(!stderr.texto.includes('AWS falló procesando'));
});

test('una excepción de una capa desconocida se reduce a un genérico sin detalle', () => {
    const canario = 'CANARIO-SANITIZA-b4470e31';
    const err = new Error(`explotó con ${canario}`);
    err.stack = `Error: ${canario}\n  at algo`;
    const { exit, mensaje } = sanitizarFalla(err);
    assert.equal(exit, EXIT.INTERNAL);
    assert.ok(!mensaje.includes(canario));
    assert.match(mensaje, /falla no prevista/);
});

test('el mensaje genérico no trae el prefijo: lo pone el emisor una sola vez', () => {
    // Regresión de una corrida real, que imprimía
    // "vault-provision: vault-provision: falla no prevista...".
    const { mensaje } = sanitizarFalla(new Error('lo que sea'));
    assert.ok(!mensaje.startsWith('vault-provision'),
        'el mensaje sanitizado duplica el prefijo que agrega el emisor');
});

test('todo error emitido lleva el prefijo `vault-provision:` exactamente una vez', async () => {
    const casos = [
        { argv: [...argsBase(), '--nope=1'], stdin: stdinPipe('x\n') },
        { argv: argsBase(['--stdin']), stdin: stdinPipe('') },
        { argv: argsBase(['--stdin']), stdin: stdinPipe('x1234\n'), arn: OTRO_PRINCIPAL },
    ];
    for (const c of casos) {
        const r = await correr(c);
        const veces = r.stderr.split('vault-provision:').length - 1;
        assert.equal(veces, 1, `prefijo repetido ${veces} veces en: ${r.stderr}`);
    }
});

test('el sumidero suprime cualquier mensaje que contenga el valor', () => {
    const canario = 'CANARIO-SUMIDERO-cc9017f2';
    const stdout = escritor();
    const stderr = escritor();
    const ref = { value: canario };
    const salida = crearSalida({ stdout, stderr, refSecreto: ref, color: false });

    salida.out(`esto es inocuo\n`);
    assert.match(stdout.texto, /inocuo/);
    assert.equal(salida.fueContaminado(), false);

    // Un mensaje que arrastre el valor jamás llega al descriptor.
    salida.err(`fallo con ${canario}\n`);
    assert.ok(!stderr.texto.includes(canario));
    assert.match(stderr.texto, /se suprimió un mensaje/);
    assert.equal(salida.fueContaminado(), true);
});

test('el guardián del sumidero también atrapa el valor partido por ANSI', () => {
    const canario = 'CANARIO-ANSI-7710ba43';
    const stdout = escritor();
    const stderr = escritor();
    const salida = crearSalida({ stdout, stderr, refSecreto: { value: canario }, color: true });
    // El valor con un color intercalado en el medio sigue siendo el valor.
    salida.out(`${canario.slice(0, 6)}${ESC}[31m${canario.slice(6)}\n`);
    assert.ok(!stdout.texto.includes(canario));
});

test('un valor demasiado corto no dispara falsos positivos en el sumidero', () => {
    const stdout = escritor();
    const stderr = escritor();
    const salida = crearSalida({ stdout, stderr, refSecreto: { value: 'ab' }, color: false });
    salida.out('mensaje con ab adentro\n');
    assert.match(stdout.texto, /mensaje con ab adentro/);
    assert.equal(salida.fueContaminado(), false);
});

test('la salida exitosa sólo lleva los campos de la allowlist', async () => {
    const canario = 'CANARIO-SALIDA-30ffab27';
    const r = await correr({ argv: argsBase(['--stdin']), stdin: stdinPipe(`${canario}\n`) });
    assert.equal(r.codigo, EXIT.OK, r.stderr);
    const campos = r.stdout.trim().split('\n').map((l) => l.split(':')[0].trim());
    assert.deepEqual(campos,
        ['nombre lógico', 'tier', 'backend', 'path', 'estado', 'tipo', 'versión']);
    assert.match(r.stdout, /backend\s+: ssm/);
    sinCanario(r, canario, 'salida exitosa');
});

// =============================================================================
// CA-5 — la salida funciona sin color y dice exactamente lo mismo
// =============================================================================

test('la salida con color, despojada de ANSI, es idéntica a la salida sin color', async () => {
    const conColor = await correr({
        argv: argsBase(['--stdin']),
        stdin: stdinPipe('un-valor\n'),
        stdoutTty: true,
        existente: null,
    });
    const sinColor = await correr({
        argv: argsBase(['--stdin', '--no-color']),
        stdin: stdinPipe('un-valor\n'),
        stdoutTty: true,
    });
    assert.equal(conColor.codigo, EXIT.OK);
    assert.equal(sinColor.codigo, EXIT.OK);
    // eslint-disable-next-line no-control-regex
    const limpio = conColor.stdout.replace(/\x1B\[[0-9;]*m/g, '');
    assert.equal(limpio, sinColor.stdout);
    assert.ok(!sinColor.stdout.includes(ESC + '['), 'la salida sin color trajo ANSI');
});

test('`NO_COLOR` en el entorno también apaga el color', async () => {
    const r = await correr({
        argv: argsBase(['--stdin']),
        stdin: stdinPipe('un-valor\n'),
        stdoutTty: true,
        env: { NO_COLOR: '1' },
    });
    assert.ok(!r.stdout.includes(ESC + '['));
});

// =============================================================================
// A02 — restauración del TTY por todos los caminos
// =============================================================================

test('el eco se restaura tras un éxito, un error y un rechazo', async () => {
    // Éxito.
    const ok = stdinTty('valor-ok\r');
    await correr({ argv: argsBase(), stdin: ok });
    assert.equal(ok.modos.at(-1), false, 'éxito');

    // Error de backend (el put falla).
    const malo = stdinTty('valor-x\r');
    const stdout = escritor();
    const stderr = escritor();
    await run({
        argv: argsBase(),
        env: {},
        stdout,
        stderr,
        stdin: malo,
        deps: {
            cargarConfig: () => CONFIG,
            crearSsm: () => ({
                async getParameter() { return null; },
                async putParameter() { throw new Error('boom'); },
                async getParameterMetadata() { return null; },
            }),
            crearIdentidad: () => identidadFalsa(),
            timeoutMs: 250,
        },
    });
    assert.equal(malo.modos.at(-1), false, 'error de backend');

    // Rechazo por identidad.
    const denegado = stdinTty('valor-y\r');
    await correr({ argv: argsBase(), stdin: denegado, arn: OTRO_PRINCIPAL });
    assert.equal(denegado.modos.at(-1), false, 'identidad denegada');
});

test('`restaurarEco` es idempotente y nunca lanza', () => {
    const tty = stdinTty();
    assert.equal(restaurarEco(tty), true);
    assert.equal(restaurarEco(tty), true);
    assert.deepEqual(tty.modos, [false, false]);

    // Superficies que no son terminal, o que fallan, no rompen nada.
    assert.equal(restaurarEco(null), false);
    assert.equal(restaurarEco({ isTTY: false }), false);
    assert.equal(restaurarEco({ isTTY: true, setRawMode() { throw new Error('sin tty'); } }), false);
});

test('los handlers de señal, excepción y rechazo restauran el eco y no imprimen detalle', () => {
    const registrados = new Map();
    const stderr = escritor();
    const tty = stdinTty();
    const salidas = [];
    const procFalso = {
        on(evento, fn) { registrados.set(evento, fn); },
        exit(codigo) { salidas.push(codigo); },
    };

    instalarHandlers({ stdin: tty, stderr, proc: procFalso });

    // Se cubren las tres señales declaradas más los dos handlers globales.
    for (const senal of SENALES) {
        assert.ok(registrados.has(senal), `falta el handler de ${senal}`);
    }
    assert.ok(registrados.has('uncaughtException'));
    assert.ok(registrados.has('unhandledRejection'));

    // Una excepción con el valor en el mensaje NO se imprime.
    const canario = 'CANARIO-HANDLER-fe0913dd';
    const err = new Error(canario);
    err.stack = `Error: ${canario}\n at x`;
    registrados.get('uncaughtException')(err);
    assert.ok(!stderr.texto.includes(canario), 'el handler imprimió el detalle');
    assert.equal(salidas.at(-1), EXIT.INTERNAL);

    registrados.get('unhandledRejection')(err);
    assert.ok(!stderr.texto.includes(canario));

    registrados.get('SIGINT')();
    assert.match(stderr.texto, /interrumpido por SIGINT/);
    assert.equal(salidas.at(-1), EXIT.CANCELLED);

    // Cada handler invocado restauró el eco, y ninguno lo dejó en modo crudo.
    assert.equal(tty.modos.length, 3, 'un handler no restauró el eco');
    assert.ok(tty.modos.every((m) => m === false));
});

// =============================================================================
// CA-7 — códigos de salida estables
// =============================================================================

test('los códigos de salida son los documentados y no se solapan', () => {
    assert.deepEqual(EXIT, {
        OK: 0, USAGE: 1, INPUT: 2, IDENTITY: 3,
        CANCELLED: 4, CONFIG: 5, BACKEND: 6, INTERNAL: 7,
    });
    const valores = Object.values(EXIT);
    assert.equal(new Set(valores).size, valores.length);
});

test('cada familia de falla mapea a su código documentado', async () => {
    const casos = [
        { nombre: 'uso', argv: [...argsBase(), '--nope=1'], stdin: stdinPipe('x\n'), esperado: EXIT.USAGE },
        { nombre: 'entrada', argv: argsBase(['--stdin']), stdin: stdinPipe(''), esperado: EXIT.INPUT },
        { nombre: 'identidad', argv: argsBase(['--stdin']), stdin: stdinPipe('x1234\n'), arn: OTRO_PRINCIPAL, esperado: EXIT.IDENTITY },
    ];
    for (const c of casos) {
        const r = await correr({ argv: c.argv, stdin: c.stdin, arn: c.arn });
        assert.equal(r.codigo, c.esperado, `caso ${c.nombre}`);
    }
});

test('una config sin región falla como configuración, antes de AWS', async () => {
    const r = await correr({
        argv: argsBase(['--stdin']),
        stdin: stdinPipe('x1234\n'),
        config: { ...CONFIG, region: '' },
    });
    assert.equal(r.codigo, EXIT.CONFIG);
    assert.equal(r.ssm.calls.length, 0);
    assert.match(r.stderr, /kernel\.region/);
});

// =============================================================================
// Evidencia agregada: ningún camino filtra su canario
// =============================================================================

test('ningún camino — feliz o fallido — deja el canario en una superficie observable', async () => {
    const escenarios = [
        { nombre: 'creado', canario: 'CANARIO-E2E-aa01', existente: null, argv: argsBase(['--stdin']) },
        { nombre: 'sin cambios', canario: 'CANARIO-E2E-bb02', existente: { Value: 'CANARIO-E2E-bb02', Type: 'SecureString', Version: 1 }, argv: argsBase(['--stdin']) },
        { nombre: 'sobrescrito', canario: 'CANARIO-E2E-cc03', existente: { Value: 'previo', Type: 'SecureString', Version: 1 }, argv: argsBase(['--stdin', '--yes']) },
        { nombre: 'overwrite denegado', canario: 'CANARIO-E2E-dd04', existente: { Value: 'previo', Type: 'SecureString', Version: 1 }, argv: argsBase(['--stdin']) },
        { nombre: 'identidad denegada', canario: 'CANARIO-E2E-ee05', existente: null, argv: argsBase(['--stdin']), arn: OTRO_PRINCIPAL },
    ];

    for (const e of escenarios) {
        const r = await correr({
            argv: e.argv,
            stdin: stdinPipe(`${e.canario}\n`),
            existente: e.existente,
            arn: e.arn,
        });
        sinCanario(r, e.canario, e.nombre);
        // Tampoco en el objeto de resultado que la CLI proyecta.
        assert.ok(!r.todo.includes(e.canario), `el canario apareció en ${e.nombre}`);
    }
});

test('el valor no queda referenciado en el entorno del proceso', async () => {
    const canario = 'CANARIO-ENV-19cd77e0';
    const antes = Object.keys(process.env).length;
    await correr({ argv: argsBase(['--stdin']), stdin: stdinPipe(`${canario}\n`) });
    assert.equal(Object.keys(process.env).length, antes, 'la CLI agregó variables de entorno');
    for (const [k, v] of Object.entries(process.env)) {
        assert.ok(!String(v).includes(canario), `el canario terminó en la variable ${k}`);
    }
});
