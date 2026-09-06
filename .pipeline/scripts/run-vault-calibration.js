#!/usr/bin/env node
'use strict';

// =============================================================================
// run-vault-calibration.js — Issue #5805 (hija de #5800)
//
// Ejecuta la carga reproducible contra el vault y publica el artefacto de
// evidencia en `.pipeline/audit/vault-load-calibration.json`.
//
// ESTE ARCHIVO NO TIENE LÓGICA DE NEGOCIO. Todo lo que valida, mide, calcula o
// construye evidencia vive en `../lib/vault-load-calibration.js` (#5805), que a
// su vez consume el núcleo/runner de `../lib/vault-calibration-scenario.js`
// (#5804) y el enum de telemetría de `../lib/secret-vault.js` (#5803).
//
// Acá sólo hay: parseo de argumentos, lectura de stdin, cableado de los puertos
// reales (git, fs, crypto, reloj y el driver que resuelve contra el vault),
// traducción de `code` a código de salida + texto de operador, y `exitCode`.
//
// Uso:
//   cat corrida.json | node .pipeline/scripts/run-vault-calibration.js --stdin
//   cat corrida.json | node .pipeline/scripts/run-vault-calibration.js --stdin --json
//   node .pipeline/scripts/run-vault-calibration.js --help
//
// Sobre esperado por stdin (claves CERRADAS):
//   {
//     "scenario": {                      // contrato de #5804
//       "window_start_ms": 1735689600000,
//       "window_duration_ms": 60000,
//       "bucket_ms": 10000,
//       "concurrency": 8,
//       "launches": 16,
//       "distribution": "sequential",    // sequential | uniform | burst
//       "sequence_seed": 7,
//       "unit": "physical_read"
//     },
//     "required_commits": [              // las cuatro dependencias duras
//       { "issue": 5339, "commit": "<sha>" },
//       { "issue": 5340, "commit": "<sha>" },
//       { "issue": 5791, "commit": "<sha>" },
//       { "issue": 5792, "commit": "<sha>" }
//     ],
//     "project_id": "<producto>",
//     "scope_logico": "<nombre logico del scope medido>",
//     "shared_scopes": []                // opcional
//   }
//
// IMPORTANTE — la corrida INVALIDA la evidencia anterior: al arrancar borra
// `.pipeline/audit/vault-load-calibration.json` y los temporales que hayan
// quedado. Es deliberado (CA-1): una evidencia de otro HEAD conviviendo con una
// corrida fallida se confunde con la nueva y termina firmando un umbral falso.
// =============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const {
    runCalibration,
    createGitPort,
    ARTIFACT_FILENAME,
    LOAD_CALIBRATION_ERROR_CODES: E,
} = require('../lib/vault-load-calibration');

// #5800 — el núcleo de escenario de #5804 propaga sus `CalibrationError` TAL CUAL
// a través de `runCalibration` (`vault-load-calibration.js`: `if (err instanceof
// CalibrationError) throw err;`). Por lo tanto sus códigos llegan a ESTE borde y
// también necesitan fila de traducción: sin ella salían por el `FALLBACK` como
// "condicion no prevista / reportar el incidente" con salida 8 (interno), que le
// miente al operador cuando lo que pasó fue un parámetro mal declarado.
const { CALIBRATION_ERROR_CODES: N } = require('../lib/vault-calibration-scenario');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AUDIT_DIR = path.join(REPO_ROOT, '.pipeline', 'audit');
/** Ruta RELATIVA para mostrarle al operador: un path absoluto no se imprime. */
const ARTIFACT_RELATIVO = `.pipeline/audit/${ARTIFACT_FILENAME}`;

/**
 * Códigos de salida ESTABLES. Un operador (o un wrapper) discrimina por número,
 * no parseando el mensaje. La numeración separa "no llegué a medir" (1-4) de "la
 * medición no cerró" (5-6) y de "no pude publicar" (7).
 */
const EXIT = Object.freeze({
    OK: 0,
    USAGE: 1,        // argumentos ausentes, desconocidos o mal formados
    INPUT: 2,        // stdin ausente, no es JSON, o el sobre tiene claves ajenas
    PREFLIGHT: 3,    // HEAD, árbol sucio o dependencia no integrada
    IDENTITY: 4,     // la identidad no es de sólo lectura o excede los scopes
    RUN: 5,          // el escenario o el runner no pasaron la validación
    EVIDENCE: 6,     // la evidencia no cierra o no está limpia
    PUBLISH: 7,      // no se pudo publicar el artefacto
    INTERNAL: 8,     // excepción no prevista, ya sanitizada
});

/** Claves admitidas en el sobre de stdin. Enum CERRADO. */
const PAYLOAD_KEYS = Object.freeze([
    'scenario', 'required_commits', 'project_id', 'scope_logico', 'shared_scopes',
]);

/**
 * Traducción de cada `code` a (salida, impacto, próximo paso).
 *
 * Los textos son literales ESTÁTICOS: nunca se interpola el input, así que esta
 * tabla no puede reintroducir un canario que el módulo ya descartó. El `detail`
 * del error (nombres de campo e índices, ya saneados) se imprime aparte.
 */
const TRADUCCION = Object.freeze({
    [E.HEAD_UNRESOLVED]: [EXIT.PREFLIGHT,
        'no se pudo resolver el SHA de HEAD, asi que la medicion no seria atribuible a ningun codigo',
        'correr el comando dentro del repo, con un HEAD valido (`git rev-parse HEAD`)'],
    [E.WORKTREE_DIRTY]: [EXIT.PREFLIGHT,
        'el arbol de trabajo tiene cambios sin commitear: el SHA registrado no describiria el codigo que corrio',
        'commitear o descartar los cambios y volver a correr (`git status --porcelain` debe quedar vacio)'],
    [E.INTEGRATION_UNRESOLVED]: [EXIT.PREFLIGHT,
        'el commit declarado para esa dependencia no resuelve o es ambiguo, asi que no se puede probar que este integrado',
        'corregir el SHA de la dependencia informada en `detail.field` (usar el commit completo de 40 hex)'],
    [E.INTEGRATION_MISSING]: [EXIT.PREFLIGHT,
        'esa dependencia NO esta integrada en el HEAD: la calibracion medida seria sobre un codigo incompleto',
        'mergear la dependencia informada en `detail.field` y volver a correr sobre el HEAD integrado'],
    [E.REQUIRED_COMMITS_INVALID]: [EXIT.INPUT,
        'la lista de dependencias no paso la validacion, asi que no se verifico ninguna integracion',
        'revisar `required_commits`: cada entrada es `{issue, commit}` con SHA hexadecimal en minuscula'],
    [E.GIT_PORT_MISSING]: [EXIT.INTERNAL,
        'no se pudo construir el acceso a git, asi que no hubo preflight',
        'verificar que `git` este en el PATH y que el comando corra dentro del repo'],
    [E.IDENTITY_INVALID]: [EXIT.IDENTITY,
        'la identidad declarada no tiene la forma esperada y la corrida no se ejecuto',
        'declarar `scope_logico` como nombre logico en minusculas (sin ARN, path ni account id)'],
    [E.IDENTITY_NOT_READ_ONLY]: [EXIT.IDENTITY,
        'la corrida exige una identidad de SOLO LECTURA y la provista no lo es',
        'ejecutar con la identidad de lectura del vault; ningun verbo de escritura puede estar disponible'],
    [E.IDENTITY_SCOPES_EXCESIVOS]: [EXIT.IDENTITY,
        'la identidad tiene mas scopes que el que se mide: seria privilegio sin justificacion',
        'acotar la identidad al unico scope declarado en `scope_logico`'],
    [E.UNKNOWN_FIELD]: [EXIT.INPUT,
        'la entrada trae un campo de mas y se rechazo entera: un campo desconocido puede ser un parametro viejo que ya no se respeta',
        'quitar el campo informado en `detail.field` o corregir su nombre'],
    [E.SCOPE_INVALID]: [EXIT.INPUT,
        'el scope declarado no es un nombre logico, asi que se rechazo antes de medir',
        'usar el NOMBRE logico del scope (minusculas, digitos, `_` y `-`), nunca su ARN ni su ruta'],
    [E.COUNTERS_INVALID]: [EXIT.RUN,
        'los contadores de resolucion no cubren exactamente las tres vias, asi que el pico seria inventado',
        'revisar la instrumentacion del vault: cada resolucion emite una y solo una categoria'],
    [E.WINDOW_INVALID]: [EXIT.RUN,
        'la ventana de medicion no paso la validacion y no se calculo ninguna metrica',
        'revisar `scenario`: la duracion debe ser multiplo exacto de `bucket_ms`'],
    [E.FORMULA_INVALID]: [EXIT.RUN,
        'la formula de extrapolacion pedida no esta soportada',
        'usar la familia `ceil_rate_extrapolation` con horizonte `month`'],
    [E.PREFLIGHT_INVALID]: [EXIT.RUN,
        'la procedencia de la corrida no paso la validacion',
        'volver a correr: el preflight y la medicion deben ocurrir en la misma pasada'],
    [E.RUNNER_FAILED]: [EXIT.RUN,
        'el runner no pudo completar la carga, asi que no hay medicion que publicar',
        'revisar el acceso de lectura al vault y volver a correr'],
    [E.RUNNER_RESULT_INVALID]: [EXIT.RUN,
        'el runner devolvio un resultado que no tiene la forma esperada',
        'reportar el incidente: es un defecto del nucleo de calibracion, no del escenario'],
    [E.NON_FINITE_RESULT]: [EXIT.EVIDENCE,
        'una metrica no dio un numero finito, asi que no se publica nada',
        'revisar la ventana y los contadores de la corrida'],
    [E.UNSAFE_INTEGER_RESULT]: [EXIT.EVIDENCE,
        'la extrapolacion excede el rango entero seguro y seria un numero enganoso',
        'acortar la ventana o reducir los launches del escenario'],
    [E.EVIDENCE_NOT_CLEAN]: [EXIT.EVIDENCE,
        'la evidencia contenia un dato que no puede publicarse y se descarto entera',
        'reportar el incidente: ningun dato sensible deberia llegar al artefacto'],
    [E.ARTIFACT_DIR_INVALID]: [EXIT.PUBLISH,
        'el directorio del artefacto no es valido, asi que no se publico nada',
        'verificar que `.pipeline/audit/` exista y sea escribible'],
    [E.ARTIFACT_WRITE_FAILED]: [EXIT.PUBLISH,
        'no se pudo escribir el artefacto; no quedo ningun archivo a medio publicar',
        'verificar permisos y espacio en disco, y volver a correr'],
    [E.PORT_MISSING]: [EXIT.INTERNAL,
        'falto un puerto obligatorio, asi que la corrida no arranco',
        'reportar el incidente: es un defecto de cableado del wrapper'],

    // -------------------------------------------------------------------------
    // Códigos del núcleo de escenario (#5804) que atraviesan `runCalibration`.
    //
    // Se agrupan por QUIÉN puede corregirlos, que es lo que decide el código de
    // salida: el escenario del sobre lo escribe el operador (corrida, 5), la
    // procedencia la demuestra el preflight (3), el número lo produce el cálculo
    // (evidencia, 6) y el cableado del wrapper es defecto nuestro (interno, 8).
    // -------------------------------------------------------------------------

    // -- Escenario declarado por el operador -> EXIT.RUN --
    [N.SCENARIO_NOT_OBJECT]: [EXIT.RUN,
        'no hay escenario que calibrar, asi que la corrida no arranco',
        'mandar `scenario` como objeto JSON plano (ver --help)'],
    [N.UNKNOWN_FIELD]: [EXIT.RUN,
        'el escenario trae un campo de mas y se rechazo entero: un campo desconocido puede ser un parametro viejo que ya no se respeta',
        'quitar del `scenario` el campo informado en `detail.field` o corregir su nombre'],
    [N.MISSING_FIELD]: [EXIT.RUN,
        'sin ese campo no hay default posible: completarlo en silencio produciria una calibracion inventada',
        'declarar explicitamente en `scenario` el campo informado en `detail.field`'],
    [N.NOT_INTEGER]: [EXIT.RUN,
        'no se redondea por las nuestras: una fraccion o un no-numero ahi corromperia el bucket y el pico',
        'mandar un entero seguro en el campo informado en `detail.field`'],
    [N.OUT_OF_RANGE]: [EXIT.RUN,
        'el valor excede el tope del contrato y se rechazo ANTES de medir',
        'bajar el valor por debajo del tope informado en `detail.limit`'],
    [N.NOT_STRING]: [EXIT.RUN,
        'el campo no es texto, asi que no se pudo validar contra su enum cerrado',
        'mandar una cadena en el campo informado en `detail.field`'],
    [N.STRING_TOO_LONG]: [EXIT.RUN,
        'el texto excede el tope y se rechazo antes de copiarse a la evidencia',
        'acortar el campo informado en `detail.field` por debajo de `detail.limit`'],
    [N.STRING_MALFORMED]: [EXIT.RUN,
        'el texto no respeta el formato del contrato y no puede viajar a la unidad de la evidencia',
        'usar un identificador en minusculas, digitos, `-` y `_`'],
    [N.UNKNOWN_DISTRIBUTION]: [EXIT.RUN,
        'no se cae a una distribucion por defecto: eso haria irreproducible la corrida',
        'elegir una de las distribuciones que lista --help'],
    [N.WINDOW_NOT_DIVISIBLE]: [EXIT.RUN,
        'un bucket final mas corto haria que el pico no sea comparable entre corridas',
        'ajustar `bucket_ms` para que divida exacto a `window_duration_ms`'],
    [N.TOO_MANY_BUCKETS]: [EXIT.RUN,
        'la ventana se parte en mas buckets que el tope y se rechazo antes de medir',
        'agrandar `bucket_ms` o achicar `window_duration_ms`'],

    // -- Clave peligrosa en el JSON de entrada -> EXIT.INPUT --
    [N.UNSAFE_KEY]: [EXIT.INPUT,
        'la entrada trae una clave de herencia peligrosa y se descarto entera',
        'quitar `__proto__` / `constructor` / `prototype` del JSON de entrada'],

    // -- Lote emitido por la instrumentacion durante la corrida -> EXIT.RUN --
    [N.EVENTS_NOT_ARRAY]: [EXIT.RUN,
        'la corrida no produjo un lote de eventos agregable, asi que no hay medicion que publicar',
        'reportar el incidente: el lote lo emite la instrumentacion del vault, no el sobre'],
    [N.TOO_MANY_EVENTS]: [EXIT.RUN,
        'la corrida emitio mas eventos que el tope y se corto ANTES de agregar: es la defensa de memoria y CPU',
        'bajar `launches` o acortar `window_duration_ms` y volver a correr'],
    [N.EVENT_NOT_OBJECT]: [EXIT.RUN,
        'un evento invalido no se descarta en silencio: se rechaza la corrida entera',
        'reportar el incidente con el indice informado en `detail.index`: es un defecto de la instrumentacion'],
    [N.UNKNOWN_CATEGORY]: [EXIT.RUN,
        'una categoria fuera del vocabulario haria que el conteo no cierre contra la instrumentacion',
        'reportar el incidente: el vocabulario lo define el vault y la corrida no puede ampliarlo'],
    [N.EVENT_OUT_OF_WINDOW]: [EXIT.RUN,
        'un evento fuera de la ventana no tiene bucket, asi que la evidencia seria parcial',
        'revisar `window_start_ms` / `window_duration_ms`: la ventana debe cubrir toda la corrida'],
    [N.DUPLICATE_SEQUENCE]: [EXIT.RUN,
        'con `seq` repetido los empates dejan de resolverse y la evidencia deja de ser reproducible',
        'reportar el incidente: la secuencia la asigna el runner, no el sobre'],

    // -- Driver del vault -> EXIT.RUN (lo corrige el acceso, no el codigo) --
    [N.DRIVER_FAILED]: [EXIT.RUN,
        'una resolucion contra el vault fallo y su error se descarto entero para no filtrar payload; no se publico nada',
        'verificar el acceso de SOLO LECTURA al scope declarado en `scope_logico` (y que `project_id` sea el correcto) y volver a correr'],

    // -- Procedencia de la medicion -> EXIT.PREFLIGHT --
    [N.PROVENANCE_INVALID]: [EXIT.PREFLIGHT,
        'sin procedencia demostrable la evidencia no se puede atribuir a un commit',
        'volver a correr dentro del repo: el HEAD lo sella el preflight de la misma pasada'],
    [N.INVALID_HEAD_SHA]: [EXIT.PREFLIGHT,
        'un HEAD no verificable atribuiria la medicion al commit equivocado',
        'verificar que `git rev-parse HEAD` devuelva 40 caracteres hexadecimales en minusculas'],

    // -- Metrica no representable -> EXIT.EVIDENCE --
    [N.NON_FINITE_RESULT]: [EXIT.EVIDENCE,
        'el calculo no es finito: se corta sin evidencia parcial en vez de publicar un numero enganoso',
        'revisar `window_duration_ms` y el total fisico de la corrida'],
    [N.UNSAFE_INTEGER_RESULT]: [EXIT.EVIDENCE,
        'la extrapolacion desborda el entero seguro y dejaria de ser exacta',
        'alargar la ventana o bajar los launches para reducir el factor de extrapolacion'],

    // -- Defectos de nucleo o de cableado del wrapper -> EXIT.INTERNAL --
    [N.SUMMARY_INVALID]: [EXIT.INTERNAL,
        'el resumen intermedio no cumple su contrato y no se construyo evidencia',
        'reportar el caso: es un defecto del nucleo de calibracion, no de la entrada'],
    [N.PORT_MISSING]: [EXIT.INTERNAL,
        'el nucleo no recibio un puerto obligatorio, asi que no se midio nada',
        'reportar el incidente: es un defecto de cableado del wrapper'],
    [N.CLOCK_INVALID]: [EXIT.INTERNAL,
        'el reloj inyectado no cumple su contrato y no se sello la corrida',
        'reportar el incidente: el reloj lo inyecta el wrapper, no el sobre'],
    [N.RESOLVE_HEAD_FAILED]: [EXIT.INTERNAL,
        'no se pudo releer el HEAD ya demostrado por el preflight y la corrida se corto',
        'reportar el incidente: es un defecto de cableado del wrapper'],
    [N.DRIVER_RESULT_INVALID]: [EXIT.INTERNAL,
        'el driver devolvio algo que no cumple su contrato y la resolucion quedo sin clasificar',
        'reportar el incidente: el driver lo arma el wrapper, no el sobre'],
    [N.SINK_FAILED]: [EXIT.INTERNAL,
        'el sink del nucleo fallo despues de medir, asi que la corrida no llego a publicar',
        'reportar el incidente: esta corrida descarta el sink del nucleo, no deberia fallar'],
});

// -----------------------------------------------------------------------------
// Uso
// -----------------------------------------------------------------------------

const USO = `
run-vault-calibration — corrida de calibracion de trafico fisico del vault (#5805)

  cat corrida.json | node .pipeline/scripts/run-vault-calibration.js --stdin

Opciones
  --stdin    lee el sobre de la corrida desde la entrada estandar (obligatorio)
  --json     imprime el resultado como JSON (para consumo programatico)
  --help     muestra esta ayuda

Sobre esperado (claves cerradas)
  scenario          escenario de carga: window_start_ms, window_duration_ms,
                    bucket_ms, concurrency, launches, distribution,
                    sequence_seed, unit
  required_commits  [{issue, commit}] de las dependencias que el HEAD debe integrar
  project_id        producto cuyo namespace del vault se mide
  scope_logico      nombre logico del scope medido (nunca ARN ni ruta)
  shared_scopes     opcional, scopes compartidos del producto

Salida
  publica ${ARTIFACT_RELATIVO} con permisos minimos.
  La corrida INVALIDA la evidencia anterior al arrancar: si falla, ese
  directorio queda limpio a proposito.

Codigos de salida
  0 ok · 1 uso · 2 entrada · 3 preflight · 4 identidad · 5 corrida
  6 evidencia · 7 publicacion · 8 interno
`.trim();

// -----------------------------------------------------------------------------
// Parseo de argumentos
// -----------------------------------------------------------------------------

function parseArgs(argv) {
    const out = { help: false, stdin: false, json: false, desconocido: null };
    for (const arg of argv) {
        if (arg === '--help' || arg === '-h') out.help = true;
        else if (arg === '--stdin') out.stdin = true;
        else if (arg === '--json') out.json = true;
        else { out.desconocido = arg; break; }
    }
    return out;
}

function leerStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch (e) {
        return null;
    }
}

/** Valida el sobre por allowlist. No valida el contenido: eso es del módulo. */
function parsearSobre(texto) {
    let sobre;
    try {
        sobre = JSON.parse(texto);
    } catch (e) {
        return { error: 'la entrada no es JSON valido' };
    }
    if (sobre === null || typeof sobre !== 'object' || Array.isArray(sobre)) {
        return { error: 'la entrada debe ser un objeto JSON' };
    }
    for (const clave of Object.keys(sobre)) {
        if (!PAYLOAD_KEYS.includes(clave)) {
            // Nombrar la clave sobrante es seguro (es un NOMBRE, no un valor) y
            // es la única forma de que el error sea accionable.
            return { error: `clave desconocida en el sobre: ${JSON.stringify(String(clave)).slice(0, 80)}` };
        }
    }
    for (const clave of ['scenario', 'required_commits', 'project_id', 'scope_logico']) {
        if (!Object.prototype.hasOwnProperty.call(sobre, clave)) {
            return { error: `falta \`${clave}\` en el sobre` };
        }
    }
    return { sobre };
}

// -----------------------------------------------------------------------------
// Cableado del driver real
// -----------------------------------------------------------------------------

/**
 * Traduce una resolución del vault a la categoría que la clasifica.
 *
 * No clasifica NADA por su cuenta: el `sink` es por invocación, así que la
 * categoría la dicta el único evento que emite la capa que tomó la decisión
 * (`secret-vault.js` para `physical_read` / `cache_hit`, `credentials.js` para
 * `single_flight_join`). Un sink por pedido es lo que mantiene la correlación
 * launch ↔ categoría exacta bajo concurrencia, sin observar eventos ajenos.
 *
 * @param {object} deps
 * @param {object} deps.credentials módulo `credentials.js` (inyectable para tests)
 * @param {string} deps.projectId
 * @param {string} deps.scope
 * @param {string[]} [deps.sharedScopes]
 * @returns {function(): Promise<{category:string}>}
 */
function createVaultResolutionDriver({ credentials, projectId, scope, sharedScopes }) {
    return async function driver() {
        let categoria = null;
        const resultado = await credentials.resolveInstanceVaultAsync(
            {
                projectId,
                scopes: [scope],
                sharedScopes: Array.isArray(sharedScopes) ? sharedScopes : [],
            },
            // Latch de "a lo sumo un evento por invocación": la primera categoría
            // emitida es la de ESTA resolución.
            { vaultSink: (evento) => { if (categoria === null && evento) categoria = evento.category; } },
        );

        if (!resultado || resultado.ok !== true) {
            // El error del vault se DESCARTA: su texto puede traer namespace,
            // ruta o diagnóstico del backend. Sólo sobrevive un código propio.
            const err = new Error('VAULT_RESOLUTION_FAILED');
            err.code = 'VAULT_RESOLUTION_FAILED';
            throw err;
        }
        if (categoria === null) {
            // Sin evento no hay resolución clasificable: fail-closed, nunca se
            // asume una categoría por default.
            const err = new Error('VAULT_RESOLUTION_UNCLASSIFIED');
            err.code = 'VAULT_RESOLUTION_UNCLASSIFIED';
            throw err;
        }
        return { category: categoria };
    };
}

// -----------------------------------------------------------------------------
// Salida
// -----------------------------------------------------------------------------

function traducir(err) {
    const entrada = err && err.code ? TRADUCCION[err.code] : null;
    if (entrada) return { exit: entrada[0], impacto: entrada[1], siguiente: entrada[2] };
    return {
        exit: EXIT.INTERNAL,
        impacto: 'la corrida termino por una condicion no prevista y no se publico nada',
        siguiente: 'reportar el incidente con el codigo de error informado',
    };
}

function imprimirError(err, json) {
    const { exit, impacto, siguiente } = traducir(err);
    const code = (err && err.code) || 'DESCONOCIDO';
    const detail = (err && err.detail) || {};
    if (json) {
        console.log(JSON.stringify({ ok: false, code, detail, impacto, siguiente }));
    } else {
        console.error(`[calibracion] FALLO ${code}`);
        if (detail && Object.keys(detail).length > 0) {
            console.error(`[calibracion] detalle: ${JSON.stringify(detail)}`);
        }
        console.error(`[calibracion] impacto: ${impacto}`);
        console.error(`[calibracion] proximo paso: ${siguiente}`);
    }
    return exit;
}

function imprimirOk(evidence, json) {
    if (json) {
        console.log(JSON.stringify({ ok: true, artifact: ARTIFACT_RELATIVO, evidence }));
        return EXIT.OK;
    }
    console.log('[calibracion] corrida completa');
    console.log(`[calibracion] HEAD medido: ${evidence.head_sha}`);
    console.log(`[calibracion] integraciones verificadas: ${evidence.integrated_commits.map((c) => `#${c.issue}`).join(', ')}`);
    console.log(`[calibracion] ventana: ${evidence.window.started_at} · ${evidence.window.duration_ms} ms · `
        + `${evidence.window.launches} launches · concurrencia ${evidence.window.concurrency} · ${evidence.window.distribution}`);
    console.log(`[calibracion] resoluciones: ${JSON.stringify(evidence.counts)}`);
    console.log(`[calibracion] pico: ${evidence.peak_physical_reads_per_minute} ${evidence.peak_unit}`);
    console.log(`[calibracion] extrapolacion: ${evidence.monthly_extrapolation} ${evidence.formula.unit}`);
    console.log(`[calibracion] formula: ${evidence.formula.expression}`);
    console.log(`[calibracion] sustitucion: ${evidence.formula.substitution}`);
    console.log(`[calibracion] artefacto: ${ARTIFACT_RELATIVO}`);
    return EXIT.OK;
}

// -----------------------------------------------------------------------------
// main
// -----------------------------------------------------------------------------

async function main(argv, deps = {}) {
    const args = parseArgs(argv);

    if (args.help) {
        console.log(USO);
        return EXIT.OK;
    }
    if (args.desconocido !== null) {
        console.error(`[calibracion] argumento desconocido: ${JSON.stringify(String(args.desconocido)).slice(0, 80)}`);
        console.error(USO);
        return EXIT.USAGE;
    }
    if (!args.stdin) {
        console.error('[calibracion] falta --stdin: el sobre de la corrida se lee por la entrada estandar');
        console.error(USO);
        return EXIT.USAGE;
    }

    const texto = deps.stdinTexto !== undefined ? deps.stdinTexto : leerStdin();
    if (typeof texto !== 'string' || texto.trim() === '') {
        console.error('[calibracion] no llego ningun sobre por stdin');
        return EXIT.INPUT;
    }
    const parseado = parsearSobre(texto);
    if (parseado.error) {
        console.error(`[calibracion] ${parseado.error}`);
        return EXIT.INPUT;
    }
    const sobre = parseado.sobre;

    const credentials = deps.credentials || require('../lib/credentials');
    const driver = createVaultResolutionDriver({
        credentials,
        projectId: sobre.project_id,
        scope: sobre.scope_logico,
        sharedScopes: sobre.shared_scopes,
    });

    try {
        const { evidence } = await runCalibration({
            git: deps.git || createGitPort({
                execFileSync,
                cwd: REPO_ROOT,
                // Requisito 3 de Security: el hijo recibe SÓLO las variables
                // allowlisted del módulo, nunca `{ ...process.env }`.
                env: process.env,
            }),
            requiredCommits: sobre.required_commits,
            scenario: sobre.scenario,
            clock: deps.clock || (() => Date.now()),
            driver,
            // La corrida se ejecuta por el camino de SÓLO LECTURA del vault
            // (`VAULT_READONLY_COMMANDS`), acotado al único scope medido.
            identity: { read_only: true, scopes: [sobre.scope_logico] },
            scopeLogico: sobre.scope_logico,
            formula: { kind: 'ceil_rate_extrapolation', horizon: 'month' },
            dir: deps.dir || AUDIT_DIR,
            fs,
            crypto,
        });
        return imprimirOk(evidence, args.json);
    } catch (err) {
        return imprimirError(err, args.json);
    }
}

if (require.main === module) {
    main(process.argv.slice(2))
        .then((codigo) => { process.exitCode = codigo; })
        .catch(() => {
            // Red de seguridad: nada del error se imprime, puede traer paths.
            console.error('[calibracion] FALLO INTERNO no previsto');
            process.exitCode = EXIT.INTERNAL;
        });
}

module.exports = {
    main,
    TRADUCCION,
    parseArgs,
    parsearSobre,
    createVaultResolutionDriver,
    traducir,
    EXIT,
    PAYLOAD_KEYS,
    ARTIFACT_RELATIVO,
};
