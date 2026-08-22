// =============================================================================
// _test-helpers.js — Helpers compartidos para tests Node del pipeline
//
// `ensureGitOnPath()` resuelve `git.exe` cuando el PATH heredado no lo trae
// (caso típico cuando el pulpo arranca con PATH stripped en Windows) y lo
// prepende a `process.env.PATH` para que `spawnSync('git', …)` y
// `execSync('git …')` funcionen dentro de los tests.
//
// Razón (rebote #2893): el tester determinístico ya hace este mismo trabajo
// antes de spawnear `node --test` (ver `.pipeline/skills-deterministicos/
// tester.js → resolveGitDir()`). Pero cuando la versión deployada del tester
// en `main` no incluye ese fix, los child node procesos heredan un PATH sin
// git y todos los tests que invocan git via spawn explotan con ENOENT.
// Este helper hace al test suite robusto sin depender de qué versión del
// tester esté corriendo.
// =============================================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const GIT_FALLBACK_DIRS_WIN32 = [
    'C:\\Program Files\\Git\\cmd',
    'C:\\Program Files\\Git\\bin',
    'C:\\Program Files\\Git\\mingw64\\bin',
    'C:\\Program Files (x86)\\Git\\cmd',
    'C:\\Program Files (x86)\\Git\\bin',
];
const GIT_PROBE_TIMEOUT_MS = 15000;

let _cached = undefined; // undefined = no chequeado, null = no encontrado, string = path

/**
 * Verifica si `git` es invocable en el PATH actual.
 */
function gitIsInvokable() {
    try {
        const r = spawnSync('git', ['--version'], {
            encoding: 'utf8', windowsHide: true, shell: false, timeout: GIT_PROBE_TIMEOUT_MS,
        });
        return r && r.status === 0 && /^git version/.test(r.stdout || '');
    } catch {
        return false;
    }
}

/**
 * Localiza el directorio que contiene git.exe / git, sin asumir que esté en PATH.
 * Usa `where git` (Windows) / `which git` (Unix) primero, después paths estándar.
 * Devuelve `null` si no encuentra.
 */
function locateGitDir() {
    const lookup = process.platform === 'win32' ? 'where' : 'which';
    try {
        const r = spawnSync(lookup, ['git'], {
            encoding: 'utf8', windowsHide: true, shell: false, timeout: GIT_PROBE_TIMEOUT_MS,
        });
        if (r && r.status === 0 && typeof r.stdout === 'string') {
            const firstLine = r.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
            if (firstLine) {
                try {
                    const stat = fs.statSync(firstLine);
                    if (stat.isFile()) return path.dirname(firstLine);
                } catch { /* ignore */ }
            }
        }
    } catch { /* ignore */ }

    if (process.platform === 'win32') {
        for (const dir of GIT_FALLBACK_DIRS_WIN32) {
            try {
                if (fs.statSync(path.join(dir, 'git.exe')).isFile()) return dir;
            } catch { /* ignore */ }
        }
    }
    return null;
}

/**
 * Asegura que `git` sea invocable desde tests. Idempotente:
 *   - Si `git --version` ya funciona, no hace nada.
 *   - Si no, busca git.exe y lo prepende a `process.env.PATH`.
 *   - Si tampoco lo encuentra, devuelve false (los tests deberían skippearse).
 *
 * @returns {boolean} true si git quedó invokable; false si no se pudo.
 */
function ensureGitOnPath() {
    if (_cached === undefined) {
        if (gitIsInvokable()) {
            _cached = 'in-path';
        } else {
            const dir = locateGitDir();
            if (dir) {
                process.env.PATH = `${dir}${path.delimiter}${process.env.PATH || ''}`;
                _cached = gitIsInvokable() ? dir : null;
            } else {
                _cached = null;
            }
        }
    }
    return _cached !== null;
}

// =============================================================================
// Mocks de http.IncomingMessage / http.ServerResponse para tests de routers
// del pipeline. @since #3724 (wizard-session).
//
// `fakeHttpReq` emite el body async vía `req.on('data')/('end')` SOLO cuando
// se llama `_emitBody()`, replicando que el router se suscribe en una
// microtarea (igual que multi-provider-api.test.js).
// =============================================================================

/**
 * @param {{url?:string, method?:string, headers?:object, body?:string}} opts
 */
function fakeHttpReq({ url = '/', method = 'GET', headers = {}, body = '' } = {}) {
    const handlers = {};
    const req = {
        url,
        method,
        headers,
        on(ev, fn) { handlers[ev] = fn; return this; },
        _emitBody() {
            setImmediate(() => {
                if (handlers.data && body) handlers.data(Buffer.from(body, 'utf8'));
                if (handlers.end) handlers.end();
            });
        },
        destroy() { this._destroyed = true; },
    };
    return req;
}

function fakeHttpRes() {
    let resolved;
    const done = new Promise((r) => { resolved = r; });
    const res = {
        _status: null,
        _headers: {},
        _body: '',
        writeHead(status, headers) {
            this._status = status;
            this._headers = { ...this._headers, ...(headers || {}) };
            return this;
        },
        setHeader(k, v) { this._headers[k] = v; },
        end(body) {
            this._body = body == null ? '' : String(body);
            resolved(this);
        },
    };
    res.done = done;
    return res;
}

// =============================================================================
// seedPipelineConfig — #5172
// =============================================================================
//
// Desde que la lectura de `config.yaml` pasa por `lib/config-resolver`, un
// directorio de pipeline SIN `config.yaml` es un fallo de lectura tipado
// (`ConfigParseViolation`) y ya NO degrada en silencio a los defaults del
// consumidor. Eso es justo lo que la historia viene a arreglar en producción,
// pero deja al descubierto que decenas de tests montaban su sandbox
// (`PIPELINE_DIR_OVERRIDE` / `pipelineRoot` a un `mkdtemp`) sin config alguna y
// venían corriendo, sin saberlo, contra la rama del `catch`.
//
// Este helper materializa la config del sandbox de forma explícita.
//
// ## Por qué el default es un documento VACÍO (`{}`) y no una config rica
//
// Paridad de valores efectivos (CA-18). El contrato que estos tests ejercitaban
// es *"sección ausente ⇒ default seguro del consumidor"* (D-4), que sigue
// intacto: un config VÁLIDO sin `waves.max_concurrency` da
// `WAVE_MAX_CONCURRENCY_DEFAULT`, exactamente el mismo 10 que antes producía el
// `catch`. Sembrar valores concretos cambiaría silenciosamente lo que el test
// afirma. Quien necesite un valor distinto lo pide por `extra` y queda a la
// vista en el test.
//
// `pipelines: {}` es config válida sin fases declaradas ⇒ enum de fases vacío
// ⇒ `FALLBACK_PHASES` en `deliverable-index`, que es el mismo camino que esos
// fixtures tomaban antes.

/**
 * Escribe un `config.yaml` mínimo y VÁLIDO en el directorio de pipeline de un
 * sandbox de test. Idempotente: sobrescribe.
 *
 * @param {string} pipelineDir - directorio que hará de `.pipeline/` (el que se
 *   pasa como `PIPELINE_DIR_OVERRIDE` o `pipelineDir`). Se crea si no existe.
 * @param {object} [extra] - secciones adicionales a mergear en la raíz del
 *   documento, para el test que necesite un valor concreto (ej.
 *   `{ waves: { max_concurrency: 3 } }`).
 * @returns {string} ruta del `config.yaml` escrito.
 */
function seedPipelineConfig(pipelineDir, extra = {}, product = undefined) {
    const yaml = require('js-yaml'); // eslint-disable-line global-require
    const file = path.join(pipelineDir, 'config.yaml');
    assertSandbox(file);
    fs.mkdirSync(pipelineDir, { recursive: true });
    fs.writeFileSync(file, yaml.dump({ pipelines: {}, ...extra }), 'utf8');
    // #5174 — la configuración vive PARTIDA: un sandbox con `config.yaml` pero
    // sin manifiesto de producto es corrupción TOTAL (CA-5), no un sandbox a
    // medias. Se siembran los dos SIEMPRE, y por el mismo camino que usa el
    // resolver para ubicarlos, así el helper no puede quedar desfasado de la
    // regla de derivación de rutas.
    seedProductManifest(pipelineDir, product);
    return file;
}

// #5174 — Raíz del repo. Los helpers de siembra escriben CONFIGURACIÓN, así que
// un `pipelineDir` mal pasado no produce un test rojo: produce un
// `.pipeline/config.yaml` o un `pipeline.config.json` de PRODUCCIÓN pisado con
// un documento de fixture. Pasó de verdad al migrar los sandboxes de esta
// entrega, y el síntoma fue un test ajeno fallando en OTRO archivo — nunca el
// que causaba el daño.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * Aborta si la ruta a sembrar cae dentro del repo. Un sandbox vive en un
 * `mkdtemp`; escribir adentro del checkout nunca es lo que el test quiso.
 * @param {string} file
 */
function assertSandbox(file) {
    const rel = path.relative(REPO_ROOT, path.resolve(file));
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        throw new Error(
            `[_test-helpers] me pediste sembrar configuración DENTRO del repo (${rel}). `
            + 'Los sandboxes van en un mkdtemp: sembrar acá pisa la configuración de producción '
            + 'y el daño aparece como un test ajeno en rojo, no como este error.'
        );
    }
}

/**
 * #5174 — Siembra el manifiesto de producto en la ubicación que le corresponde a
 * un `pipelineDir` dado.
 *
 * Existe para los sandboxes que escriben su `config.yaml` a mano (porque
 * ejercitan un contenido específico: corrupto, a medio escribir, con una sección
 * puntual) y por eso no pueden usar `seedPipelineConfig`.
 *
 * ## Modo AUTO-PARTICIÓN (sin `product` explícito)
 *
 * Los fixtures se escribieron cuando la configuración era un archivo único, así
 * que declaran claves de los dos lados mezcladas — `pipelines.*.skills_por_fase`
 * es el caso masivo: el schema la exige y es lado producto. Sin partirlas, cada
 * fixture sería una violación de lado y el test rojo NO diría nada sobre el
 * comportamiento que ejercita.
 *
 * Por eso el helper le aplica al fixture **la misma partición que se le aplicó a
 * producción**, con la MISMA fuente de verdad (`checkSide` sobre la lista
 * congelada de #5173): saca del `config.yaml` lo que es del producto y lo pone
 * en el manifiesto. Reescribir el fixture, en vez de relajar la regla, es lo que
 * mantiene al test ejercitando la partición real.
 *
 * Un `config.yaml` que no parsea (fixture corrupto A PROPÓSITO) no se toca: ahí
 * lo que el test ejercita es justamente el fail-closed.
 *
 * @param {string} pipelineDir - directorio donde vive el `config.yaml`.
 * @param {object} [product] - contenido explícito de `productConfig`. Si se
 *   omite, se auto-particiona el `config.yaml` que haya en `pipelineDir`.
 * @returns {string} ruta del manifiesto escrito.
 */
function seedProductManifest(pipelineDir, product) {
    const resolver = require('../config-resolver'); // eslint-disable-line global-require
    const file = resolver.productPathFor(pipelineDir);
    assertSandbox(file);
    let slice = product;
    if (slice === undefined) {
        slice = {};
        const yaml = require('js-yaml');            // eslint-disable-line global-require
        const schema = require('../config-schema'); // eslint-disable-line global-require
        const yamlPath = path.join(pipelineDir, 'config.yaml');
        try {
            const doc = yaml.load(fs.readFileSync(yamlPath, 'utf8'));
            if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
                const rutas = schema.checkSide(doc, 'kernel').errors
                    .map((e) => e.path.split('/').filter(Boolean));
                for (const segs of rutas) {
                    let src = doc;
                    let dst = slice;
                    for (let i = 0; i < segs.length - 1; i++) {
                        if (!dst[segs[i]]) dst[segs[i]] = {};
                        dst = dst[segs[i]];
                        src = src[segs[i]];
                    }
                    const hoja = segs[segs.length - 1];
                    dst[hoja] = src[hoja];
                    delete src[hoja];
                }
                if (rutas.length) fs.writeFileSync(yamlPath, yaml.dump(doc), 'utf8');
            }
        } catch { /* fixture ilegible a propósito: el test ejercita el fail-closed */ }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ [resolver.PRODUCT_CONFIG_KEY]: slice }, null, 2) + '\n', 'utf8');
    return file;
}

/**
 * #5174 — Siembra el manifiesto de producto REAL del repo junto a un fixture que
 * es una COPIA del `config.yaml` real.
 *
 * `seedProductManifest` en modo auto-partición no sirve para ese caso y el modo
 * de fallo es traicionero: el `config.yaml` real YA está partido, así que no
 * tiene ninguna clave de producto para mover, la auto-partición produce un slice
 * VACÍO y el documento mergeado queda sin `pipelines.*.skills_por_fase` — que el
 * schema exige. El test no falla diciendo «falta el manifiesto»: falla diciendo
 * «falta una clave requerida», que apunta al lado equivocado.
 *
 * La regla para elegir helper:
 *   - fixture COPIADO del `config.yaml` real  → `seedRealProductManifest`
 *   - fixture YAML mínimo escrito a mano      → `seedProductManifest`
 *
 * @param {string} pipelineDir - directorio donde vive el `config.yaml` del fixture.
 * @returns {string} ruta del manifiesto escrito.
 */
/**
 * #5174 — La configuración EFECTIVA del repo: `.pipeline/config.yaml` (kernel)
 * mergeado con `pipeline.config.json → productConfig`.
 *
 * Post-partición, `yaml.load('.pipeline/config.yaml')` ya NO es la configuración
 * del pipeline: es un lado. Todo test que afirme algo sobre "lo que el pipeline
 * ve" (coherencia de whitelists, tablas de ruteo, `skills_por_fase`) tiene que
 * mirar el merge, o afirma sobre un documento que en producción no existe.
 *
 * Es la vía de COMPARACIÓN (`resolveForDiff`), no la de enforcement: no cachea,
 * no trazea y no toca `process.env`, así que es segura de llamar desde cualquier
 * test sin ensuciar el estado del resolver.
 *
 * @returns {object} documento efectivo (kernel + producto).
 */
function readEffectiveConfig() {
    const resolver = require('../config-resolver'); // eslint-disable-line global-require
    const { config } = resolver.resolveMergedForDiff({
        kernelText: fs.readFileSync(path.join(REPO_ROOT, '.pipeline', 'config.yaml'), 'utf8'),
        productText: fs.readFileSync(path.join(REPO_ROOT, resolver.PRODUCT_FILENAME), 'utf8'),
    });
    return config;
}

function seedRealProductManifest(pipelineDir) {
    const resolver = require('../config-resolver'); // eslint-disable-line global-require
    const real = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, resolver.PRODUCT_FILENAME), 'utf8'));
    return seedProductManifest(pipelineDir, real[resolver.PRODUCT_CONFIG_KEY] || {});
}

/**
 * Variante para los sandboxes cuya raíz es el REPO ROOT (los que pasan
 * `pipelineRoot`/`repoRoot`, no el `.pipeline/` directo): siembra en
 * `<repoRoot>/.pipeline/config.yaml`.
 *
 * @param {string} repoRoot
 * @param {object} [extra]
 * @returns {string} ruta del `config.yaml` escrito.
 */
function seedRepoRootConfig(repoRoot, extra = {}, product = undefined) {
    return seedPipelineConfig(path.join(repoRoot, '.pipeline'), extra, product);
}

module.exports = {
    ensureGitOnPath,
    seedProductManifest,
    seedRealProductManifest,
    readEffectiveConfig,
    locateGitDir,
    gitIsInvokable,
    fakeHttpReq,
    fakeHttpRes,
    seedPipelineConfig,
    seedRepoRootConfig,
};
