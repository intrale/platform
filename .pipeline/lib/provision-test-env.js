// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

/**
 * #7111 (split de #7102) — PROVISIONADOR DEL AMBIENTE DE PRUEBAS DEL PIPELINE.
 *
 * Levanta, verifica y descarta un `pipelineDir` completo, reproducible y
 * desechable que vive FUERA del checkout y no comparte un solo archivo con el
 * `.pipeline` productivo. Es el destino que el resolvedor único (#7110) deja
 * en `dir: null` cuando está en modo `pruebas`: "#7111 provee el dir".
 *
 * ── Layout provisionado ─────────────────────────────────────────────────────
 *
 *   <root>/                       default: <tmpdir real>/intrale-pipeline-pruebas
 *   ├── pipeline.config.json      copia byte a byte del manifiesto de producto
 *   └── .pipeline/
 *       ├── config.yaml           productivo + overlay (durable/vault apagados)
 *       ├── ambiente-pruebas.json marcador: la LLAVE de `destroy`
 *       ├── waves.json.template   copia
 *       ├── waves.json            sembrado desde el template (no se pisa)
 *       ├── .partial-pause.json   allowlist vacía == running (no se pisa)
 *       ├── agent-models.json / agent-models.schema.json
 *       ├── descriptors/ roles/   copia con walk + lstat (abortar ante link)
 *       ├── <pipeline>/<fase>/<subestado>/   colas derivadas de config.yaml
 *       ├── servicios/<svc>/<subestado>/
 *       └── logs/ state/ rejections/ metrics/ audit/ events/ locks/ …  (vacíos)
 *
 * ── Decisiones cerradas (receta del arquitecto, D1–D11) ─────────────────────
 *
 * - D1  El provisionador APORTA el candidato y el resolvedor lo VALIDA: el
 *       candidato viaja sólo por `PIPELINE_DIR_OVERRIDE` en el env que recibe
 *       `pipelineEnv.resolve()`; nunca `opts.pipelineDir` (modo `explicito` no
 *       aplica SEC-3). Se exige `modo === 'pruebas' && dir !== null`.
 * - D2  Root fuera del checkout, layout fiel `<root>/.pipeline` + manifiesto en
 *       el padre (`config-resolver.productPathFor`).
 * - D3  fs puro + `pipeline-env`. No requiere `waves.js`, `partial-pause.js`,
 *       `project-context.js` ni `operational-state*` (leen `process.env`).
 * - D4  Allowlist de copia, nunca blacklist: `logs/` productivo pesa 2,2 GB de
 *       transcripts. Todo lo que no está en la allowlist se crea VACÍO.
 * - D5  Overlay obligatorio sobre `config.yaml`: `operational_state.durable`,
 *       `kernel.durable` y `vault.enabled` en `false` (precisión de guru: hay
 *       DOS flags `durable`).
 * - D6  Marcador sin timestamp (byte-idéntico entre corridas). Sin marcador con
 *       `modo: 'pruebas'`, `destroy` no borra nada.
 * - D7  Paths comparados SIEMPRE por `fs.realpathSync.native` (bypass 8.3:
 *       `os.tmpdir()` devuelve `ADMINI~1`), nunca por string.
 * - D8  Recorridos con `lstatSync`; cualquier link en origen o en el ambiente
 *       aborta (no saltea). Walk propio, nunca `fs.cpSync` (derreferencia
 *       junctions).
 * - D9  Sólo APIs `fs`. Única excepción: `execFileSync('git', ['rev-parse',
 *       'HEAD'])` con argv literal y best-effort.
 * - D10 Env saneado antes de resolver (`ENV_STRIP`). `--print-env` emite sólo
 *       la declaración de ambiente en `pruebas` (`ENV_AMBIENTE` del resolvedor;
 *       acá no se repite el literal: CA-8 de #7110 exige que `pipeline-env.js`
 *       sea el único módulo que lo nombra) y `PIPELINE_DIR_OVERRIDE=<root>/.pipeline`
 *       (#7112, SEC-9 estricto): el directorio viaja por la misma variable que
 *       validó D1. NO emite `PIPELINE_REPO_ROOT`: en `pruebas` es contexto
 *       heredado del checkout productivo, nunca aporta dir, y su `.pipeline`
 *       integra la unión que SEC-3 protege (apuntarlo al root de pruebas
 *       anularía el propio override).
 * - D11 No se toca `pipeline-env.js` ni `config-resolver.js`.
 *
 * ── Pureza ──────────────────────────────────────────────────────────────────
 *
 * `env`, `fs`, `os` y `execFileSync` se reciben por parámetro (`deps`), nunca
 * se lee la global de entorno del proceso. Los mensajes de error nombran paths
 * y variables, jamás valores del env (SEC-P9).
 *
 * @module provision-test-env
 */

const path = require('path');
const yaml = require('js-yaml');
const pipelineEnv = require('./pipeline-env');

// ─── Constantes ──────────────────────────────────────────────────────────────

/** Nombre del root default bajo `os.tmpdir()` (canonicalizado por realpath). */
const DEFAULT_ROOT_NAME = 'intrale-pipeline-pruebas';

/** Marcador que identifica un ambiente de pruebas. Llave de `destroy` (D6). */
const MARKER_FILENAME = 'ambiente-pruebas.json';

/** Versión del layout que produce este provisionador. Se escribe en el marcador. */
const PROVISIONER_VERSION = 1;

/** Nombre del manifiesto de producto (mismo que `config-resolver.PRODUCT_FILENAME`). */
const PRODUCT_FILENAME = 'pipeline.config.json';

/**
 * Subestados por fase: los 7 "activos" de `pulpo.js` (`for (const estado of
 * [...])` en el intake) + `procesado` + `archivado` (existen en disco).
 */
const SUBESTADOS = Object.freeze([
    'pendiente', 'trabajando', 'listo', 'procesado', 'archivado',
    'bloqueado-humano', 'bloqueado-dependencias', 'esperando-firma', 'waiting-operator',
]);

/** Servicios: literal de `pulpo.js` (`for (const svc of [...])`) + `emulador` (existe en disco). */
const SERVICIOS = Object.freeze(['telegram', 'github', 'drive', 'commander', 'emulador']);

/** Subestados de las colas de servicios. */
const SERVICIO_SUBESTADOS = Object.freeze(['pendiente', 'trabajando', 'listo', 'procesado', 'fallido']);

/** Directorios que el pulpo crea on-demand; acá se crean vacíos. */
const DIRS_FIJOS = Object.freeze([
    'logs', 'state', 'state/project-bindings', 'rejections', 'metrics',
    'audit', 'events', 'locks', 'archivado', 'assets', 'deliverables', 'descriptors', 'roles',
]);

/**
 * Allowlist de copia desde el `.pipeline` productivo (D4 / SEC-P4). Relativos
 * al `pipelineDir`. `pipeline.config.json` se copia aparte porque vive en el
 * padre. `config.yaml` pasa por el overlay (D5), el resto es verbatim.
 */
const COPY_ALLOWLIST = Object.freeze([
    'config.yaml',
    'waves.json.template',
    'agent-models.json',
    'agent-models.schema.json',
    'descriptors',
    'roles',
]);

/**
 * Variables que se ELIMINAN del env heredado antes de resolver (D10 / SEC-P6):
 * la declaración de ambiente y el escape hatch (nombres tomados del resolvedor,
 * nunca repetidos como literal) + las 3 variables de directorio + runtime.
 */
const ENV_STRIP = Object.freeze([
    pipelineEnv.ENV_AMBIENTE,
    pipelineEnv.ENV_ESCAPE_HATCH,
    'PIPELINE_DIR_OVERRIDE',
    'PIPELINE_STATE_DIR',
    'PIPELINE_REPO_ROOT',
    'PIPELINE_RUNTIME_DIR',
]);

/** Overlay de pruebas sobre `config.yaml` (D5 + precisión de guru). */
const CONFIG_OVERLAY = Object.freeze([
    Object.freeze({ path: ['operational_state', 'durable'], value: false }),
    Object.freeze({ path: ['kernel', 'durable'], value: false }),
    Object.freeze({ path: ['vault', 'enabled'], value: false }),
]);

/** Estado operativo inicial: allowlist vacía == running (`partial-pause.js`). */
const PARTIAL_PAUSE_INICIAL = Object.freeze({ allowed_issues: [], source: 'provision-test-env' });

/** Marcador de halt total: se garantiza su AUSENCIA. */
const PAUSED_FILENAME = '.paused';

const RM_OPTS = Object.freeze({ recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

// ─── Errores ─────────────────────────────────────────────────────────────────

/**
 * Abort fail-closed: nada fue creado ni borrado (o se dice explícitamente qué
 * quedó). El CLI lo mapea a exit 2 con el prefijo `ABORTADO`.
 */
class AbortError extends Error {
    constructor(mensaje) {
        super(mensaje);
        this.name = 'AbortError';
        this.abort = true;
    }
}

// ─── Helpers de path (D7) ────────────────────────────────────────────────────

function resolverDeps(deps) {
    const d = deps && typeof deps === 'object' ? deps : {};
    return {
        fs: d.fs || require('fs'), // eslint-disable-line global-require
        os: d.os || require('os'), // eslint-disable-line global-require
        execFileSync: d.execFileSync || require('child_process').execFileSync, // eslint-disable-line global-require
    };
}

/** `true` si `hijo` es igual o descendiente de `padre` (ambos canónicos). SEC-P10: `rel === ''` cuenta. */
function esContenido(hijo, padre) {
    const rel = path.relative(padre, hijo);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Compartido con el productivo: igual o dentro (SEC-P10 explícito). */
function esCompartido(realEntrada, realProd) {
    return esContenido(realEntrada, realProd);
}

function esRaizDeDrive(p) {
    return p === '/' || /^[A-Za-z]:[\\/]?$/.test(p);
}

/** realpath canónico si existe, `null` si no. */
function realpathSiExiste(fs, p) {
    try {
        return fs.realpathSync.native(p);
    } catch {
        return null;
    }
}

function lstatSiExiste(fs, p) {
    try {
        return fs.lstatSync(p);
    } catch {
        return null;
    }
}

/** rel portable (`/`), para snapshots y reportes. */
function relPortable(base, abs) {
    return path.relative(base, abs).split(path.sep).join('/');
}

/** Root pedido (absoluto): el `--root` del operador o el default bajo el tmpdir REAL. */
function rootPedido(root, { fs, os }) {
    return root
        ? path.resolve(root)
        : path.join(fs.realpathSync.native(os.tmpdir()), DEFAULT_ROOT_NAME);
}

/**
 * Forma canónica de un path para MOSTRAR (G-9: nunca 8.3), sin efectos ni
 * abortos: realpath del ancestro existente más cercano + el resto tal cual.
 * Un link NO se sigue en el último componente (se resuelve el padre y se
 * conserva el nombre): quien decide qué hacer con un link es el llamador.
 */
function resolveRoot(opts = {}, deps = {}) {
    const d = resolverDeps(deps);
    const pedido = rootPedido((opts || {}).root, d);
    const st = lstatSiExiste(d.fs, pedido);
    if (st && !st.isSymbolicLink()) return d.fs.realpathSync.native(pedido);
    const restos = [];
    let cursor = pedido;
    for (;;) {
        const padre = path.dirname(cursor);
        restos.unshift(path.basename(cursor));
        if (padre === cursor) return pedido; // llegó a la raíz sin nada existente
        const real = realpathSiExiste(d.fs, padre);
        if (real !== null) return path.join(real, ...restos);
        cursor = padre;
    }
}

/**
 * Canonicaliza el root para PROVISIONAR (precisión UX a G-9 / CA-1): nunca sale
 * un path 8.3.
 * - existe y NO es link → realpath completo;
 * - existe y es link → abort (SEC-P2);
 * - no existe → realpath del padre (que debe existir) + basename.
 */
function canonizarRoot(root, d) {
    const { fs } = d;
    const pedido = rootPedido(root, d);
    const st = lstatSiExiste(fs, pedido);
    if (st && st.isSymbolicLink()) {
        throw new AbortError(`el root es un enlace y no se sigue (${resolveRoot({ root: pedido }, d)}); elegí un directorio real`);
    }
    if (st) return fs.realpathSync.native(pedido);
    const padreReal = realpathSiExiste(fs, path.dirname(pedido));
    if (padreReal === null) {
        throw new AbortError(`el directorio padre de ${resolveRoot({ root: pedido }, d)} no existe; crealo o elegí otro --root`);
    }
    return path.join(padreReal, path.basename(pedido));
}

/**
 * Defensa en profundidad por realpath (SEC-P1/P5): el root no puede ser, contener
 * ni estar contenido en el repo ni en el productivo; no puede ser el home ni un
 * ancestro del home (pero SÍ un descendiente: `os.tmpdir()` vive bajo el home
 * en Windows); no puede ser raíz de drive.
 *
 * @returns {string|null} etiqueta del conflicto (`repo` | `productivo` | `home` | `raíz`) o `null`.
 */
function conflictoDeRoot(realRoot, { repos, prodDirs, fs, os }) {
    if (esRaizDeDrive(realRoot)) return 'raíz';
    for (const prod of prodDirs) {
        const realProd = realpathSiExiste(fs, prod);
        if (realProd && (esContenido(realRoot, realProd) || esContenido(realProd, realRoot))) return 'productivo';
    }
    for (const repo of repos) {
        const realRepo = realpathSiExiste(fs, repo);
        if (realRepo && (esContenido(realRoot, realRepo) || esContenido(realRepo, realRoot))) return 'repo';
    }
    const realHome = realpathSiExiste(fs, os.homedir());
    if (realHome && (realRoot === realHome || esContenido(realHome, realRoot))) return 'home';
    return null;
}

// ─── Recorridos (D8) ─────────────────────────────────────────────────────────

/**
 * Walk propio con `lstat`, orden determinístico, sin descender en links.
 * @returns {Array<{abs: string, rel: string, st: import('fs').Stats}>}
 */
function walkLstat(fs, base) {
    const out = [];
    const visitar = (dir) => {
        const nombres = fs.readdirSync(dir).slice().sort();
        for (const nombre of nombres) {
            const abs = path.join(dir, nombre);
            const st = fs.lstatSync(abs);
            out.push({ abs, rel: relPortable(base, abs), st });
            if (st.isDirectory() && !st.isSymbolicLink()) visitar(abs);
        }
    };
    visitar(base);
    return out;
}

/**
 * Snapshot determinístico de un árbol (helper de los tests de CA-3/CA-4).
 * @param {string} dir
 * @param {object} [deps]
 * @returns {Array<{rel: string, tipo: string, size: number, mtimeMs: number}>}
 */
function snapshotTree(dir, deps) {
    const { fs } = resolverDeps(deps);
    if (lstatSiExiste(fs, dir) === null) return [];
    return walkLstat(fs, dir).map(({ rel, st }) => ({
        rel,
        tipo: st.isSymbolicLink() ? 'link' : (st.isDirectory() ? 'dir' : 'file'),
        size: st.isFile() ? st.size : 0,
        mtimeMs: st.mtimeMs,
    }));
}

// ─── Layout ──────────────────────────────────────────────────────────────────

/**
 * Estructura DERIVADA de `config.yaml`: colas por fase × subestado, colas de
 * servicios y directorios fijos. Todo relativo al `pipelineDir`.
 * @param {object} config documento de `config.yaml` ya cargado.
 * @returns {{fases: string[], servicios: string[], fijos: string[]}}
 */
function layoutFor(config) {
    const fases = [];
    const pipelines = (config && config.pipelines) || {};
    for (const [p, pc] of Object.entries(pipelines)) {
        for (const f of (pc && pc.fases) || []) {
            for (const s of SUBESTADOS) fases.push(path.join(p, f, s));
        }
    }
    const servicios = SERVICIOS.flatMap((s) => SERVICIO_SUBESTADOS.map((e) => path.join('servicios', s, e)));
    return { fases, servicios, fijos: [...DIRS_FIJOS] };
}

// ─── Escrituras idempotentes ─────────────────────────────────────────────────

/** mkdir idempotente; registra en `creados` sólo si no existía. */
function asegurarDir(fs, abs, rootAbs, creados) {
    const st = lstatSiExiste(fs, abs);
    if (st && st.isSymbolicLink()) {
        throw new AbortError(`${relPortable(rootAbs, abs)} es un enlace dentro del ambiente; nada más fue escrito bajo ${rootAbs}`);
    }
    if (st) return;
    fs.mkdirSync(abs, { recursive: true });
    creados.push(relPortable(rootAbs, abs) || '.');
}

/** Escribe sólo si el contenido difiere (idempotente, mtime estable). */
function escribirSiDifiere(fs, abs, contenido, rootAbs, creados) {
    const st = lstatSiExiste(fs, abs);
    if (st && st.isSymbolicLink()) {
        throw new AbortError(`${relPortable(rootAbs, abs)} es un enlace dentro del ambiente; nada más fue escrito bajo ${rootAbs}`);
    }
    const buf = Buffer.isBuffer(contenido) ? contenido : Buffer.from(contenido, 'utf8');
    if (st && fs.readFileSync(abs).equals(buf)) return;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
    if (!st) creados.push(relPortable(rootAbs, abs));
}

function setDeep(obj, segs, value) {
    let node = obj;
    for (const seg of segs.slice(0, -1)) {
        if (node[seg] === null || typeof node[seg] !== 'object' || Array.isArray(node[seg])) node[seg] = {};
        node = node[seg];
    }
    node[segs[segs.length - 1]] = value;
}

/** Overlay D5: load → mutate → dump. Devuelve `{ texto, config }`. */
function aplicarOverlay(textoConfig) {
    const doc = yaml.load(textoConfig);
    const config = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
    for (const { path: segs, value } of CONFIG_OVERLAY) setDeep(config, segs, value);
    return { texto: yaml.dump(config, { lineWidth: -1, noRefs: true }), config };
}

/**
 * Plan de copia de la allowlist: se resuelve ANTES de escribir un byte para
 * poder abortar ante un link en el origen sin dejar residuo (SEC-P3).
 * @returns {{archivos: Array<{src: string, rel: string}>, dirs: string[], omitidos: string[]}}
 */
function planDeCopia(fs, srcDir) {
    const archivos = [];
    const dirs = [];
    const omitidos = [];
    for (const nombre of COPY_ALLOWLIST) {
        const src = path.join(srcDir, nombre);
        const st = lstatSiExiste(fs, src);
        if (st === null) { omitidos.push(nombre); continue; }
        if (st.isSymbolicLink()) {
            throw new AbortError(`${nombre} del origen es un enlace (${src}); nada fue escrito`);
        }
        if (st.isFile()) { archivos.push({ src, rel: nombre }); continue; }
        dirs.push(nombre);
        for (const e of walkLstat(fs, src)) {
            if (e.st.isSymbolicLink()) {
                throw new AbortError(`${nombre}/ del origen contiene un enlace (${e.rel}); nada fue escrito`);
            }
            const rel = path.join(nombre, e.rel.split('/').join(path.sep));
            if (e.st.isDirectory()) dirs.push(rel);
            else archivos.push({ src: e.abs, rel });
        }
    }
    return { archivos, dirs, omitidos };
}

/** SHA del HEAD del repo de origen, best-effort (D9). */
function shaDelRepo(execFileSync, repo) {
    try {
        const out = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
        });
        const sha = String(out).trim();
        return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    } catch {
        return null;
    }
}

function leerMarcador(fs, pipelineDir) {
    try {
        const doc = JSON.parse(fs.readFileSync(path.join(pipelineDir, MARKER_FILENAME), 'utf8'));
        return doc && typeof doc === 'object' ? doc : null;
    } catch {
        return null;
    }
}

// ─── API ─────────────────────────────────────────────────────────────────────

/**
 * Provisiona el ambiente. Idempotente: completa lo faltante y no pisa el estado
 * operativo (`waves.json`, `.partial-pause.json`). Con `fresh` lo destruye
 * primero (mismo fail-closed que `destroy`).
 *
 * @param {{env?: object, root?: string, repoRoot?: string, fresh?: boolean}} [opts]
 * @param {{fs?: object, os?: object, execFileSync?: Function}} [deps]
 * @returns {{root: string, pipelineDir: string, manifestPath: string, marker: string,
 *   productivo: string, yaExistia: boolean, creados: string[], colas: number,
 *   copiados: number, omitidos: string[]}}
 */
function provision(opts = {}, deps = {}) {
    const { env = {}, root, repoRoot, fresh = false } = opts || {};
    const d = resolverDeps(deps);
    const { fs, os } = d;

    const prodDir = pipelineEnv.DEFAULT_PRODUCTIVE_DIR;
    const repoProd = path.dirname(prodDir);
    const repo = path.resolve(repoRoot || repoProd);
    const srcDir = path.join(repo, '.pipeline');

    // 0. root canónico (nunca 8.3) — aborta si es link o si el padre no existe.
    const rootAbs = canonizarRoot(root, d);
    const candidato = path.join(rootAbs, '.pipeline');

    // 1. Env saneado (D10) + resolvedor único (D1). El candidato viaja SÓLO por env.
    const envSaneado = Object.fromEntries(
        Object.entries(env && typeof env === 'object' ? env : {}).filter(([k]) => !ENV_STRIP.includes(k)),
    );
    const amb = pipelineEnv.resolve({ ...envSaneado, PIPELINE_DIR_OVERRIDE: candidato });
    if (amb.modo !== pipelineEnv.MODOS.PRUEBAS || amb.dir === null) {
        throw new AbortError(
            `el resolvedor no habilitó el destino como pruebas (modo=${amb.modo}; ${amb.motivo}); usá --root <dir> fuera del repo`,
        );
    }

    // 2. Defensa en profundidad por realpath (SEC-P5, bypass 8.3 hasta #7407).
    const conflicto = conflictoDeRoot(rootAbs, {
        repos: [repoProd, repo], prodDirs: [prodDir, srcDir], fs, os,
    });
    if (conflicto) {
        throw new AbortError(`el root cae dentro de ${conflicto} (${rootAbs}); nada fue creado ni borrado`);
    }

    // 3. Plan de copia ANTES de escribir: un link en el origen aborta sin residuo (SEC-P3).
    const plan = planDeCopia(fs, srcDir);

    // 4. fresh → destroy primero (reusa el mismo fail-closed).
    const yaExistia = leerMarcador(fs, candidato) !== null;
    if (fresh && lstatSiExiste(fs, rootAbs) !== null) {
        const dst = destroy({ root: rootAbs }, deps);
        if (!dst.ok) throw new AbortError(dst.motivo);
    }

    // 5. mkdir raíz y RE-verificar por realpath tras crear (SEC-P2: race por nombre fijo en TEMP).
    const creados = [];
    asegurarDir(fs, rootAbs, rootAbs, creados);
    const stRoot = fs.lstatSync(rootAbs);
    const realRoot = fs.realpathSync.native(rootAbs);
    const padreReal = fs.realpathSync.native(path.dirname(rootAbs));
    if (stRoot.isSymbolicLink() || !esContenido(realRoot, padreReal) || realRoot === padreReal) {
        throw new AbortError(`el root cambió de lugar mientras se creaba (${rootAbs}); no se escribió nada adentro`);
    }
    asegurarDir(fs, candidato, rootAbs, creados);

    // 6. Copias por allowlist (D4) + overlay (D5).
    let configDoc = {};
    let copiados = 0;
    for (const rel of plan.dirs) asegurarDir(fs, path.join(candidato, rel), rootAbs, creados);
    for (const { src, rel } of plan.archivos) {
        const bytes = fs.readFileSync(src);
        if (rel === 'config.yaml') {
            const { texto, config } = aplicarOverlay(bytes.toString('utf8'));
            configDoc = config;
            escribirSiDifiere(fs, path.join(candidato, rel), texto, rootAbs, creados);
        } else {
            escribirSiDifiere(fs, path.join(candidato, rel), bytes, rootAbs, creados);
        }
        copiados++;
    }
    const manifestSrc = path.join(repo, PRODUCT_FILENAME);
    const manifestPath = path.join(rootAbs, PRODUCT_FILENAME);
    const stManifest = lstatSiExiste(fs, manifestSrc);
    if (stManifest && stManifest.isSymbolicLink()) {
        throw new AbortError(`${PRODUCT_FILENAME} del origen es un enlace (${manifestSrc}); el ambiente quedó a medio provisionar en ${rootAbs}`);
    }
    if (stManifest) {
        escribirSiDifiere(fs, manifestPath, fs.readFileSync(manifestSrc), rootAbs, creados);
        copiados++;
    } else {
        plan.omitidos.push(PRODUCT_FILENAME);
    }

    // 7. Estructura derivada (layoutFor) — vacía, sin `.gitkeep`.
    const layout = layoutFor(configDoc);
    const colas = [...layout.fases, ...layout.servicios];
    for (const rel of [...colas, ...layout.fijos]) asegurarDir(fs, path.join(candidato, rel), rootAbs, creados);

    // 8. Estado operativo inicial: se siembra sólo si falta (no se pisa).
    const templateAbs = path.join(candidato, 'waves.json.template');
    const wavesAbs = path.join(candidato, 'waves.json');
    if (lstatSiExiste(fs, wavesAbs) === null && lstatSiExiste(fs, templateAbs) !== null) {
        escribirSiDifiere(fs, wavesAbs, fs.readFileSync(templateAbs), rootAbs, creados);
    }
    const partialAbs = path.join(candidato, '.partial-pause.json');
    if (lstatSiExiste(fs, partialAbs) === null) {
        escribirSiDifiere(fs, partialAbs, JSON.stringify(PARTIAL_PAUSE_INICIAL, null, 2) + '\n', rootAbs, creados);
    }
    const pausedAbs = path.join(candidato, PAUSED_FILENAME);
    if (lstatSiExiste(fs, pausedAbs) !== null) fs.rmSync(pausedAbs, { force: true });

    // 9. Marcador ÚLTIMO (D6): un root sin marcador es "a medio provisionar" y destroy lo rechaza.
    const marker = path.join(candidato, MARKER_FILENAME);
    const marcador = {
        modo: pipelineEnv.MODOS.PRUEBAS,
        provisionerVersion: PROVISIONER_VERSION,
        origen: { repoRoot: repo, sha: shaDelRepo(d.execFileSync, repo) },
    };
    escribirSiDifiere(fs, marker, JSON.stringify(marcador, null, 2) + '\n', rootAbs, creados);

    return {
        root: realRoot,
        pipelineDir: path.join(realRoot, '.pipeline'),
        manifestPath: path.join(realRoot, PRODUCT_FILENAME),
        marker: path.join(realRoot, '.pipeline', MARKER_FILENAME),
        productivo: fs.realpathSync.native(prodDir),
        yaExistia,
        creados,
        colas: colas.length,
        copiados,
        omitidos: plan.omitidos,
    };
}

/**
 * Destruye el ambiente. Fail-closed (SEC-P1): sólo borra si el root no es link,
 * no es/contiene/está contenido en el repo ni el productivo, no es el home ni
 * un ancestro del home, no es raíz de drive, y tiene marcador `modo: 'pruebas'`.
 *
 * @param {{root?: string}} [opts]
 * @param {object} [deps]
 * @returns {{ok: boolean, root: string, existia: boolean, borrado: boolean, residuo: string[], motivo?: string}}
 */
function destroy(opts = {}, deps = {}) {
    const { root } = opts || {};
    const d = resolverDeps(deps);
    const { fs, os } = d;

    const pedido = rootPedido(root, d);
    const mostrado = resolveRoot({ root: pedido }, d);

    const st = lstatSiExiste(fs, pedido);
    if (st === null) {
        return { ok: true, root: mostrado, existia: false, borrado: false, residuo: [] };
    }
    // (a) no es link.
    if (st.isSymbolicLink()) {
        return { ok: false, root: mostrado, existia: true, borrado: false, residuo: [], motivo: `el root es un enlace y no se sigue (${mostrado}); no se borra nada` };
    }
    // (b) realpath canónico y ubicación segura.
    const real = fs.realpathSync.native(pedido);
    const prodDir = pipelineEnv.DEFAULT_PRODUCTIVE_DIR;
    const conflicto = conflictoDeRoot(real, { repos: [path.dirname(prodDir)], prodDirs: [prodDir], fs, os });
    if (conflicto) {
        return { ok: false, root: real, existia: true, borrado: false, residuo: [], motivo: `el root cae dentro de ${conflicto} (${real}); no se borra nada` };
    }
    // (c) marcador presente y modo pruebas.
    const marcador = leerMarcador(fs, path.join(real, '.pipeline'));
    if (!marcador || marcador.modo !== pipelineEnv.MODOS.PRUEBAS) {
        return {
            ok: false, root: real, existia: true, borrado: false, residuo: [],
            motivo: `${real} no tiene marcador de ambiente de pruebas; no se borra nada. Si es un ambiente a medio provisionar, borralo a mano`,
        };
    }
    // (d) borrar con reintentos (EPERM/EBUSY en Windows) — nunca por shell (D9).
    let errorRm = null;
    try {
        fs.rmSync(real, RM_OPTS);
    } catch (e) {
        errorRm = e && e.code ? e.code : 'error';
    }
    // (e) residuo por nombre.
    const residuo = lstatSiExiste(fs, real) !== null ? snapshotTree(real, deps).map((e) => e.rel) : [];
    const ok = residuo.length === 0 && lstatSiExiste(fs, real) === null;
    const out = { ok, root: real, existia: true, borrado: true, residuo };
    if (!ok) {
        out.motivo = `quedaron ${residuo.length} entradas en ${real}${errorRm ? ` (${errorRm})` : ''}; causa probable: un proceso tiene su cwd adentro o el antivirus lo retiene. Cerralo y repetí --destroy`;
    }
    return out;
}

/**
 * Verifica que el ambiente no comparte NADA con el productivo (CA-5): recorre
 * con `lstat`, cualquier link cuenta como falla, y cada entrada se compara por
 * realpath contra el productivo (`rel === ''` cuenta como compartido, SEC-P10).
 *
 * @param {{root?: string, productivo?: string}} [opts]
 * @param {object} [deps]
 * @returns {{ok: boolean, root: string, productivo: string, entradas: number,
 *   marcador: boolean, compartidos: string[], links: string[], motivo?: string}}
 */
function verifyIsolation(opts = {}, deps = {}) {
    const { root, productivo } = opts || {};
    const d = resolverDeps(deps);
    const { fs } = d;

    const pedido = rootPedido(root, d);
    const mostrado = resolveRoot({ root: pedido }, d);
    const prod = productivo ? path.resolve(productivo) : pipelineEnv.DEFAULT_PRODUCTIVE_DIR;
    const realProd = realpathSiExiste(fs, prod) || prod;

    const st = lstatSiExiste(fs, pedido);
    if (st === null) {
        return { ok: false, root: mostrado, productivo: realProd, entradas: 0, marcador: false, compartidos: [], links: [], motivo: `no hay ambiente en ${mostrado}` };
    }
    if (st.isSymbolicLink()) {
        return { ok: false, root: mostrado, productivo: realProd, entradas: 1, marcador: false, compartidos: [], links: ['.'], motivo: `el root es un enlace (${mostrado})` };
    }
    const real = fs.realpathSync.native(pedido);
    const compartidos = [];
    const links = [];
    const entradas = [{ abs: real, rel: '.', st }, ...walkLstat(fs, real)];
    for (const e of entradas) {
        if (e.st.isSymbolicLink()) { links.push(e.rel); continue; }
        const realEntrada = realpathSiExiste(fs, e.abs);
        if (realEntrada === null) continue; // desapareció durante el recorrido
        if (esCompartido(realEntrada, realProd)) compartidos.push(e.rel);
    }
    const marcador = leerMarcador(fs, path.join(real, '.pipeline'));
    const out = {
        ok: compartidos.length === 0 && links.length === 0,
        root: real,
        productivo: realProd,
        entradas: entradas.length,
        marcador: !!(marcador && marcador.modo === pipelineEnv.MODOS.PRUEBAS),
        compartidos,
        links,
    };
    if (!out.ok) {
        const partes = [];
        if (compartidos.length) partes.push(`comparte ${compartidos.length} entradas con el productivo`);
        if (links.length) partes.push(`contiene ${links.length} enlaces`);
        out.motivo = `el ambiente ${partes.join(' / ')} (ver lista)`;
    }
    return out;
}

module.exports = {
    provision,
    destroy,
    verifyIsolation,
    resolveRoot,
    layoutFor,
    snapshotTree,
    AbortError,
    DEFAULT_ROOT_NAME,
    MARKER_FILENAME,
    PROVISIONER_VERSION,
    PRODUCT_FILENAME,
    /** Nombre de la variable de declaración de ambiente y el valor que `--print-env` emite (D10). */
    ENV_AMBIENTE: pipelineEnv.ENV_AMBIENTE,
    MODO_PRUEBAS: pipelineEnv.MODOS.PRUEBAS,
    /** Variable por la que viaja el dir de pruebas (D1; la emite `--print-env` desde #7112). */
    ENV_DIR_OVERRIDE: 'PIPELINE_DIR_OVERRIDE',
    /** `.pipeline` productivo (fijo en código por el resolvedor). */
    DEFAULT_PRODUCTIVE_DIR: pipelineEnv.DEFAULT_PRODUCTIVE_DIR,
    SUBESTADOS,
    SERVICIOS,
    SERVICIO_SUBESTADOS,
    DIRS_FIJOS,
    COPY_ALLOWLIST,
    ENV_STRIP,
    CONFIG_OVERLAY,
    _internal: {
        esContenido,
        esCompartido,
        esRaizDeDrive,
        canonizarRoot,
        conflictoDeRoot,
        walkLstat,
        planDeCopia,
        aplicarOverlay,
        shaDelRepo,
        leerMarcador,
    },
};
