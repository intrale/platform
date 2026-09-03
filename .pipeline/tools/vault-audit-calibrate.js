#!/usr/bin/env node
'use strict';

/**
 * #5804 — Wrapper CLI de la calibración de tráfico físico del vault.
 *
 * ESTE ARCHIVO NO TIENE LÓGICA DE NEGOCIO (CA-1). Todo lo que valida, agrega,
 * calcula o construye evidencia vive en `../lib/vault-calibration-scenario.js`.
 * Acá sólo hay: parseo de argumentos, lectura de stdin, traducción de
 * `CalibrationError.code` a código de salida + texto de operador, y `exitCode`.
 *
 * Tampoco ejecuta la medición productiva ni publica nada (eso es #5805): no
 * abre red, no toca AWS, no escribe archivos. Recalcula evidencia a partir de un
 * lote de eventos ya capturado, que es lo que permite auditar un número sin
 * volver a correr la carga.
 *
 * Único `require` del archivo: el núcleo de `../lib/`. La dirección de capas es
 * `tools/ -> lib/` y nunca al revés (CA-1). stdin se lee por el stream global,
 * así que no hace falta `fs`.
 *
 * Uso:
 *   cat lote.json | node .pipeline/tools/vault-audit-calibrate.js --stdin
 */

const {
    CALIBRATION_ERROR_CODES,
    CalibrationError,
    aggregateEvents,
    buildScenarioEvidence,
} = require('../lib/vault-calibration-scenario');

// -----------------------------------------------------------------------------
// Contrato público de la CLI (G-1)
// -----------------------------------------------------------------------------

/**
 * Códigos de salida. Son ESTABLES y están documentados en `--help`: un operador
 * (o un wrapper) discrimina por número, no parseando el mensaje.
 *
 * La numeración separa "no llegué a calcular" (1-2) de "el dato de entrada no
 * cierra" (3-5) y de "el cálculo no es representable" (6). El runbook trata esos
 * grupos con procedimientos distintos.
 */
const EXIT = Object.freeze({
    OK: 0,
    USAGE: 1,       // argumentos ausentes, desconocidos o mal formados
    INPUT: 2,       // stdin ausente, no es JSON, o el sobre tiene claves ajenas
    SCENARIO: 3,    // el escenario no pasa la validación fail-closed
    EVENTS: 4,      // el lote de eventos no pasa la validación fail-closed
    PROVENANCE: 5,  // HEAD o sello temporal ausentes, mal formados o fuera de rango
    METRIC: 6,      // el resultado no es finito o no es entero seguro
    INTERNAL: 7,    // excepción no prevista, ya sanitizada
});

/** Claves admitidas en el sobre que llega por stdin. Enum CERRADO. */
const PAYLOAD_KEYS = Object.freeze(['scenario', 'events', 'head_sha', 'generated_at_ms']);

/**
 * Traducción de cada código del núcleo a (salida, impacto, próximo paso) (G-2).
 *
 * Los textos son literales ESTÁTICOS: nunca se interpola el input, así que esta
 * tabla no puede reintroducir un canario que el núcleo ya descartó. El núcleo
 * sigue devolviendo sólo `code` + `detail` (nombres de campo e índices); la
 * lectura para humanos se agrega recién acá, en el borde.
 */
const C = CALIBRATION_ERROR_CODES;
const TRADUCCION = Object.freeze({
    [C.SCENARIO_NOT_OBJECT]: [EXIT.SCENARIO,
        'no hay escenario que calibrar, asi que no se calculo ninguna metrica',
        'mandar `scenario` como objeto JSON plano (ver --help)'],
    [C.UNKNOWN_FIELD]: [EXIT.SCENARIO,
        'se rechazo la entrada entera: un campo de mas puede ser un parametro viejo que ya no se respeta',
        'quitar el campo informado en `detail.field` o corregir su nombre'],
    [C.MISSING_FIELD]: [EXIT.SCENARIO,
        'sin ese campo no hay default posible: completarlo en silencio produciria una calibracion inventada',
        'declarar explicitamente el campo informado en `detail.field`'],
    [C.UNSAFE_KEY]: [EXIT.INPUT,
        'la entrada trae una clave de herencia peligrosa y se descarto entera',
        'quitar `__proto__` / `constructor` / `prototype` del JSON de entrada'],
    [C.NOT_INTEGER]: [EXIT.SCENARIO,
        'no se redondea por las nuestras: una fraccion o un no-numero ahi corromperia el bucket y el pico',
        'mandar un entero seguro en el campo informado en `detail.field`'],
    [C.OUT_OF_RANGE]: [EXIT.SCENARIO,
        'el valor excede el tope del contrato y se rechazo ANTES de ordenar o agregar',
        'bajar el valor por debajo del tope informado en `detail.limit`'],
    [C.NOT_STRING]: [EXIT.SCENARIO,
        'el campo no es texto, asi que no se pudo validar contra su enum cerrado',
        'mandar una cadena en el campo informado en `detail.field`'],
    [C.STRING_TOO_LONG]: [EXIT.SCENARIO,
        'el texto excede el tope y se rechazo antes de copiarse a la evidencia',
        'acortar el campo informado en `detail.field` por debajo de `detail.limit`'],
    [C.STRING_MALFORMED]: [EXIT.SCENARIO,
        'el texto no respeta el formato del contrato y no puede viajar a la unidad de la evidencia',
        'usar un identificador en minusculas, digitos, `-` y `_`'],
    [C.UNKNOWN_DISTRIBUTION]: [EXIT.SCENARIO,
        'no se cae a una distribucion por defecto: eso haria irreproducible la corrida',
        'elegir una de las distribuciones que lista --help'],
    [C.WINDOW_NOT_DIVISIBLE]: [EXIT.SCENARIO,
        'un bucket final mas corto haria que el pico no sea comparable entre corridas',
        'ajustar `bucket_ms` para que divida exacto a `window_duration_ms`'],
    [C.TOO_MANY_BUCKETS]: [EXIT.SCENARIO,
        'la ventana se parte en mas buckets que el tope y se rechazo antes de agregar',
        'agrandar `bucket_ms` o achicar `window_duration_ms`'],
    [C.EVENTS_NOT_ARRAY]: [EXIT.EVENTS,
        'sin lote de eventos no hay nada que agregar y no se emitio evidencia',
        'mandar `events` como arreglo JSON'],
    [C.TOO_MANY_EVENTS]: [EXIT.EVENTS,
        'el lote excede el tope y se rechazo ANTES de ordenar: es la defensa de memoria y CPU',
        'partir el lote o acortar la ventana'],
    [C.EVENT_NOT_OBJECT]: [EXIT.EVENTS,
        'un evento invalido no se descarta en silencio: se rechaza el lote entero',
        'revisar el evento del indice informado en `detail.index`'],
    [C.UNKNOWN_CATEGORY]: [EXIT.EVENTS,
        'una categoria fuera del vocabulario haria que el conteo no cierre contra la instrumentacion',
        'usar una categoria del vocabulario del vault (ver --help)'],
    [C.EVENT_OUT_OF_WINDOW]: [EXIT.EVENTS,
        'un evento fuera de la ventana no tiene bucket, asi que la evidencia seria parcial',
        'recortar el lote a la ventana o corregir `window_start_ms` / `window_duration_ms`'],
    [C.DUPLICATE_SEQUENCE]: [EXIT.EVENTS,
        'con `seq` repetido los empates dejan de resolverse y la evidencia deja de ser reproducible',
        'asignar un `seq` unico por evento'],
    [C.SUMMARY_INVALID]: [EXIT.INTERNAL,
        'el resumen intermedio no cumple su contrato y no se construyo evidencia',
        'reportar el caso: es un defecto del nucleo, no de la entrada'],
    [C.PROVENANCE_INVALID]: [EXIT.PROVENANCE,
        'sin procedencia demostrable la evidencia no se puede atribuir a un commit',
        'declarar `head_sha` y `generated_at_ms` en el sobre'],
    [C.INVALID_HEAD_SHA]: [EXIT.PROVENANCE,
        'un HEAD no verificable atribuiria la medicion al commit equivocado',
        'mandar `head_sha` como 40 caracteres hexadecimales en minusculas'],
    [C.NON_FINITE_RESULT]: [EXIT.METRIC,
        'el calculo no es finito: se corta sin evidencia parcial en vez de publicar un numero enganoso',
        'revisar `window_duration_ms` y el total fisico del lote'],
    [C.UNSAFE_INTEGER_RESULT]: [EXIT.METRIC,
        'la extrapolacion desborda el entero seguro y dejaria de ser exacta',
        'acortar el lote o alargar la ventana para bajar el factor de extrapolacion'],
    [C.PORT_MISSING]: [EXIT.INTERNAL,
        'falta un puerto inyectable y no se ejecuto nada',
        'reportar el caso: esta CLI no usa puertos, es un defecto del nucleo'],
    [C.CLOCK_INVALID]: [EXIT.INTERNAL,
        'el reloj inyectado no cumple su contrato y no se sello la corrida',
        'reportar el caso: esta CLI no inyecta reloj'],
    [C.RESOLVE_HEAD_FAILED]: [EXIT.PROVENANCE,
        'no se pudo resolver el HEAD y no se midio nada',
        'reportar el caso: esta CLI recibe el HEAD por el sobre'],
    [C.DRIVER_FAILED]: [EXIT.INTERNAL,
        'el driver fallo y su error se descarto entero para no filtrar payload',
        'reportar el caso: esta CLI no ejecuta driver'],
    [C.DRIVER_RESULT_INVALID]: [EXIT.INTERNAL,
        'el driver devolvio algo que no cumple su contrato',
        'reportar el caso: esta CLI no ejecuta driver'],
    [C.SINK_FAILED]: [EXIT.INTERNAL,
        'el sink fallo despues de calcular, asi que la evidencia quedo sin persistir',
        'reportar el caso: esta CLI escribe a stdout, no usa sink'],
});

const FALLBACK = Object.freeze([EXIT.INTERNAL,
    'la corrida termino por un error no previsto y no se emitio evidencia',
    'reportar el caso con el codigo informado arriba']);

// -----------------------------------------------------------------------------
// Ayuda (G-1: OPCIONES + CÓDIGOS DE SALIDA en el mismo lugar)
// -----------------------------------------------------------------------------

function renderHelp() {
    return [
        // G-4: la ayuda es ASCII pura. Termina en logs, redirecciones y consolas
        // sin UTF-8, donde un caracter no representable se vuelve ruido.
        'vault-audit-calibrate - recalcula la evidencia de calibracion del vault',
        'a partir de un lote de eventos ya capturado.',
        '',
        'No mide, no publica, no toca AWS y no escribe archivos: lee un sobre JSON',
        'por stdin y escribe la evidencia por stdout.',
        '',
        'USO',
        '  cat lote.json | node .pipeline/tools/vault-audit-calibrate.js --stdin',
        '',
        'OPCIONES',
        '  --stdin        Lee el sobre JSON de stdin. Obligatorio: no hay entrada',
        '                 implicita ni argumentos posicionales.',
        '  --pretty       Indenta la salida JSON. El contenido es identico al de la',
        '                 salida compacta.',
        '  --no-color     Salida sin secuencias ANSI. El texto es identico al de la',
        '                 salida con color.',
        '  --help, -h     Esta ayuda.',
        '',
        'SOBRE DE ENTRADA',
        '  { "scenario": {...}, "events": [...], "head_sha": "<40 hex>",',
        '    "generated_at_ms": <entero> }',
        '  Cualquier otra clave de primer nivel es un error, no un dato que se ignora.',
        '  Los campos de `scenario` y de cada evento los define el nucleo y se validan',
        '  fail-closed: no se corrigen, no se completan y no se descartan en silencio.',
        '',
        'CATEGORIAS DE EVENTO',
        '  El vocabulario lo define el vault y esta CLI no lo redeclara. Se lista con:',
        "  node -e \"console.log(require('./.pipeline/lib/secret-vault').VAULT_TELEMETRY_CATEGORIES)\"",
        '  Solo la primera categoria (lectura fisica) alimenta pico y extrapolacion.',
        '',
        'CODIGOS DE SALIDA',
        `  ${EXIT.OK}  ok            Se emitio la evidencia por stdout.`,
        `  ${EXIT.USAGE}  uso           Argumentos ausentes, desconocidos o mal formados.`,
        `  ${EXIT.INPUT}  entrada       stdin ausente, no es JSON, o el sobre trae claves ajenas.`,
        `  ${EXIT.SCENARIO}  escenario     El escenario no paso la validacion fail-closed.`,
        `  ${EXIT.EVENTS}  eventos       El lote de eventos no paso la validacion fail-closed.`,
        `  ${EXIT.PROVENANCE}  procedencia   HEAD o sello temporal ausentes o mal formados.`,
        `  ${EXIT.METRIC}  metrica       El resultado no es finito o no es entero seguro.`,
        `  ${EXIT.INTERNAL}  interno       Error no previsto, ya sanitizado.`,
        '',
    ].join('\n');
}

// -----------------------------------------------------------------------------
// Parseo de argumentos: fail-closed, sin flags implicitas, sin posicionales
// -----------------------------------------------------------------------------

class CliError extends Error {
    constructor(exit, mensaje) {
        super(mensaje);
        this.name = 'CliError';
        this.exit = exit;
    }
}

function parseArgs(argv) {
    const opts = { stdin: false, pretty: false, color: true, help: false };
    for (const crudo of argv) {
        if (crudo === '--help' || crudo === '-h') { opts.help = true; continue; }
        if (crudo === '--stdin') { opts.stdin = true; continue; }
        if (crudo === '--pretty') { opts.pretty = true; continue; }
        if (crudo === '--no-color') { opts.color = false; continue; }
        if (!crudo.startsWith('--')) {
            throw new CliError(EXIT.USAGE,
                'no admite argumentos posicionales: el lote entra por stdin con --stdin');
        }
        // Se nombra solo la CLAVE, nunca lo que venia despues del `=`: el valor
        // tipeado por el operador no se repite en el mensaje de error.
        const sep = crudo.indexOf('=');
        const clave = sep === -1 ? crudo.slice(2) : crudo.slice(2, sep);
        throw new CliError(EXIT.USAGE, `\`--${clave}\` no es una opcion conocida (ver --help)`);
    }
    return opts;
}

/**
 * Proyecta el sobre por allowlist. Es parseo de entrada del borde, no logica de
 * negocio: los valores no se tocan, se pasan tal cual al nucleo, que los valida.
 */
function parsePayload(texto) {
    if (typeof texto !== 'string' || texto.trim().length === 0) {
        throw new CliError(EXIT.INPUT, 'stdin llego vacio: no hay lote que recalcular');
    }
    let sobre;
    try {
        sobre = JSON.parse(texto);
    } catch (err) {
        // El mensaje del parser se descarta: puede citar el fragmento crudo del
        // lote, que es exactamente lo que no puede salir por stderr.
        throw new CliError(EXIT.INPUT, 'stdin no es JSON valido');
    }
    if (sobre === null || typeof sobre !== 'object' || Array.isArray(sobre)) {
        throw new CliError(EXIT.INPUT, 'el sobre tiene que ser un objeto JSON');
    }
    for (const clave of Object.keys(sobre)) {
        if (!PAYLOAD_KEYS.includes(clave)) {
            // Se informa que HAY una clave ajena, no cual: el nombre viene del
            // input y podria ser el canario.
            throw new CliError(EXIT.INPUT,
                'el sobre trae una clave de primer nivel que no esta en el contrato (ver --help)');
        }
    }
    return sobre;
}

// -----------------------------------------------------------------------------
// Salida
// -----------------------------------------------------------------------------

const ANSI_ROJO = '[31m';
const ANSI_RESET = '[0m';

/**
 * G-4: el color NUNCA es el unico portador de estado. El prefijo textual
 * `ERROR:` y el codigo de salida distinguen exito de fallo con `--no-color`, sin
 * color, en un log o en una redireccion.
 */
function renderError(color, encabezado, impacto, proximoPaso) {
    const cuerpo = [
        `ERROR: ${encabezado}`,
        `Impacto: ${impacto}`,
        `Proximo paso: ${proximoPaso}`,
    ].join('\n');
    return color ? `${ANSI_ROJO}${cuerpo}${ANSI_RESET}` : cuerpo;
}

/** Traduce un error del nucleo a (salida, texto). No interpola input. */
function traducir(err) {
    const [exit, impacto, proximoPaso] = TRADUCCION[err.code] || FALLBACK;
    const detalle = err.detail && Object.keys(err.detail).length > 0
        ? ` ${JSON.stringify(err.detail)}`
        : '';
    return { exit, encabezado: `${err.code}${detalle}`, impacto, proximoPaso };
}

async function readStdin(stream) {
    const partes = [];
    for await (const parte of stream) partes.push(parte);
    return Buffer.concat(partes.map((p) => Buffer.from(p))).toString('utf8');
}

// -----------------------------------------------------------------------------
// main
// -----------------------------------------------------------------------------

/**
 * @param {{argv:string[], stdin:AsyncIterable, stdout:{write:Function}, stderr:{write:Function}}} io
 * @returns {Promise<number>} codigo de salida
 */
async function main(io) {
    const stdout = io.stdout;
    const stderr = io.stderr;
    let opts = { color: true };
    try {
        opts = parseArgs(io.argv);
        if (opts.help) {
            stdout.write(`${renderHelp()}\n`);
            return EXIT.OK;
        }
        if (!opts.stdin) {
            throw new CliError(EXIT.USAGE,
                '--stdin es obligatorio: no hay entrada implicita (ver --help)');
        }

        const sobre = parsePayload(await readStdin(io.stdin));

        // Delegacion pura al nucleo. Esta CLI no valida los campos internos, no
        // calcula y no arma evidencia: si algo de eso apareciera aca, seria la
        // segunda implementacion que el CA-1 prohibe.
        const summary = aggregateEvents(sobre.events, sobre.scenario);
        const evidence = buildScenarioEvidence(summary, {
            head_sha: sobre.head_sha,
            generated_at_ms: sobre.generated_at_ms,
        });

        stdout.write(`${JSON.stringify(evidence, null, opts.pretty ? 2 : 0)}\n`);
        return EXIT.OK;
    } catch (err) {
        if (err instanceof CliError) {
            stderr.write(`${renderError(opts.color, err.message,
                'no se emitio evidencia: la corrida se corto antes de calcular',
                'corregir la invocacion y volver a intentar')}\n`);
            return err.exit;
        }
        if (err instanceof CalibrationError) {
            const t = traducir(err);
            stderr.write(`${renderError(opts.color, t.encabezado, t.impacto, t.proximoPaso)}\n`);
            return t.exit;
        }
        // Error ajeno: se descarta entero (mensaje y stack) y sale un codigo propio.
        stderr.write(`${renderError(opts.color, 'error no previsto, ya sanitizado',
            FALLBACK[1], FALLBACK[2])}\n`);
        return EXIT.INTERNAL;
    }
}

if (require.main === module) {
    main({
        argv: process.argv.slice(2),
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
    }).then((code) => { process.exitCode = code; });
}

module.exports = { EXIT, PAYLOAD_KEYS, CliError, parseArgs, parsePayload, renderHelp, main };
