'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { redactSensitive } = require('./redact');

// #6495 (rebote 3) — CA-10 fija el tope con "el máximo observado en el
// histórico es 7", pero el barrido real de `procesado/` + `archivado/` encuentra
// dropfiles aprobados con 10 campos (`6118.qa`, `6226.qa`). El tope sigue siendo
// fijo y explícito —no hay truncado silencioso, superarlo es fail-closed— pero
// se calibra sobre el histórico real. La cota que acota el abuso de lectura de
// archivos del host es `MAX_TOTAL_BYTES` + el confinamiento, no este número.
const MAX_EVIDENCE_FIELDS = 16;
const MAX_GLOB_FILES = 64;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
// #6495 (rebote 3, R-3) — El centinela de "campo declarado sin artefacto" se
// reconoce por PREFIJO, no por igualdad exacta. La igualdad exacta era una
// invención del módulo: ningún dropfile real escribe el centinela pelado, todos
// lo justifican ("no aplica: el preflight confirmo que no hay superficie UI
// visible", "n/a - QA_MODE=structural sin UI visible"). Exigir la forma pelada
// convertía en bloqueante la forma que el histórico usa todo el tiempo: en el
// barrido de dropfiles reales, 49 de 247 campos de evidencia son prosa y la
// mayoría son justamente centinelas justificados.
const SKIP_SENTINEL = /^(?:-+|n\s*\/\s*a|null|no\s*[-_.]?\s*aplica|no\s+corresponde|not\s+applicable|sin\s+evidencia)(?:\b|$)/i;

// Toda ruta absoluta: drive letter de Windows, POSIX o UNC.
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|[\\/])/;
const TRAVERSAL_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
const ARTIFACT_EXTENSION = /\.[A-Za-z0-9]{1,8}$/;

// #6495 (rebote 3, R-4 · rebote 4, S-2) — Segundo recinto permitido.
//
// CA-6 justifica `tipo: derivado` con `.pipeline/logs/media/qa-6190.mp4` (re-mux
// faststart del original), pero confinar TODO a `qa/evidence/<issue>/` hacía que
// ese artefacto —y los 4 dropfiles reales que declaran esa ruta, más los
// `evidencia_pdf: .pipeline/logs/rejection-<issue>-qa.pdf`— murieran en
// `fuera-de-recinto` antes de llegar a la rama de derivado. La tensión entre
// CA-5 (recinto estricto) y CA-6 (motivo fuera del recinto) se resuelve acá, a
// favor de un segundo recinto explícito y acotado.
//
// El recinto de logs NO es `.pipeline/logs/` entero ni recursivo: eso promovía a
// evidencia sellada cualquier archivo del pipeline con el número de issue en el
// basename —incluido `.pipeline/logs/<issue>-<skill>.log`, que es el transcript
// completo del agente, y cualquier `logs/<subdir>/…-<issue>-….log`— en un canal
// que las partes 2 y 3 del split consumen y publican. Lo permitido es una
// ALLOWLIST DE FORMA, sin profundidad libre, que cubre exactamente las dos
// formas que CA-6 justifica y que el histórico real usa:
//
//   - `logs/media/<basename con extensión de media>`  (un solo nivel)
//   - `logs/rejection-<…>.pdf`                        (sin subdirectorio)
//
// y en las dos el basename tiene que referenciar el issue como token propio, así
// que el veredicto de #A no puede sellar el artefacto de #B. Sigue valiendo todo
// lo demás: sin traversal, sin ruta sensible, containment por `realpath`, topes.
const LOG_RECINTO = ['.pipeline', 'logs'];
const MEDIA_SUBDIR = 'media';
const MEDIA_EXTENSION = /\.(?:mp4|webm|mkv|mov|m4v|gif|png|jpe?g|pdf)$/i;
const REJECTION_BASENAME = /^rejection-[A-Za-z0-9._-]+\.pdf$/i;

// #6495 (rebote 7, R-5) - Los artefactos NO viven necesariamente en `ROOT`.
//
// La fase `verificacion` esta en `EXISTING_WORKTREE_PHASES`
// (`lib/phase-workspace.js:32`), asi que el agente QA corre con
// `cwd = worktreePath` y el rol le manda declarar rutas RELATIVAS
// (`roles/qa.md:336-338`): esas rutas caen en el WORKTREE, no en el repo
// principal. El Pulpo, en cambio, baja el video crudo del emulador a
// `ROOT/qa/evidence/<issue>/`. Los dos lados son legitimos y ninguno alcanza
// solo: resolver unicamente contra `ROOT` degradaba a `rechazado` el QA android
// canonico del rol (y dejaba sin sello 42 de los 76 aprobados structural reales
// del corpus), y resolver unicamente contra el worktree dejaba sin sellar el
// crudo que graba el propio Pulpo.
//
// Por eso el sellado acepta VARIOS workspaces, en orden de preferencia
// (worktree primero, repo despues), y de cada uno abre los MISMOS dos recintos
// acotados de siempre. No se agrega permisividad: el containment sigue siendo
// por `realpath` contra un recinto fijo derivado del issue, la allowlist de
// forma del recinto de logs no cambia, y los topes por archivo / campos / bytes
// agregados son globales al sellado, no por workspace.
//
// Los workspaces los pasa el PULPO desde su `spawnCwd`; nunca salen de `data`,
// igual que el `cwd` de `deriveHead` (CA-12a).
const MAX_WORKSPACES = 4;

class SealError extends Error {
  constructor(reason, declaredPath = '') {
    super(reason);
    this.reason = reason;
    this.declaredPath = declaredPath;
  }
}

function normalizeHash(value) {
  const match = String(value || '').trim().toLowerCase().match(/^(?:sha256:)?([a-f0-9]{64})$/);
  return match ? `sha256:${match[1]}` : null;
}

function isSensitivePath(value) {
  return /(^|[\\/._-])(credentials?|secrets?|passwords?|\.env|id_rsa)([\\/._-]|$)|\.(?:pem|key|p12)$/i.test(String(value));
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * Workspaces donde puede vivir un artefacto, en orden de preferencia y sin
 * duplicados (dedupe por `realpath`, con fallback al absoluto cuando el
 * directorio todavia no existe). `root` SIEMPRE entra, y entra ULTIMO: los
 * workspaces explicitos son el lugar donde el agente acaba de escribir, asi que
 * ante el mismo path relativo presente de los dos lados gana el del agente, que
 * es el que su veredicto esta afirmando.
 *
 * Fail-closed, sin truncado silencioso (mismo criterio que CA-10): pasarse de
 * `MAX_WORKSPACES` frena el sellado en vez de recortar la lista.
 *
 * @param {string} root raiz del repo principal (fija, nunca del YAML)
 * @param {string[]|undefined} workspaces recintos adicionales que pasa el Pulpo
 * @returns {string[]} bases absolutas, en orden de preferencia
 */
function normalizeWorkspaces(root, workspaces) {
  const bases = [];
  const vistos = new Set();
  const agregar = value => {
    if (typeof value !== 'string' || value.trim() === '') return;
    let absolute;
    try { absolute = path.resolve(value); } catch { return; }
    let clave;
    try { clave = fs.realpathSync(absolute); } catch { clave = absolute; }
    clave = clave.replace(/[\\/]+$/, '').toLowerCase();
    if (vistos.has(clave)) return;
    vistos.add(clave);
    bases.push(absolute);
  };
  if (Array.isArray(workspaces)) workspaces.forEach(agregar);
  agregar(root);
  if (bases.length > MAX_WORKSPACES) throw new SealError('workspaces-oversize');
  return bases;
}

/**
 * Recintos permitidos, en orden de preferencia. Son rutas FIJAS derivadas de
 * cada workspace y del issue: ninguna sale del YAML del agente.
 */
function confinementRoots(root, issue, workspaces) {
  const recintos = [];
  for (const base of normalizeWorkspaces(root, workspaces)) {
    recintos.push({ base, dir: path.join(base, 'qa', 'evidence', String(issue)), permite: () => true });
    recintos.push({ base, dir: path.join(base, ...LOG_RECINTO), permite: allowedLogShape });
  }
  return recintos;
}

/**
 * Allowlist de forma del recinto de logs (#6495, rebote 4 · S-2). Recibe los
 * segmentos de la ruta RELATIVOS al recinto, así que no hay profundidad libre:
 * cualquier subdirectorio que no sea `media/` —y cualquier nivel extra dentro
 * de `media/`— queda afuera.
 *
 * `esDirectorio` existe para la expansión de globs, que resuelve primero el
 * directorio contenedor (`.pipeline/logs/media`) y recién después valida cada
 * archivo expandido con esta misma función en modo archivo.
 */
function allowedLogShape(relParts, issue, esDirectorio) {
  if (esDirectorio) {
    if (relParts.length === 0) return true;
    return relParts.length === 1 && relParts[0].toLowerCase() === MEDIA_SUBDIR;
  }
  const basename = relParts[relParts.length - 1] || '';
  if (!referencesIssue(basename, issue)) return false;
  if (relParts.length === 1) return REJECTION_BASENAME.test(basename);
  if (relParts.length === 2 && relParts[0].toLowerCase() === MEDIA_SUBDIR) {
    return MEDIA_EXTENSION.test(basename);
  }
  return false;
}

/**
 * `qa-6239.mp4`, `qa-5400-rebote.mp4` y `rejection-6208-qa.pdf` referencian el
 * issue como token propio. `qa-62391.mp4` no: el borde numérico es lo que evita
 * que el recinto de logs se vuelva un comodín entre issues.
 */
function referencesIssue(basename, issue) {
  return new RegExp(`(?:^|[^0-9])${String(issue)}(?:[^0-9]|$)`).test(basename);
}

/**
 * Resuelve artefactos exclusivamente contra los recintos de `confinementRoots`.
 * El cwd no participa: queda reservado para deriveHead y nunca se toma de data.
 *
 * #6495 (rebote 3, R-1) — La ruta ABSOLUTA se acepta si (y sólo si) cae dentro
 * de un recinto, en vez de rechazarse por su forma. El rechazo por forma no era
 * una defensa: el containment por `realpath` ya decide, y el propio Pulpo
 * escribe una ruta absoluta en `data.evidencia` (`path.join(ROOT, 'qa',
 * 'evidence', issue, ...)`) unas líneas antes de invocar el sellado, así que
 * rechazarla degradaba a `rechazado` TODO QA android con video ≥50KB — el happy
 * path del modo android. El Pulpo además ahora normaliza a relativa, pero el
 * módulo no depende de que su llamador lo haga.
 *
 * La ruta devuelta (`ruta`) SIEMPRE es relativa al repo y con `/`: el
 * manifiesto no persiste rutas absolutas del host (SEC-8).
 */
function resolveConfined(root, issue, declaredPath, options = {}) {
  const esDirectorio = options.directorio === true;
  if (typeof declaredPath !== 'string') throw new SealError('fuera-de-recinto', declaredPath);
  const raw = declaredPath.trim();
  if (raw === '') throw new SealError('fuera-de-recinto', declaredPath);
  if (TRAVERSAL_SEGMENT.test(raw)) throw new SealError('traversal', declaredPath);
  if (isSensitivePath(raw)) throw new SealError('fuera-de-recinto', declaredPath);

  for (const recinto of confinementRoots(root, issue, options.workspaces)) {
    const resuelto = resolveEnRecinto(recinto, issue, raw, esDirectorio);
    if (resuelto) return resuelto;
  }
  // No distingue ausencia de rechazo: evita usar el motivo como oráculo (CA-11).
  throw new SealError('fuera-de-recinto', declaredPath);
}

/**
 * Resuelve contra UN recinto. Devuelve `null` -no lanza- cuando la ruta no le
 * corresponde, para que `resolveConfined` pueda seguir con el proximo workspace
 * sin convertir un "aca no esta" en el rechazo definitivo. El rechazo lo emite
 * el llamador recien cuando NINGUN recinto la acepto, con el mismo motivo
 * categorico de siempre (CA-11: no distingue ausencia de rechazo).
 *
 * La ruta devuelta (`ruta`) SIEMPRE es relativa a la base de SU recinto y con
 * `/`, asi que un artefacto del worktree se persiste con la misma forma que uno
 * del repo (`qa/evidence/<issue>/...`) y el manifiesto nunca guarda rutas
 * absolutas del host (SEC-8).
 */
function resolveEnRecinto(recinto, issue, raw, esDirectorio) {
  const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(recinto.base, raw);
  if (!isInside(recinto.dir, absolute)) return null;
  const relativoAlRecinto = path.relative(recinto.dir, absolute);
  const relParts = relativoAlRecinto === '' ? [] : relativoAlRecinto.split(/[\\/]/);
  if (!recinto.permite(relParts, issue, esDirectorio)) return null;

  let realRecinto;
  let real;
  try {
    realRecinto = fs.realpathSync(recinto.dir);
    real = fs.realpathSync(absolute);
  } catch {
    return null;
  }
  if (!isInside(realRecinto, real)) return null;
  const ruta = path.relative(recinto.base, absolute).replace(/\\/g, '/');
  if (ruta === '' || ruta.startsWith('..')) return null;
  return { absolute, real, ruta, evidenceDir: realRecinto, base: recinto.base };
}

function deriveHead(cwd) {
  let output;
  try {
    // #6495 (rebote de seguridad): `execFileSync` manda el stderr del hijo al
    // stderr del padre por default, así que un `fatal: ...` de git escribía en
    // el mismo sink SIN pasar por sanitizeLogField. Se descarta: el único dato
    // que este módulo necesita es el stdout, y el motivo ya es categórico
    // ('head-invalido').
    output = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', timeout: 10000, windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new SealError('head-invalido');
  }
  if (!/^[a-f0-9]{40}$/i.test(output)) throw new SealError('head-invalido');
  return output.toLowerCase();
}

/**
 * Compila el basename de un glob a matcher. Lo comparten `expandGlob` (camino
 * autoritativo) y `resolvesToExistingFile` (sonda de existencia): si divergieran,
 * la sonda podría declarar "no es artefacto" un patrón que el camino
 * autoritativo sí expande, y volvería a abrirse el fail-open de S-1.
 */
function globMatcher(basename) {
  const escaped = basename
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/[*?]/g, match => (match === '*' ? '.*' : '.'));
  return new RegExp(`^${escaped}$`);
}

/**
 * Expande el campo declarado a la lista de rutas a sellar.
 *
 * #6495 (rebote 7, R-5) - El glob se prueba workspace por workspace y gana el
 * PRIMERO que expande a por lo menos un archivo. Elegir el workspace por
 * existencia del DIRECTORIO no alcanzaba: el Pulpo crea
 * `ROOT/qa/evidence/<issue>/` para bajar el video crudo (`pulpo.js`), asi que
 * ese directorio existe y esta vacio mientras los frames viven en el worktree
 * del agente; el glob habria muerto en `glob-vacio` con los frames a la vista.
 *
 * Los archivos expandidos se devuelven atados a ESE workspace: si el glob
 * resolvio en el worktree, los frames salen del worktree y no se mezclan con
 * los de `ROOT`, que pueden ser de otra corrida.
 *
 * @returns {{rutas: string[], workspaces: string[]|undefined}}
 */
function expandGlob(root, issue, declaredPath, workspaces) {
  if (!/[?*]/.test(declaredPath)) return { rutas: [declaredPath], workspaces };
  if (declaredPath.includes('?') || (declaredPath.match(/\*/g) || []).length !== 1) {
    throw new SealError('glob-invalido', declaredPath);
  }
  const directory = path.dirname(declaredPath);
  const basename = path.basename(declaredPath);
  const matcher = globMatcher(basename);
  for (const base of normalizeWorkspaces(root, workspaces)) {
    let confinedDir;
    try { confinedDir = resolveConfined(base, issue, path.join(directory, '.'), { directorio: true }); }
    catch { continue; }
    let names;
    try { names = fs.readdirSync(confinedDir.real).filter(name => matcher.test(name)).sort(); }
    catch { continue; }
    if (names.length === 0) continue;
    if (names.length > MAX_GLOB_FILES) throw new SealError('glob-oversize', declaredPath);
    return {
      rutas: names.map(name => path.join(directory, name).replace(/\\/g, '/')),
      workspaces: [confinedDir.base],
    };
  }
  throw new SealError('glob-vacio', declaredPath);
}

/**
 * #6495 — Presupuesto agregado del sellado (CA-10), inyectable SÓLO HACIA ABAJO.
 *
 * El `Math.min` con la constante hace estructuralmente imposible que un
 * llamador —o un YAML que se cuele hasta acá— suba el techo: cualquier valor
 * ausente, no finito, cero o negativo cae al tope del módulo. Existe porque la
 * rama del tope agregado es la única de CA-10 que, sin este parámetro, sólo se
 * podría ejercitar escribiendo 256MB a disco en cada corrida de la suite.
 */
function resolveTotalBudget(limits) {
  const raw = limits ? Number(limits.totalBytes) : NaN;
  if (!Number.isFinite(raw) || raw <= 0) return MAX_TOTAL_BYTES;
  return Math.min(MAX_TOTAL_BYTES, Math.floor(raw));
}

function readAndHash(confined, declaredPath, remainingBytes) {
  let fd = null;
  try {
    fd = fs.openSync(confined.absolute, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new SealError('no-regular', declaredPath);
    if (stat.size === 0) throw new SealError('vacio', declaredPath);
    if (stat.size > MAX_FILE_BYTES || stat.size > remainingBytes) throw new SealError('oversize', declaredPath);

    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, stat.size));
    let position = 0;
    while (position < stat.size) {
      const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (read <= 0) throw new SealError('no-regular', declaredPath);
      hash.update(buffer.subarray(0, read));
      position += read;
    }
    if (fs.realpathSync(confined.absolute) !== confined.real) throw new SealError('fuera-de-recinto', declaredPath);
    const finalStat = fs.fstatSync(fd);
    if (finalStat.size !== stat.size || finalStat.mtimeMs !== stat.mtimeMs) throw new SealError('fuera-de-recinto', declaredPath);
    return { sha256: `sha256:${hash.digest('hex')}`, bytes: stat.size, mtime_ms: stat.mtimeMs };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

function evidenceFields(data) {
  return Object.keys(data || {}).filter(key => key === 'screenshot' || /^evidencia(?:_|$)/.test(key))
    .filter(key => !/_sha256$/.test(key));
}

// #6495 (rebote 2 de seguridad) — Formas aceptadas de un campo de evidencia.
//
// Sólo dos: el escalar string (ruta o glob) y el objeto descriptor con `ruta`
// string. TODO lo demás —lista YAML, null, número, booleano, objeto sin `ruta`
// textual— devuelve null y el llamador lo convierte en `tipo-invalido`, que
// frena el sellado entero.
//
// La LISTA se rechaza por decisión explícita, no por omisión: declarar varios
// archivos ya tiene un canal soportado y acotado (el glob confinado, con tope
// `MAX_GLOB_FILES` y fallo cerrado si expande a cero). Aceptar además una lista
// agregaría un segundo parser —con su propio tope, su propio manejo de
// centinelas y su propia relación con `<campo>_sha256`— sin agregar ninguna
// capacidad que el glob no cubra. Menos superficie, mismo poder expresivo.
function artifactSpec(value) {
  if (typeof value === 'string') return { ruta: value, tipo: 'original' };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const ruta = value.ruta !== undefined ? value.ruta : value.path;
    if (typeof ruta !== 'string') return null;
    // `tipo` ausente asume 'original'; un `tipo` presente pero vacío/no textual
    // NO se normaliza en silencio: cae en la validación de tipo del llamador.
    const tipo = value.tipo === undefined ? 'original' : value.tipo;
    return { ruta, tipo, derivado_de: value.derivado_de, sha256: value.sha256 };
  }
  return null;
}

/**
 * El centinela de "campo declarado sin artefacto" es TEXTUAL y sólo vale en la
 * forma escalar del campo: `evidencia: "no-aplica: <justificación>"`. Un objeto
 * con `ruta: "no-aplica"` no se saltea — se resuelve contra el recinto y falla
 * ahí, porque un descriptor estructurado es una declaración explícita.
 *
 * `undefined`/`null` también son centinela: en YAML, `evidencia_sondas:` sin
 * valor parsea como `null` y significa exactamente "campo declarado, sin
 * artefacto" (caso real `5172.qa`, y 7 campos vacíos más en el histórico).
 */
function isSkipSentinel(value) {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed === '' || SKIP_SENTINEL.test(trimmed);
}

/**
 * #6495 (rebote 3, R-2/R-3) — Distingue "campo que NO es una ruta" de "campo que
 * es una ruta inválida". Es la distinción que faltaba: sin ella, la prosa que el
 * contrato del rol `qa.md` manda escribir en modo structural
 * ("Validación estructural — archivos modificados verificados") se leía como una
 * ruta rota y disparaba `fuera-de-recinto`, degradando el 22% de las
 * aprobaciones históricas.
 *
 * Se considera referencia a artefacto —y por lo tanto se RESUELVE, con
 * fail-closed si no resuelve— cuando:
 *   - es absoluta (aunque tenga espacios: una ruta del host nunca se saltea en
 *     silencio, se resuelve y falla si está fuera del recinto), o
 *   - contiene un segmento `..` (un intento de traversal jamás se saltea), o
 *   - no tiene espacios y tiene separador de path o extensión de archivo.
 *
 * Todo lo demás es prosa: se saltea con traza, nunca en silencio.
 */
function looksLikeArtifactRef(value) {
  const trimmed = String(value).trim();
  if (ABSOLUTE_PATH.test(trimmed)) return true;
  if (TRAVERSAL_SEGMENT.test(trimmed)) return true;
  // Un carácter de control o una marca bidi NUNCA son prosa legítima: son un
  // intento de inyección en el sink de log. No se saltean en silencio — se
  // resuelven contra el recinto, fallan ahí, y el motivo sale por
  // `sanitizeLogField` con marcador categórico. Saltearlos como prosa habría
  // desactivado el PoC del rebote 1 de seguridad.
  // (CONTROL_CHARS/BIDI_CHARS se declaran más abajo: esta función sólo corre en
  // runtime, cuando el módulo ya terminó de evaluarse.)
  if (CONTROL_CHARS.test(trimmed) || BIDI_CHARS.test(trimmed)) return true;
  if (/\s/.test(trimmed)) return false;
  return /[\\/]/.test(trimmed) || ARTIFACT_EXTENSION.test(trimmed);
}

/**
 * #6495 (rebote 4, S-1) — Contrapeso empírico de `looksLikeArtifactRef`.
 *
 * La heurística de forma es una CONVENIENCIA para no frenar la prosa que el rol
 * `qa.md` manda escribir en modo structural; nunca puede ser un canal para dejar
 * un artefacto REAL fuera del sello. El PoC del security lo mostró: el agente
 * guarda el video como `video de qa.mp4`, la heurística ve el espacio, decide
 * "esto es prosa", saltea el campo y el módulo responde `sellado OK` con el
 * video sin hashear — la desincronización sello↔artefacto de #6475, ahora con el
 * sello afirmando que está todo bien.
 *
 * Por eso el salteo por prosa está condicionado a que el valor NO corresponda a
 * un archivo regular existente. La sonda es deliberadamente PERMISIVA y ajena a
 * la política: acá sólo se contesta "¿esto puede ser un archivo?". Si contesta
 * que sí, el valor sigue el camino normal —`resolveConfined` + `readAndHash`— y
 * es ESE camino, con toda la política de CA-5, el que decide sellar o
 * fail-closed. Un archivo real fuera del recinto ya no se saltea en silencio:
 * frena el sellado.
 *
 * No abre oráculo de existencia (CA-11): el resultado sólo elige entre "saltear
 * con traza" y "resolver"; el motivo que sale al operador sigue siendo
 * categórico y no distingue inexistente de rechazado.
 *
 * #6495 (rebote 7, R-5): la sonda mira TODOS los workspaces del sellado, no
 * solo `ROOT`. Si mirara solo `ROOT`, el artefacto real que el agente escribio
 * en su worktree con un espacio en el nombre volveria a saltearse como prosa y
 * el fail-open de S-1 quedaria reabierto justo en el carril de produccion.
 *
 * @param {string|string[]} bases raiz(es) del sellado (fijas, nunca del YAML)
 * @param {*} value valor declarado por el agente (no confiable)
 * @returns {boolean} true si el valor corresponde a al menos un archivo regular
 */
function resolvesToExistingFile(bases, value) {
  const lista = Array.isArray(bases) ? bases : [bases];
  return lista.some(base => resolvesToExistingFileUnder(base, value));
}

function resolvesToExistingFileUnder(root, value) {
  if (typeof value !== 'string') return false;
  const raw = value.trim();
  if (raw === '') return false;
  let base;
  try { base = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw); }
  catch { return false; }
  if (!/[?*]/.test(raw)) {
    try { return fs.statSync(base).isFile(); } catch { return false; }
  }
  const directory = path.dirname(base);
  const pattern = path.basename(base);
  // Un comodín en el directorio no se sondea: la expansión soportada (y por lo
  // tanto la única que puede producir artefactos) es sobre el basename.
  if (/[?*]/.test(directory)) return false;
  let matcher;
  let names;
  try {
    matcher = globMatcher(pattern);
    names = fs.readdirSync(directory);
  } catch { return false; }
  return names.some(name => {
    if (!matcher.test(name)) return false;
    try { return fs.statSync(path.join(directory, name)).isFile(); } catch { return false; }
  });
}

// #6495 (rebote de seguridad) — El campo de evidencia lo escribe el YAML del
// agente QA: es entrada hostil y NO puede llegar cruda a un sink de log.
//
// El sanitizado es por ALLOWLIST, no por denylist. El denylist ya se mostró
// insuficiente dos veces sobre este mismo sink:
//   1. Cubría sólo drive letters de Windows (`C:\...`), así que toda ruta
//      absoluta POSIX (`/var/lib/...`) o UNC se emitía entera, y un CR/LF en la
//      ruta partía el mensaje en dos líneas permitiendo forjar entradas
//      ("[INFO] sellado aprobado por operador").
//   2. Aun cerrando CR/LF y los controles C0/C1 quedaban afuera tres clases:
//      la coerción de valores no string (`{ruta: ['ok','/var/lib/secreto']}`
//      pasaba por String() y quedaba `ok,/var/lib/secreto`, que ya no empieza
//      con `/` y esquivaba el marcador), los overrides bidireccionales
//      (U+202E invierte visualmente el resto de la línea para el operador) y el
//      envenenamiento dentro de una sola línea (`x) sellado OK campo=(y`).
//
// Una ruta legítima de evidencia vive confinada en `qa/evidence/<issue>/` y sólo
// necesita `[A-Za-z0-9._-]`, `/` y el `*` del glob. Todo lo demás —espacios,
// `:`, backslash, paréntesis, `=`, comas, bidi, cualquier no-ASCII— se
// reemplaza ENTERO por un marcador categórico. Nunca se emite una porción del
// valor original: un escape parcial es exactamente lo que reabre la inyección.
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
// Marcas bidi/invisibles: no son control C0/C1, pero reescriben la línea que ve
// el operador, que es el daño concreto que este sanitizado tiene que evitar.
const BIDI_CHARS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;
// Allowlist: el alfabeto mínimo de una ruta de evidencia confinada.
const SAFE_PATH_CHARS = /^[A-Za-z0-9._\-/*]+$/;
const MAX_LOG_FIELD_CHARS = 120;

// Los motivos son literales internos, pero el sink no confía en eso: sólo se
// emite un motivo de la lista conocida.
const KNOWN_REASONS = new Set([
  'sin-evidencia', 'campos-oversize', 'tipo-invalido', 'traversal', 'fuera-de-recinto',
  'no-regular', 'vacio', 'oversize', 'head-invalido', 'glob-invalido', 'glob-vacio',
  'glob-oversize', 'hash-divergente', 'workspaces-oversize', 'sellado-invalido',
]);

/**
 * Normaliza un valor controlado por el YAML antes de mandarlo a un log.
 * Garantiza: una sola línea, sin caracteres de control ni bidi, sin rutas
 * absolutas, sin caracteres fuera del alfabeto de una ruta de evidencia y
 * acotado en largo.
 *
 * Fail-closed: ante cualquier duda devuelve un marcador categórico ENTERO, no
 * una versión "limpiada" del valor.
 *
 * @param {*} value valor declarado por el agente (no confiable)
 * @returns {string} valor seguro para concatenar en una línea de log
 */
function sanitizeLogField(value) {
  if (value === undefined || value === null) return '';
  // Sin coerción: String(['ok','/var/lib/secreto']) producía una línea que
  // filtraba la ruta absoluta porque el valor unido ya no empieza con `/`.
  if (typeof value !== 'string') return '<valor-no-textual>';
  if (value === '') return '';
  // El trim va ANTES del test de ruta: "  /etc/passwd" sigue siendo absoluta,
  // y "\n/etc/passwd" no puede esquivar el marcador por un prefijo en blanco.
  const trimmed = value.trim();
  if (trimmed === '') return '<ruta-vacia>';
  if (ABSOLUTE_PATH.test(trimmed)) return '<ruta-absoluta>';
  if (CONTROL_CHARS.test(trimmed) || BIDI_CHARS.test(trimmed)) return '<ruta-no-imprimible>';
  if (!SAFE_PATH_CHARS.test(trimmed)) return '<ruta-no-representable>';
  const redacted = String(redactSensitive(trimmed));
  // Defensa en profundidad: si la redacción reintrodujera un carácter de
  // control o bidi, el valor entero se descarta igual.
  if (CONTROL_CHARS.test(redacted) || BIDI_CHARS.test(redacted)) return '<ruta-no-imprimible>';
  if (redacted.length > MAX_LOG_FIELD_CHARS) return `${redacted.slice(0, MAX_LOG_FIELD_CHARS)}<truncado>`;
  return redacted;
}

function sanitizeReason(reason) {
  return KNOWN_REASONS.has(reason) ? reason : 'sellado-invalido';
}

function logFailure(error) {
  const campo = sanitizeLogField(error && error.declaredPath);
  const reason = sanitizeReason(error && error.reason);
  console.error(`[qa-evidence-seal] sellado rechazado (${reason})${campo ? ` campo=${campo}` : ''}`);
}

/**
 * Saca de `data` TODO lo que el agente haya declarado a mano sobre el sellado y
 * devuelve lo sacado como snapshot.
 *
 * #6495 (rebote 5, seguridad) — El sello es una afirmacion DEL PIPELINE, nunca
 * del agente: `data` es el YAML que escribe el agente QA, o sea la entrada no
 * confiable de SEC-1. Antes de este borrado el modulo era fail-open, porque
 * `data.sello` se asignaba SOLO en el camino de exito y en ningun lado se
 * borraba lo preexistente: un sello inventado (head y hashes arbitrarios)
 * sobrevivia intacto al early return por veredicto no aprobado, al fail-closed
 * del `catch`, y —el carril que de verdad importa— al best-effort de los modos
 * structural/api, donde el veredicto queda `aprobado`. El Pulpo re-serializa el
 * YAML entero con `writeYaml` antes de mover el dropfile a `listo/`, asi que
 * ese sello forjado viajaba a `procesado/` y de ahi a las partes 2-5 del split,
 * que lo consumen como autoridad (caducidad por `sello.head`, `sha256` del
 * descriptor de Drive). Es el Objetivo del issue al reves.
 *
 * Alcance del borrado: `sello` y los `<campo>_sha256` de los campos de
 * evidencia (`evidencia*` + `screenshot`), que son los unicos que el sellado
 * deriva y que las partes rio abajo leen. El unico `<campo>_sha256` que puede
 * volver a `data` es el que reescribe `sealQaVerdict` en el camino de exito,
 * derivado de los bytes reales.
 *
 * Idempotente y acotado a `data`: se llama dos veces por dropfile —el Pulpo lo
 * corre para TODO dropfile de qa/verificacion, aprobado o no, y `sealQaVerdict`
 * lo repite para que el modulo sea seguro invocado por si solo.
 *
 * @param {object} data YAML del agente, mutado in-place
 * @returns {{sello: *, hashes: Record<string, *>}} lo declarado, para trazarlo
 */
function stripDeclaredSeal(data) {
  const declared = { sello: undefined, hashes: {} };
  if (!data || typeof data !== 'object') return declared;
  if (data.sello !== undefined) {
    declared.sello = data.sello;
    delete data.sello;
  }
  for (const key of Object.keys(data)) {
    if (!/_sha256$/.test(key)) continue;
    const base = key.slice(0, -'_sha256'.length);
    // Mismo criterio de descubrimiento que `evidenceFields`, para no tocar
    // campos ajenos al sellado que el dropfile pueda traer.
    if (base !== 'screenshot' && !/^evidencia(?:_|$)/.test(base)) continue;
    declared.hashes[key] = data[key];
    delete data[key];
  }
  return declared;
}

/**
 * Une el snapshot que tomó un llamador previo con el que toma el sellado.
 *
 * #6495 (rebote 6, QA) — `stripDeclaredSeal` es DESTRUCTIVO: saca los campos de
 * `data` y sólo el retorno conserva lo declarado. El Pulpo lo corre para TODO
 * dropfile de qa/verificación (aprobado o no) ANTES de los gates, así que
 * cuando `sealQaVerdict` corría su propio strip el campo ya no estaba en `data`
 * y `declared.hashes` salía vacío: el sello se persistía con `descartes: []` y
 * la auditoría de CA-2 se perdía en el ÚNICO camino de producción. Los tests no
 * lo veían porque llamaban a `sealQaVerdict` aislado, sin cruzar el strip
 * previo. La traza sobrevive porque el Pulpo ahora PASA su snapshot y acá se
 * fusiona con el propio.
 *
 * Precedencia: gana lo que todavía está en `data` al momento de sellar (es lo
 * más reciente que escribió el agente); el snapshot previo sólo aporta las
 * claves que ya no están. Y el snapshot del llamador NO es confiable por venir
 * de afuera: se aceptan únicamente claves con forma `<campo>_sha256` (mismo
 * filtro que `stripDeclaredSeal`), para que un llamador no pueda inyectar
 * claves arbitrarias —`__proto__` incluido— en el mapa de descartes.
 *
 * @param {{sello: *, hashes: Record<string, *>}|null|undefined} previo snapshot del llamador
 * @param {{sello: *, hashes: Record<string, *>}} propio snapshot del strip local
 * @returns {{sello: *, hashes: Record<string, *>}}
 */
function mergeDeclaredSnapshots(previo, propio) {
  const merged = { sello: propio.sello, hashes: { ...propio.hashes } };
  if (!previo || typeof previo !== 'object') return merged;
  if (merged.sello === undefined && previo.sello !== undefined) merged.sello = previo.sello;
  const hashesPrevios = previo.hashes;
  if (!hashesPrevios || typeof hashesPrevios !== 'object') return merged;
  for (const key of Object.keys(hashesPrevios)) {
    if (!/_sha256$/.test(key)) continue;
    const base = key.slice(0, -'_sha256'.length);
    if (base !== 'screenshot' && !/^evidencia(?:_|$)/.test(base)) continue;
    if (Object.prototype.hasOwnProperty.call(merged.hashes, key)) continue;
    merged.hashes[key] = hashesPrevios[key];
  }
  return merged;
}

/**
 * Deriva el sello de la evidencia de un veredicto aprobado de QA.
 *
 * ALCANCE DEL FAIL-CLOSED (#6495, rebote 3 · R-2). El módulo siempre intenta
 * sellar y siempre devuelve `sealed:false` + motivo categórico cuando no puede;
 * **quién degrada el veredicto es el llamador**, y sólo lo hace en los modos en
 * los que el gate hermano `validateQaEvidence` también exige evidencia:
 *
 *   - `qaMode: 'android'` sin label `qa:skipped` ⇒ ENFORCED. Un `sealed:false`
 *     degrada el veredicto a `rechazado` (`degradeVerdictForSeal`).
 *   - `qaMode ∈ {'api','structural'}` o label `qa:skipped` ⇒ BEST-EFFORT. Ahí
 *     `evidencia` es prosa por contrato del rol (`.pipeline/roles/qa.md`), así
 *     que un `sealed:false` sólo se loguea: el veredicto NO se toca. El sello se
 *     escribe igual cuando el dropfile sí declara artefactos reales.
 *
 * DÓNDE SE RESUELVE CADA COSA (#6495, rebote 7 · R-5). Artefactos contra los
 * recintos fijos de `workspaces` + `root`; `head` contra `cwd`.
 *
 * CA-12a exige una sola cosa —y sólo esa—: que el `cwd` de `deriveHead` **no
 * salga del YAML**. Eso sigue intacto: el `cwd` viene exclusivamente del
 * `spawnCwd` que el Pulpo tiene en scope y el módulo ignora cualquier ruta
 * presente en `data` (incluido `data.entorno`, que #6258 ya declara). Lo que
 * CA-12a **no** dice es contra qué raíz se resuelven los artefactos: la versión
 * anterior de este JSDoc canonizaba "artefactos contra `root`" citándola, y esa
 * lectura de más dejaba fuera del sello todo lo que el agente escribe en su
 * worktree —que en `verificacion` es TODO lo que declara el rol, porque corre
 * con `cwd = worktreePath`—. Los `workspaces` son igual de no negociables que
 * el `cwd`: los pasa el Pulpo, nunca el YAML.
 *
 * `declared` (CA-2): snapshot OPCIONAL de un `stripDeclaredSeal` previo del
 * llamador. El Pulpo ya corre el strip sobre todo dropfile de qa/verificación
 * antes de los gates, así que sin este parámetro el sellado no tendría contra
 * qué contrastar y persistiría `descartes: []` — ver `mergeDeclaredSnapshots`.
 *
 * @param {{root: string, issue: string|number, data: object, cwd: string, workspaces?: string[], declared?: object, limits?: {totalBytes?: number}}} params
 * @returns {{sealed: boolean, manifest: object|null, descartes: object[], reason: string|null}}
 */
function sealQaVerdict({ root, issue, data, cwd, workspaces, declared: declaredPrevio, limits } = {}) {
  if (!data || typeof data !== 'object') return { sealed: false, manifest: null, descartes: [], reason: 'no-aplica' };
  // #6495 (rebote 5, seguridad) — El borrado va ANTES del early return por
  // veredicto no aprobado: si viviera adentro del `try`, un dropfile
  // `rechazado` viajaria a listo/ con el sello que declaro el agente intacto.
  // (rebote 6, QA) El strip local sigue siendo obligatorio —el modulo tiene que
  // ser seguro invocado solo—, pero lo que se traza es la union con el snapshot
  // del llamador, que es el unico que todavia tiene lo que declaro el agente.
  const declared = mergeDeclaredSnapshots(declaredPrevio, stripDeclaredSeal(data));
  if (data.resultado !== 'aprobado') return { sealed: false, manifest: null, descartes: [], reason: 'no-aplica' };
  try {
    // Se normaliza UNA vez y adentro del try: pasarse del tope de workspaces es
    // fail-closed como cualquier otro tope, no una lista recortada en silencio.
    const bases = normalizeWorkspaces(root, workspaces);
    const fields = evidenceFields(data);
    if (fields.length === 0) throw new SealError('sin-evidencia');
    if (fields.length > MAX_EVIDENCE_FIELDS) throw new SealError('campos-oversize');
    const head = deriveHead(cwd);
    const artifacts = [];
    const discards = [];
    let totalBytes = 0;
    const totalBudget = resolveTotalBudget(limits);

    for (const field of fields) {
      // #6495 (rebote 2 de seguridad) — La ÚNICA omisión permitida es el
      // centinela textual. Antes, `artifactSpec()` devolvía null para lista,
      // null, número y booleano y ese null caía en el mismo `continue`: el
      // campo se salteaba en silencio y el sellado seguía adelante con menos
      // artefactos de los declarados. Con `evidencia: [a, b]` + `screenshot`
      // válido el módulo devolvía `sealed: true` con un solo artefacto y
      // promovía el hash del screenshot a `evidencia_sha256`, o sea la misma
      // desincronización sello-artefacto que este issue existe para eliminar.
      // Ahora todo valor que no produzca spec frena el sellado (fail-closed).
      //
      // #6495 (rebote 4, S-1): el centinela lleva el MISMO contrapeso empírico
      // que la prosa. El centinela se reconoce por prefijo, así que un artefacto
      // real cuyo nombre empiece con la forma del centinela (`-qa-video.mp4`)
      // salía del sello en silencio: la misma clase de fail-open que el PoC.
      // `undefined`/`null` no son strings y la sonda contesta `false`, así que
      // el campo YAML vacío sigue siendo centinela como hasta ahora.
      if (isSkipSentinel(data[field]) && !resolvesToExistingFile(bases, data[field])) {
        discards.push({ campo: field, declarado: null, real: null, motivo: 'centinela' });
        continue;
      }
      // #6495 (rebote 3, R-2/R-3): la prosa NO es una ruta rota. Se saltea con
      // traza explícita —nunca en silencio, que es lo que el rebote 2 cerró— y
      // el sellado sigue con los campos que sí declaran artefactos. Si ninguno
      // lo hace, el `sin-evidencia` de más abajo frena igual (fail-closed).
      //
      // #6495 (rebote 4, S-1): el salteo por prosa exige LAS DOS condiciones —
      // que no tenga forma de ruta Y que no corresponda a un archivo real. Con
      // sólo la primera, cualquier nombre de archivo con un espacio
      // (`video de qa.mp4`, elegido por el mismo agente que escribe el YAML)
      // salía del sello con `sealed: true`, que es exactamente el fail-open que
      // este issue existe para cerrar (CA-4 + CA-7).
      if (typeof data[field] === 'string'
        && !looksLikeArtifactRef(data[field])
        && !resolvesToExistingFile(bases, data[field])) {
        discards.push({ campo: field, declarado: null, real: null, motivo: 'no-es-artefacto' });
        continue;
      }
      const spec = artifactSpec(data[field]);
      if (!spec) throw new SealError('tipo-invalido');
      if (!['original', 'copia', 'derivado'].includes(spec.tipo)) throw new SealError('tipo-invalido');
      const expanded = expandGlob(root, issue, spec.ruta, workspaces);
      const rutas = expanded.rutas;
      // #6495 (rebote 6, QA) — El hash declarado es UNO POR CAMPO, así que sólo
      // tiene contra qué compararse cuando el campo produce UN artefacto. Con
      // un glob que expande a varios, compararlo adentro del bucle emitía una
      // entrada de descarte por archivo, todas con el mismo `declarado` y
      // distinto `real`: exactamente la "traza contradictoria" que la rama de
      // compat de más abajo ya evitaba duplicar. En ese caso el descarte se
      // emite una sola vez, con `real: null`, que significa "el campo no
      // produjo un artefacto único al que apuntar" (misma semántica que la
      // rama de compat de `evidencia_sha256`).
      const rawDeclaredHash = spec.sha256 !== undefined
        ? spec.sha256
        : declared.hashes[`${field}_sha256`];
      // Sale del SNAPSHOT, no de `data`: el campo ya no está en `data` porque
      // se borró al entrar —y el Pulpo lo había borrado antes—, así que leerlo
      // de ahí daría siempre undefined y rompería la traza de CA-1/CA-2.
      const declaredHash = rutas.length === 1 ? normalizeHash(rawDeclaredHash) : null;
      if (rutas.length !== 1 && rawDeclaredHash !== undefined
        && !discards.some(item => item.campo === `${field}_sha256`)) {
        discards.push({
          campo: `${field}_sha256`,
          declarado: normalizeHash(rawDeclaredHash) || '<no-canonico>',
          real: null,
        });
      }
      for (const route of rutas) {
        const confined = resolveConfined(root, issue, route, { workspaces: expanded.workspaces });
        const hashed = readAndHash(confined, route, totalBudget - totalBytes);
        totalBytes += hashed.bytes;
        const artifact = { campo: field, ruta: confined.ruta, ...hashed, tipo: spec.tipo };
        if (spec.tipo === 'derivado') {
          const source = normalizeHash(spec.derivado_de);
          if (!source) throw new SealError('hash-divergente');
          artifact.derivado_de = source;
        }
        if (spec.tipo === 'copia') {
          const source = normalizeHash(spec.derivado_de) || declaredHash;
          if (!source || source !== hashed.sha256) throw new SealError('hash-divergente');
          artifact.derivado_de = source;
        }
        if (declaredHash && declaredHash !== hashed.sha256) {
          discards.push({ campo: `${field}_sha256`, declarado: declaredHash, real: hashed.sha256 });
        }
        artifacts.push(artifact);
      }
    }
    if (artifacts.length === 0) throw new SealError('sin-evidencia');

    // #6495 (rebote 2 de seguridad) — `evidencia_sha256` es el campo de compat
    // y su contrato es apuntar al artefacto de `data.evidencia`. Antes caía a
    // `artefactos[0]` cuando el campo `evidencia` no había producido artefacto,
    // así que el dropfile terminaba con `evidencia: <un archivo>` y
    // `evidencia_sha256: <hash de OTRO archivo>`.
    //
    // Invariante nueva: se fija si y sólo si el campo `evidencia` produjo
    // exactamente un artefacto. En cualquier otro caso —campo ausente,
    // centinela, o glob que expandió a varios— el campo se borra y el
    // manifiesto (`sello.artefactos`) queda como única autoridad. Que falte es
    // verificable; que apunte al archivo equivocado no.
    const evidenciaArtifacts = artifacts.filter(item => item.campo === 'evidencia');
    if (evidenciaArtifacts.length === 1) {
      data.evidencia_sha256 = evidenciaArtifacts[0].sha256;
    } else if (declared.hashes.evidencia_sha256 !== undefined) {
      // El descarte deja traza del hash declarado que se tira, sin filtrar el
      // valor crudo: si no es canónico se registra el marcador (CA-2/SEC-8).
      // `real: null` significa exactamente "el campo `evidencia` no produjo un
      // artefacto único al que apuntar", que es distinto de la divergencia
      // hash-declarado-vs-hash-real que ya traza el bucle. Si el bucle ya
      // trazó este mismo campo (glob con varios artefactos divergentes) no se
      // duplica: dos entradas del mismo campo con `real` distinto se leerían
      // como una traza contradictoria.
      if (!discards.some(item => item.campo === 'evidencia_sha256')) {
        discards.push({
          campo: 'evidencia_sha256',
          declarado: normalizeHash(declared.hashes.evidencia_sha256) || '<no-canonico>',
          real: null,
        });
      }
      // Sin `delete` aca: `stripDeclaredSeal` ya lo saco de `data` al entrar.
    }

    const manifest = { version: 1, derivado_por: 'qa-evidence-seal', head, artefactos: artifacts, descartes: discards };
    data.sello = manifest;
    return { sealed: true, manifest, descartes: discards, reason: null };
  } catch (error) {
    const safeError = error instanceof SealError ? error : new SealError('sellado-invalido');
    logFailure(safeError);
    return { sealed: false, manifest: null, descartes: [], reason: safeError.reason };
  }
}

// #6495 (CA-11 + CA-13) — Traducción del motivo categórico a lenguaje llano.
//
// Vive acá y no inline en `pulpo.js` para que el fail-closed sea testeable: el
// review del rebote 3 marcó que el mapa de mensajes no tenía ninguna prueba y
// que sin motivo el consumidor de rejection-report emite PDF y audio que dicen
// literalmente "Sin motivo" (mismo defecto que motivó #6421).
//
// CA-11 y CA-13 conviven: legible = frase en español + slug entre paréntesis;
// categórico = describe la CLASE de fallo, nunca el path declarado ni un ENOENT
// distinguible de un rechazo por recinto.
const FAILURE_MESSAGES = {
  traversal: 'La ruta de evidencia declarada por QA sale del recinto permitido',
  'fuera-de-recinto': 'La evidencia declarada por QA no es accesible dentro del recinto permitido',
  'no-regular': 'La evidencia declarada por QA no es un archivo regular',
  vacio: 'La evidencia declarada por QA está vacía',
  oversize: 'La evidencia declarada por QA supera el tamaño permitido',
  'head-invalido': 'No se pudo determinar el commit del worktree de QA',
  'glob-invalido': 'El patrón de evidencia declarado por QA no es un patrón soportado',
  'glob-vacio': 'El patrón de evidencia declarado por QA no produjo artefactos',
  'hash-divergente': 'La copia de evidencia no coincide con su hash canónico',
  'campos-oversize': 'QA declaró más campos de evidencia que el límite permitido',
  'glob-oversize': 'El patrón de evidencia produjo más archivos que el límite permitido',
  'tipo-invalido': 'QA declaró un campo de evidencia con un valor que no es una ruta de artefacto',
  'sin-evidencia': 'El veredicto aprobado de QA no declara ningún artefacto de evidencia',
  'workspaces-oversize': 'El sellado recibió más workspaces de evidencia que el límite permitido',
};

const SEAL_REJECTED_BY = 'gate-sellado-evidencia';

/**
 * @param {string} reason motivo categórico devuelto por `sealQaVerdict`
 * @returns {string} frase legible + slug entre paréntesis, sin interpolar rutas
 */
function describeSealFailure(reason) {
  const slug = sanitizeReason(reason);
  const texto = FAILURE_MESSAGES[slug] || 'No se pudo derivar un sello confiable para la evidencia de QA';
  return `${texto} (${slug}).`;
}

/**
 * Degrada in-place el veredicto aprobado que no pudo sellarse. Muta `data`
 * ANTES de que corra el recorder #5708, que se autoexcluye con
 * `data.resultado !== 'aprobado'`: el orden gate → sellado → recorder es por
 * diseño, no por accidente.
 *
 * @returns {{motivo: string, rechazado_por: string}} lo que quedó escrito
 */
function degradeVerdictForSeal(data, reason) {
  const motivo = describeSealFailure(reason);
  data.resultado = 'rechazado';
  data.motivo = motivo;
  data.rechazado_por = SEAL_REJECTED_BY;
  return { motivo, rechazado_por: SEAL_REJECTED_BY };
}

module.exports = {
  sealQaVerdict, stripDeclaredSeal, mergeDeclaredSnapshots, normalizeHash, resolveConfined, deriveHead, sanitizeLogField,
  normalizeWorkspaces, MAX_WORKSPACES,
  describeSealFailure, degradeVerdictForSeal, isSkipSentinel, looksLikeArtifactRef,
  resolvesToExistingFile,
  SEAL_REJECTED_BY,
  MAX_EVIDENCE_FIELDS, MAX_GLOB_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_LOG_FIELD_CHARS,
};
