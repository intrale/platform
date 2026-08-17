'use strict';

// Fuente UNICA del vocabulario de scopes de secretos (Eje A: almacenamiento).
//
// Modulo HOJA: cero dependencias de modulos locales del pipeline (built-ins de
// Node estan permitidos, pero hoy no hace falta ninguno). Es un requisito de
// ARQUITECTURA, no de estilo: todos sus consumidores previstos
// (secrets-manifest, el enum del schema, el borde del supervisor, la herencia
// cross-proyecto) deben poder importarlo sin riesgo de ciclo. Por eso las
// listas que espejan otros modulos son copia manual, y la unica red contra el
// stale es el test de contrato (`__tests__/secret-scopes-contract.test.js`),
// que si puede requerir a los modulos espejados porque no es hoja.

// ORDEN CONTRACTUAL - NO alfabetico. Espeja literal el array que vivia en
// `secrets-manifest.js:8-10`, porque `SCHEMA.services` preserva contenido Y
// orden: reordenar aca cambia el contrato del manifiesto en silencio.
//
// Este vocabulario es el del Eje A (ALMACENAMIENTO de credenciales). El enum
// legacy del schema (`contracts/project.schema.json:157`) mezcla ademas dos
// valores del Eje B (inyeccion de entorno hacia el proceso hijo) que NO tienen
// equivalente aca y que la migracion debe RECHAZAR, nunca traducir:
//   - `gradle-android` - paths de toolchain (JAVA_HOME, ANDROID_HOME...), no
//     son secretos; su destino es `build-child-env.js`, no el vault.
//   - `telegram-hooks`  - contexto de destino (un chat id), no la credencial;
//     traducirlo a `telegram` haria que el bot token cruce al proceso hijo,
//     que es exactamente lo que el codigo de inyeccion evita hoy.
const SECRET_SCOPES = Object.freeze([
    'telegram', 'github', 'providers', 'aws', 'google_drive', 'r2', 'multimedia',
]);

// Vendors de ALMACENAMIENTO: derivados de las claves `providers.*` de
// `ENV_MAPPING` (credentials.js).
//
// NUNCA de `LIVE_PROVIDER_IDS` (project-descriptor.js), que es otro
// vocabulario - el de RUNTIME:
//   ['anthropic', 'openai-codex', 'gemini-google', 'cerebras', 'nvidia-nim']
// Derivarlo de ahi perderia la credencial de Moonshot y renombraria tres
// scopes. Los dos vocabularios se parecen lo suficiente como para confundirlos:
// es el error mas caro que se puede cometer en este archivo.
const PROVIDER_VENDORS = Object.freeze([
    'anthropic', 'openai', 'google', 'cerebras', 'nvidia', 'moonshot',
]);

// Herencia cross-proyecto. La clasificacion es una PARTICION EXPLICITA de
// `SECRET_SCOPES`: todo scope esta en exactamente una de las dos listas, nunca
// en ninguna y nunca en las dos.
//
// Con solo la denylist, un scope nuevo naceria heredable por SILENCIO - una
// escalada de privilegios por omision. `r2` y `google_drive` ya son
// credenciales con capacidad de escritura, y nadie decidio conscientemente que
// se hereden. El test de contrato falla si la union no cubre `SECRET_SCOPES` o
// si las listas se solapan, forzando una decision consciente por scope nuevo.
//
// La SEMANTICA definitiva de la herencia (y una eventual forma allowlist) es
// decision del tramo que la implementa; esto es solo la red que la habilita.
const NON_INHERITABLE_SCOPES = Object.freeze(['aws', 'github']);
const INHERITABLE_SCOPES = Object.freeze([
    'telegram', 'providers', 'google_drive', 'r2', 'multimedia',
]);

// Vocabulario del descriptor: scopes raiz (sin `providers`) mas un
// `providers:<vendor>` por vendor. Aca SI aplica el orden alfabetico: es un
// derivado para lectura humana, no un contrato posicional como `SECRET_SCOPES`.
const DESCRIPTOR_SCOPE_ENUM = Object.freeze([
    ...SECRET_SCOPES.filter((scope) => scope !== 'providers'),
    ...PROVIDER_VENDORS.map((vendor) => `providers:${vendor}`),
].sort());

// Separador del segmento de path del vault.
//
// DIRECCION DE VISIBILIDAD: `providers:anthropic` es la forma de CONTRATO, la
// que el operador escribe y lee. `providers__anthropic` es DERIVADA e INTERNA
// del vault (asi se llaman los parametros alla adentro) y nunca se le muestra
// al operador.
//
// Por que `'__'` y no otro separador:
//   '_'  - es inyectivo al CODIFICAR, pero su inverso es AMBIGUO:
//          'google' + '_' + 'drive' === 'google_drive', que ademas es un scope
//          raiz valido del vocabulario. Un decoder que splitee en el primer
//          '_' serviria el scope equivocado - confusion de scope, con
//          credenciales del otro lado. La falla esta en la decodificacion, no
//          en la codificacion ni en el borde del vault (que acepta los tres
//          separadores sin chistar).
//   '-'  - colisiona con el vocabulario legacy del schema (`gradle-android`,
//          `telegram-hooks`): durante la migracion, un segmento con guion seria
//          indistinguible de un scope legacy.
const VAULT_SCOPE_SEP = '__';

/**
 * Traduce un scope de CONTRATO al segmento de path del vault.
 *
 *   scopeVaultSegment('providers:anthropic') === 'providers__anthropic'
 *   scopeVaultSegment('aws')                 === 'aws'
 *
 * Los scopes sin `:` pasan sin cambio: la traduccion es identidad sobre los
 * scopes raiz.
 *
 * Saltear esta traduccion NO produce un path silenciosamente equivocado: el
 * borde del vault rechaza la forma de contrato con
 *
 *   vault: `vault.scope` invalido ("providers:anthropic"): solo letras,
 *   numeros, guion y guion bajo - sin barras, sin puntos y sin `..`
 *
 * El mensaje se cita a proposito: quien debuguee ese error va a grepearlo, y el
 * grep debe caer aca, en la fuente unica que explica la causa. El mensaje
 * describe el alfabeto del PATH, no el del CONTRATO - por eso induce a escribir
 * `__` donde en realidad va `:`. Es fail-closed, que es lo correcto, pero la
 * explicacion vive en este comentario.
 *
 * @param {string} scope Scope en forma de contrato (`aws`, `providers:openai`).
 * @returns {string} Segmento apto para el path del vault.
 */
function scopeVaultSegment(scope) {
    return String(scope).split(':').join(VAULT_SCOPE_SEP);
}

/**
 * Devuelve la raiz de un scope: `providers:anthropic` -> `providers`.
 *
 * ES UN PARSER, NO UN VALIDADOR. Devuelve algo para CUALQUIER entrada:
 *
 *   rootScope('../../otro/aws:x')  === '../../otro/aws'
 *   rootScope('providers:../../x') === 'providers'
 *   rootScope('')                  === ''
 *
 * Su salida NUNCA se usa sola para construir un path del vault ni para decidir
 * autorizacion. La forma CORRECTA de usarla es componerla siempre con una
 * verificacion de pertenencia al vocabulario:
 *
 *   if (!SECRET_SCOPES.includes(rootScope(scope))) throw ...;
 *
 * @param {string} scope Scope en forma de contrato.
 * @returns {string} Primer segmento antes de `:`, sin validar.
 */
function rootScope(scope) {
    return String(scope).split(':')[0];
}

module.exports = {
    SECRET_SCOPES,
    PROVIDER_VENDORS,
    NON_INHERITABLE_SCOPES,
    INHERITABLE_SCOPES,
    DESCRIPTOR_SCOPE_ENUM,
    VAULT_SCOPE_SEP,
    scopeVaultSegment,
    rootScope,
};
