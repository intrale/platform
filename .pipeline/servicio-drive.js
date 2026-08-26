#!/usr/bin/env node
// =============================================================================
// Servicio Drive — Fire-and-forget: upload de archivos a Google Drive
// Procesa cola de servicios/drive/pendiente/
// Delega el upload real a qa/scripts/qa-video-share.js (OAuth + Drive REST API)
// =============================================================================

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
// #2334: sanitización write-time.
require('./lib/sanitize-console').install();
const { sanitize } = require('./sanitizer');
const { sanitizeDrivePayload, sanitizeDriveFilename, filenameHasSecret } = require('./lib/sanitize-payload');
// CA-3 / RS-3 (#3927): notificación de fallo a Telegram con texto redactado.
const { notifyTelegram } = require('./lib/notify-telegram');
const { isMarkerArtifact } = require('./lib/marker-artifact');
// RS-3 (#3927): `redactSensitive` cubre emails/URLs/bot-tokens, pero NO los
// patrones de VALOR de proveedores (AWS `AKIA…`, `sk-ant-…`, JWT, etc.) — esos
// los redacta `redactSecretValue`. Componemos ambas para no volcar NINGÚN
// secreto del mensaje de error al usuario.
const { redactSensitive, redactSecretValue } = require('./lib/redact');
// CA-1 / CA-2 / R-5 (#6497): UNA sola derivación del hash de integridad en todo
// el pipeline. `sha256File` ya devuelve el formato canónico `sha256:<64 hex>` y
// es el mismo helper que usa el puerto de evidencia E2E. No se reimplementa acá
// ni en `deliverable-notify.js`: dos derivaciones del sello sobre el mismo
// artefacto reproducirían la desincronización que el épico #6475 busca cerrar.
const { sha256File } = require('./lib/e2e-evidence-port');

const PIPELINE = process.env.PIPELINE_STATE_DIR || path.resolve(__dirname);
const PROJECT_ROOT = path.resolve(PIPELINE, '..');
const QUEUE_DIR = path.join(PIPELINE, 'servicios', 'drive');
const PENDIENTE = path.join(QUEUE_DIR, 'pendiente');
const TRABAJANDO = path.join(QUEUE_DIR, 'trabajando');
const LISTO = path.join(QUEUE_DIR, 'listo');
const FALLIDO = path.join(QUEUE_DIR, 'fallido');
const QA_VIDEO_SHARE = path.join(PROJECT_ROOT, 'qa', 'scripts', 'qa-video-share.js');

// Máximo reintentos antes de mover a fallido
const MAX_RETRIES = 2;

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [svc-drive] ${msg}`);
}

// CA-3 / RS-3 (#3927): "fallo de envío SIEMPRE notifica". Antes el camino
// `fallido/` sólo escribía `_error`/`_failedAt` y logueaba → silencio. Ahora
// emite una alerta a Telegram. El texto pasa SIEMPRE por `redactSensitive`
// (RS-3) — nunca volcamos `err.stack`/`_error` crudo al usuario.
//
// CA-UX-1 (#6497): el mensaje NO puede seguir diciendo "el video". Este guard
// dejó de correr sólo en la vía de video: ahora rechaza `.md`, `.pdf` y `.xml`
// (8 de cada 11 artefactos fuera del allowlist en la cola real no son video).
// Un operador que recibe "no se pudo subir el video del issue #4899" por un
// `qa-verificacion-4899.md` sale a buscar un video que nunca existió: es un
// ciclo de diagnóstico humano perdido por alerta. El descriptor del artefacto
// lo deriva `describeArtifact()` a partir del propio job (`mode` + extensión).
//
// CA-5 / R-7: el `sha256` NUNCA entra en este texto. Al operador no le sirve
// para decidir nada, y publicar el hash de un archivo de baja entropía es
// publicar el secreto (fuerza bruta offline).
function notifyDriveFailure(issue, reason, artifact) {
  try {
    const art = (artifact && typeof artifact === 'object' && artifact.label)
      ? artifact
      : DEFAULT_ARTIFACT;
    const safeIssue = /^\d+$/.test(String(issue || '')) ? String(issue) : 'desconocido';
    const safeReason = redactSecretValue(
      redactSensitive(String(reason == null ? 'error desconocido' : reason)),
    );
    const safeBase = art.base
      ? ` (${redactSecretValue(redactSensitive(String(art.base)))})`
      : '';
    notifyTelegram({
      level: 'error',
      component: 'svc-drive',
      message: `Fallo al subir a Drive ${art.label} del issue #${safeIssue}${safeBase}: ${safeReason}`,
      context: { issue: safeIssue, adjunto: art.kind },
    });
  } catch (e) {
    log(`No se pudo notificar fallo a Telegram: ${e.message}`);
  }
}

function listWorkFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(f => !f.startsWith('.') && f.endsWith('.json'))
      .map(f => ({ name: f, path: path.join(dir, f) }));
  } catch { return []; }
}

// Recovery al arrancar: archivos huérfanos en trabajando/ (proceso muerto mid-upload).
// Recientes (<15 min) → reencolar a pendiente. Viejos → descartar a listo/ con marcador
// (reintentar un upload de Drive de hace horas puede duplicar videos ya subidos).
const ORPHAN_MAX_AGE_MS = 15 * 60 * 1000;
function recoverOrphans() {
  const orphans = listWorkFiles(TRABAJANDO);
  if (orphans.length === 0) return;
  const now = Date.now();
  let recovered = 0, discarded = 0;
  for (const file of orphans) {
    try {
      const mtime = fs.statSync(file.path).mtimeMs;
      if (now - mtime < ORPHAN_MAX_AGE_MS) {
        fs.renameSync(file.path, path.join(PENDIENTE, file.name));
        recovered++;
      } else {
        const destName = file.name.replace(/\.json$/, '-zombie-descartado.json');
        fs.renameSync(file.path, path.join(LISTO, destName));
        discarded++;
      }
    } catch {}
  }
  if (recovered > 0) log(`Recovery: ${recovered} orphans recientes reencolados a pendiente/`);
  if (discarded > 0) log(`Recovery: ${discarded} zombies viejos (>${ORPHAN_MAX_AGE_MS/60000}min) movidos a listo/ (no se reintentan)`);
}

// Extraer número de issue desde description o filename
// Ej: "QA video con relato narrado #2015" → "2015"
// Ej: "qa-2015-video.json" → "2015"
function extractIssue(data, filename) {
  // #3927: campo `issue` explícito (schema { file, issue, title } que emite
  // deliverable-notify al encolar). Tiene prioridad si es numérico.
  if (data && data.issue != null && /^\d+$/.test(String(data.issue))) {
    return String(data.issue);
  }
  // Desde description: buscar #NNNN
  if (data.description) {
    const match = data.description.match(/#(\d+)/);
    if (match) return match[1];
  }
  // Desde folder: "QA/evidence/2015" → "2015"
  if (data.folder) {
    const parts = data.folder.split('/');
    const last = parts[parts.length - 1];
    if (/^\d+$/.test(last)) return last;
  }
  // Desde filename: "qa-2015-video.json" → "2015"
  const fMatch = filename.match(/qa-(\d+)/);
  if (fMatch) return fMatch[1];
  return '0';
}

// Extraer título del issue desde description (después del " - " o " — ")
function extractTitle(data) {
  // #3927: campo `title` explícito (schema { file, issue, title }).
  if (data && typeof data.title === 'string' && data.title.trim()) {
    return data.title.trim();
  }
  if (!data.description) return '';
  const match = data.description.match(/(?:#\d+)\s*[-—]\s*(.+)/);
  return match ? match[1].trim() : '';
}

// RS-2 (#3927) + CA-4 (#6497): containment. Sólo se sube a Drive un artefacto
// contenido en uno de los directorios canónicos de evidencia. Evita que un job
// con `../` o un path absoluto arbitrario publique un archivo cualquiera del
// filesystem.
//
// Deja de aplicar sólo a video, de ahí el rename (`ALLOWED_VIDEO_DIRS` →
// `ALLOWED_EVIDENCE_DIRS`): el guard ahora corre ANTES del early-return del
// modo estructural, o sea para TODOS los modos (`api`, `structural`, `android`).
//
// R-4 — el allowlist se amplió a los directorios que producen jobs de Drive
// REALES hoy. Medido sobre la cola de producción: 11 de 169 jobs (6,5 %) caen
// fuera de `qa/evidence|qa/recordings`, y 6 de ellos son estructurales que hoy
// sólo pasan gracias al early-return. `deliverable-notify.js:1150-1183` emite
// bajo `.pipeline/assets/docs/**` y `.pipeline/logs/media/**`, y los reportes de
// QA android bajo `docs/qa/**`. Mover el guard arriba SIN ampliar el allowlist
// mandaba esos 11 a FALLIDO: regresión en producción + tormenta de Telegram.
//
// R-3 — NO se incluye `.claude/worktrees/**` a propósito. El artefacto se
// promueve al repo principal ANTES de encolar el job y el hash se computa sobre
// la copia canónica (CA-3). Un job cuyo artefacto no llegó a la ruta canónica va
// a FALLIDO con un motivo DISTINGUIBLE del motivo de seguridad (CA-UX-2).
//
// Los dropfiles `.pipeline/desarrollo/*/procesado/*.qa` NO son evidencia
// publicable y quedan deliberadamente afuera: deben ir a FALLIDO y corregirse en
// el productor (el propio agente de QA al declarar el campo `file`).
const ALLOWED_EVIDENCE_DIRS = [
  path.resolve(PROJECT_ROOT, 'qa', 'evidence'),
  path.resolve(PROJECT_ROOT, 'qa', 'recordings'),
  path.resolve(PROJECT_ROOT, '.pipeline', 'assets', 'docs'),
  path.resolve(PROJECT_ROOT, '.pipeline', 'logs', 'media'),
  path.resolve(PROJECT_ROOT, 'docs', 'qa'),
];
// Compat: el nombre viejo sigue exportado y apunta a la MISMA lista, para no
// romper consumidores/tests que lo importen mientras dure la transición.
const ALLOWED_VIDEO_DIRS = ALLOWED_EVIDENCE_DIRS;

// #4796 — precedente vivo en `servicio-telegram.js:1044-1047`. `startsWith` sobre
// strings es frágil (`/qa/evidence-malicioso` matchea `/qa/evidence`); `relative`
// razona sobre segmentos de path.
function isUnderBase(base, target) {
  const rel = path.relative(base, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// CA-4: el containment canoniza AMBOS lados con `realpath`. El anterior era
// LÉXICO (`path.resolve` + `startsWith`): no resolvía symlinks ni junctions, así
// que un link creado dentro de `qa/evidence/<issue>/` — directorio que escribe el
// agente de QA en su worktree — resolvía léxicamente "adentro" apuntando afuera.
//
// R-2: `realpathSync` tira `ENOENT` si el path no existe. Acá se aplica sólo
// sobre resultados de `resolveVideoPath` (sus 4 ramas ya validaron `existsSync`),
// y el `realpathSync` del directorio BASE va en `try/catch` porque puede no
// existir en un checkout limpio: degrada a "no permitido", nunca a excepción.
function isWithinAllowedEvidenceDir(resolved) {
  if (!resolved) return false;
  let real;
  try {
    real = fs.realpathSync(path.resolve(resolved));
  } catch {
    return false;
  }
  return ALLOWED_EVIDENCE_DIRS.some((dir) => {
    let base;
    try { base = fs.realpathSync(dir); } catch { return false; }
    return real === base || isUnderBase(base, real);
  });
}
// Compat con el nombre previo (exportado desde #3927).
const isWithinAllowedVideoDir = isWithinAllowedEvidenceDir;

// PROJECT_ROOT canonizado — necesario para derivar la ruta canónica relativa
// (CA-3) cuando el root real difiere del léxico (junctions, nombres 8.3 de
// Windows, `/tmp` → `/private/tmp` en macOS).
function realProjectRoot() {
  try { return fs.realpathSync(PROJECT_ROOT); } catch { return path.resolve(PROJECT_ROOT); }
}

// Resolver la ruta del artefacto: buscar en múltiples ubicaciones posibles.
//
// ⚠️ ESTA FUNCIÓN NO CONFINA (#6497). Hace SÓLO resolución + fallbacks; devuelve
// el path resuelto o `null` si no existe en ninguna de las 4 ramas. El
// confinamiento se centralizó en un ÚNICO punto — `resolveConfinedEvidence()` —
// que corre DESPUÉS, sobre el path RESUELTO.
//
// R-1: confinar el path DECLARADO (como proponía el snippet original del issue)
// rompía los fallbacks. Un job con `file: "qa-5176.mp4"` (basename suelto)
// resuelve hoy vía `qa/recordings/`; con el guard sobre el declarado daría
// `<root>/qa-5176.mp4` → FALLIDO. Orden correcto: resolver → confinar → hashear.
function resolveVideoPath(filePath) {
  // Intentar como ruta relativa al proyecto
  const fromProject = path.resolve(PROJECT_ROOT, filePath);
  if (fs.existsSync(fromProject)) return fromProject;

  // Intentar como ruta absoluta
  if (path.isAbsolute(filePath) && fs.existsSync(filePath)) return filePath;

  // Buscar en qa/evidence/{issue}/ por videos con extensión mp4
  const issueMatch = filePath.match(/qa-(\d+)/);
  if (issueMatch) {
    const issueDir = path.join(PROJECT_ROOT, 'qa', 'evidence', issueMatch[1]);
    if (fs.existsSync(issueDir)) {
      const mp4s = fs.readdirSync(issueDir).filter(f => f.endsWith('.mp4'));
      if (mp4s.length > 0) {
        // Preferir narrated, luego el más reciente
        const narrated = mp4s.find(f => f.includes('narrat'));
        return path.join(issueDir, narrated || mp4s[mp4s.length - 1]);
      }
    }
  }

  // Buscar en qa/recordings/
  const recordingsDir = path.join(PROJECT_ROOT, 'qa', 'recordings');
  if (fs.existsSync(recordingsDir)) {
    const basename = path.basename(filePath);
    const inRecordings = path.join(recordingsDir, basename);
    if (fs.existsSync(inRecordings)) return inRecordings;
  }

  return null;
}

// QA estructural no produce video por contrato. Algunos agentes dejan un
// Markdown auditable y encolan un job para conservar la trazabilidad. Ese job
// no debe llegar al uploader de videos ni fallar por el containment RS-2.
// Exigimos ambos campos canónicos para que un payload común no pueda saltear
// accidentalmente el upload con sólo declarar `mode: structural`.
function isStructuralEvidenceJob(data) {
  return Boolean(
    data
    && data.mode === 'structural'
    && data.source === 'qa-structural',
  );
}

// =============================================================================
// #6497 — Ruta canónica, sello de integridad y confinamiento de TODAS las vías
// =============================================================================

// Motivos de rechazo. CA-UX-2: son DOS causas con acciones humanas OPUESTAS y
// por eso son dos motivos distintos, no un string fundido. Antes el único texto
// era "no se encontró el video o quedó fuera de qa/evidence|qa/recordings".
const REJECT_NO_PROMOVIDO = 'no-promovido';
const REJECT_FUERA_ALLOWLIST = 'fuera-de-allowlist';
const REJECT_ERROR = 'error';

// CA-UX-2: la lista de directorios del mensaje se DERIVA de
// `ALLOWED_EVIDENCE_DIRS`. Escribirla a mano la desincroniza del allowlist real
// en el mismo commit que lo amplía — que es exactamente lo que pasó con el
// string hardcodeado "qa/evidence|qa/recordings".
function allowlistHint() {
  return ALLOWED_EVIDENCE_DIRS
    .map((dir) => path.relative(realProjectRoot(), dir).split(path.sep).join('/') || '.')
    .join(', ');
}

function rejectReasonText(reason) {
  if (reason === REJECT_NO_PROMOVIDO) {
    return 'no promovido a la ruta canónica: el artefacto no existe en el repo '
      + 'principal. Re-promovelo desde el worktree del agente y re-encolá el job.';
  }
  if (reason === REJECT_FUERA_ALLOWLIST) {
    return `fuera de los directorios de evidencia permitidos (${allowlistHint()}). `
      + 'Revisá el productor del job: puede ser un incidente de seguridad.';
  }
  return String(reason);
}

// CA-UX-1: descriptor legible del artefacto, derivado del job (`mode` +
// extensión). Nunca la palabra fija "video".
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const DEFAULT_ARTIFACT = { label: 'el artefacto', kind: 'artefacto', base: '' };

function describeArtifact(data) {
  const file = (data && typeof data.file === 'string') ? data.file : '';
  const base = file ? path.basename(file) : '';
  const ext = base ? path.extname(base).toLowerCase() : '';
  // La extensión manda sobre el `mode` cuando es inequívoca: en la cola real hay
  // jobs `mode: structural` cuyo `file` es un `.mp4` (p.ej. un rebote grabado).
  // Anunciar ESE como "evidencia estructural" sería el mismo error que CA-UX-1
  // corrige, sólo que al revés.
  if (VIDEO_EXTS.has(ext)) return { label: 'el video', kind: 'video', base };
  if (data && data.mode === 'structural') {
    return { label: 'la evidencia estructural', kind: 'evidencia-estructural', base };
  }
  if (ext === '.pdf') return { label: 'el reporte PDF', kind: 'pdf', base };
  if (ext === '.md') return { label: 'la evidencia en Markdown', kind: 'markdown', base };
  if (ext === '.xml') return { label: 'el reporte XML', kind: 'xml', base };
  if (IMAGE_EXTS.has(ext)) return { label: 'la captura', kind: 'imagen', base };
  return { label: 'el artefacto', kind: 'artefacto', base };
}

// CA-4 — PUNTO ÚNICO de confinamiento, usado por AMBAS vías (estructural y
// video). Orden: resolver → confinar → (después) hashear → sellar.
//
// Devuelve `{ ok: true, absolute, canonical }` o `{ ok: false, reason }` con el
// motivo DISTINGUIBLE de CA-UX-2. No lanza: un guard que tira excepción dentro
// de `processJob` cae al catch genérico, que devuelve el job a `pendiente/` y
// arma un loop de reintento infinito.
//
// `canonical` (CA-3) es LA ruta autoritativa del artefacto: relativa al
// PROJECT_ROOT canonizado, con separador POSIX. Todos los derivados (la copia
// `.sanitized/`, el registro de Drive) apuntan a ella.
function resolveConfinedEvidence(filePath) {
  let resolved;
  try {
    resolved = resolveVideoPath(filePath);
  } catch (e) {
    return { ok: false, reason: REJECT_ERROR, detail: e.message };
  }
  if (!resolved) return { ok: false, reason: REJECT_NO_PROMOVIDO };
  if (!isWithinAllowedEvidenceDir(resolved)) {
    return { ok: false, reason: REJECT_FUERA_ALLOWLIST };
  }
  let absolute;
  try {
    absolute = fs.realpathSync(resolved);
  } catch {
    // Carrera: el artefacto existía cuando resolvió y ya no. No es un problema
    // de seguridad — motivo operativo.
    return { ok: false, reason: REJECT_NO_PROMOVIDO };
  }
  const canonical = path.relative(realProjectRoot(), absolute).split(path.sep).join('/');
  return { ok: true, absolute, canonical };
}

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

// CA-1 / CA-2 / CA-5 / CA-6 — el sello lo DERIVA el pipeline, acá y en ningún
// otro lado (R-5). Lo que el agente declare en `sha256`/`bytes` se DESCARTA y se
// recomputa sobre los bytes locales del artefacto YA confinado:
//
//   CA-2 (SEC-10) — el hash se computa LOCAL antes de subir. Nunca se relee
//                   desde Drive para validar: la identidad autoritativa son los
//                   bytes locales.
//   CA-5 (R-7)    — sólo obtiene hash lo que pasó el guard. Hashear antes del
//                   containment convierte el sello en un oráculo de contenido.
//   CA-3          — `file` pasa a ser la ruta canónica; si el job la declaró de
//                   otra forma (basename suelto que resolvió por fallback), la
//                   original queda en `file_declarado` para trazabilidad.
function sealJob(data, confined) {
  if (data.file !== confined.canonical) data.file_declarado = data.file;
  data.file = confined.canonical;
  data.sha256 = sha256File(confined.absolute);
  data.bytes = fs.statSync(confined.absolute).size;
  return data;
}

// CA-1 — el "schema que los exige". `isStructuralEvidenceJob` NO cambia de
// semántica (sigue siendo el discriminador de ruteo, `mode` + `source`); la
// validación del sello es esta función aparte, fail-closed.
function assertSealedStructuralJob(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('descriptor estructural vacío o no-objeto');
  }
  if (typeof data.file !== 'string' || !data.file.trim()) {
    throw new Error('descriptor estructural sin `file` canónico');
  }
  if (typeof data.sha256 !== 'string' || !SHA256_RE.test(data.sha256)) {
    throw new Error('descriptor estructural sin `sha256` derivado (formato `sha256:<64 hex>`)');
  }
  if (!Number.isInteger(data.bytes) || data.bytes <= 0) {
    throw new Error('descriptor estructural sin `bytes` (entero > 0)');
  }
  return true;
}

// R-6 — rollout observable. El cambio es visible en producción desde el primer
// job, así que `DRIVE_CONTAINMENT_MODE=log-only` permite medir el impacto real
// sobre la cola antes de activar el FALLIDO. Default `enforce`: CA-4 exige el
// FALLIDO, y el default nunca puede ser el modo permisivo.
//
// El modo log-only relaja SÓLO la superficie NUEVA (la vía estructural, que
// hasta este commit no pasaba por ningún guard). La vía de video ya estaba
// confinada desde #3927 y sigue rechazando aunque el modo sea log-only: un
// rollout no puede abrir un agujero que ya estaba cerrado.
const CONTAINMENT_MODE = String(process.env.DRIVE_CONTAINMENT_MODE || 'enforce')
  .trim().toLowerCase() === 'log-only' ? 'log-only' : 'enforce';

// CA-UX-3 — un ciclo que rechaza MÁS DE UN job emite UN aviso agregado, no uno
// por job. `notifyTelegram` no tiene dedup ni coalescing (una llamada = un
// mensaje): con la cola actual, activar el FALLIDO sin agrupar son 11 alertas
// seguidas. Un canal que dispara ráfagas entrena al operador a ignorarlo, y ahí
// se pierden las alertas que sí importan. El detalle por job va a `log()`.
let cycleRejections = null;   // null ⇒ fuera de ciclo (processJob suelto)

function reportRejectedJob(entry) {
  log(`Job ${entry.job} rechazado (${entry.reason}): ${entry.detail || rejectReasonText(entry.reason)}`);
  if (cycleRejections) { cycleRejections.push(entry); return; }
  notifyDriveFailure(entry.issue, entry.detail || rejectReasonText(entry.reason), entry.artifact);
}

function flushCycleRejections() {
  const items = Array.isArray(cycleRejections) ? cycleRejections : [];
  cycleRejections = null;
  if (items.length === 0) return;
  if (items.length === 1) {
    const e = items[0];
    notifyDriveFailure(e.issue, e.detail || rejectReasonText(e.reason), e.artifact);
    return;
  }
  try {
    const noProm = items.filter((i) => i.reason === REJECT_NO_PROMOVIDO).length;
    const fuera = items.filter((i) => i.reason === REJECT_FUERA_ALLOWLIST).length;
    const otros = items.length - noProm - fuera;
    const issues = [...new Set(items.map((i) => String(i.issue)).filter((i) => /^\d+$/.test(i)))]
      .map((i) => `#${i}`).join(', ');
    const partes = [];
    if (noProm > 0) partes.push(`${noProm} no promovido${noProm === 1 ? '' : 's'} a la ruta canónica`);
    if (fuera > 0) partes.push(`${fuera} fuera de los directorios permitidos`);
    if (otros > 0) partes.push(`${otros} por error de proceso`);
    // CA-5 / R-7: ni un hash acá tampoco.
    notifyTelegram({
      level: 'error',
      component: 'svc-drive',
      message: `${items.length} jobs de Drive rechazados en este ciclo: ${partes.join(', ')}`
        + (issues ? ` — issues ${issues}` : ''),
      context: {
        rechazados: items.length,
        no_promovidos: noProm,
        fuera_de_allowlist: fuera,
      },
    });
  } catch (e) {
    log(`No se pudo notificar el agregado de rechazos: ${e.message}`);
  }
}

// #2519: lee qa-narration.meta.json (si existe) para saber qué proveedor TTS
// narró el audio. El campo `provider` mapea a Nacho/Rulo del perfil qa.
// Devuelve string vacío si no hay meta confiable — el template omite la línea
// del narrador en ese caso (CA-A5).
function readNarratorProvider(issue) {
  if (!/^\d+$/.test(String(issue || ''))) return '';
  const metaPath = path.join(PROJECT_ROOT, 'qa', 'evidence', String(issue), 'qa-narration.meta.json');
  try {
    if (!fs.existsSync(metaPath)) return '';
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const provider = typeof meta.provider === 'string' ? meta.provider.trim().toLowerCase() : '';
    if (provider === 'edge' || provider === 'openai') return provider;
    return '';
  } catch (_) {
    return '';
  }
}

// #2519: derivar motivo + criterios + modo + verdict del YAML del QA si el
// payload del job no los trae explícitos. Busca en
// `.pipeline/desarrollo/verificacion/procesado/<issue>.qa.yaml` o variantes.
// Best-effort: si no encuentra, devuelve objeto vacío y el template usa fallback.
function readQaVerdictFromYaml(issue) {
  if (!/^\d+$/.test(String(issue || ''))) return {};
  const procesadoDir = path.join(PROJECT_ROOT, '.pipeline', 'desarrollo', 'verificacion', 'procesado');
  try {
    if (!fs.existsSync(procesadoDir)) return {};
    const files = fs.readdirSync(procesadoDir)
      .filter((f) => !isMarkerArtifact(f))
      .filter((f) => f.startsWith(String(issue) + '.') && f.endsWith('.yaml') && f.includes('qa'));
    if (files.length === 0) return {};
    // Preferir el más reciente
    files.sort((a, b) => {
      try {
        return fs.statSync(path.join(procesadoDir, b)).mtimeMs -
               fs.statSync(path.join(procesadoDir, a)).mtimeMs;
      } catch (_) { return 0; }
    });
    const yamlText = fs.readFileSync(path.join(procesadoDir, files[0]), 'utf8');
    // Parseo minimalista YAML — sólo los campos que nos interesan para el template
    const out = {};
    const m1 = /^\s*resultado:\s*(\w+)\s*$/m.exec(yamlText);
    if (m1) out.verdict = m1[1].toLowerCase();
    const m2 = /^\s*modo:\s*(\w+)\s*$/m.exec(yamlText);
    if (m2) out.mode = m2[1].toLowerCase();
    const m3 = /^\s*motivo:\s*["']?(.*?)["']?\s*$/m.exec(yamlText);
    if (m3) out.motivo = m3[1].trim();
    const m4 = /^\s*criterios_fallidos:\s*\[(.*?)\]\s*$/m.exec(yamlText);
    if (m4) {
      out.criteriosFallidos = m4[1]
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    }
    const m5 = /^\s*tests_passed:\s*(\d+)\s*$/m.exec(yamlText);
    if (m5) out.passed = m5[1];
    const m6 = /^\s*tests_total:\s*(\d+)\s*$/m.exec(yamlText);
    if (m6) out.total = m6[1];
    return out;
  } catch (_) {
    return {};
  }
}

// Ejecutar qa-video-share.js como child process.
// #2519: ahora lee verdict/passed/total/mode/motivo/criteriosFallidos/narrator
// del payload del job (con fallback a YAML del QA y meta de narración).
// Todo lo textual pasa por sanitizeDrivePayload antes de viajar como arg CLI.
function runVideoShare(videoPath, issue, title, payload) {
  return new Promise((resolve, reject) => {
    // CA-S4: validar issue numérico antes de construir paths/args
    if (!/^\d+$/.test(String(issue || ''))) {
      return reject(new Error(`issue inválido: ${JSON.stringify(issue)}`));
    }

    const data = payload && typeof payload === 'object' ? payload : {};
    const yamlFallback = readQaVerdictFromYaml(issue);

    // Helper: primer string no vacío
    const firstNonEmpty = (...vals) => {
      for (const v of vals) {
        if (v !== undefined && v !== null && String(v).trim() !== '') return String(v);
      }
      return '';
    };

    const verdict = firstNonEmpty(data.verdict, yamlFallback.verdict);
    const passed = firstNonEmpty(data.passed, yamlFallback.passed, '0');
    const total = firstNonEmpty(data.total, yamlFallback.total, '0');
    const mode = firstNonEmpty(data.mode, yamlFallback.mode);
    const motivo = firstNonEmpty(data.motivo, yamlFallback.motivo);
    const criteriosFallidos = Array.isArray(data.criteriosFallidos) && data.criteriosFallidos.length > 0
      ? data.criteriosFallidos
      : (Array.isArray(yamlFallback.criteriosFallidos) ? yamlFallback.criteriosFallidos : []);
    const narrator = firstNonEmpty(data.narrator, readNarratorProvider(issue));
    const rejectionPdf = firstNonEmpty(data.rejectionPdf, `logs/rejection-${issue}-qa.pdf`);

    // CA-S2: sanitizar campos textuales libres antes de pasarlos como args.
    // sanitizeDrivePayload cubre title/description/caption; extendemos para
    // motivo + criterios + narrator + verdict usando el mismo sanitizer.
    const sanitizable = sanitizeDrivePayload({
      title: title || '',
      verdict: verdict || '',
      mode: mode || '',
      motivo: motivo || '',
      narrator: narrator || '',
      criteriosFallidos: criteriosFallidos.join('|'),
    });

    const args = [
      QA_VIDEO_SHARE,
      '--issue', issue,
      '--videos', videoPath,
      // CA-A1/A2: veredicto + contadores reales (o fallback legacy si no hay)
      '--verdict', sanitizable.verdict || 'EVIDENCIA',
      '--passed', String(passed),
      '--total', String(total),
    ];
    if (sanitizable.title) args.push('--title', sanitizable.title);
    if (sanitizable.mode) args.push('--mode', sanitizable.mode);
    if (sanitizable.motivo) args.push('--motivo', sanitizable.motivo);
    if (sanitizable.criteriosFallidos) {
      args.push('--criterios-fallidos', sanitizable.criteriosFallidos.replace(/\|/g, ','));
    }
    if (sanitizable.narrator) args.push('--narrator', sanitizable.narrator);
    // Rejection PDF: sólo si existe el archivo; el child también valida.
    try {
      if (rejectionPdf && fs.existsSync(path.resolve(PROJECT_ROOT, rejectionPdf))) {
        args.push('--rejection-pdf', rejectionPdf);
      }
    } catch (_) { /* best-effort */ }

    log(`Ejecutando: node ${args.join(' ')}`);

    execFile(process.execPath, args, {
      cwd: PROJECT_ROOT,
      timeout: 600000, // 10 min
      env: { ...process.env },
    }, (err, stdout, stderr) => {
      if (stdout) log(`[qa-video-share stdout] ${stdout.trim()}`);
      if (stderr) log(`[qa-video-share stderr] ${stderr.trim()}`);
      if (err) {
        reject(new Error(`qa-video-share exit ${err.code || err.signal}: ${stderr || err.message}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

// Procesar un job individual
async function processJob(file) {
  const trabajandoPath = path.join(TRABAJANDO, file.name);
  try { fs.renameSync(file.path, trabajandoPath); } catch { return; }

  try {
    const rawData = JSON.parse(fs.readFileSync(trabajandoPath, 'utf8'));
    // #2334: sanitizar description/title/caption ANTES del upload.
    // Esos campos van como CLI args a qa-video-share.js y terminan en
    // metadata de Drive + mensajes de Telegram.
    const data = sanitizeDrivePayload(rawData);
    const issue = extractIssue(data, file.name);
    const title = extractTitle(data);
    const videoFile = data.file || '';

    if (!videoFile) {
      log(`Job ${file.name}: sin campo 'file', moviendo a listo`);
      fs.renameSync(trabajandoPath, path.join(LISTO, file.name));
      return;
    }

    const artifact = describeArtifact(data);

    // CA-4 (#6497) — CONTAINMENT ANTES DEL EARLY-RETURN ESTRUCTURAL.
    //
    // Hasta este commit, `if (isStructuralEvidenceJob(data)) { … return; }`
    // corría ANTES de `resolveVideoPath`, donde vivía el único containment: un
    // job estructural con `file: "qa/evidence/6258/../../../.claude/secrets/
    // credentials.json"` o con un absoluto fuera del repo NUNCA era evaluado.
    // Era inofensivo mientras la vía estructural sólo movía el descriptor a
    // `listo/`; con el sellado pasa a ser lectura + publicación del hash de un
    // path arbitrario → oráculo de existencia → oráculo de contenido →
    // exfiltración (OWASP A01:2021 + A08:2021).
    //
    // Ahora el guard corre acá arriba y aplica a TODOS los modos.
    const confined = resolveConfinedEvidence(videoFile);
    if (!confined.ok) {
      // R-6 — en rollout log-only sólo se deja pasar la superficie NUEVA (la vía
      // estructural, que antes no pasaba por ningún guard). La vía de video ya
      // estaba confinada desde #3927 y sigue yendo a FALLIDO.
      if (CONTAINMENT_MODE === 'log-only' && isStructuralEvidenceJob(data)) {
        log(`R-6 log-only: job ${file.name} habría ido a FALLIDO (${confined.reason}: ${videoFile})`
          + ' — se deja pasar SIN sellar');
        ensureDir(LISTO);
        fs.renameSync(trabajandoPath, path.join(LISTO, file.name));
        return;
      }
      // Mover a fallido para no reintentar indefinidamente.
      ensureDir(FALLIDO);
      fs.renameSync(trabajandoPath, path.join(FALLIDO, file.name));
      // CA-3 (#3927): fallo SIEMPRE notifica. CA-UX-1/2/3 (#6497): con el tipo
      // real de artefacto, el motivo distinguible y agrupado por ciclo.
      reportRejectedJob({
        job: file.name,
        issue,
        reason: confined.reason,
        detail: confined.detail,
        artifact,
      });
      return;
    }

    if (isStructuralEvidenceJob(data)) {
      // CA-1 / CA-2 / CA-5: el sello se deriva DESPUÉS del guard, sobre los
      // bytes locales del artefacto confinado, y se persiste en el descriptor
      // antes de moverlo a `listo/` — `qa/evidence/**` es efímero, así que la
      // identidad autoritativa del artefacto es este registro con hash.
      try {
        sealJob(data, confined);
        assertSealedStructuralJob(data);
      } catch (e) {
        // Fail-closed: un descriptor que no se puede sellar NO llega a `listo/`
        // haciéndose pasar por evidencia trazable. Va a FALLIDO con motivo
        // propio (nunca al catch genérico, que lo devolvería a `pendiente/` y
        // armaría un loop de reintento infinito).
        ensureDir(FALLIDO);
        fs.renameSync(trabajandoPath, path.join(FALLIDO, file.name));
        reportRejectedJob({
          job: file.name,
          issue,
          reason: REJECT_ERROR,
          detail: `no se pudo sellar la evidencia estructural: ${e.message}`,
          artifact,
        });
        return;
      }
      log(`Job ${file.name}: QA estructural sellado (${data.bytes} bytes); cola Drive eximida`);
      ensureDir(LISTO);
      fs.writeFileSync(trabajandoPath, JSON.stringify(data, null, 2));
      fs.renameSync(trabajandoPath, path.join(LISTO, file.name));
      return;
    }

    // La vía de video reutiliza el MISMO resultado del punto único de
    // confinamiento: no hay una segunda resolución que pueda divergir.
    const resolvedPath = confined.absolute;

    // CA-1 — el registro de subida también lleva el sello. El descriptor viaja
    // al child como payload, así que el hash acompaña al artefacto subido.
    try {
      sealJob(data, confined);
    } catch (e) {
      ensureDir(FALLIDO);
      fs.renameSync(trabajandoPath, path.join(FALLIDO, file.name));
      reportRejectedJob({
        job: file.name,
        issue,
        reason: REJECT_ERROR,
        detail: `no se pudo sellar el artefacto: ${e.message}`,
        artifact,
      });
      return;
    }

    // #2334 CA7: validar que el basename NO contenga patrones de secretos
    // (tokens, JWT, etc). Si matchea, copiamos a un path con nombre
    // truncado + hash (no placeholder, que rompería la trazabilidad). El
    // contenido del video NO se toca — es binario y el sanitizer sólo
    // opera sobre texto.
    let uploadPath = resolvedPath;
    const originalBasename = path.basename(resolvedPath);
    if (filenameHasSecret(originalBasename)) {
      const safeBasename = sanitizeDriveFilename(originalBasename);
      const safeDir = path.join(path.dirname(resolvedPath), '.sanitized');
      try {
        fs.mkdirSync(safeDir, { recursive: true });
      } catch {}
      const safePath = path.join(safeDir, safeBasename);
      try {
        fs.copyFileSync(resolvedPath, safePath);
        uploadPath = safePath;
        // CA-3 — la copia `.sanitized/` es un DERIVADO, no un artefacto nuevo:
        // `copyFileSync` la hace byte-idéntica, así que arrastra el MISMO
        // `sha256` y apunta a la ruta canónica. NO se recalcula un hash distinto
        // (dos hashes para el mismo contenido es la desincronización de #6475).
        data.derivado_de = confined.canonical;
        log(`Filename sanitizado: basename original contenía patrón de secreto, subiendo como ${safeBasename}`);
      } catch (e) {
        log(`Error copiando a nombre saneado (${e.message}); se omite upload para evitar leak`);
        ensureDir(FALLIDO);
        fs.renameSync(trabajandoPath, path.join(FALLIDO, file.name));
        // CA-3: fallo SIEMPRE notifica (mensaje redactado RS-3).
        reportRejectedJob({
          job: file.name,
          issue,
          reason: REJECT_ERROR,
          detail: `no se pudo preparar el nombre seguro del archivo: ${e.message}`,
          artifact,
        });
        return;
      }
    }

    // CA-1 — persistir el sello en el descriptor ANTES de subir: si el proceso
    // muere mid-upload, el registro que queda en `trabajando/`/`fallido/` ya
    // tiene la identidad del artefacto.
    try {
      fs.writeFileSync(trabajandoPath, JSON.stringify(data, null, 2));
    } catch (e) {
      log(`No se pudo persistir el sello en el descriptor: ${e.message}`);
    }

    log(`Subiendo ${artifact.label}: ${uploadPath} (issue #${issue})`);

    // Reintentar hasta MAX_RETRIES veces
    // #2519: pasar `data` completo (ya sanitizado) al child para que el template
    // tenga verdict/passed/total/mode/motivo/criterios/narrator/rejectionPdf.
    let lastErr;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await runVideoShare(uploadPath, issue, title, data);
        log(`Upload exitoso: ${file.name} (intento ${attempt})`);
        fs.renameSync(trabajandoPath, path.join(LISTO, file.name));
        return;
      } catch (e) {
        lastErr = e;
        log(`Intento ${attempt}/${MAX_RETRIES} falló: ${e.message}`);
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }

    // Todos los intentos fallaron
    log(`Upload fallido después de ${MAX_RETRIES} intentos: ${file.name}`);
    ensureDir(FALLIDO);
    // Agregar info de error al job
    try {
      const jobData = JSON.parse(fs.readFileSync(trabajandoPath, 'utf8'));
      jobData._error = lastErr.message;
      jobData._failedAt = new Date().toISOString();
      fs.writeFileSync(trabajandoPath, JSON.stringify(jobData, null, 2));
    } catch {}
    fs.renameSync(trabajandoPath, path.join(FALLIDO, file.name));
    // CA-3 / RS-3: fallo terminal SIEMPRE notifica a Telegram, con el mensaje
    // del último error redactado (nunca `err.stack`/`_error` crudo).
    reportRejectedJob({
      job: file.name,
      issue,
      reason: REJECT_ERROR,
      detail: `tras ${MAX_RETRIES} intentos: ${lastErr && lastErr.message ? lastErr.message : 'error desconocido'}`,
      artifact,
    });

  } catch (e) {
    log(`Error procesando ${file.name}: ${e.message}`);
    try { fs.renameSync(trabajandoPath, file.path); } catch {}
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Cola global para serializar uploads (evitar saturar OAuth)
let processing = false;

async function processQueue() {
  if (processing) return;
  processing = true;
  // CA-UX-3: abrir la ventana de agregación del ciclo. Todos los rechazos de
  // este barrido se acumulan y salen como UN aviso si son más de uno.
  cycleRejections = [];
  try {
    const files = listWorkFiles(PENDIENTE);
    if (files.length === 0) return;

    log(`${files.length} job(s) en cola`);
    for (const file of files) {
      await processJob(file);
    }
  } finally {
    processing = false;
    // En `finally` para que un throw inesperado no deje al operador sin aviso
    // NI deje la ventana abierta contaminando el ciclo siguiente.
    try { flushCycleRejections(); } catch { cycleRejections = null; }
  }
}

function main() {
  log('Servicio Drive iniciado (upload real via qa-video-share.js)');

  // Verificar que qa-video-share.js existe
  if (!fs.existsSync(QA_VIDEO_SHARE)) {
    log(`ERROR: qa-video-share.js no encontrado en ${QA_VIDEO_SHARE}`);
    process.exit(1);
  }

  recoverOrphans();
  try { require('./lib/ready-marker').signalReady('svc-drive'); } catch {}
  setInterval(() => {
    processQueue().catch(e => log(`Error en processQueue: ${e.message}`));
  }, 10000);
}

// CA-4 / RS-2 (#3927) — exportamos las funciones puras para el test de
// integración (`node --test`). Sin esto, requerir el módulo arrancaba el
// servicio (pidfile + setInterval), colgando el runner.
module.exports = {
  resolveVideoPath,
  isWithinAllowedVideoDir,
  notifyDriveFailure,
  extractIssue,
  extractTitle,
  isStructuralEvidenceJob,
  processJob,
  ALLOWED_VIDEO_DIRS,
  // #6497 — ruta canónica, sello y confinamiento único.
  ALLOWED_EVIDENCE_DIRS,
  isWithinAllowedEvidenceDir,
  isUnderBase,
  resolveConfinedEvidence,
  sealJob,
  assertSealedStructuralJob,
  describeArtifact,
  allowlistHint,
  processQueue,
  SHA256_RE,
  REJECT_NO_PROMOVIDO,
  REJECT_FUERA_ALLOWLIST,
  REJECT_ERROR,
  PROJECT_ROOT,
  PENDIENTE,
  LISTO,
  FALLIDO,
  TRABAJANDO,
};

// Arranque del servicio: SOLO cuando se ejecuta directamente (`node servicio-drive.js`),
// nunca al ser requerido como módulo desde un test.
if (require.main === module) {
  fs.writeFileSync(path.join(PIPELINE, 'svc-drive.pid'), String(process.pid));
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  // Crash handlers — loguear antes de morir para diagnóstico
  const LOG_DIR = path.join(PIPELINE, 'logs');
  process.on('uncaughtException', (err) => {
    // #2334: sanitizar antes de persistir stack a disco.
    const msg = sanitize(`[${new Date().toISOString()}] [svc-drive] CRASH uncaughtException: ${err.stack || err.message}\n`);
    try { fs.appendFileSync(path.join(LOG_DIR, 'svc-drive.log'), msg); } catch {}
    console.error(msg);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    const msg = sanitize(`[${new Date().toISOString()}] [svc-drive] CRASH unhandledRejection: ${reason?.stack || reason}\n`);
    try { fs.appendFileSync(path.join(LOG_DIR, 'svc-drive.log'), msg); } catch {}
    console.error(msg);
    process.exit(1);
  });

  main();
}
