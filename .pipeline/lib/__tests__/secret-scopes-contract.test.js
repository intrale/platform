// =============================================================================
// Tests de contrato secret-scopes.js — CA-1..CA-9 de #6030
//
// Este test es la UNICA red contra la divergencia del vocabulario: el modulo
// bajo prueba es HOJA por requisito de arquitectura, asi que no puede derivar
// nada de sus espejos. El test si puede requerirlos, y ese es todo el punto.
//
// CA-9: el test lee EXCLUSIVAMENTE nombres de clave (`Object.keys(ENV_MAPPING)`)
// y `validateVaultNamespace`, que es pura. No invoca `loadIntoEnv`,
// `resolveVaultOnly` ni driver alguno del vault: nada dispara la CLI de AWS ni
// necesita red o credenciales. Los datos sinteticos usan prefijo `FAKE-`.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    SECRET_SCOPES,
    PROVIDER_VENDORS,
    NON_INHERITABLE_SCOPES,
    INHERITABLE_SCOPES,
    DESCRIPTOR_SCOPE_ENUM,
    VAULT_SCOPE_SEP,
    scopeVaultSegment,
    rootScope,
} = require('../secret-scopes');

const { ENV_MAPPING } = require('../credentials');
const { validateVaultNamespace } = require('../secret-vault');

const SOURCE_PATH = path.join(__dirname, '..', 'secret-scopes.js');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

// El test estatico de "modulo hoja" matchea el TEXTO del archivo, comentarios
// incluidos. Sin este stripping, documentar en prosa un require local pondria
// el test en rojo por la razon equivocada. Se quitan bloques `/* */` primero y
// linea `//` despues.
const SOURCE_CODE_ONLY = SOURCE
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

// Orden contractual exacto heredado de `secrets-manifest.js:8-10`.
const ORDEN_CONTRACTUAL = ['telegram', 'github', 'providers', 'aws', 'google_drive', 'r2', 'multimedia'];

// -----------------------------------------------------------------------------
// CA-1 — SERVICES se exporta y deja de ser undefined
// -----------------------------------------------------------------------------

test('CA-1 — secrets-manifest exporta SERVICES como array congelado de los 7 scopes', () => {
    const manifest = require('../secrets-manifest');

    assert.notEqual(typeof manifest.SERVICES, 'undefined',
        'SERVICES sin exportar: un `enum` de Ajv derivado de aca seria `undefined` y aceptaria cualquier string (fail-open)');
    assert.equal(typeof manifest.SERVICES, 'object');
    assert.ok(Array.isArray(manifest.SERVICES));
    assert.equal(manifest.SERVICES.length, 7);
    assert.deepEqual(manifest.SERVICES, SECRET_SCOPES);
    assert.equal(Object.isFrozen(manifest.SERVICES), true,
        'el congelamiento del origen se propaga porque es la MISMA referencia');
});

test('CA-1 — un enum derivado de SERVICES ya no acepta un scope arbitrario', () => {
    const { SERVICES } = require('../secrets-manifest');

    // Reproduce el fail-open sin depender de Ajv: lo que importa es que el
    // vocabulario exista y sea acotado, no la libreria que lo consuma.
    assert.equal(SERVICES.includes('../../FAKE-otro-proyecto/aws'), false);
    assert.equal(SERVICES.includes('FAKE-scope-inventado'), false);
    assert.equal(SERVICES.includes('aws'), true);
});

// -----------------------------------------------------------------------------
// CA-2 — el manifiesto no cambia de comportamiento
// -----------------------------------------------------------------------------

test('CA-2 — SCHEMA.services mantiene contenido Y orden exactos', () => {
    const { SCHEMA } = require('../secrets-manifest');

    assert.deepEqual(SCHEMA.services, ORDEN_CONTRACTUAL,
        'SCHEMA.services es contrato posicional: reordenarlo lo rompe en silencio');
});

test('CA-2 — SECRET_SCOPES conserva el orden contractual, NO el alfabetico', () => {
    assert.deepEqual([...SECRET_SCOPES], ORDEN_CONTRACTUAL);
    assert.notDeepEqual([...SECRET_SCOPES], [...SECRET_SCOPES].sort(),
        'si alguien "ordena alfabeticamente" la constante, rompe SCHEMA.services');
    assert.equal(Object.isFrozen(SECRET_SCOPES), true);
});

// -----------------------------------------------------------------------------
// CA-3 — modulo hoja de verdad (verificado automaticamente, no por inspeccion)
// -----------------------------------------------------------------------------

test('CA-3 — secret-scopes.js no requiere ningun modulo local', () => {
    const requiresLocales = SOURCE_CODE_ONLY.match(/require\(\s*['"]\.{1,2}\//g) || [];

    assert.deepEqual(requiresLocales, [],
        'un require local reintroduce el riesgo de ciclo que este modulo existe para evitar');
});

test('CA-3 — secret-scopes.js no hace I/O, ni lee el entorno, ni ejecuta comandos', () => {
    assert.equal(/process\.env/.test(SOURCE_CODE_ONLY), false, 'no debe leer process.env');
    assert.equal(/\beval\s*\(/.test(SOURCE_CODE_ONLY), false, 'no debe usar eval');
    assert.equal(/child_process/.test(SOURCE_CODE_ONLY), false, 'no debe ejecutar comandos');
    assert.equal(/require\(\s*['"]node:fs['"]\s*\)/.test(SOURCE_CODE_ONLY), false, 'no debe hacer I/O');
});

// -----------------------------------------------------------------------------
// CA-4 — PROVIDER_VENDORS no puede divergir de ENV_MAPPING, en ambas direcciones
// -----------------------------------------------------------------------------

test('CA-4 — PROVIDER_VENDORS es igual por conjunto a los vendors de ENV_MAPPING', () => {
    const vendorsDelMapping = new Set(
        Object.keys(ENV_MAPPING)
            .filter((clave) => clave.startsWith('providers.'))
            .map((clave) => clave.split('.')[1]),
    );
    const vendorsDeclarados = new Set(PROVIDER_VENDORS);

    // Comparacion POR CONJUNTO, no por orden: el orden del issue y el
    // alfabetico son ambos aceptables y un test sensible al orden seria fragil.
    const sobran = [...vendorsDeclarados].filter((v) => !vendorsDelMapping.has(v));
    const faltan = [...vendorsDelMapping].filter((v) => !vendorsDeclarados.has(v));

    assert.deepEqual(sobran, [],
        'vendor declarado que no existe en ENV_MAPPING: el scope no tiene credencial detras');
    assert.deepEqual(faltan, [],
        'vendor agregado a credentials.js sin declararlo aca: su credencial queda fuera del vocabulario en silencio');
    assert.equal(vendorsDeclarados.size, vendorsDelMapping.size);
    assert.equal(Object.isFrozen(PROVIDER_VENDORS), true);
});

// -----------------------------------------------------------------------------
// CA-5 — PROVIDER_VENDORS deriva de almacenamiento, nunca de runtime
// -----------------------------------------------------------------------------

test('CA-5 — el codigo no deriva ni compara PROVIDER_VENDORS contra el vocabulario de runtime', () => {
    // Sobre el source SIN comentarios: lo que se prohibe es la DERIVACION, no
    // la mencion. El comentario explicativo es obligatorio (se verifica abajo).
    assert.equal(/LIVE_PROVIDER_IDS/.test(SOURCE_CODE_ONLY), false,
        'derivar de LIVE_PROVIDER_IDS perderia Moonshot y renombraria tres scopes');
    assert.equal(/project-descriptor/.test(SOURCE_CODE_ONLY), false);
});

test('CA-5 — hay un comentario junto a la constante que explica por que no es el vocabulario de runtime', () => {
    assert.ok(/LIVE_PROVIDER_IDS/.test(SOURCE),
        'sin la advertencia escrita, los dos vocabularios se parecen lo suficiente como para confundirlos');
    assert.ok(/moonshot/i.test(SOURCE));
});

test('CA-5 — los vendors de almacenamiento no coinciden con los ids de runtime', () => {
    // Ancla del error mas caro del issue: si alguien "unifica" ambas listas,
    // esto se pone rojo.
    const idsDeRuntime = ['anthropic', 'openai-codex', 'gemini-google', 'cerebras', 'nvidia-nim'];

    assert.notDeepEqual([...PROVIDER_VENDORS].sort(), [...idsDeRuntime].sort());
    assert.ok(PROVIDER_VENDORS.includes('moonshot'), 'Moonshot solo existe del lado de almacenamiento');
    assert.equal(PROVIDER_VENDORS.includes('openai-codex'), false);
});

// -----------------------------------------------------------------------------
// CA-6 — scopeVaultSegment: inyectivo Y de inverso determinista
// -----------------------------------------------------------------------------

test('CA-6 — DESCRIPTOR_SCOPE_ENUM tiene las 12 entradas esperadas y esta ordenado', () => {
    assert.equal(DESCRIPTOR_SCOPE_ENUM.length, 12);
    assert.deepEqual([...DESCRIPTOR_SCOPE_ENUM], [...DESCRIPTOR_SCOPE_ENUM].sort());
    assert.equal(DESCRIPTOR_SCOPE_ENUM.includes('providers'), false,
        '`providers` pelado no pertenece al vocabulario del descriptor: se expande por vendor');
    for (const vendor of PROVIDER_VENDORS) {
        assert.ok(DESCRIPTOR_SCOPE_ENUM.includes(`providers:${vendor}`));
    }
});

test('CA-6.1 — scopeVaultSegment es inyectivo sobre el vocabulario completo', () => {
    const segmentos = DESCRIPTOR_SCOPE_ENUM.map(scopeVaultSegment);

    assert.equal(new Set(segmentos).size, segmentos.length,
        'dos scopes distintos que dan el mismo segmento serian dos credenciales en el mismo parametro');
});

test('CA-6.2 — el inverso es determinista: ningun scope raiz contiene el separador', () => {
    // Esto es lo que descarta `'_'`: con ese separador, `google_drive` es a la
    // vez scope raiz valido y parseable como `google` + `drive`.
    for (const scope of SECRET_SCOPES) {
        assert.equal(scope.includes(VAULT_SCOPE_SEP), false, `el scope raiz "${scope}" contiene el separador`);
    }
    for (const vendor of PROVIDER_VENDORS) {
        assert.equal(vendor.includes(VAULT_SCOPE_SEP), false, `el vendor "${vendor}" contiene el separador`);
    }

    // Decoder de referencia: si el mapeo es reversible, esto reconstruye los 12.
    const decode = (segmento) => segmento.split(VAULT_SCOPE_SEP).join(':');
    for (const scope of DESCRIPTOR_SCOPE_ENUM) {
        assert.equal(decode(scopeVaultSegment(scope)), scope, `no reversible: "${scope}"`);
    }
});

test('CA-6.3 — el borde del vault acepta los 12 segmentos', () => {
    // NO se copia SEGMENT_RE: `secret-vault.js` documenta que los regex no se
    // exportan a proposito, porque exportarlos habilita justamente la copia que
    // este issue viene a eliminar. Se valida con la funcion exportada, que es
    // pura y no toca AWS.
    const rechazados = [];
    for (const scope of DESCRIPTOR_SCOPE_ENUM) {
        try {
            validateVaultNamespace({
                prefix: '/FAKE-prefix',
                projectId: 'FAKE-proj',
                hostId: null,
                scope: scopeVaultSegment(scope),
                tier: 'shared',
                root: false,
            });
        } catch (error) {
            rechazados.push(`${scope} -> ${error.message}`);
        }
    }

    assert.deepEqual(rechazados, []);
});

test('CA-6 — la forma de contrato es rechazada por el borde: fail-closed, no path equivocado', () => {
    // Saltear la traduccion da una excepcion dura, no un path silenciosamente
    // erroneo. Es la propiedad que hace seguro el mapeo.
    assert.throws(() => validateVaultNamespace({
        prefix: '/FAKE-prefix',
        projectId: 'FAKE-proj',
        hostId: null,
        scope: 'providers:anthropic',
        tier: 'shared',
        root: false,
    }));
});

test('CA-6 — el separador y su razon estan documentados junto a la constante', () => {
    assert.equal(VAULT_SCOPE_SEP, '__');
    assert.ok(/gradle-android/.test(SOURCE),
        'la colision de `-` con el vocabulario legacy queda registrada en el codigo, no en un doc aparte');
    assert.ok(/telegram-hooks/.test(SOURCE));
});

test('CA-6 — los scopes sin `:` pasan por la traduccion sin cambio', () => {
    assert.equal(scopeVaultSegment('aws'), 'aws');
    assert.equal(scopeVaultSegment('google_drive'), 'google_drive');
    assert.equal(scopeVaultSegment('providers:anthropic'), 'providers__anthropic');
});

// -----------------------------------------------------------------------------
// CA-7 — rootScope documentado como parser, no como validador
// -----------------------------------------------------------------------------

test('CA-7 — rootScope parsea y no valida: devuelve algo para cualquier entrada', () => {
    assert.equal(rootScope('providers:anthropic'), 'providers');
    assert.equal(rootScope('aws'), 'aws');
    assert.equal(rootScope('../../FAKE-otro/aws:x'), '../../FAKE-otro/aws');
    assert.equal(rootScope(''), '');

    // Por eso su salida se compone SIEMPRE con verificacion de pertenencia.
    assert.equal(SECRET_SCOPES.includes(rootScope('../../FAKE-otro/aws:x')), false);
    assert.equal(SECRET_SCOPES.includes(rootScope('providers:anthropic')), true);
});

test('CA-7 — el JSDoc advierte que la salida nunca se usa sola y da la forma correcta', () => {
    const jsdoc = SOURCE.slice(SOURCE.indexOf('Devuelve la raiz de un scope'), SOURCE.indexOf('function rootScope'));

    assert.ok(/PARSER, NO UN VALIDADOR/.test(jsdoc));
    assert.ok(/NUNCA se usa sola/.test(jsdoc));
    // UX-4: una advertencia sin alternativa se ignora; con alternativa se copia.
    assert.ok(/SECRET_SCOPES\.includes\(rootScope\(/.test(jsdoc),
        'el JSDoc debe mostrar la composicion correcta, no solo prohibir el mal uso');
});

// -----------------------------------------------------------------------------
// CA-8 — todo scope tiene clasificacion de herencia explicita
// -----------------------------------------------------------------------------

test('CA-8 — heredables y no heredables forman una particion exacta de SECRET_SCOPES', () => {
    const heredables = new Set(INHERITABLE_SCOPES);
    const noHeredables = new Set(NON_INHERITABLE_SCOPES);

    const sinClasificar = SECRET_SCOPES.filter((s) => !heredables.has(s) && !noHeredables.has(s));
    assert.deepEqual(sinClasificar, [],
        'un scope sin clasificar nace heredable por silencio: escalada de privilegios por omision');

    const solapados = SECRET_SCOPES.filter((s) => heredables.has(s) && noHeredables.has(s));
    assert.deepEqual(solapados, [], 'un scope no puede ser heredable y no heredable a la vez');

    const forasteros = [...heredables, ...noHeredables].filter((s) => !SECRET_SCOPES.includes(s));
    assert.deepEqual(forasteros, [], 'clasificacion de un scope que no existe en el vocabulario');

    assert.equal(heredables.size + noHeredables.size, SECRET_SCOPES.length);
});

test('CA-8 — aws y github siguen siendo no heredables', () => {
    assert.deepEqual([...NON_INHERITABLE_SCOPES].sort(), ['aws', 'github']);
    assert.equal(Object.isFrozen(NON_INHERITABLE_SCOPES), true);
    assert.equal(Object.isFrozen(INHERITABLE_SCOPES), true);
});

// -----------------------------------------------------------------------------
// CA-9 — el test no toca credenciales reales ni AWS
// -----------------------------------------------------------------------------

test('CA-9 — ENV_MAPPING aporta solo nombres de variable, nunca valores', () => {
    const clavesDeProviders = Object.keys(ENV_MAPPING).filter((c) => c.startsWith('providers.'));

    assert.ok(clavesDeProviders.length > 0);
    for (const clave of clavesDeProviders) {
        // El descriptor expone el NOMBRE de la env var; el valor no vive aca.
        const descriptor = ENV_MAPPING[clave];
        const nombre = typeof descriptor === 'string' ? descriptor : descriptor && descriptor.env;
        assert.equal(typeof nombre, 'string');
        assert.ok(/^[A-Z0-9_]+$/.test(nombre), `"${nombre}" no parece un nombre de variable de entorno`);
    }
});

test('CA-9 — requerir credentials no muta process.env', () => {
    const antes = Object.keys(process.env).length;
    delete require.cache[require.resolve('../credentials')];
    require('../credentials');
    assert.equal(Object.keys(process.env).length, antes);
});
