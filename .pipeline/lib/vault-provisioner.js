// =============================================================================
// vault-provisioner.js — port de PROVISIÓN del vault (#5465, 2/3 de #5425)
// =============================================================================
//
// QUÉ ES: el port de ESCRITURA sobre SSM. Aprovisiona `SecureString` con CMK
// explícita, de forma idempotente, sin filtrar el valor por ninguna superficie.
//
// POR QUÉ VIVE FUERA DE `secret-vault.js`: ese módulo es el runtime de LECTURA.
// Su allowlist (`VAULT_READONLY_COMMANDS`) está congelada en tres verbos de
// lectura y la policy IAM del runtime tiene un `Deny` explícito sobre
// `ssm:PutParameter` (`docs/pipeline/vault-iam-policy.json`). Escribir es otro
// rol, otra identidad y otro proceso: mezclarlo acá ampliaría los privilegios
// del runtime, que es exactamente lo que el split viene a evitar.
//
// LO QUE ESTE MÓDULO **NO** HACE (a propósito):
//   - NO valida namespaces por su cuenta. El nombre sale EXCLUSIVAMENTE de
//     `validateVaultNamespace` (#5464): no hay regex, ni concatenación de path,
//     ni reglas propias acá. Si las hubiera, serían la copia que el split evita.
//   - NO acepta la CMK ni la autorización de sobrescritura dentro del payload
//     que trae el secreto. Ambas vienen de config/capability inyectadas por el
//     composition root (ver "Modelo de autorización").
//   - NO devuelve, loguea ni serializa el valor, su hash, la respuesta cruda de
//     AWS, `$metadata`, `cause` ni el stack del SDK (ver "Frontera de fuga").
//   - NO importa `@aws-sdk/client-ssm` en el tope. El SDK se carga en forma
//     perezosa y sólo dentro del adapter real, para que los tests corran contra
//     el fake sin depender de que el paquete esté instalado.
//
// MODELO DE AUTORIZACIÓN (REQ-SEC-5465-1 / -2)
//   La autorización NO es un booleano del request. Un `allowOverwrite: true`
//   viajando junto al secreto es autoautorización: el caller se firma el propio
//   permiso. Acá son dos colaboradores separados e inyectados:
//     - `identity.resolveArn()`  — principal EFECTIVO, de fuente confiable
//       (STS). Se compara contra `config.provisioningPrincipal`. Ausente, no
//       verificable o distinto ⇒ falla ANTES de cualquier llamada a SSM.
//     - `overwriteAuthority.authorize({ path })` — capability construida por el
//       composition root del operador. Sólo `true` estricto habilita sobrescribir.
//   Además el payload es CERRADO: sólo admite `tier`, `scope` y `value`. Una
//   clave de más (`kmsKeyId`, `allowOverwrite`, `principal`) es rechazo, no un
//   campo ignorado en silencio.
//
// FRONTERA DE FUGA (REQ-SEC-5465-5)
//   Todo lo que sale de acá se construye por ALLOWLIST, nunca por omisión:
//   `{ estado, tier, scope, path, metadata: { Type, Version } }`. Los errores
//   son `VaultProvisionError` con un `code` estable y un mensaje redactado a
//   mano; jamás se adjunta `cause` ni se reenvía el error del SDK, porque el
//   error de AWS puede arrastrar el request completo — y el request lleva el
//   valor.
//
// IDEMPOTENCIA Y CONCURRENCIA (REQ-SEC-5465-4)
//   SSM `PutParameter` NO ofrece compare-and-swap por versión: la secuencia
//   `Get -> comparar -> Put` es idempotente para ejecución SERIAL, y nada más.
//   Este módulo serializa por nombre DENTRO del proceso (ver `serializarPorPath`)
//   para que dos llamadas concurrentes no se pisen. Entre PROCESOS distintos no
//   hay exclusión posible con la API de SSM: el contrato no promete idempotencia
//   fuerte y el composition root debe serializar si abre varios provisionadores.
// =============================================================================
'use strict';

const { validateVaultNamespace } = require('./secret-vault');

// -----------------------------------------------------------------------------
// Contrato público
// -----------------------------------------------------------------------------

/**
 * Estados terminales de una provisión. Son los ÚNICOS valores que puede tomar
 * `estado` en el resultado.
 */
const VAULT_PROVISION_STATES = Object.freeze({
    CREATED: 'creado',
    UNCHANGED: 'sin cambios',
    OVERWRITTEN: 'sobrescrito',
});

/**
 * Códigos de falla. Se discriminan por `code` (no por clase) siguiendo la misma
 * convención que `VaultConfigError` en `secret-vault.js`.
 */
const VAULT_PROVISION_ERROR_CODES = Object.freeze({
    PAYLOAD_INVALID: 'VAULT_PROVISION_PAYLOAD_INVALID',
    VALUE_INVALID: 'VAULT_PROVISION_VALUE_INVALID',
    TIER_UNSUPPORTED: 'VAULT_PROVISION_TIER_UNSUPPORTED',
    CMK_INVALID: 'VAULT_PROVISION_CMK_INVALID',
    IDENTITY_DENIED: 'VAULT_PROVISION_IDENTITY_DENIED',
    OVERWRITE_DENIED: 'VAULT_PROVISION_OVERWRITE_DENIED',
    VERIFY_FAILED: 'VAULT_PROVISION_VERIFY_FAILED',
    BACKEND: 'VAULT_PROVISION_BACKEND',
});

/**
 * Falla terminal de provisión. El mensaje se escribe a mano y describe la
 * REMEDIACIÓN; nunca interpola el valor, el hash ni la respuesta de AWS.
 *
 * No lleva `cause` deliberadamente: encadenar el error del SDK arrastraría el
 * request (y con él, el secreto) a cualquier `util.inspect` o logger.
 */
class VaultProvisionError extends Error {
    constructor(code, detalle) {
        super(`vault-provisioner: ${detalle}.`);
        this.name = 'VaultProvisionError';
        this.code = code;
    }
}

// Campos admitidos en el payload de provisión. Cerrado a propósito: ver
// "Modelo de autorización".
const CAMPOS_PAYLOAD = Object.freeze(['tier', 'scope', 'value']);

// El único `Type` que este port escribe. No es configurable: un `String` en
// texto plano sería el bug que todo el módulo previene.
const TIPO_SEGURO = 'SecureString';

// -----------------------------------------------------------------------------
// Provisionador
// -----------------------------------------------------------------------------

/**
 * Crea el port de provisión.
 *
 * @param {object}   deps
 * @param {object}   deps.ssm     port de escritura. Tres métodos, todos async:
 *   - `getParameter({ Name, WithDecryption })` -> `{ Value, Type, Version }`, o
 *     `null` si el parámetro NO existe. El adapter traduce `ParameterNotFound`
 *     a `null`: "no existe" es un estado del flujo, no una excepción.
 *   - `putParameter({ Name, Value, Type, KeyId, Overwrite })` -> `{ Version }`.
 *   - `getParameterMetadata({ Name })` -> `{ Type, Version }` SIN descifrar.
 * @param {object}   deps.identity            `{ resolveArn(): Promise<string> }`.
 * @param {object}   deps.overwriteAuthority  `{ authorize({ path }): Promise<boolean> }`.
 * @param {object}   deps.config
 * @param {string}   deps.config.prefix
 * @param {string}   deps.config.projectId
 * @param {string}   [deps.config.hostId]               requerido sólo en tier `host`.
 * @param {string}   deps.config.kmsKeyId               CMK permitida. Obligatoria.
 * @param {string}   deps.config.provisioningPrincipal  ARN autorizado a escribir.
 */
function createVaultProvisioner({ ssm, identity, overwriteAuthority, config } = {}) {
    assertPuerto('ssm', ssm, ['getParameter', 'putParameter', 'getParameterMetadata']);
    assertPuerto('identity', identity, ['resolveArn']);
    assertPuerto('overwriteAuthority', overwriteAuthority, ['authorize']);

    if (config == null || typeof config !== 'object') {
        throw new VaultProvisionError(VAULT_PROVISION_ERROR_CODES.PAYLOAD_INVALID,
            'requiere `config` con prefix, projectId, kmsKeyId y provisioningPrincipal');
    }

    // La CMK se fija al CONSTRUIR, no por request: así no hay forma de que
    // llegue junto al secreto (REQ-SEC-5465-3).
    const kmsKeyId = config.kmsKeyId;
    if (typeof kmsKeyId !== 'string' || kmsKeyId === '') {
        throw new VaultProvisionError(VAULT_PROVISION_ERROR_CODES.CMK_INVALID,
            'requiere `config.kmsKeyId` (CMK explícita): sin CMK no se escribe — '
            + 'la clave administrada por defecto de AWS no es una CMK del proyecto');
    }

    const provisioningPrincipal = config.provisioningPrincipal;
    if (typeof provisioningPrincipal !== 'string' || provisioningPrincipal === '') {
        throw new VaultProvisionError(VAULT_PROVISION_ERROR_CODES.IDENTITY_DENIED,
            'requiere `config.provisioningPrincipal`: el principal autorizado se '
            + 'declara en config, no se infiere del caller');
    }

    // Serialización por nombre. Ver "Idempotencia y concurrencia".
    const cadenasPorPath = new Map();

    function serializarPorPath(path, tarea) {
        const previa = cadenasPorPath.get(path) || Promise.resolve();
        // `.then(tarea, tarea)`: la tarea siguiente corre aunque la anterior
        // haya fallado — una falla no debe trabar el nombre para siempre.
        const actual = previa.then(tarea, tarea);
        // La cadena de espera nunca rechaza, si no un fallo propagaría a los
        // que esperan detrás.
        const espera = actual.then(() => {}, () => {});
        cadenasPorPath.set(path, espera);
        espera.then(() => {
            // Sólo el último de la fila limpia: si otro ya encoló, el Map debe
            // seguir apuntando a esa cadena más nueva.
            if (cadenasPorPath.get(path) === espera) cadenasPorPath.delete(path);
        });
        return actual;
    }

    /**
     * Aprovisiona un secreto. Payload CERRADO: `{ tier, scope, value }`.
     *
     * @returns {Promise<Readonly<{estado:string, tier:string, scope:string,
     *                             path:string, metadata:Readonly<{Type:string, Version:number}>}>>}
     */
    async function provisionSecret(payload) {
        // --- 1. Payload cerrado -------------------------------------------------
        if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
            throw new VaultProvisionError(VAULT_PROVISION_ERROR_CODES.PAYLOAD_INVALID,
                'el payload debe ser un objeto `{ tier, scope, value }`');
        }
        const sobrantes = Object.keys(payload).filter((k) => !CAMPOS_PAYLOAD.includes(k));
        if (sobrantes.length > 0) {
            // Nombrar las claves sobrantes es seguro: son NOMBRES de campo, no
            // valores. Y es la única forma de que el error sea accionable.
            throw new VaultProvisionError(VAULT_PROVISION_ERROR_CODES.PAYLOAD_INVALID,
                `el payload sólo admite ${CAMPOS_PAYLOAD.join(', ')} — sobran: `
                + `${sobrantes.join(', ')}. La CMK y la autorización de sobrescritura `
                + 'NO viajan con el secreto: vienen de config y de la capability inyectada');
        }

        const { tier, scope, value } = payload;

        // --- 2. Valor (sin ecos) ------------------------------------------------
        if (typeof value !== 'string' || value === '') {
            // `typeof` y nada más: describir el valor lo filtraría.
            throw new VaultProvisionError(VAULT_PROVISION_ERROR_CODES.VALUE_INVALID,
                `el valor debe ser una cadena no vacía (recibido: ${typeof value})`);
        }

        // --- 3. Nombre canónico (#5464) ----------------------------------------
        // `validateVaultNamespace` es fail-closed: si el prefijo, el namespace,
        // el tier o el nombre lógico no validan, lanza `VaultConfigError` y no
        // devuelve descriptor a medias. Se deja propagar tal cual: nombra la
        // clave de config, no el valor, y ya es accionable.
        const descriptor = validateVaultNamespace({
            prefix: config.prefix,
            projectId: config.projectId,
            hostId: config.hostId,
            scope,
            tier,
        });

        // --- 4. Tier soportado --------------------------------------------------
        // `rotating` vive en Secrets Manager, con otra API y otro ciclo de
        // rotación. Este port es SSM: fallar es más honesto que mandar un
        // `PutParameter` a un nombre que pertenece a otro servicio.
        if (descriptor.service !== 'ssm') {
            throw new VaultProvisionError(VAULT_PROVISION_ERROR_CODES.TIER_UNSUPPORTED,
                `el tier \`${descriptor.tier}\` se resuelve en \`${descriptor.service}\` y este `
                + 'port sólo aprovisiona SSM: la rotación de Secrets Manager es otro flujo');
        }

        const path = descriptor.path;

        // --- 5. Identidad efectiva (antes de TODA llamada a SSM) ----------------
        // Se resuelve ANTES de tocar la red con el secreto en mano. Cualquier
        // ambigüedad es rechazo: fail-closed.
        let arn;
        try {
            arn = await identity.resolveArn();
        } catch {
            // El error de STS se descarta entero: puede traer contexto de la
            // sesión que no corresponde propagar.
            throw new VaultProvisionError(VAULT_PROVISION_ERROR_CODES.IDENTITY_DENIED,
                'no se pudo verificar la identidad efectiva contra STS: sin principal '
                + 'verificado no se escribe');
        }
        if (typeof arn !== 'string' || arn === '') {
            throw new VaultProvisionError(VAULT_PROVISION_ERROR_CODES.IDENTITY_DENIED,
                'la identidad efectiva no es verificable (STS devolvió un principal vacío)');
        }
        if (arn !== provisioningPrincipal) {
            // NO se interpola el ARN recibido: en un runtime comprometido el
            // mensaje termina en un log compartido. Alcanza con decir que no
            // coincide y cuál es la clave de config a revisar.
            throw new VaultProvisionError(VAULT_PROVISION_ERROR_CODES.IDENTITY_DENIED,
                'la identidad efectiva no es el principal de provisión declarado en '
                + '`config.provisioningPrincipal`: el runtime read-only no escribe, '
                + 'y declararse "provisioning" no alcanza');
        }

        // --- 6. Sección serializada por nombre ---------------------------------
        return serializarPorPath(path, () => ejecutar({ descriptor, path, value }));
    }

    async function ejecutar({ descriptor, path, value }) {
        // --- Lectura de comparación -------------------------------------------
        // Se descifra SÓLO en memoria y sólo para comparar. El valor leído no
        // sale de esta función ni se persiste como hash (un hash de un secreto
        // de baja entropía es un oráculo offline).
        const actual = await conBackend('leer el parámetro',
            () => ssm.getParameter({ Name: path, WithDecryption: true }));

        if (actual != null && typeof actual !== 'object') {
            throw new VaultProvisionError(VAULT_PROVISION_ERROR_CODES.BACKEND,
                'la lectura de comparación devolvió una forma inesperada');
        }

        // Un parámetro preexistente que NO sea `SecureString` está en texto
        // plano: aunque el valor coincida, NO es "sin cambios" — hay que
        // repararlo, y reparar es sobrescribir (requiere autorización).
        const existe = actual != null;
        const esIgual = existe
            && actual.Value === value
            && actual.Type === TIPO_SEGURO;

        if (esIgual) {
            // CA: una repetición idéntica NO ejecuta `PutParameter` y NO
            // aumenta la versión. Se proyecta la metadata que ya se tenía.
            return proyectar(descriptor, path, VAULT_PROVISION_STATES.UNCHANGED, {
                Type: actual.Type,
                Version: actual.Version,
            });
        }

        // --- Autorización de sobrescritura -------------------------------------
        let estado = VAULT_PROVISION_STATES.CREATED;
        let versionPrevia = null;

        if (existe) {
            versionPrevia = actual.Version;
            let autorizado;
            try {
                autorizado = await overwriteAuthority.authorize({ path });
            } catch {
                throw new VaultProvisionError(VAULT_PROVISION_ERROR_CODES.OVERWRITE_DENIED,
                    'la capability de sobrescritura falló al evaluar: se deniega por defecto');
            }
            // `=== true` estricto: un truthy (`'no'`, `1`, `{}`) no autoriza.
            if (autorizado !== true) {
                throw new VaultProvisionError(VAULT_PROVISION_ERROR_CODES.OVERWRITE_DENIED,
                    'el nombre ya tiene un valor distinto y la capability no autorizó '
                    + 'sobrescribirlo: la autorización la otorga el composition root del '
                    + 'operador, no el pedido');
            }
            estado = VAULT_PROVISION_STATES.OVERWRITTEN;
        }

        // --- Escritura ----------------------------------------------------------
        // Los cuatro campos son POSITIVOS y fijos: `SecureString`, la CMK de
        // config, `Overwrite: true` y el nombre canónico. Ninguno sale del payload.
        await conBackend('escribir el parámetro', () => ssm.putParameter({
            Name: path,
            Value: value,
            Type: TIPO_SEGURO,
            KeyId: kmsKeyId,
            Overwrite: true,
        }));

        // --- Verificación posterior (sin descifrar) -----------------------------
        const meta = await conBackend('verificar el parámetro escrito',
            () => ssm.getParameterMetadata({ Name: path }));

        if (meta == null || typeof meta !== 'object') {
            throw new VaultProvisionError(VAULT_PROVISION_ERROR_CODES.VERIFY_FAILED,
                'la verificación posterior no devolvió metadata');
        }
        if (meta.Type !== TIPO_SEGURO) {
            throw new VaultProvisionError(VAULT_PROVISION_ERROR_CODES.VERIFY_FAILED,
                `la verificación posterior esperaba Type \`${TIPO_SEGURO}\` y encontró otro: `
                + 'el parámetro NO quedó cifrado y debe revisarse a mano');
        }
        if (!Number.isInteger(meta.Version) || meta.Version < 1) {
            throw new VaultProvisionError(VAULT_PROVISION_ERROR_CODES.VERIFY_FAILED,
                'la verificación posterior devolvió una versión que no es un entero válido');
        }
        // Una sobrescritura DEBE avanzar la versión. Si no avanzó, el `Put` no
        // impactó (o impactó otro writer): fallar cerrado.
        if (versionPrevia != null && !(meta.Version > versionPrevia)) {
            throw new VaultProvisionError(VAULT_PROVISION_ERROR_CODES.VERIFY_FAILED,
                'la sobrescritura no avanzó la versión del parámetro: la escritura no '
                + 'impactó o hubo otro writer sobre el mismo nombre');
        }

        return proyectar(descriptor, path, estado, meta);
    }

    return Object.freeze({ provisionSecret });
}

// -----------------------------------------------------------------------------
// Helpers internos
// -----------------------------------------------------------------------------

/**
 * Proyección por ALLOWLIST del resultado público. Se construyen campos uno por
 * uno: nunca `{ ...respuesta }`, porque un spread arrastra lo que AWS agregue
 * mañana (incluido `Value` y `$metadata`).
 */
function proyectar(descriptor, path, estado, meta) {
    return Object.freeze({
        estado,
        tier: descriptor.tier,
        scope: descriptor.scope,
        path,
        metadata: Object.freeze({
            Type: meta.Type,
            Version: meta.Version,
        }),
    });
}

/**
 * Ejecuta una llamada al backend y traduce CUALQUIER error a un
 * `VaultProvisionError` genérico. El error original se descarta entero —
 * no se encadena, no se inspecciona y no se loguea — porque el error del SDK
 * puede traer el request completo, y el request lleva el valor.
 */
async function conBackend(accion, fn) {
    try {
        return await fn();
    } catch (err) {
        // Se rescata SÓLO el `name`/`code` si son cadenas cortas y conocidas;
        // ante la duda, nada. Nunca el `message` del SDK.
        const codigo = typeof err?.name === 'string' && /^[A-Za-z]{1,60}$/.test(err.name)
            ? ` (${err.name})`
            : '';
        throw new VaultProvisionError(VAULT_PROVISION_ERROR_CODES.BACKEND,
            `falló al ${accion}${codigo}`);
    }
}

function assertPuerto(nombre, puerto, metodos) {
    if (puerto == null || typeof puerto !== 'object') {
        throw new VaultProvisionError(VAULT_PROVISION_ERROR_CODES.PAYLOAD_INVALID,
            `requiere el port \`${nombre}\` inyectado`);
    }
    for (const m of metodos) {
        if (typeof puerto[m] !== 'function') {
            throw new VaultProvisionError(VAULT_PROVISION_ERROR_CODES.PAYLOAD_INVALID,
                `el port \`${nombre}\` debe exponer \`${m}()\``);
        }
    }
}

// -----------------------------------------------------------------------------
// Adapter real sobre @aws-sdk/client-ssm
// -----------------------------------------------------------------------------

/**
 * Adapta el cliente del SDK al port `ssm` que espera `createVaultProvisioner`.
 *
 * `commands` se puede inyectar para poder verificar POR TEST la forma exacta de
 * los comandos emitidos (Type, KeyId, Overwrite, WithDecryption) sin depender de
 * que `@aws-sdk/client-ssm` esté instalado. Sin ese punto de inyección los tests
 * sólo probarían el fake y el adapter que va a producción quedaría sin cubrir —
 * la "cobertura ilusoria" que la suite de `secret-vault` ya evita con su test de
 * paridad de drivers.
 *
 * @param {object} deps
 * @param {{ send: Function }} deps.client
 * @param {{ GetParameterCommand: Function, PutParameterCommand: Function }} [deps.commands]
 */
function createAwsSsmProvisionDriver({ client, commands } = {}) {
    if (client == null || typeof client.send !== 'function') {
        throw new VaultProvisionError(VAULT_PROVISION_ERROR_CODES.PAYLOAD_INVALID,
            'requiere un `client` de SSM con `send()`');
    }

    // Carga PEREZOSA: importar el SDK en el tope obligaría a instalarlo para
    // correr cualquier test que sólo usa el fake.
    const { GetParameterCommand, PutParameterCommand } = commands
        || require('@aws-sdk/client-ssm');

    return Object.freeze({
        async getParameter({ Name, WithDecryption }) {
            try {
                const res = await client.send(new GetParameterCommand({ Name, WithDecryption }));
                const p = res?.Parameter;
                if (p == null) return null;
                // Proyección explícita: nada de devolver `res` entero.
                return { Value: p.Value, Type: p.Type, Version: p.Version };
            } catch (err) {
                // "No existe" es un estado del flujo, no una excepción.
                if (err?.name === 'ParameterNotFound') return null;
                throw err;
            }
        },

        async putParameter({ Name, Value, Type, KeyId, Overwrite }) {
            const res = await client.send(new PutParameterCommand({
                Name, Value, Type, KeyId, Overwrite,
            }));
            return { Version: res?.Version };
        },

        async getParameterMetadata({ Name }) {
            // `WithDecryption: false` — la verificación posterior NO descifra.
            const res = await client.send(new GetParameterCommand({
                Name, WithDecryption: false,
            }));
            const p = res?.Parameter;
            if (p == null) return null;
            return { Type: p.Type, Version: p.Version };
        },
    });
}

module.exports = {
    VAULT_PROVISION_STATES,
    VAULT_PROVISION_ERROR_CODES,
    VaultProvisionError,
    createVaultProvisioner,
    createAwsSsmProvisionDriver,
};
