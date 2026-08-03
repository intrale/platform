#!/usr/bin/env node
// =============================================================================
// vault-provision.js — interfaz de OPERADOR de la provisión del vault
// (#5466, 3/3 de #5425). Runbook: docs/pipeline/vault-provisioning.md
// =============================================================================
//
// QUÉ ES: el composition root del operador. Toma el port de escritura de
// `vault-provisioner.js` (#5465) y el contrato canónico de nombres de
// `secret-vault.js` (#5464) y los cablea a una CLI que puede recibir material
// secreto sin filtrarlo por ninguna superficie local.
//
// LO QUE ESTE ARCHIVO **NO** HACE (a propósito):
//   - NO acepta el valor por argumento ni por variable de entorno. No existe
//     `--value`. Un argumento queda en `ps`, en el historial del shell y en el
//     log de auditoría del SO; una variable de entorno se hereda a todo hijo.
//     Las dos únicas puertas son TTY con eco deshabilitado y stdin.
//   - NO valida el namespace por su cuenta. Tier, prefijo y nombre lógico los
//     resuelve `validateVaultNamespace` (#5464) a través del provisionador. Acá
//     no hay regex de path: sería la tercera copia del esquema.
//   - NO decide la autorización de sobrescritura por sí mismo dentro del
//     pedido. La confirmación se expone como la capability
//     `overwriteAuthority` que el provisionador consulta, y sólo se consulta
//     cuando el nombre YA existe con un valor distinto (ver "Capability").
//   - NO construye ni ejecuta un comando de shell con datos del operador. El
//     único proceso externo es la AWS CLI para `sts get-caller-identity`,
//     invocada con `execFile` y una lista de argumentos estructurada (nunca
//     `exec`, nunca una cadena interpolada).
//   - NO imprime el valor, fragmentos, longitud, hash, la respuesta cruda de
//     AWS, `cause` ni stacks. Ver "Frontera de fuga".
//
// FRONTERA DE FUGA (CA-4)
//   Todo lo que llega a stdout/stderr pasa por `crearSalida()`, que es el ÚNICO
//   sumidero del proceso. Ese sumidero:
//     1. compone los mensajes por ALLOWLIST de campos (nombre lógico, tier,
//        backend, estado, path sanitizado, código) — nunca por interpolación de
//        lo que devolvió AWS;
//     2. antes de escribir un solo byte, verifica que el buffer NO contenga el
//        valor que está en memoria. Si lo contuviera — que sería un bug — se
//        descarta el mensaje entero y se emite uno genérico. Es un cinturón
//        además de los tiradores: los tests con canarios prueban que el camino
//        normal nunca lo dispara.
//   Los handlers de `uncaughtException`, `unhandledRejection` y de señales
//   entran por el MISMO sumidero. Un handler que imprima `err.stack` crudo
//   anularía todo lo anterior, así que no existe.
//
// CAPABILITY DE SOBRESCRITURA (A07)
//   `overwriteAuthority.authorize({ path })` NO es un booleano que la CLI
//   calcula de antemano: es una función que, al ser llamada, pregunta. Eso
//   importa por dos razones:
//     - una creación limpia NUNCA pregunta (el provisionador no consulta la
//       capability si el nombre no existía), así que el operador no aprende a
//       tipear "sí" por reflejo;
//     - la pregunta identifica el path sanitizado REAL que está por pisarse,
//       resuelto por el contrato canónico, no el que el operador creyó escribir.
//   `--yes` es la única forma de saltearla y se lee EXCLUSIVAMENTE de `argv`:
//   ninguna variable de entorno, ninguna heurística de CI y ningún "no hay TTY,
//   asumo que sí" la habilitan. Sin TTY y sin `--yes`, un overwrite aborta.
//
// TTY (A02)
//   El eco se deshabilita con `setRawMode(true)` y se restaura en `finally`,
//   además de en los handlers de señal y de excepción. Un proceso que muere con
//   el eco apagado deja la terminal del operador inutilizable, así que la
//   restauración es idempotente y se intenta por todos los caminos de salida.
// =============================================================================
'use strict';

const path = require('node:path');

const {
    createVaultProvisioner,
    createAwsSsmProvisionDriver,
    VAULT_PROVISION_STATES,
    VAULT_PROVISION_ERROR_CODES,
} = require('../lib/vault-provisioner');

// -----------------------------------------------------------------------------
// Contrato público de la CLI
// -----------------------------------------------------------------------------

/**
 * Códigos de salida. Son ESTABLES y documentados en `--help` y en el runbook:
 * un operador (o un wrapper) discrimina por número, no parseando el mensaje.
 *
 * La numeración separa "no llegué a AWS" (1-5) de "AWS respondió mal" (6): el
 * runbook trata esos dos grupos con procedimientos distintos.
 */
const EXIT = Object.freeze({
    OK: 0,
    USAGE: 1,       // argumentos ausentes, desconocidos o mal formados
    INPUT: 2,       // valor ausente, vacío, no imprimible o fuera de tamaño
    IDENTITY: 3,    // identidad efectiva no verificable o distinta a la declarada
    CANCELLED: 4,   // sobrescritura no confirmada, EOF, timeout o cancelación
    CONFIG: 5,      // tier/namespace/CMK inválidos por el contrato canónico
    BACKEND: 6,     // fallo de SSM o de la verificación posterior
    INTERNAL: 7,    // excepción no prevista, ya sanitizada
});

/**
 * Tiers que esta CLI aprovisiona. `rotating` NO está: vive en Secrets Manager,
 * que es otra API y otro ciclo de rotación. El provisionador también lo rechaza
 * (`TIER_UNSUPPORTED`); acá se rechaza ANTES para que el mensaje sea de uso, no
 * de backend.
 */
const TIERS_CLI = Object.freeze(['shared', 'host']);

// Señales que dejan la terminal en modo crudo si no se atienden. Se declaran
// una vez para que el test itere sobre la MISMA lista que instala el handler:
// una señal agregada acá sin handler rompe la suite en vez de descubrirse el
// día que alguien mata el proceso a mitad de un prompt.
const SENALES = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP']);

// SSM `Standard` admite hasta 4096 caracteres. El tope se aplica en BYTES UTF-8
// porque es lo que viaja, y se comprueba ANTES de cualquier llamada remota
// (A04): mandar 8 KB para que AWS los rechace expondría el valor a la red sin
// necesidad.
const MAX_VALUE_BYTES = 4096;

// Respuesta EXACTA que autoriza una sobrescritura. Se documenta en `--help` y en
// el prompt mismo. No se acepta "s", "si", "y", "yes" ni el `Enter` pelado:
// tienen que ser suficientes caracteres como para que no salga por reflejo.
const CONFIRMACION = 'sobrescribir';

// Tope de espera de las lecturas interactivas. Un prompt abierto para siempre en
// una sesión olvidada es un proceso con credenciales de provisión vivas.
const TIMEOUT_INTERACTIVO_MS = 120_000;

// Perfil y CMK son datos de configuración, no secretos, pero igual se validan
// antes de viajar: van como argumento a la AWS CLI y como campo a la API.
const PERFIL_RE = /^[A-Za-z0-9_.@-]{1,64}$/;
const CMK_RE = /^[A-Za-z0-9/_:.-]{1,2048}$/;
const ARN_RE = /^arn:[A-Za-z0-9-]+:[A-Za-z0-9-]*:[A-Za-z0-9-]*:\d{12}:.+$/;

// Flags que existen SÓLO para ser rechazadas con un mensaje útil. Un operador
// que intenta `--value=...` tiene que entender POR QUÉ no existe, no recibir un
// genérico "flag desconocida" y buscar otra forma de pasarlo por argumento.
const FLAGS_PROHIBIDAS = Object.freeze([
    'value', 'secret', 'password', 'pass', 'token', 'valor', 'clave',
]);

// -----------------------------------------------------------------------------
// Ayuda
// -----------------------------------------------------------------------------
//
// Sin un solo valor real: ni ARN de cuenta, ni id de CMK, ni nombre de host, ni
// nombre lógico concreto. Este repositorio es público y el catálogo de nombres
// del vault es justamente lo que la policy IAM le niega enumerar al runtime
// (ver docs/pipeline/vault-secretos-aws.md).
const AYUDA = `
vault-provision — alta y rotación de un secreto del vault (SSM SecureString)

USO
  node .pipeline/tools/vault-provision.js --tier=<shared|host> --scope=<nombre>
                                          --profile=<perfil> --cmk=<id-o-arn>
                                          --principal=<arn> [opciones]

  El VALOR nunca se pasa por argumento. Se pide por terminal con el eco
  deshabilitado, o se lee de stdin con --stdin.

TIERS
  shared   Secreto compartido por todo el proyecto.
           Resuelve en  <prefix>/<projectId>/shared/<scope>
  host     Secreto propio de una máquina. Toma el hostId de la config del
           pipeline.
           Resuelve en  <prefix>/<projectId>/hosts/<hostId>/<scope>

  El tier 'rotating' NO se aprovisiona acá: vive en Secrets Manager y tiene su
  propio ciclo de rotación.

REQUERIDAS
  --tier=<shared|host>   Explícito: nunca se infiere de la presencia de hostId.
  --scope=<nombre>       Nombre LÓGICO del secreto (letras, números, - y _).
  --profile=<perfil>     Perfil AWS de PROVISIÓN. Obligatorio y explícito: no se
                         usa la cadena de credenciales por defecto, para que la
                         identidad del runtime no pueda escribir por descuido.
  --cmk=<id-o-arn>       CMK del proyecto. Sin CMK no se escribe: la clave
                         administrada por defecto de AWS no es una CMK propia.
                         Alternativa: variable VAULT_PROVISION_CMK.
  --principal=<arn>      ARN que DEBE tener la identidad efectiva. Se compara
                         contra 'sts get-caller-identity'; si no coincide, se
                         aborta antes de tocar SSM.
                         Alternativa: variable VAULT_PROVISION_PRINCIPAL.

OPCIONES
  --stdin                Lee el valor de stdin en vez de pedirlo por terminal.
                         Modo no interactivo. Se descarta UN salto de línea
                         final; un stdin vacío o sólo espacios falla sin llamar
                         a AWS.
  --yes                  Autoriza la sobrescritura sin preguntar. Sólo se lee de
                         la línea de comandos: ninguna variable de entorno ni
                         detección de CI la activa.
  --no-color             Salida sin secuencias ANSI. El texto es idéntico al de
                         la salida con color.
  --help, -h             Esta ayuda.

ESTADOS
  creado         El nombre no existía. Se escribió.
  sin cambios    Ya tenía exactamente ese valor y ya era SecureString. NO se
                 escribió y la versión no avanzó.
  sobrescrito    Tenía un valor distinto y la sobrescritura fue autorizada.

CONFIRMACIÓN
  Si el nombre ya existe con otro valor, se pide escribir '${CONFIRMACION}'
  (exacto) mostrando el path que se va a pisar. Cualquier otra respuesta, un
  EOF, una señal o el vencimiento del tiempo de espera abortan SIN escribir.

CÓDIGOS DE SALIDA
  ${EXIT.OK}  ok            La operación terminó (ver el estado informado).
  ${EXIT.USAGE}  uso           Argumentos ausentes, desconocidos o mal formados.
  ${EXIT.INPUT}  entrada       Valor ausente, vacío, no imprimible o > ${MAX_VALUE_BYTES} bytes.
  ${EXIT.IDENTITY}  identidad     La identidad efectiva no es la declarada en --principal.
  ${EXIT.CANCELLED}  cancelado     Sobrescritura no confirmada. No se escribió nada.
  ${EXIT.CONFIG}  configuración Tier, namespace o CMK inválidos.
  ${EXIT.BACKEND}  backend       SSM falló o la verificación posterior no cerró.
  ${EXIT.INTERNAL}  interno       Falla no prevista, ya sanitizada.

EJEMPLOS
  # Alta interactiva (el valor se tipea y no se ve):
  node .pipeline/tools/vault-provision.js --tier=shared --scope=<nombre> \\
       --profile=<perfil> --cmk=<id> --principal=<arn>

  # Carga no interactiva desde un gestor de contraseñas, sin tocar el disco
  # ni el historial (notar el espacio inicial si el shell lo respeta):
   <comando-que-imprime-el-secreto> | node .pipeline/tools/vault-provision.js \\
       --tier=host --scope=<nombre> --profile=<perfil> --cmk=<id> \\
       --principal=<arn> --stdin

  Nunca:  --value=...   ni   echo "$SECRETO" | ...   con el valor exportado en
  el entorno. Ver el runbook: docs/pipeline/vault-provisioning.md
`.trimStart();

// -----------------------------------------------------------------------------
// Falla de uso de la CLI
// -----------------------------------------------------------------------------

/**
 * Error terminal de la CLI, con su código de salida adosado. Se distingue de
 * `VaultProvisionError`/`VaultConfigError` (que vienen de las capas de abajo)
 * porque describe un problema de INVOCACIÓN, no de provisión.
 *
 * Igual que sus pares de abajo, no lleva `cause`: encadenar el error original
 * arrastraría a cualquier `util.inspect` lo que se quiso dejar afuera.
 */
class CliError extends Error {
    constructor(exit, mensaje) {
        super(mensaje);
        this.name = 'CliError';
        this.exit = exit;
    }
}

// -----------------------------------------------------------------------------
// Sumidero único de salida (ver "Frontera de fuga")
// -----------------------------------------------------------------------------

const ANSI_RE = /\x1B\[[0-9;]*m/g;

/**
 * Crea el único par de escritores del proceso.
 *
 * `refSecreto` es una CAJA (`{ value }`), no el valor: cuando el secreto todavía
 * no se leyó la caja está vacía, y cuando se lee no hay que volver a cablear
 * nada. El sumidero consulta la caja en cada escritura.
 *
 * @param {object} args
 * @param {{write: Function}} args.stdout
 * @param {{write: Function}} args.stderr
 * @param {{value: string|null}} args.refSecreto
 * @param {boolean} args.color
 */
function crearSalida({ stdout, stderr, refSecreto, color }) {
    let contaminado = false;

    // Longitud mínima para el chequeo de contención. Por debajo de esto la
    // comparación sería ruido: un secreto de 3 caracteres aparece por azar en
    // cualquier mensaje y el guardián se volvería un generador de falsos
    // positivos. Un secreto tan corto es, además, un problema aparte.
    const MIN_CHEQUEO = 4;

    function seguro(texto) {
        const secreto = refSecreto.value;
        if (typeof secreto !== 'string' || secreto.length < MIN_CHEQUEO) return texto;
        // Se compara contra el texto YA sin ANSI: un color intercalado no puede
        // usarse para colar el valor partido en dos.
        if (!texto.replace(ANSI_RE, '').includes(secreto)) return texto;
        contaminado = true;
        return 'vault-provision: se suprimió un mensaje que contenía el valor '
            + '(defecto interno). No se filtró nada; revisar el reporte del incidente.\n';
    }

    function escribir(destino, texto) {
        destino.write(seguro(texto));
    }

    return {
        out: (t) => escribir(stdout, t),
        err: (t) => escribir(stderr, t),
        // El color SÓLO agrega secuencias alrededor del mismo texto (A05): la
        // salida sin color y la salida con color, despojada de ANSI, son
        // idénticas byte a byte.
        tinte: (codigo, texto) => (color ? `\x1B[${codigo}m${texto}\x1B[0m` : texto),
        fueContaminado: () => contaminado,
    };
}

// -----------------------------------------------------------------------------
// Parser de argumentos
// -----------------------------------------------------------------------------

/**
 * Parser propio y fail-closed: sin dependencias, sin flags implícitas y sin
 * posicionales. Todo lo que no está en la tabla es un error, no un dato que se
 * ignora en silencio.
 *
 * NO lee `env` para NADA que decida un permiso. `--yes` sale exclusivamente de
 * acá (A07); `env` sólo aporta valores de configuración no sensibles
 * (`VAULT_PROVISION_CMK` / `VAULT_PROVISION_PRINCIPAL`) y jamás el valor.
 */
function parsearArgs(argv, env = {}) {
    const opts = {
        tier: null, scope: null, profile: null, cmk: null, principal: null,
        stdin: false, yes: false, color: true, help: false,
    };

    for (const crudo of argv) {
        if (crudo === '--help' || crudo === '-h') { opts.help = true; continue; }
        if (crudo === '--stdin') { opts.stdin = true; continue; }
        if (crudo === '--yes') { opts.yes = true; continue; }
        if (crudo === '--no-color') { opts.color = false; continue; }

        if (!crudo.startsWith('--')) {
            throw new CliError(EXIT.USAGE,
                'no admite argumentos posicionales: todo se declara con --clave=valor. '
                + 'El VALOR del secreto no se pasa por argumento (ver --help)');
        }

        const sep = crudo.indexOf('=');
        // Se nombra sólo la CLAVE, nunca lo que venía después del `=`: si el
        // operador tipeó `--value=<secreto>`, el mensaje no puede repetirlo.
        const clave = (sep === -1 ? crudo.slice(2) : crudo.slice(2, sep)).toLowerCase();

        if (FLAGS_PROHIBIDAS.includes(clave)) {
            throw new CliError(EXIT.USAGE,
                `\`--${clave}\` no existe y no va a existir: un valor pasado por argumento `
                + 'queda en la tabla de procesos, en el historial del shell y en el log de '
                + 'auditoría del sistema operativo. Se ingresa por terminal (sin eco) o por '
                + 'stdin con `--stdin`. Si ya lo tipeaste, tratá ese secreto como '
                + 'comprometido y rotalo en origen');
        }
        if (sep === -1) {
            throw new CliError(EXIT.USAGE,
                `\`--${clave}\` requiere la forma \`--${clave}=<valor>\``);
        }

        const valor = crudo.slice(sep + 1);
        switch (clave) {
            case 'tier': opts.tier = valor; break;
            case 'scope': opts.scope = valor; break;
            case 'profile': opts.profile = valor; break;
            case 'cmk': opts.cmk = valor; break;
            case 'principal': opts.principal = valor; break;
            default:
                throw new CliError(EXIT.USAGE, `opción desconocida \`--${clave}\` (ver --help)`);
        }
    }

    if (opts.help) return opts;

    // Fallback de entorno SÓLO para los dos datos de configuración estables y
    // no secretos. Nunca para `--profile` (la identidad se declara en cada
    // invocación) y nunca para `--yes` (sería una autorización ambiental).
    if (opts.cmk == null && typeof env.VAULT_PROVISION_CMK === 'string') {
        opts.cmk = env.VAULT_PROVISION_CMK;
    }
    if (opts.principal == null && typeof env.VAULT_PROVISION_PRINCIPAL === 'string') {
        opts.principal = env.VAULT_PROVISION_PRINCIPAL;
    }

    if (!TIERS_CLI.includes(opts.tier)) {
        throw new CliError(EXIT.USAGE,
            `\`--tier\` debe ser uno de ${TIERS_CLI.join('|')}. El tier \`rotating\` vive en `
            + 'Secrets Manager y no se aprovisiona con esta herramienta');
    }
    // El nombre lógico NO se valida con un regex propio (eso lo hace
    // `validateVaultNamespace`); acá sólo se exige que exista, para poder dar un
    // error de USO en vez de uno de configuración.
    if (typeof opts.scope !== 'string' || opts.scope === '') {
        throw new CliError(EXIT.USAGE, '`--scope` es obligatorio: es el nombre lógico del secreto');
    }
    if (typeof opts.profile !== 'string' || !PERFIL_RE.test(opts.profile)) {
        throw new CliError(EXIT.USAGE,
            '`--profile` es obligatorio y debe ser un nombre de perfil AWS válido. Es '
            + 'explícito a propósito: sin él se usaría la cadena de credenciales por '
            + 'defecto, que en esta máquina es la identidad READ-ONLY del runtime');
    }
    if (typeof opts.cmk !== 'string' || !CMK_RE.test(opts.cmk)) {
        throw new CliError(EXIT.USAGE,
            '`--cmk` es obligatorio (o `VAULT_PROVISION_CMK`): sin CMK explícita no se '
            + 'escribe, porque la clave administrada por defecto de AWS no es una CMK '
            + 'del proyecto');
    }
    if (typeof opts.principal !== 'string' || !ARN_RE.test(opts.principal)) {
        throw new CliError(EXIT.USAGE,
            '`--principal` es obligatorio (o `VAULT_PROVISION_PRINCIPAL`) y debe ser un ARN: '
            + 'es el principal de provisión contra el que se compara la identidad efectiva');
    }
    return opts;
}

// -----------------------------------------------------------------------------
// Lectura del valor
// -----------------------------------------------------------------------------

/**
 * Restaura el eco de la terminal. ÚNICO lugar donde se apaga el modo crudo.
 *
 * Lo llaman el camino feliz, el de error, el `finally` de `run()` y los
 * handlers de señal: si cada uno tuviera su propia versión, alcanzaría con que
 * una se olvidara del `try/catch` para dejar la terminal del operador muda.
 * Es idempotente y nunca lanza — fallar restaurando no puede ser peor que el
 * problema que se estaba manejando.
 *
 * @returns {boolean} si efectivamente tocó la terminal (para los tests)
 */
function restaurarEco(stdin) {
    try {
        if (stdin?.isTTY === true && typeof stdin.setRawMode === 'function') {
            stdin.setRawMode(false);
            return true;
        }
    } catch { /* la terminal ya no está */ }
    return false;
}

/**
 * Valida el valor recién leído. Corre SIEMPRE antes de construir el
 * provisionador, así que ningún valor inválido llega a producir tráfico (A04).
 *
 * Ningún mensaje de acá incluye el valor, un fragmento ni su longitud exacta
 * cuando esa longitud sería informativa: el tope es público (está en `--help`),
 * así que decir "excede N bytes" no agrega información que un atacante no tenga.
 */
function validarValor(valor) {
    if (typeof valor !== 'string' || valor === '') {
        throw new CliError(EXIT.INPUT, 'el valor está vacío: no se escribe un secreto vacío');
    }
    if (valor.trim() === '') {
        throw new CliError(EXIT.INPUT,
            'el valor es sólo espacios en blanco: casi siempre es un pipe que no produjo '
            + 'nada. No se escribió nada');
    }
    const bytes = Buffer.byteLength(valor, 'utf8');
    if (bytes > MAX_VALUE_BYTES) {
        throw new CliError(EXIT.INPUT,
            `el valor excede ${MAX_VALUE_BYTES} bytes, el máximo de un parámetro SSM Standard. `
            + 'Se rechaza acá, sin enviarlo a AWS');
    }
    // Un control de terminal embebido casi siempre es un copiar/pegar que se
    // llevó basura. Se detecta antes de escribirlo para siempre en el vault.
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(valor)) {
        throw new CliError(EXIT.INPUT,
            'el valor contiene caracteres de control no imprimibles: casi siempre es un '
            + 'pegado que arrastró basura. No se escribió nada');
    }
}

/**
 * Lee el valor de stdin (modo no interactivo).
 *
 * Se descarta UN salto de línea final — y sólo uno — porque es el artefacto que
 * agregan `echo`, los here-docs y la mayoría de los gestores de contraseñas. Un
 * `trim()` completo, en cambio, corrompería un secreto cuyos espacios sean
 * significativos.
 */
function leerDeStdin(stdin) {
    return new Promise((resolve, reject) => {
        if (stdin == null || typeof stdin.on !== 'function') {
            reject(new CliError(EXIT.INPUT, 'no hay stdin disponible para leer el valor'));
            return;
        }
        const trozos = [];
        let bytes = 0;
        let terminado = false;

        const fin = (fn) => (arg) => { if (!terminado) { terminado = true; fn(arg); } };
        const ok = fin(resolve);
        const mal = fin(reject);

        stdin.on('data', (t) => {
            bytes += t.length;
            // Corte temprano: no se acumula en memoria un stream arbitrario sólo
            // para después medirlo. El tope real se vuelve a comprobar en
            // `validarValor` sobre la cadena decodificada.
            if (bytes > MAX_VALUE_BYTES * 4) {
                trozos.length = 0;
                mal(new CliError(EXIT.INPUT,
                    `stdin superó ampliamente los ${MAX_VALUE_BYTES} bytes admitidos: se cortó `
                    + 'la lectura sin enviar nada a AWS'));
                return;
            }
            trozos.push(Buffer.from(t));
        });
        stdin.on('error', () => mal(new CliError(EXIT.INPUT, 'stdin falló durante la lectura')));
        stdin.on('end', () => {
            const texto = Buffer.concat(trozos).toString('utf8');
            ok(texto.replace(/\r?\n$/, ''));
        });
        if (typeof stdin.resume === 'function') stdin.resume();
    });
}

/**
 * Lee el valor por TTY con el eco DESHABILITADO.
 *
 * Se trabaja en modo crudo y byte a byte porque `readline` echa lo que recibe:
 * no hay forma de pedirle "leé una línea pero no la muestres". A cambio, hay que
 * manejar a mano el fin de línea, el borrado y el `Ctrl-C`.
 *
 * La restauración del modo va en `finally` Y en el handler de señales: si el
 * proceso muere con el eco apagado, la terminal del operador queda inservible.
 */
function leerDeTty({ stdin, salida, etiqueta, timeoutMs }) {
    return new Promise((resolve, reject) => {
        if (!stdin || stdin.isTTY !== true || typeof stdin.setRawMode !== 'function') {
            reject(new CliError(EXIT.INPUT,
                'no hay terminal interactiva para pedir el valor sin eco. En un contexto no '
                + 'interactivo hay que usar `--stdin`; el valor NUNCA se pasa por argumento'));
            return;
        }

        salida.out(`${etiqueta}: `);

        const buffer = [];
        let cerrado = false;
        let temporizador = null;

        // Restauración idempotente: se llama desde el camino feliz, desde el
        // error y desde el timeout, y las tres veces tiene que ser inocua.
        const restaurar = () => {
            if (cerrado) return;
            cerrado = true;
            if (temporizador) clearTimeout(temporizador);
            stdin.removeListener('data', alRecibir);
            restaurarEco(stdin);
            if (typeof stdin.pause === 'function') stdin.pause();
            salida.out('\n');
        };

        const fallar = (err) => { restaurar(); reject(err); };

        function alRecibir(trozo) {
            const bytes = Buffer.from(trozo);
            for (const byte of bytes) {
                if (byte === 0x03) {                       // Ctrl-C
                    fallar(new CliError(EXIT.CANCELLED,
                        'lectura cancelada por el operador. No se escribió nada'));
                    return;
                }
                if (byte === 0x04 && buffer.length === 0) { // Ctrl-D en vacío
                    fallar(new CliError(EXIT.INPUT,
                        'la terminal cerró la entrada sin valor. No se escribió nada'));
                    return;
                }
                if (byte === 0x0d || byte === 0x0a) {       // Enter
                    const texto = Buffer.from(buffer).toString('utf8');
                    buffer.length = 0;                      // el buffer no sobrevive al prompt
                    restaurar();
                    resolve(texto);
                    return;
                }
                if (byte === 0x7f || byte === 0x08) {       // Backspace
                    buffer.pop();
                    continue;
                }
                buffer.push(byte);
            }
        }

        temporizador = setTimeout(() => {
            buffer.length = 0;
            fallar(new CliError(EXIT.CANCELLED,
                'se agotó el tiempo de espera de la entrada. No se escribió nada'));
        }, timeoutMs);
        // Un timer pendiente no debe mantener vivo el proceso por sí solo.
        if (typeof temporizador.unref === 'function') temporizador.unref();

        try {
            stdin.setRawMode(true);
        } catch {
            fallar(new CliError(EXIT.INPUT, 'no se pudo deshabilitar el eco de la terminal'));
            return;
        }
        if (typeof stdin.resume === 'function') stdin.resume();
        stdin.on('data', alRecibir);
    });
}

/**
 * Lee una línea CON eco. Se usa sólo para la confirmación de sobrescritura, que
 * no es secreta: mostrarla es deseable, así el operador ve qué tipeó.
 */
function leerLineaTty({ stdin, timeoutMs }) {
    return new Promise((resolve, reject) => {
        if (!stdin || stdin.isTTY !== true) {
            reject(new CliError(EXIT.CANCELLED,
                'no hay terminal para confirmar la sobrescritura y no se pasó `--yes`. '
                + 'No se escribió nada'));
            return;
        }
        const trozos = [];
        let cerrado = false;
        let temporizador = null;

        const cerrar = () => {
            if (cerrado) return;
            cerrado = true;
            if (temporizador) clearTimeout(temporizador);
            stdin.removeListener('data', alRecibir);
            stdin.removeListener('end', alFin);
            if (typeof stdin.pause === 'function') stdin.pause();
        };

        function alFin() {
            cerrar();
            reject(new CliError(EXIT.CANCELLED,
                'la entrada terminó sin confirmación (EOF). No se escribió nada'));
        }

        function alRecibir(trozo) {
            const texto = String(trozo);
            trozos.push(texto);
            if (!/[\r\n]/.test(texto)) return;
            cerrar();
            resolve(trozos.join('').split(/[\r\n]/)[0]);
        }

        temporizador = setTimeout(() => {
            cerrar();
            reject(new CliError(EXIT.CANCELLED,
                'se agotó el tiempo de espera de la confirmación. No se escribió nada'));
        }, timeoutMs);
        if (typeof temporizador.unref === 'function') temporizador.unref();

        // Modo línea (no crudo): acá el eco es intencional.
        try { if (typeof stdin.setRawMode === 'function') stdin.setRawMode(false); } catch { /* noop */ }
        if (typeof stdin.setEncoding === 'function') stdin.setEncoding('utf8');
        if (typeof stdin.resume === 'function') stdin.resume();
        stdin.on('data', alRecibir);
        stdin.on('end', alFin);
    });
}

// -----------------------------------------------------------------------------
// Composition root real (AWS). Todo perezoso.
// -----------------------------------------------------------------------------

/**
 * Identidad efectiva vía `aws sts get-caller-identity`.
 *
 * POR QUÉ LA AWS CLI Y NO EL SDK: el camino de lectura del vault
 * (`secret-vault.js`) ya resuelve contra la AWS CLI, y usar `@aws-sdk/client-sts`
 * agregaría una dependencia nueva sólo para una llamada. Se invoca con
 * `execFile` y una lista de argumentos ESTRUCTURADA — nunca `exec`, nunca una
 * cadena interpolada — así que el perfil (ya validado contra `PERFIL_RE`) no
 * puede escapar a un shell (A03).
 *
 * El `stdout` se parsea con `JSON.parse` y se proyecta a un solo campo: `Arn`.
 * Ni el `Account`, ni el `UserId`, ni el `stderr` del proceso salen de acá.
 */
function crearIdentidadAwsCli({ profile, region }) {
    return {
        async resolveArn() {
            const { execFile } = require('node:child_process');
            const args = [
                'sts', 'get-caller-identity',
                '--output', 'json',
                '--profile', profile,
                '--region', region,
            ];
            const salida = await new Promise((resolve, reject) => {
                execFile('aws', args, { timeout: 30_000, maxBuffer: 1024 * 1024 },
                    (err, stdout) => {
                        // El error de la CLI se descarta ENTERO: su stderr puede
                        // traer contexto de la sesión que no corresponde propagar.
                        if (err) reject(new Error('sts'));
                        else resolve(String(stdout));
                    });
            });
            let json;
            try { json = JSON.parse(salida); } catch { throw new Error('sts'); }
            return typeof json?.Arn === 'string' ? json.Arn : '';
        },
    };
}

/** Port SSM real. El SDK se carga acá adentro para no exigirlo en los tests. */
function crearSsmAws({ profile, region }) {
    // Una corrida real en un checkout sin `node_modules` reportaba esto como
    // "falla no prevista" (código 7), que no le dice al operador qué hacer. Un
    // módulo ausente es un problema de ENTORNO y tiene remediación concreta.
    let SSMClient;
    let fromIni;
    try {
        ({ SSMClient } = require('@aws-sdk/client-ssm'));
        ({ fromIni } = require('@aws-sdk/credential-provider-ini'));
    } catch {
        throw new CliError(EXIT.CONFIG,
            'faltan las dependencias de AWS en este checkout. Remediación: `npm install` '
            + 'en la raíz del repo antes de aprovisionar');
    }
    // Credenciales EXPLÍCITAS del perfil declarado. Sin esto el SDK caería a la
    // cadena por defecto, que en esta máquina es la identidad read-only del
    // runtime: exactamente lo que la CLI existe para impedir (A01).
    const client = new SSMClient({ region, credentials: fromIni({ profile }) });
    return createAwsSsmProvisionDriver({ client });
}

/**
 * Config del vault.
 *
 * Se resuelve por `lib/config-resolver`, que es el ÚNICO lector de
 * `config.yaml` del pipeline (lo verifica `config-resolver-guard.test.js`). Leer
 * el YAML acá con `js-yaml` propio compilaría igual, pero se saltearía la
 * validación de schema, la partición kernel/producto y los overrides de entorno:
 * la CLI resolvería un namespace distinto del que resuelve el runtime que
 * después LEE ese mismo secreto, y el desvío recién se notaría en producción.
 *
 * La carga es perezosa para que la suite corra sin tocar el config real.
 */
function cargarConfigVault() {
    let doc;
    try {
        doc = require('../lib/config-resolver').resolve({
            pipelineDir: path.resolve(__dirname, '..'),
        });
    } catch {
        // El error del resolver puede nombrar rutas y claves del host; se
        // descarta entero y se emite una remediación propia.
        throw new CliError(EXIT.CONFIG,
            'no se pudo resolver la configuración del pipeline para obtener el namespace '
            + 'del vault. Verificar `.pipeline/config.yaml` con `node .pipeline/lib/config-resolver.js`');
    }
    const vault = doc?.vault || {};
    return {
        prefix: vault.prefix,
        projectId: vault.projectId,
        hostId: vault.hostId,
        // El vault REUSA `kernel.region` a propósito: dos regiones que pueden
        // divergir es un modo de falla que no aporta nada.
        region: doc?.kernel?.region,
    };
}

// -----------------------------------------------------------------------------
// Sanitización única de fallas (A09)
// -----------------------------------------------------------------------------

// Mapa de código de provisión -> código de salida de la CLI. Traducir por tabla
// (y no por `if` desperdigados) mantiene los códigos estables y auditables.
const EXIT_POR_CODIGO = Object.freeze({
    [VAULT_PROVISION_ERROR_CODES.PAYLOAD_INVALID]: EXIT.USAGE,
    [VAULT_PROVISION_ERROR_CODES.VALUE_INVALID]: EXIT.INPUT,
    [VAULT_PROVISION_ERROR_CODES.TIER_UNSUPPORTED]: EXIT.CONFIG,
    [VAULT_PROVISION_ERROR_CODES.CMK_INVALID]: EXIT.CONFIG,
    [VAULT_PROVISION_ERROR_CODES.IDENTITY_DENIED]: EXIT.IDENTITY,
    [VAULT_PROVISION_ERROR_CODES.OVERWRITE_DENIED]: EXIT.CANCELLED,
    [VAULT_PROVISION_ERROR_CODES.VERIFY_FAILED]: EXIT.BACKEND,
    [VAULT_PROVISION_ERROR_CODES.BACKEND]: EXIT.BACKEND,
});

/**
 * ÚNICO traductor de excepción a `{ exit, mensaje }`. Todo camino de falla del
 * proceso — incluidos los handlers globales — pasa por acá.
 *
 * Sólo se reusa el `message` de los errores cuyo texto está escrito a mano en
 * este repositorio (`CliError`, `VaultProvisionError`, `VaultConfigError`):
 * están auditados y no interpolan el valor. Para cualquier otra excepción se
 * emite un genérico y se descartan `message`, `stack` y `cause` — un error de
 * una capa desconocida puede arrastrar el request, y el request lleva el valor.
 */
function sanitizarFalla(err) {
    if (err instanceof CliError) {
        return { exit: err.exit, mensaje: err.message };
    }
    const nombre = err?.name;
    const codigo = err?.code;

    if (nombre === 'VaultProvisionError' && typeof codigo === 'string') {
        return {
            exit: EXIT_POR_CODIGO[codigo] ?? EXIT.BACKEND,
            mensaje: String(err.message),
        };
    }
    // `VaultConfigError` no se exporta como clase (se discrimina por `name`,
    // igual que hace `secret-vault.js` internamente). Su mensaje nombra la CLAVE
    // de configuración en falta, nunca el valor del secreto: el secreto no pasa
    // por `validateVaultNamespace`.
    if (nombre === 'VaultConfigError') {
        return { exit: EXIT.CONFIG, mensaje: String(err.message) };
    }
    return {
        exit: EXIT.INTERNAL,
        // Sin el prefijo `vault-provision:`: lo agrega el emisor. Duplicarlo
        // acá produce el "vault-provision: vault-provision: ..." que ya se vio
        // en una corrida real.
        mensaje: 'falla no prevista. El detalle se omite a propósito porque un error de '
            + 'una capa desconocida puede arrastrar el valor. Reintentar; si persiste, '
            + 'reportar el código de salida y el momento.',
    };
}

// -----------------------------------------------------------------------------
// Ejecución
// -----------------------------------------------------------------------------

/**
 * Cuerpo de la CLI. Devuelve el código de salida; NO llama a `process.exit`.
 *
 * Todo lo externo entra por `deps` para que la suite ejercite el camino REAL
 * (parser, lectura, capability, provisionador de #5465 y sanitización) contra
 * puertos falsos, en vez de probar un doble de la CLI entera.
 *
 * @param {object} args
 * @param {string[]} args.argv
 * @param {object}  [args.env]
 * @param {object}  args.stdout / args.stderr / args.stdin
 * @param {object}  [args.deps]
 *   - `cargarConfig()`          -> `{ prefix, projectId, hostId, region }`
 *   - `crearSsm({profile,region})`      -> port `ssm` de #5465
 *   - `crearIdentidad({profile,region})`-> `{ resolveArn() }`
 *   - `timeoutMs`               -> tope de las lecturas interactivas
 */
async function run({ argv = [], env = {}, stdout, stderr, stdin, deps = {} } = {}) {
    // La caja se crea ANTES que nada y se cablea al sumidero: desde la primera
    // línea impresa hasta la última, la protección está activa.
    const refSecreto = { value: null };
    let salida = crearSalida({ stdout, stderr, refSecreto, color: false });

    // Se declara acá arriba (y no junto a la capability) porque el `catch` de
    // abajo lo necesita para reemplazar el mensaje genérico del provisionador
    // por el motivo real de la cancelación.
    let motivoCancelacion = null;

    try {
        const opts = parsearArgs(argv, env);

        // El color se decide recién con las opciones ya parseadas; hasta acá se
        // escribió en crudo, que es lo correcto para un error de uso.
        const usarColor = opts.color && stdout?.isTTY === true && env.NO_COLOR == null;
        salida = crearSalida({ stdout, stderr, refSecreto, color: usarColor });

        if (opts.help) {
            salida.out(AYUDA);
            return EXIT.OK;
        }

        const cargarConfig = deps.cargarConfig || cargarConfigVault;
        const crearSsm = deps.crearSsm || crearSsmAws;
        const crearIdentidad = deps.crearIdentidad || crearIdentidadAwsCli;
        const timeoutMs = typeof deps.timeoutMs === 'number' ? deps.timeoutMs : TIMEOUT_INTERACTIVO_MS;

        const cfg = cargarConfig();
        const region = cfg?.region;
        if (typeof region !== 'string' || region === '') {
            throw new CliError(EXIT.CONFIG,
                'falta `kernel.region` en `.pipeline/config.yaml`: la región es explícita');
        }

        // --- Lectura del valor (antes de construir nada que hable con AWS) ---
        const valor = opts.stdin
            ? await leerDeStdin(stdin)
            : await leerDeTty({
                stdin, salida, timeoutMs,
                etiqueta: `Valor para \`${opts.scope}\` (no se muestra)`,
            });

        validarValor(valor);
        // Recién ahora el guardián del sumidero tiene con qué comparar.
        refSecreto.value = valor;

        // --- Capability de sobrescritura (ver "Capability de sobrescritura") ---
        //
        // POR QUÉ DEVUELVE `false` EN VEZ DE LANZAR: el provisionador de #5465
        // envuelve cualquier excepción de `authorize()` en un `OVERWRITE_DENIED`
        // genérico ("la capability falló al evaluar"). Si acá se lanzara, el
        // operador perdería el motivo REAL — si se agotó el tiempo, si escribió
        // otra cosa, o si no había terminal. Devolver `false` produce el mismo
        // rechazo fail-closed y deja el motivo preciso en `motivoCancelacion`,
        // que el `catch` de abajo usa para reemplazar el mensaje genérico.
        let confirmado = false;

        const overwriteAuthority = {
            async authorize({ path: pathReal }) {
                if (opts.yes) {
                    // `--yes` vino de argv y de ningún otro lado. Se narra para
                    // que quede en el registro de la sesión del operador.
                    salida.err(`vault-provision: sobrescritura autorizada por \`--yes\` sobre ${pathReal}\n`);
                    confirmado = true;
                    return true;
                }
                salida.err(
                    `\n${salida.tinte('33', 'ATENCIÓN')}: \`${pathReal}\` ya existe con un valor DISTINTO.\n`
                    + 'Sobrescribir crea una versión nueva; la anterior deja de servirse.\n'
                    + `Escribí \`${CONFIRMACION}\` para confirmar, o cualquier otra cosa para abortar: `,
                );
                let respuesta;
                try {
                    respuesta = await leerLineaTty({ stdin, timeoutMs });
                } catch (err) {
                    motivoCancelacion = err instanceof CliError
                        ? err.message
                        : 'no se pudo leer la confirmación. No se escribió nada';
                    return false;
                }
                if (String(respuesta).trim() !== CONFIRMACION) {
                    motivoCancelacion = `la confirmación no coincide exactamente con \`${CONFIRMACION}\`. `
                        + 'No se escribió nada';
                    return false;
                }
                confirmado = true;
                return true;
            },
        };

        // --- Provisionador ----------------------------------------------------
        const provisioner = createVaultProvisioner({
            ssm: crearSsm({ profile: opts.profile, region }),
            identity: crearIdentidad({ profile: opts.profile, region }),
            overwriteAuthority,
            config: {
                prefix: cfg.prefix,
                projectId: cfg.projectId,
                hostId: cfg.hostId,
                kmsKeyId: opts.cmk,
                provisioningPrincipal: opts.principal,
            },
        });

        const resultado = await provisioner.provisionSecret({
            tier: opts.tier,
            scope: opts.scope,
            value: valor,
        });

        // --- Reporte por ALLOWLIST -------------------------------------------
        // Campo por campo, del resultado ya proyectado por #5465. Nunca un
        // spread, nunca la respuesta de AWS.
        const verde = resultado.estado === VAULT_PROVISION_STATES.UNCHANGED ? '36' : '32';
        salida.out(
            `nombre lógico : ${resultado.scope}\n`
            + `tier          : ${resultado.tier}\n`
            + 'backend       : ssm\n'
            + `path          : ${resultado.path}\n`
            + `estado        : ${salida.tinte(verde, resultado.estado)}\n`
            + `tipo          : ${resultado.metadata.Type}\n`
            + `versión       : ${resultado.metadata.Version}\n`,
        );
        if (resultado.estado === VAULT_PROVISION_STATES.OVERWRITTEN && confirmado) {
            salida.err('vault-provision: la versión anterior dejó de servirse.\n');
        }

        return salida.fueContaminado() ? EXIT.INTERNAL : EXIT.OK;
    } catch (err) {
        const { exit, mensaje } = sanitizarFalla(err);
        // El provisionador reporta toda denegación de sobrescritura con el mismo
        // texto genérico. Si la capability sabe POR QUÉ dijo que no (tiempo
        // agotado, respuesta distinta, sin terminal), ese motivo es el útil.
        const texto = (exit === EXIT.CANCELLED && motivoCancelacion) ? motivoCancelacion : mensaje;
        salida.err(`${salida.tinte('31', 'vault-provision')}: ${texto}\n`);
        return salida.fueContaminado() ? EXIT.INTERNAL : exit;
    } finally {
        // El valor deja de estar referenciado en cuanto termina la operación.
        // No borra la copia que el motor pueda tener viva, pero cierra la
        // ventana obvia: un `--inspect` posterior no lo encuentra en el scope.
        refSecreto.value = null;
        // Si algo dejó el eco apagado por un camino no previsto, se restaura.
        restaurarEco(stdin);
    }
}

// -----------------------------------------------------------------------------
// Entrypoint
// -----------------------------------------------------------------------------

/**
 * Instala los handlers globales. Existen para que una excepción escapada no
 * imprima un stack — que es el vector de fuga más probable de todo el archivo —
 * y para que una señal no deje la terminal con el eco apagado.
 */
function instalarHandlers({ stdin, stderr, proc = process }) {
    // Mismo sumidero, sin secreto en la caja: para cuando esto corre, el valor
    // ya no está referenciado. El mensaje es genérico por construcción.
    const emitir = (mensaje) => {
        restaurarEco(stdin);
        try { stderr.write(`vault-provision: ${mensaje}\n`); } catch { /* noop */ }
    };

    proc.on('uncaughtException', () => {
        // El error NO se inspecciona: ni `message`, ni `stack`, ni `cause`.
        emitir('excepción no capturada; el detalle se omite para no arrastrar el valor');
        proc.exit(EXIT.INTERNAL);
    });
    proc.on('unhandledRejection', () => {
        emitir('promesa rechazada sin manejar; el detalle se omite para no arrastrar el valor');
        proc.exit(EXIT.INTERNAL);
    });
    for (const senal of SENALES) {
        proc.on(senal, () => {
            emitir(`interrumpido por ${senal}. No se escribió nada`);
            proc.exit(EXIT.CANCELLED);
        });
    }
}

if (require.main === module) {
    instalarHandlers({ stdin: process.stdin, stderr: process.stderr });
    run({
        argv: process.argv.slice(2),
        env: process.env,
        stdout: process.stdout,
        stderr: process.stderr,
        stdin: process.stdin,
    }).then((codigo) => { process.exitCode = codigo; })
        .catch(() => { process.exitCode = EXIT.INTERNAL; });
}

module.exports = {
    run,
    parsearArgs,
    validarValor,
    sanitizarFalla,
    crearSalida,
    restaurarEco,
    instalarHandlers,
    CliError,
    EXIT,
    TIERS_CLI,
    SENALES,
    MAX_VALUE_BYTES,
    CONFIRMACION,
    AYUDA,
};
