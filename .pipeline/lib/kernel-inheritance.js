'use strict';

// =============================================================================
// kernel-inheritance.js — Decision PURA de herencia de credenciales del kernel
// hacia un producto hijo (#6034 · split de #5900).
//
// QUE RESUELVE
// ------------
// "Si no encuentro lo tuyo, uso otra cosa" es el patron fail-open canonico: el
// producto B se da de alta sin su credencial, hereda en silencio la del kernel
// (produccion de Intrale) y trabaja convencido de estar en su propio entorno.
// Nadie ve nada raro porque la resolucion "funciono". Este modulo existe para
// que esa herencia sea SIEMPRE una decision explicita, acotada en el tiempo,
// tomada por quien ENTREGA la credencial, y con un motivo tipado por caso.
//
// MODULO HOJA — requisito de ARQUITECTURA, no de estilo
// ----------------------------------------------------
// Unica dependencia local permitida: `./secret-scopes` (que a su vez es hoja).
// CERO `require` de `kernel-supervisor`, `credentials`, `audit-log` o `redact`:
// el modulo DECIDE, el supervisor EJECUTA. Sin esa separacion aparece el ciclo
// `kernel-supervisor -> credentials -> ...` y, peor, la decision de autorizacion
// quedaria mezclada con I/O y no se podria testear como funcion pura.
//
// GARANTIA ESTRUCTURAL DE NO-FUGA (REQ-SEC-5)
// -------------------------------------------
// Ninguna funcion de este archivo recibe VALORES de credencial: la firma de
// `evaluarHerenciaScope` toma `projectId` + `scope` + metadatos del grant, y
// nada mas. Por eso los ocho mensajes al operador no pueden filtrar un secreto
// aunque el template este mal escrito: no hay secreto al alcance del template.
// Es una garantia de forma, no de disciplina.
//
// AUTORIDAD (REQ-SEC-1 · CA-4)
// ----------------------------
// `credentials[].inherit` del descriptor HIJO es a lo sumo una SOLICITUD: el
// descriptor de un alta se persiste verbatim desde un pedido autoemitido
// (`product-control-drainer.js`), asi que una propiedad con poder declarada ahi
// seria autoconcedible. La herencia efectiva es la INTERSECCION de esa solicitud
// con un grant declarado del lado del kernel (`vault.inheritance.grants` de
// `.pipeline/config.yaml`, que no es escribible por esa via).
// =============================================================================

const {
    SECRET_SCOPES,
    INHERITABLE_SCOPES,
    DESCRIPTOR_SCOPE_ENUM,
    rootScope,
} = require('./secret-scopes');

// Origen del valor de un scope. `kernel-inherited` es DISTINTO de `project` a
// proposito: sin esa marca, la rotacion de la credencial del kernel (#5901) no
// sabe a que hijos alcanza y un secreto rotado deja hijos con credencial muerta.
const FUENTE_PROPIA = 'project';
const FUENTE_HEREDADA = 'kernel-inherited';

// Motivos tipados de la decision. El VALOR es autodescriptivo porque viaja al
// audit encadenado, que lo lee una maquina y lo audita un humano meses despues:
// `M4` solo obligaria a abrir el codigo para saber que paso.
//
// Los ocho motivos son EXHAUSTIVOS sobre las ocho situaciones de CA-11. M1, M7 y
// M8 no los decide `evaluarHerenciaScope` (dependen del veredicto del vault, que
// es I/O): los decide el supervisor y construye su texto con `mensajeHerencia`,
// para que los ocho mensajes salgan igual de este unico modulo.
const MOTIVOS_HERENCIA = Object.freeze({
    M1: 'M1_SCOPE_PROPIO_VACIO',
    M2: 'M2_SIN_INHERIT_DECLARADO',
    M3: 'M3_SCOPE_NO_HEREDABLE',
    M4: 'M4_SIN_GRANT_DEL_KERNEL',
    M5: 'M5_GRANT_NO_VIGENTE',
    M6: 'M6_SCOPE_FUERA_DEL_VOCABULARIO',
    M7: 'M7_VEREDICTO_NO_ES_SCOPE_MISSING',
    M8: 'M8_SCOPE_RECHAZADO_POR_EL_VAULT',
});

// Sub-motivos de M5. Existen porque las cuatro situaciones se REMEDIAN distinto
// (UX-OPS-E): mandar al operador a tocar `until` cuando lo que falta es
// `enabled: true` es enviarlo a arreglar lo que no esta roto.
const SUBMOTIVOS_M5 = Object.freeze({
    FLAG_APAGADO: 'flag-apagado',
    UNTIL_AUSENTE: 'until-ausente',
    UNTIL_INVALIDO: 'until-invalido',
    CADUCADA: 'caducada',
});

/**
 * Canoniza un scope ANTES de derivar su raiz (CA-7 · REQ-SEC-2b).
 *
 * Sobre un string crudo, `AWS:prod`, `Aws` o `"aws "` no matchean `'aws'` y se
 * colarian por la allowlist de heredables. La canonizacion NO es una correccion
 * silenciosa: el llamador compara el resultado contra la entrada y rechaza la
 * diferencia (M6). Canonizar y seguir de largo convertiria el vocabulario
 * cerrado en uno "tolerante", que es como se pierden las allowlists.
 */
function canonizarScope(scope) {
    return String(scope === null || scope === undefined ? '' : scope)
        .normalize('NFC')
        .trim()
        .toLowerCase();
}

/**
 * Pertenencia al vocabulario CERRADO de scopes de contrato (CA-7).
 *
 * Se valida el scope COMPLETO contra `DESCRIPTOR_SCOPE_ENUM`, no solo su raiz.
 * Con la raiz sola queda un bypass real: `aws:` canoniza a si mismo (el trim y
 * el toLowerCase no le sacan el `:`), su `rootScope` es `'aws'`, que si
 * pertenece a `SECRET_SCOPES`, y el scope pasaria la puerta del vocabulario
 * disfrazado de scope valido. La verificacion de la raiz se conserva ADEMAS
 * porque `rootScope` es un parser y no un validador (documentado en
 * `secret-scopes.js`): su salida nunca decide autorizacion sola.
 */
function esScopeDelVocabulario(canon) {
    return DESCRIPTOR_SCOPE_ENUM.includes(canon) && SECRET_SCOPES.includes(rootScope(canon));
}

/**
 * Busca el grant del kernel para un `projectId`.
 *
 * @param {object|Array} cfgInheritance  seccion `vault.inheritance` o su array
 *                                       `grants` directamente.
 * @param {string} projectId             producto que pide heredar.
 * @returns {object|null}                el grant declarado, o `null`.
 */
function leerGrant(cfgInheritance, projectId) {
    const lista = Array.isArray(cfgInheritance)
        ? cfgInheritance
        : (cfgInheritance && Array.isArray(cfgInheritance.grants) ? cfgInheritance.grants : []);
    const buscado = String(projectId === null || projectId === undefined ? '' : projectId).trim();
    if (!buscado) return null;
    // Primera coincidencia: dos grants para el mismo producto son un error de
    // config, y quedarse con el primero es lo conservador (el segundo no puede
    // AMPLIAR lo que concede el primero sin que nadie lo vea en la lectura).
    for (const grant of lista) {
        if (grant && typeof grant === 'object' && String(grant.projectId || '').trim() === buscado) {
            return grant;
        }
    }
    return null;
}

/** Fallo tipado de la decision, con su texto ya construido. */
function denegar(motivo, datos) {
    return {
        ok: false,
        source: null,
        motivo,
        submotivo: datos.submotivo || null,
        mensaje: mensajeHerencia(motivo, datos),
    };
}

/**
 * Decide si UN scope faltante del producto `projectId` puede heredarse del
 * kernel. Funcion PURA: no lee config, no toca el vault, no audita.
 *
 * ORDEN DE EVALUACION (es la correccion misma, no una preferencia):
 *   1. vocabulario cerrado + forma canonica  (allowlist primero)
 *   2. allowlist de heredables               (deny despues, sobre la raiz ya validada)
 *   3. solicitud del hijo (`inherit`)        (sin declaracion no hay herencia implicita)
 *   4. grant del kernel                      (la autoridad es de quien entrega)
 *   5. vigencia del grant                    (booleano exacto + `until` obligatorio)
 *
 * @param {object}   args
 * @param {string}   args.projectId  producto hijo que pide heredar.
 * @param {string}   args.scope      scope en forma de CONTRATO (`providers:anthropic`).
 * @param {string[]} args.inherit    union de `credentials[].inherit` del descriptor hijo.
 * @param {object|Array} args.grants seccion `vault.inheritance` del kernel (o su array).
 * @param {number}   args.ahora      reloj en ms (inyectable).
 * @returns {{ok:boolean, source:string|null, motivo:string|null,
 *            submotivo:string|null, mensaje:string|null}}
 */
function evaluarHerenciaScope({ projectId, scope, inherit, grants, ahora } = {}) {
    const canon = canonizarScope(scope);
    const datos = { projectId, scope: canon || String(scope) };

    // 1 · Vocabulario CERRADO y forma canonica (CA-7). La entrada tiene que ser
    // ya canonica: aceptar `Aws` "porque se entiende" es exactamente como una
    // variante se cuela por la allowlist de heredables.
    //
    // Un scope INVENTADO (`FAKE-scope-nuevo`) tambien cae aca, no en M3: CA-7
    // fija que el vocabulario se valida ANTES del deny por herencia, asi que
    // "no lo conozco" gana sobre "no es heredable". El efecto exigido por CA-6
    // se cumple igual y con el mensaje mas util: el scope NO se hereda.
    if (canon !== String(scope === null || scope === undefined ? '' : scope) || !esScopeDelVocabulario(canon)) {
        return denegar(MOTIVOS_HERENCIA.M6, { ...datos, scope: String(scope) });
    }

    // 2 · Allowlist de heredables (CA-6 · REQ-SEC-2a). Es allowlist y no
    // denylist para que un scope nuevo del vocabulario nazca NO heredable: con
    // denylist se heredaria porque nadie se acordo de agregarlo, que es una
    // escalada de privilegios por omision. `aws` y `github` quedan afuera POR
    // CONSTRUCCION, sin depender de ninguna lista negra.
    const raiz = rootScope(canon);
    if (!INHERITABLE_SCOPES.includes(raiz)) {
        return denegar(MOTIVOS_HERENCIA.M3, datos);
    }

    // 3 · Solicitud del hijo. Sin `inherit` declarado, fail-closed.
    if (!Array.isArray(inherit) || !inherit.map(canonizarScope).includes(canon)) {
        return denegar(MOTIVOS_HERENCIA.M2, datos);
    }

    // 4 · Grant del kernel (CA-4 · REQ-SEC-1). La solicitud del hijo sola no
    // alcanza: el descriptor es un documento autoemitido.
    const grant = leerGrant(grants, projectId);
    const concedidos = grant && Array.isArray(grant.scopes) ? grant.scopes.map(canonizarScope) : [];
    if (!grant || !concedidos.includes(canon)) {
        return denegar(MOTIVOS_HERENCIA.M4, datos);
    }

    // 5 · Vigencia (CA-5). Mismo molde que `evaluarVentanaBootstrap`
    // (credentials.js): booleano exacto, `until` obligatorio, caduca sola.
    if (grant.enabled !== true) {
        return denegar(MOTIVOS_HERENCIA.M5, { ...datos, submotivo: SUBMOTIVOS_M5.FLAG_APAGADO });
    }
    const hasta = typeof grant.until === 'string' ? grant.until.trim() : '';
    if (!hasta) {
        return denegar(MOTIVOS_HERENCIA.M5, { ...datos, submotivo: SUBMOTIVOS_M5.UNTIL_AUSENTE });
    }
    const vence = Date.parse(hasta);
    if (!Number.isFinite(vence)) {
        return denegar(MOTIVOS_HERENCIA.M5, { ...datos, submotivo: SUBMOTIVOS_M5.UNTIL_INVALIDO, until: hasta });
    }
    const reloj = Number.isFinite(ahora) ? ahora : Date.now();
    if (reloj > vence) {
        return denegar(MOTIVOS_HERENCIA.M5, { ...datos, submotivo: SUBMOTIVOS_M5.CADUCADA, until: hasta });
    }

    return { ok: true, source: FUENTE_HEREDADA, motivo: null, submotivo: null, mensaje: null };
}

/**
 * Diagnostico del vault listo para incrustar en M7.
 *
 * El fallback NO es cosmetico: sin el, un `error` ausente dejaria el mensaje
 * terminando en `undefined`, que es exactamente el texto terminal vacio que
 * CA-11 y UX-OPS-G prohiben.
 */
function textoDelVault(texto) {
    const s = typeof texto === 'string' ? texto.trim() : '';
    return s || 'sin detalle; revisar el log del vault, que nombra la causa y su remediacion';
}

/** Lista de scopes lista para interpolar, siempre no vacia (UX-OPS-G). */
function listar(scopes) {
    const items = (Array.isArray(scopes) ? scopes : [scopes])
        .filter((s) => typeof s === 'string' && s.trim() !== '');
    return items.length ? items.join(', ') : '(ninguno declarado)';
}

// Cola de remediacion de M5, por sub-motivo (UX-OPS-E). El texto base de M5 es
// uno solo: lo que cambia es a QUE tiene que ir el operador.
function remediacionM5(submotivo, projectId, until) {
    if (submotivo === SUBMOTIVOS_M5.FLAG_APAGADO) {
        return `poner "enabled: true" (el booleano exacto) en el grant de "${projectId}" `
            + 'dentro de vault.inheritance.grants de .pipeline/config.yaml';
    }
    if (submotivo === SUBMOTIVOS_M5.CADUCADA) {
        return `el grant vencio el ${until || 'la fecha declarada'}: renovar "until" en el grant de `
            + `"${projectId}" en .pipeline/config.yaml, o dar de alta una credencial propia del producto`;
    }
    return `poner "until" con una fecha ISO-8601 valida (por ejemplo 2026-12-31T00:00:00Z) en el grant `
        + `de "${projectId}" dentro de vault.inheritance.grants de .pipeline/config.yaml`;
}

/**
 * Construye el mensaje al operador para un motivo (CA-11 · UX-OPS-A..G).
 *
 * FORMA CONTRACTUAL, la misma de los 24 mensajes de `credentials.js`:
 *   `<que paso, nombrando producto y scope>. Impacto: <consecuencia observable>.
 *    Proximo paso: <accion concreta, con el archivo>`
 *
 * Tres reglas que el texto respeta y que un test verifica:
 *   - ASCII-safe: sin tildes ni rayas. Estos textos van a consola de Windows
 *     (cp1252) y a Telegram. Aplica al MENSAJE, no a los comentarios.
 *   - Vocabulario de CONTRATO (`providers:anthropic`), nunca el segmento interno
 *     del vault (`providers__anthropic`), que es plomeria que el operador no
 *     escribio nunca.
 *   - La remediacion nombra QUIEN la ejecuta: M2 lo arregla el responsable del
 *     producto hijo en su descriptor; M4 lo arregla el operador del kernel en
 *     config.yaml. Son personas distintas, y la asimetria de autoridad de CA-4
 *     tiene que ser legible en el texto, no solo cierta en el codigo.
 */
function mensajeHerencia(motivo, datos = {}) {
    const producto = String(datos.projectId === null || datos.projectId === undefined ? '' : datos.projectId);
    const scope = String(datos.scope === null || datos.scope === undefined ? '' : datos.scope);
    const impactoBase = 'Impacto: la instancia queda SIN credenciales (fail-closed)';

    switch (motivo) {
        case MOTIVOS_HERENCIA.M1:
            return `el producto "${producto}" tiene el scope "${scope}" en su namespace del vault pero con `
                + 'valor vacio o de placeholder. '
                + `${impactoBase} y NO se hereda del kernel: un scope propio roto no es un scope que el `
                + 'producto no tenga. '
                + `Proximo paso: poblar "${scope}" con el valor real en el namespace del producto "${producto}"`;

        case MOTIVOS_HERENCIA.M2:
            return `al producto "${producto}" le falta el scope "${scope}" y su descriptor no lo declara en `
                + 'credentials[].inherit, asi que no se hereda del kernel (sin declaracion no hay herencia '
                + 'implicita). '
                + `${impactoBase}. `
                + `Proximo paso: el responsable del producto "${producto}" agrega "${scope}" a `
                + `credentials[].inherit en .pipeline/descriptors/${producto}.json y despues le pide el grant `
                + 'al operador del kernel';

        case MOTIVOS_HERENCIA.M3:
            return `el scope "${scope}" NO se hereda nunca: no esta en la allowlist de scopes heredables, asi `
                + `que el producto "${producto}" no puede tomarlo del kernel aunque lo declare en `
                + 'credentials[].inherit y exista el grant. '
                + `${impactoBase}. `
                + `Proximo paso: dar de alta una credencial propia de "${scope}" en el namespace del producto `
                + `"${producto}"`;

        case MOTIVOS_HERENCIA.M4:
            return `el producto "${producto}" pide heredar "${scope}" pero el kernel no le concedio ese scope: `
                + 'la autoridad es de quien ENTREGA la credencial, nunca de quien la recibe. '
                + `${impactoBase}. `
                + `Proximo paso: el operador del kernel agrega el grant de "${producto}" para "${scope}" en `
                + 'vault.inheritance.grants de .pipeline/config.yaml';

        case MOTIVOS_HERENCIA.M5:
            return `el grant del kernel que le concede "${scope}" al producto "${producto}" existe pero no esta `
                + `vigente (${datos.submotivo || SUBMOTIVOS_M5.FLAG_APAGADO}). `
                + `${impactoBase}. `
                + `Proximo paso: ${remediacionM5(datos.submotivo, producto, datos.until)}`;

        case MOTIVOS_HERENCIA.M6:
            return `el producto "${producto}" declara el scope "${scope}", que no pertenece al vocabulario `
                + 'cerrado de scopes o no esta en su forma canonica (minusculas, sin espacios). '
                + `${impactoBase} y el scope NO se hereda. `
                + 'Proximo paso: usar un scope del vocabulario de .pipeline/lib/secret-scopes.js (por ejemplo '
                + `"providers:anthropic") en .pipeline/descriptors/${producto}.json`;

        // M7 CONSERVA el diagnostico del vault entero, no lo reemplaza: ese
        // texto ya nombra la palanca exacta (`vault.enabled`, la clave de config
        // que no valida, el codigo del broker) y es la unica remediacion
        // accionable. Lo que M7 agrega adelante es POR QUE la herencia no entra
        // a jugar, que es informacion nueva; pisarlo con un texto propio le
        // sacaria al operador la remediacion y le dejaria solo la explicacion.
        case MOTIVOS_HERENCIA.M7:
            return `la herencia del kernel NO se evalua para el producto "${producto}" `
                + `(scopes declarados: ${listar(datos.scopes || scope)}): el vault respondio `
                + `${datos.code || 'un codigo desconocido'}, que no es "falta el scope", y un resolver que `
                + 'devuelve vacio porque esta apagado o roto nunca significa que el producto no tenga la '
                + `credencial. Diagnostico del vault: ${textoDelVault(datos.detalle)}`;

        case MOTIVOS_HERENCIA.M8:
            return `el borde del vault rechazo los scopes declarados por el producto "${producto}": `
                + `${listar(datos.scopes || scope)} (clave: vault.scope), asi que no puede resolver `
                + 'credenciales ni evaluar herencia. '
                + `${impactoBase}; NO se cae al archivo. `
                + `Proximo paso: corregir credentials[].scopes en .pipeline/descriptors/${producto}.json, que `
                + 'es donde esta el defecto; NO en .pipeline/config.yaml';

        default:
            // Nunca deberia alcanzarse: los ocho motivos son exhaustivos. Aun
            // asi el default es fail-closed y accionable, jamas `undefined`.
            return `la herencia de credenciales del producto "${producto}" quedo denegada por un motivo no `
                + `catalogado sobre el scope "${scope}". `
                + `${impactoBase}. `
                + 'Proximo paso: reportar este caso con el issue #6034, que define los motivos M1 a M8';
    }
}

module.exports = {
    MOTIVOS_HERENCIA,
    SUBMOTIVOS_M5,
    FUENTE_PROPIA,
    FUENTE_HEREDADA,
    canonizarScope,
    esScopeDelVocabulario,
    leerGrant,
    evaluarHerenciaScope,
    mensajeHerencia,
};
