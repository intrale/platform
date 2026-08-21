// =============================================================================
// approval-channel.js — Kernel del canal único de aprobación/firma humana
// (issue #6206, parte 1 de 4 del split de #6199).
//
// QUÉ RESUELVE
// ------------
// Hoy cada gate tiene su propio write path de firma y el de GATE 1
// (`operator-signoff-gate.recordDefinitionSignature`) está huérfano: ningún
// productor de producción lo invoca. Este módulo es el ÚNICO camino de escritura
// de firma del pipeline — auditable, idempotente y multi-gate — del que dependen
// los tres medios (Telegram #6207, bandeja del dashboard #6208, docs #6209).
//
// Materializa el invariante rector de #4571 §5.1: **el adaptador pide, el kernel
// ejecuta**. Los adaptadores llaman `requestSignature()` / `submitSignature()`;
// nunca escriben firmas por su cuenta.
//
// EL KERNEL ORQUESTA, NO DUPLICA
// ------------------------------
// La autoridad sobre si un issue está firmado sigue siendo `evaluate()` de cada
// gate, leyendo su audit hash-chain. Este módulo despacha al writer de cada gate
// y NO reimplementa la lógica de integridad de ninguno.
//
// MODELO DE SEGURIDAD
// -------------------
// [CA-A1 · A01] Enum de gates congelado. Gate fuera del enum ⇒ rechazo
//   fail-closed ANTES de construir ningún path (nunca `path.join` con el gate
//   crudo).
// [CA-A2 · SEC-4] El ancla se recalcula SIEMPRE server-side. El cliente aporta
//   sólo `{ verdict, nonce }`; cualquier `anchor` que venga en la entrada se
//   ignora. `body-hash` y `commit-sha` NO se normalizan a un tipo único (R2):
//   `anchor` es `{kind, value}` con comparación discriminada por `kind`.
// [CA-A2 · A01] Las `options` del writer del gate se construyen por ENUMERACIÓN
//   EXPLÍCITA server-side (`buildWriterOptions`), NUNCA reenviando un objeto del
//   llamador. Ese objeto es el que decide la autorización del firmante
//   (`normalizeAuthorizedSigners(options.authorizedSigners)`), y por la misma vía
//   viajarían `pipelineDir` (redirige el chain de no repudio), `fsImpl`,
//   `rateLimit` (anula CA-11) y `now`/`nowISO` (falsifican el `signed_at`).
//   [CA-A5.b] La allowlist se resuelve server-side y **POR GATE** (`signersFor`
//   del registry), desde la MISMA fuente que el evaluador de ese gate:
//   `definicion` → `operator-gate.resolveOperatorAllowlist` (== `pulpo.js:5906`);
//   `aceptacion` → semántica de `delivery.js:100`, SIN el fallback al chat
//   principal de `pulpo.js:15035` (decisión D-4). Fail-closed si queda vacía.
//   Una lista única para los dos gates hacía al canal MÁS ANCHO que el evaluador
//   de GATE 1 y una firma aceptada por el canal invalidaba la firma legítima
//   previa del operador (DoS del gate por confused deputy).
// [A01/A02] El token del canal es una capability bearer: se devuelve en memoria
//   al adaptador que pidió la firma, pero NO se persiste ni en el depósito ni en
//   el audit. El depósito lo leen dashboard y Telegram; un token ahí es "quien
//   lee el índice, firma".
// [CA-A3 · SEC-1/SEC-2] Nonce de un solo uso namespaced por `(gate, issue,
//   anchor)`, extendiendo `action-token.js` (NO reimplementándolo acá): el
//   binding viaja dentro del payload firmado (`g`/`h`) y se compara en el
//   consumo.
// [CA-A4 · SEC-5] El depósito de pendientes es índice de PRESENTACIÓN, jamás
//   autoridad. Ausencia de pendiente NUNCA implica firma. Depósito ausente o
//   corrupto en `enforce` ⇒ retiene y alerta.
// [CA-A5 · H-2] El tercer escritor (`operator-gate.auditSignature`) se despacha
//   desde el registry (decisión D-2: la opción "retiro" quedó VETADA), para que
//   toda firma que pase por el canal siga alimentando
//   `audit/operator-gate-signatures.jsonl`, que lee `operator-wait.js:167`.
// [CA-A6 · SEC-9] Intento no autorizado: rechazado, registrado con allowlist
//   EXPLÍCITA de campos (construida por enumeración, no por copia+redacción) y
//   sin filtrar nonce ni token. Rate-limit también en el camino de rechazo, con
//   contador propio y acotado.
// [CA-A6.b] El rate-limit acota el camino que un atacante REALMENTE pisa: se
//   consulta y consume ANTES del paso 1 (ningún rechazo lo esquiva), la llave es
//   `origen` de ENUM CERRADO + un bucket GLOBAL por ventana (no sale del
//   payload, así que rotarla no compra intentos), y el log de rechazos se rota
//   por tamaño para que un intento hostil no engorde un archivo que
//   `appendChained` relee entero.
// [CA-A2.b] Ningún campo que gobierne una decisión fail-closed o que quede en el
//   acta se acepta del payload: `gateMode` se recalcula server-side leyendo
//   config en los TRES call sites (`requestSignature`, `listPending`, el acta).
//   Un gate fail-closed cuyo modo elige quien lo consume no es fail-closed.
//   Ídem `evidence_hash` del acta de GATE 2 (`operator-signature.js:816`): lo
//   computa el kernel sobre lo que él mismo presentó (`computeChannelEvidenceHash`)
//   y al firmar lo lee del `nonce_issued` hash-chained, NUNCA de un campo del
//   payload (el literal prohibido no se escribe ni en comentario: se verifica
//   por grep sobre este archivo, igual que SEC-2).
// [CA-A1 · #4571 §5.1] Cada gate es operable END-TO-END desde el kernel: si un
//   gate exige un artefacto previo para poder firmar (GATE 2 exige un nonce de un
//   solo uso, CA-5 de `operator-signature`), lo emite `requestSignature` por el
//   `prepare` del registry. Un adaptador que tuviera que llamar DIRECTO a
//   `issueNonce` estaría escribiendo en el audit chain del gate por fuera del
//   kernel — lo contrario del invariante rector ("el adaptador pide, el kernel
//   ejecuta") y del contrato ÚNICO multi-gate.
// [CA-A7 · A08] Firma invalidada si cambió lo firmado: el ancla recalculada no
//   matchea la firmada ⇒ se pide firma nueva.
// [SEC-2] El identificador del actor local del dashboard NO aparece en el
//   camino de firma. Se verifica por grep sobre este archivo, así que el
//   literal prohibido no se escribe ni siquiera en un comentario.
//
// NO usa `operational-state.js`: esa fachada cubre sólo `waves.json`,
// `.partial-pause.json` y `.paused` (verificado en `operational-state-lint.js`),
// y el depósito nuevo no cae bajo ella (R-6 del issue).
// =============================================================================
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const trace = require('./traceability');
const auditLog = require('./audit-log');
const redact = require('./redact');
const actionToken = require('./action-token');

const PIPELINE_DIR = path.join(trace.REPO_ROOT, '.pipeline');

// D-1 — depósito propio, DISTINTO de la cola `gate-signature/pendiente/` de
// #4580 (que es una cola que drena el kernel; esto es un índice de
// presentación). Nombres parecidos, semánticas distintas: R-4.
const DEFAULT_DEPOSIT_DIR = path.join(PIPELINE_DIR, 'approval-channel', 'pendiente');
const DEFAULT_AUDIT_FILE = path.join(PIPELINE_DIR, 'audit', 'approval-channel.jsonl');
const DEFAULT_REJECT_FILE = path.join(PIPELINE_DIR, 'audit', 'approval-channel-rejects.jsonl');
const DEFAULT_RATE_FILE = path.join(PIPELINE_DIR, 'approval-channel', '.reject-rate.json');

// Rate-limit del camino de RECHAZO (SEC-3 / CA-A6.b). Contador propio: ver
// `checkRejectRate`. `maxGlobalPerWindow` es el techo GLOBAL de la ventana: sin
// él, cualquier llave (aunque sea de enum cerrado) multiplica el techo por la
// cardinalidad del enum.
const DEFAULT_REJECT_RATE = Object.freeze({
    windowMs: 60 * 1000,
    maxPerWindow: 5,
    maxGlobalPerWindow: 15,
});

/**
 * CA-A6.b — enum CERRADO de medios de origen. **La llave del rate-limit sale de
 * acá, nunca del payload.** El defecto de rev-2 era `actorKey = p.actor || ...`:
 * rotar un string era gratis y el techo no existía. Un enum cerrado + bucket
 * global hace que el store esté acotado por construcción (≤ ORIGENES.length
 * buckets) y que no haya nada que rotar.
 */
const ORIGENES = Object.freeze(['telegram', 'dashboard', 'cli', 'pipeline', 'desconocido']);

/** Todo origen que no esté en el enum cae al bucket `desconocido` (no crea llave nueva). */
function normalizeOrigen(raw) {
    const s = String(raw == null ? '' : raw).trim().toLowerCase();
    return ORIGENES.includes(s) ? s : 'desconocido';
}

// CA-A6.b — el log de rechazos es un anillo ACOTADO, no una cadena de no repudio
// (esa vive en el audit del gate). Cuando supera este tamaño se rota, así un
// intento hostil nunca hace crecer sin techo un archivo que `appendChained`
// relee entero (`audit-log.js:71 readLastHash`).
const REJECT_FILE_MAX_BYTES = 256 * 1024;

// Límite de texto presentado antes de declarar recorte (REQ-SEC-5).
const PRESENTATION_MAX_CHARS = 3500;

// Allowlist estricta del id de issue, ANTES de tocar el FS (molde de
// `gate-signature-request.js:64`).
const ISSUE_ID_RE = /^\d+$/;

// El token del canal necesita una `action` de las que ya acepta
// `action-token.ACTION_ALLOWLIST` (que NO se altera, por decisión del issue). La
// acción es sólo el envoltorio heredado: lo que decide es el `verdict` que el
// operador elige al firmar, atado al token por el binding `(g, h)`.
const CARRIER_ACTION = 'approve';

// Mapeo verdict → acción del audit companion (`operator-gate.auditSignature`),
// que habla el vocabulario de `GATE_ACTIONS`.
const VERDICT_TO_ACTION = Object.freeze({
    signed: 'approve',
    rejected: 'reject',
    're-definition': 'adjust-definicion',
});

// -----------------------------------------------------------------------------
// CA-A1 · Registry congelado de gates
// -----------------------------------------------------------------------------

/**
 * Enum CERRADO y CONGELADO de gates despachables. Agregar un gate es un cambio
 * deliberado de este objeto — nunca un string que llega de afuera.
 *
 * `writer` es lazy (`() => require(...)`) para no crear un ciclo de require con
 * los módulos de gate y para que un módulo roto de un gate no impida cargar el
 * canal entero.
 *
 * `auditCompanion: true` (D-2) ⇒ además del writer propio del gate, la firma
 * alimenta `audit/operator-gate-signatures.jsonl` vía
 * `operator-gate.auditSignature`. Se activa en AMBOS gates: el CA-A5 pide que
 * "toda firma que pase por el canal" siga alimentando ese artefacto, y no
 * quedaría cubierto activándolo sólo en uno.
 */
const GATES = Object.freeze({
    definicion: Object.freeze({
        gate: 'definicion',
        anchorKind: 'body-hash',
        verdicts: Object.freeze(['signed', 're-definition', 'rejected']),
        auditCompanion: true,
        writer: () => require('./operator-signoff-gate').recordDefinitionSignature,
        // CA-A2.b — sección de `config.yaml` que gobierna el modo REAL de este
        // gate. El kernel lo lee de acá; nunca del payload del cliente.
        configKey: 'operator_signoff',
        // CA-A5.b — MISMA fuente que el evaluador de este gate
        // (`pulpo.js:5906` → `operator-gate.resolveOperatorAllowlist`).
        signersFor: (d) => resolveDefinicionSigners(d),
        // GATE 1 no tiene un nonce propio: el anti-replay es el del token del
        // canal (`action-token`, namespaced por `(g,i,h)`). `prepare` no emite
        // nada y `writerExtras` no agrega campos al acta.
        prepare: () => ({ ok: true }),
        writerExtras: () => ({ ok: true, extras: {} }),
    }),
    aceptacion: Object.freeze({
        gate: 'aceptacion',
        anchorKind: 'commit-sha',
        verdicts: Object.freeze(['signed', 'rejected']),
        auditCompanion: true,
        writer: () => require('./operator-signature').recordAcceptanceSignature,
        configKey: 'operator_signature',
        // CA-A5.b + D-4 — semántica de `delivery.resolveAuthorizedSigners`
        // (`delivery.js:100`), designada por el PO como autoridad ÚNICA de
        // GATE 2. SIN el fallback al chat principal de `pulpo.js:15035`.
        signersFor: (d) => resolveAceptacionSigners(d),
        // CA-A1/#6206 rev-4 — GATE 2 exige (CA-5 de `operator-signature`) un
        // nonce PROPIO emitido por `operator-signature.issueNonce`, ligado a
        // `(issue, sha)` y persistido en el audit hash-chain del gate. Lo emite
        // EL KERNEL al pedir la firma: si lo emitiera el adaptador estaría
        // escribiendo en el audit chain del gate por fuera del kernel, que es
        // exactamente lo contrario del invariante rector ("el adaptador pide,
        // el kernel ejecuta") y del contrato ÚNICO multi-gate de CA-A1.
        prepare: (d, ctx) => issueAceptacionNonce(d, ctx),
        // CA-A2.b — el `evidence_hash` del acta NO sale del payload: se lee del
        // registro `nonce_issued` que escribió este mismo kernel.
        writerExtras: (d, ctx) => resolveAceptacionWriterExtras(d, ctx),
    }),
});

/** Enum cerrado de tipos de ancla. `body-hash` y `commit-sha` NO son intercambiables (R2). */
const ANCHOR_KINDS = Object.freeze(['body-hash', 'commit-sha']);

/** Enum cerrado de tipos de evidencia (UX CA-UX1: referencias, nunca payloads). */
const EVIDENCE_KINDS = Object.freeze(['issue', 'pr', 'commit', 'run', 'artifact', 'doc']);

/**
 * Resuelve el gate contra el enum congelado. **Fail-closed ANTES de tocar el
 * filesystem** (CA-A1): devolver `{ok:false}` acá garantiza que ningún caller
 * construyó un path con el gate crudo.
 *
 * @param {string} gate
 * @returns {{ok:true, spec:object}|{ok:false, reason:string}}
 */
function resolveGate(gate) {
    if (typeof gate !== 'string' || !Object.prototype.hasOwnProperty.call(GATES, gate)) {
        return { ok: false, reason: 'gate fuera del enum congelado' };
    }
    return { ok: true, spec: GATES[gate] };
}

/**
 * ¿`raw` es un id de issue válido? Molde de `gate-signature-request.isValidIssueId`.
 * @param {number|string} raw
 * @returns {boolean}
 */
function isValidIssueId(raw) {
    const s = String(raw);
    return ISSUE_ID_RE.test(s) && Number(s) > 0;
}

// -----------------------------------------------------------------------------
// CA-A2 · Ancla server-side (nunca del cliente)
// -----------------------------------------------------------------------------

/**
 * Recalcula el ancla de lo que se firma. **SIEMPRE server-side**: toma el
 * material fuente (`body` para `definicion`, `commit` para `aceptacion`) y
 * delega en la función canónica del gate correspondiente. Un `anchor` que venga
 * en la entrada del cliente JAMÁS llega hasta acá.
 *
 * @param {string} gate
 * @param {{body?:string, commit?:string}} source
 * @returns {{ok:true, anchor:{kind:string,value:string}}|{ok:false, reason:string}}
 */
function computeAnchor(gate, source = {}) {
    const g = resolveGate(gate);
    if (!g.ok) return g;

    if (g.spec.anchorKind === 'body-hash') {
        if (typeof source.body !== 'string' || source.body.trim() === '') {
            return { ok: false, reason: 'body requerido para recalcular el ancla del gate definicion' };
        }
        const value = require('./operator-signoff-gate').computeCriteriaHash(source.body);
        return { ok: true, anchor: { kind: 'body-hash', value } };
    }

    // commit-sha
    try {
        const value = require('./operator-signature').validateSha(source.commit);
        return { ok: true, anchor: { kind: 'commit-sha', value } };
    } catch (e) {
        return { ok: false, reason: `commit inválido para el ancla del gate aceptacion: ${e.message}` };
    }
}

/** sha256 hex de un texto (digest de lo presentado, REQ-SEC-5). */
function digestText(text) {
    return `sha256:${crypto.createHash('sha256').update(String(text), 'utf8').digest('hex')}`;
}

// -----------------------------------------------------------------------------
// Depósito de pendientes (índice de presentación — CA-A4)
// -----------------------------------------------------------------------------

/**
 * Path del pendiente. `issue` está validado `^\d+$` y `gate` viene del enum
 * congelado, así que ningún componente es texto crudo del cliente. La
 * comprobación de contención es defensa REDUNDANTE (molde de
 * `gate-signature-request.js:140-142`).
 *
 * @returns {string|null} `null` si el path escaparía del depósito.
 */
function depositPathFor(depositDir, issue, gate) {
    const file = path.join(depositDir, `${Number(issue)}-${gate}.json`);
    const resolved = path.resolve(file);
    if (!resolved.startsWith(path.resolve(depositDir) + path.sep)) return null;
    return resolved;
}

function resolveDeps(deps = {}) {
    return {
        fsImpl: deps.fsImpl || fs,
        depositDir: deps.depositDir || DEFAULT_DEPOSIT_DIR,
        auditFile: deps.auditFile || DEFAULT_AUDIT_FILE,
        rejectFile: deps.rejectFile || DEFAULT_REJECT_FILE,
        rateFile: deps.rateFile || DEFAULT_RATE_FILE,
        auditImpl: deps.auditImpl || auditLog,
        signer: deps.signer || null,
        now: typeof deps.now === 'function' ? deps.now : () => Date.now(),
        rejectRate: { ...DEFAULT_REJECT_RATE, ...(deps.rejectRate || {}) },
        // Entorno del que se resuelve la allowlist de firmantes SERVER-SIDE.
        // `deps` es cableado del proceso (no input del cliente): un adaptador
        // llama `submitSignature(p)` sin `deps`; los tests inyectan un env
        // hermético. NO existe ningún camino por el que el payload del cliente
        // aporte firmantes autorizados.
        env: deps.env || process.env,
        // Config ya resuelta (tests / caller que la tiene en mano). `null` ⇒ el
        // kernel la lee él mismo con `config-resolver`. En ningún caso sale del
        // payload del cliente.
        config: deps.config != null ? deps.config : null,
        // Sólo para tests herméticos: raíz `.pipeline/` del writer del gate. En
        // producción va `null` y cada gate resuelve su propio default.
        writerPipelineDir: typeof deps.writerPipelineDir === 'string' && deps.writerPipelineDir !== ''
            ? deps.writerPipelineDir
            : null,
        // Rate-limit de FIRMA del gate (CA-11). Es del gate, no del cliente.
        writerRateLimit: deps.writerRateLimit || null,
        // Companion de audit (D-2). Lazy y sustituible en tests: el default
        // construye el singleton de `operator-gate`, que resuelve credenciales.
        auditCompanion: deps.auditCompanion
            || ((record) => require('./operator-gate').getDefault().auditSignature(record)),
    };
}

function tokenSigner(d) {
    if (d.signer) return d.signer;
    return actionToken;
}

// -----------------------------------------------------------------------------
// CA-A2 · A01 — las opciones del writer se construyen SERVER-SIDE
// -----------------------------------------------------------------------------

/**
 * Lee la config del pipeline SERVER-SIDE. Nunca sale del payload del cliente.
 *
 * @returns {{ok:true, config:object}|{ok:false, config:null}} `ok:false` ⇒ no se
 *   pudo determinar la config ⇒ los callers fallan CERRADO (`enforce`, `[]`).
 */
function readConfigSafe(d) {
    try {
        const config = d.config !== null
            ? d.config
            : require('./config-resolver').resolve({ pipelineDir: d.writerPipelineDir || undefined });
        if (config && typeof config === 'object') return { ok: true, config };
        return { ok: false, config: null };
    } catch {
        return { ok: false, config: null };
    }
}

/**
 * CA-A5.b · allowlist del gate `definicion`.
 *
 * **MISMA fuente que el evaluador de este gate**: `pulpo.js:5906` hace
 * `[...resolveOperatorAllowlist(process.env)]`, y esa función
 * (`operator-gate.js:80-85`) lee SÓLO `TELEGRAM_LEO_OPERATOR_CHAT_ID`.
 *
 * POR QUÉ NO LA UNIÓN (defecto rev-2, A01 · confused deputy): el canal resolvía
 * `env ∪ cua.operator_chat_ids` para los DOS gates, o sea MÁS ANCHO que el
 * evaluador de GATE 1. Como `evalSignature` se queda con la firma MÁS RECIENTE,
 * una firma que el canal aceptaba y el evaluador no reconocía **daba vuelta a
 * `block` una firma legítima previa del operador** — DoS del gate alcanzable por
 * un aprobador de respaldo, y `submitSignature` devolvía `ok:true` a un humano
 * cuyo gate quedaba peor que antes (requisito UX: la respuesta del canal tiene
 * que coincidir con el veredicto real del gate).
 *
 * Fail-closed: sin allowlist devuelve `[]` y el writer rechaza toda firma.
 *
 * @returns {Array<string>}
 */
function resolveDefinicionSigners(d) {
    try {
        return Array.from(require('./operator-gate').resolveOperatorAllowlist(d.env));
    } catch {
        // Módulo roto ⇒ no aporta firmantes. NUNCA abre el camino.
        return [];
    }
}

/**
 * CA-A5.b + D-4 · allowlist del gate `aceptacion`.
 *
 * GATE 2 tiene DOS evaluadores divergentes en `main` (hallazgo NUEVO B de guru):
 *   - `delivery.js:363` → `resolveAuthorizedSigners(cfg)` (`delivery.js:100`):
 *     `cua.operator_chat_ids` ∪ `TELEGRAM_LEO_OPERATOR_CHAT_ID`. **Fail-closed.**
 *   - `pulpo.js:3717`  → `resolveCuaOperatorChatIds` (`pulpo.js:15025`): idem,
 *     PERO si el set queda vacío cae al chat principal del bot (`:15035-15038`).
 *
 * **Decisión D-4 del PO (vinculante): la autoridad es la semántica de
 * `delivery.js:100`. El canal NO adopta el fallback al chat principal**, porque
 * convertiría "nadie designado" en "cualquiera del chat principal firma la
 * aceptación", que es lo contrario del invariante de GATE 2 (CLAUDE.md: sólo una
 * identidad autorizada; ante ausencia bloquea y escala). Unificar los tres
 * resolutores de `main` quedó fuera de alcance → recomendación #6232.
 *
 * Se replica la semántica sobre `d.env` (en vez de invocar `delivery.js`, que
 * lee `process.env` directo y haría no herméticos los tests). La equivalencia
 * NO queda librada a la buena fe: `approval-channel-authority.test.js` la
 * bloquea comparando esta salida contra `delivery.resolveAuthorizedSigners`.
 *
 * @returns {Array<string>}
 */
function resolveAceptacionSigners(d) {
    const ids = new Set();

    // 1 · allowlist de config, leída SERVER-SIDE (jamás del payload del cliente).
    const cfg = readConfigSafe(d);
    const cua = (cfg.ok && cfg.config.cua) || {};
    if (Array.isArray(cua.operator_chat_ids)) {
        for (const raw of cua.operator_chat_ids) {
            const s = String(raw == null ? '' : raw).trim();
            if (s) ids.add(s);
        }
    }

    // 2 · credential dedicada del operador (misma que suma `delivery.js:109`).
    const envOperator = String((d.env && d.env.TELEGRAM_LEO_OPERATOR_CHAT_ID) || '').trim();
    if (envOperator) ids.add(envOperator);

    // Fail-closed explícito: sin nada configurado, `[]` — NO el chat principal.
    return Array.from(ids);
}

/**
 * CA-A2.b · modo REAL del gate, recalculado SERVER-SIDE leyendo `config.yaml`.
 *
 * POR QUÉ (defecto rev-2, A09 + fail-closed roto): `gateMode` venía del payload
 * del caller con default `'dry-run'`, y decide TRES cosas —
 * `requestSignature` (retener texto hostil, REQ-SEC-5), `listPending` (marcar
 * `degraded` ante depósito ausente, CA-A4) y el `gate_mode` del acta de no
 * repudio. Un adaptador que OMITÍA el campo recibía una lista vacía con
 * `degraded:false`, indistinguible de "está todo firmado". **Un gate fail-closed
 * cuyo modo elige quien lo consume no es fail-closed.**
 *
 * Reglas (todas fail-closed hacia `enforce`, que es el modo que RETIENE):
 *   - config ilegible o sección ausente ⇒ `enforce` (no se puede determinar).
 *   - sección con `enabled: false`      ⇒ `dry-run` (el gate está apagado por
 *     decisión explícita del operador; retener sería ruido gratuito).
 *   - `gate_mode: 'enforce'`            ⇒ `enforce`; cualquier otro ⇒ `dry-run`.
 *
 * @param {object} spec - entrada del registry `GATES`.
 * @returns {'enforce'|'dry-run'}
 */
function resolveGateMode(spec, d) {
    const cfg = readConfigSafe(d);
    if (!cfg.ok) return 'enforce';
    const section = cfg.config[spec.configKey];
    if (!section || typeof section !== 'object') return 'enforce';
    if (section.enabled === false) return 'dry-run';
    return section.gate_mode === 'enforce' ? 'enforce' : 'dry-run';
}

/**
 * Construye las `options` que van al writer del gate por **ENUMERACIÓN
 * EXPLÍCITA**, mismo patrón que `recordRejectedAttempt`.
 *
 * POR QUÉ (A01 · confused deputy): `options` es *exactamente* el objeto que decide
 * la autorización del firmante — `recordDefinitionSignature` y
 * `recordAcceptanceSignature` hacen `normalizeAuthorizedSigners(options.authorizedSigners)`
 * y nada más. Reenviar un objeto del cliente ahí (el viejo `p.writerOptions`)
 * delegaba en el llamador la decisión de quién puede firmar, y por la misma vía
 * viajaban `pipelineDir` (redirige el audit chain de no repudio), `fsImpl`
 * (sustituye el filesystem), `rateLimit` (anula CA-11) y `now`/`nowISO`
 * (falsifican el `signed_at`). Construir por enumeración es lo que hace que el
 * comentario del paso 11 ("la autoridad sigue siendo DEL GATE") sea cierto.
 *
 * Ningún campo sale del payload del cliente: todos salen de `d` (deps del
 * proceso) o se resuelven server-side.
 *
 * CA-A5.b — la allowlist se pide al `spec` del gate que se está resolviendo
 * (`signersFor`), NO a una unión única para los dos gates: el canal no puede ser
 * más ancho que el evaluador que después decide.
 *
 * @param {object} d
 * @param {object} spec - entrada del registry `GATES`.
 */
function buildWriterOptions(d, spec) {
    const options = {
        // A01 + CA-A5.b — server-side y POR GATE, nunca del input.
        authorizedSigners: spec.signersFor(d),
        // Reloj del kernel: el gate deriva `signed_at` de acá. `nowISO` NO se
        // pasa, así que el timestamp del chain de no repudio no es inyectable.
        now: Number(d.now()),
    };
    if (d.writerPipelineDir !== null) options.pipelineDir = d.writerPipelineDir;
    if (d.fsImpl !== fs) options.fsImpl = d.fsImpl;
    if (d.writerRateLimit !== null) options.rateLimit = d.writerRateLimit;
    return options;
}

/** Raíz `.pipeline/` que usa el writer del gate (tests inyectan una hermética). */
function writerPipelineDirOf(d) {
    return d.writerPipelineDir !== null ? d.writerPipelineDir : PIPELINE_DIR;
}

// -----------------------------------------------------------------------------
// Nonce PROPIO del gate `aceptacion` (CA-5 de operator-signature) — lo emite el
// KERNEL, nunca el adaptador
// -----------------------------------------------------------------------------

/**
 * Forma del nonce de GATE 2: 32 hex minúsculas, tal como lo emite
 * `operator-signature.generateNonce` (16 bytes de CSPRNG en hex). Este módulo
 * NO genera nonces (invariante A-1, verificado por grep en
 * `approval-channel-nonce.test.js`): sólo valida la FORMA del que le devuelven,
 * y lo hace ANTES de leer el audit para que un string arbitrario del payload no
 * dispare una lectura de la cadena entera.
 */
const GATE_NONCE_RE = /^[0-9a-f]{32}$/;

/**
 * Hash del paquete de evidencia PRESENTADO, computado **server-side** sobre
 * material que armó este kernel (nada del payload crudo llega acá):
 *   - `anchor` recalculada server-side (CA-A2),
 *   - `presented.digest` (digest de lo que el medio muestra, REQ-SEC-5),
 *   - `evidence` ya normalizada por `normalizeEvidence` (enum cerrado de `kind`,
 *     `ref` truncada, ≤ 20 items).
 *
 * Se computa UNA vez, al pedir la firma, y queda en el registro `nonce_issued`
 * del audit hash-chained del gate. Al firmar, el acta lo toma DE AHÍ.
 *
 * @param {object} request - el `SignatureRequest` ya armado por el kernel.
 * @returns {string} `sha256:<hex>`
 */
function computeChannelEvidenceHash(request) {
    return require('./operator-signature').computeEvidenceHash({
        v: 'approval-channel/evidence/v1',
        gate: request.gate,
        issue: request.issue,
        anchor_kind: request.anchor.kind,
        anchor_value: request.anchor.value,
        presented_digest: request.presented.digest,
        truncated: request.presented.truncated,
        evidence: request.evidence,
    });
}

/**
 * `prepare` del gate `aceptacion`: emite el nonce de un solo uso de GATE 2 por
 * el ÚNICO camino legítimo (`operator-signature.issueNonce`), con las opciones
 * construidas server-side por el kernel.
 *
 * POR QUÉ EXISTE (defecto rev-3, bloqueante): `recordAcceptanceSignature` exige
 * (CA-5) un nonce previamente emitido; el canal no lo emitía, así que
 * `requestSignature({gate:'aceptacion'})` devolvía `ok:true` y `submitSignature`
 * con exactamente lo que el kernel entregaba fallaba con "nonce inexistente". El
 * gate sólo firmaba si el adaptador llamaba DIRECTO a `issueNonce`, o sea
 * escribiendo en el audit chain del gate POR FUERA del kernel — lo contrario del
 * invariante rector de #4571 §5.1 y del contrato único multi-gate (CA-A1).
 *
 * El `nonce` es una capability bearer, igual que el token: viaja SÓLO en la
 * respuesta en memoria de `requestSignature`, nunca al depósito ni al audit del
 * canal (el depósito lo leen Telegram y el dashboard: un nonce ahí es "quien lee
 * el índice, firma").
 *
 * @param {object} d
 * @param {{issue:number, anchor:object, evidenceHash:string}} ctx
 * @returns {{ok:true, nonce:string}|{ok:false, reason:string}}
 */
function issueAceptacionNonce(d, ctx) {
    const cfg = readConfigSafe(d);
    const section = (cfg.ok && cfg.config.operator_signature && typeof cfg.config.operator_signature === 'object')
        ? cfg.config.operator_signature
        : {};
    let out;
    try {
        out = require('./operator-signature').issueNonce({
            issueId: ctx.issue,
            sha: ctx.anchor.value,
            // Server-side: digest de lo que el kernel presenta (REQ-SEC-5).
            evidenceHash: ctx.evidenceHash,
            config: { nonce_ttl_seconds: section.nonce_ttl_seconds },
            // Mismas opciones enumeradas que el writer: `pipelineDir`/`fsImpl`/
            // reloj del kernel. `authorizedSigners` le es indiferente a
            // `issueNonce`, pero no se arma un objeto aparte para no abrir un
            // segundo camino de construcción de opciones.
            options: buildWriterOptions(d, GATES.aceptacion),
        });
    } catch (e) {
        return { ok: false, reason: `no se pudo emitir el nonce del gate aceptacion: ${e.message}` };
    }
    if (!out || out.ok !== true || typeof out.nonce !== 'string') {
        return { ok: false, reason: `no se pudo emitir el nonce del gate aceptacion: ${(out && out.reason) || 'sin motivo'}` };
    }
    return { ok: true, nonce: out.nonce };
}

/**
 * `writerExtras` del gate `aceptacion`: resuelve los campos que el writer de
 * GATE 2 necesita y que **no pueden salir del payload** (CA-A2.b).
 *
 * `evidence_hash` queda en el acta de no repudio (`operator-signature.js:816`).
 * Antes se reenviaba el campo homónimo crudo del payload, sin validación de forma
 * ni de largo y sin figurar en los `@param`: cualquiera podía elegir qué
 * "evidencia" decía haber visto el operador en un artefacto hash-chained. Ahora
 * se lee del registro `nonce_issued` que escribió ESTE kernel al emitir el
 * pedido, atado al mismo `(issue, nonce, sha)` que el gate va a validar.
 *
 * Fail-closed: si la cadena no se puede leer, o no hay un `nonce_issued` del
 * canal para ese `(issue, nonce, sha)`, **se rechaza antes de despachar** (y
 * antes de escribir el companion de audit).
 *
 * @param {object} d
 * @param {{issue:number, anchor:object, nonce:*}} ctx
 * @returns {{ok:true, extras:object}|{ok:false, reason:string}}
 */
function resolveAceptacionWriterExtras(d, ctx) {
    const nonce = typeof ctx.nonce === 'string' ? ctx.nonce : '';
    if (!GATE_NONCE_RE.test(nonce)) {
        return { ok: false, reason: 'nonce del gate ausente o con forma inválida' };
    }
    const gate2 = require('./operator-signature');
    let state;
    try {
        state = gate2.readSignatureState(ctx.issue, writerPipelineDirOf(d));
    } catch (e) {
        const code = (e && typeof e.code === 'string') ? e.code : 'unknown';
        return { ok: false, reason: `audit del gate aceptacion no verificable (${code}) — firma NO registrada` };
    }
    const issued = gate2.filterByKind(state.entries, ctx.issue, gate2.KIND_NONCE)
        .find(r => r.nonce === nonce && r.sha === ctx.anchor.value);
    if (!issued) {
        return { ok: false, reason: 'el nonce del gate no fue emitido por el canal para este artefacto' };
    }
    return {
        ok: true,
        extras: {
            nonce,
            // El writer normaliza `typeof !== 'string'` a `''`; acá ya viene del
            // registro server-side, así que o es el digest emitido o es ''.
            evidenceHash: typeof issued.evidence_hash === 'string' ? issued.evidence_hash : '',
        },
    };
}

// -----------------------------------------------------------------------------
// CA-A6 · Registro de intentos no autorizados + rate-limit del rechazo
// -----------------------------------------------------------------------------

/**
 * CA-A6.b · Rate-limit del camino de RECHAZO (SEC-3), con **contador propio y
 * acotado** en store separado.
 *
 * Por qué no se reusa `operator-signoff-gate.checkSignatureRateLimit`: ese lee
 * sólo firmas YA PERSISTIDAS, y el no autorizado retorna sin escribir nada ⇒
 * cuenta siempre 0 ⇒ intentos ilimitados.
 *
 * Por qué el contador NO se deriva del log de rechazos: si el registro de
 * intentos fuera la fuente del contador, el atacante controlaría su propio
 * límite y engordaría un archivo que el camino legítimo relee entero.
 *
 * QUÉ SE CORRIGIÓ EN ESTA REV (los dos bypass de rev-2):
 *   - **La llave ya no sale del payload.** Antes era
 *     `String(p.actor || p.signedBy || 'anonimo')`: rotar un string era gratis y
 *     50 intentos escribían 50 entradas. Ahora la llave es `origen`, de ENUM
 *     CERRADO (`ORIGENES`), así que el store tiene a lo sumo `ORIGENES.length`
 *     buckets y no hay nada que rotar.
 *   - **Techo GLOBAL por ventana.** Un enum cerrado, por sí solo, multiplica el
 *     techo por su cardinalidad. `maxGlobalPerWindow` acota la suma de todos los
 *     buckets: sin él, cualquier llave derivada del payload sigue siendo rotable
 *     dentro del enum.
 *   - **Se consulta y consume ANTES del paso 1** (ver `submitSignature`): antes
 *     entraba recién en el paso 3 y los rechazos más baratos (gate fuera del
 *     enum, issue inválido) salían por un `reject()` que no tocaba el contador.
 *
 * @param {string} origen - medio de origen; se normaliza contra `ORIGENES`.
 * @param {object} d      - deps YA resueltas (`resolveDeps`).
 * @param {{record?:boolean}} [opts] - `record:false` consulta sin consumir.
 * @returns {{allowed:boolean, count:number, global:number, scope:string|null}}
 */
function checkRejectRate(origen, d, { record = true } = {}) {
    const key = normalizeOrigen(origen);
    const nowMs = Number(d.now());
    const since = nowMs - d.rejectRate.windowMs;
    const maxOrigen = d.rejectRate.maxPerWindow;
    const maxGlobal = Number.isFinite(d.rejectRate.maxGlobalPerWindow)
        ? d.rejectRate.maxGlobalPerWindow
        : DEFAULT_REJECT_RATE.maxGlobalPerWindow;

    /** Marcas de una lista que siguen dentro de la ventana. */
    const live = (v) => (Array.isArray(v) ? v : [])
        .map(Number).filter(t => Number.isFinite(t) && t >= since);

    let store = { buckets: {}, global: [] };
    try {
        const raw = d.fsImpl.readFileSync(d.rateFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            store = {
                buckets: (parsed.buckets && typeof parsed.buckets === 'object') ? parsed.buckets : {},
                global: Array.isArray(parsed.global) ? parsed.global : [],
            };
        }
    } catch { /* ausente o corrupto → se reconstruye (fail-closed: cuenta desde 0) */ }

    const bucket = live(store.buckets[key]);
    const global = live(store.global);
    const count = bucket.length;
    const globalCount = global.length;

    let scope = null;
    if (count >= maxOrigen) scope = 'origen';
    else if (globalCount >= maxGlobal) scope = 'global';
    const allowed = scope === null;

    if (record) {
        bucket.push(nowMs);
        global.push(nowMs);

        // Cotas duras: el store no crece ni con marcas ni con llaves.
        //   - por bucket: nunca más de maxOrigen+1 marcas;
        //   - global: nunca más de maxGlobal+1 marcas;
        //   - llaves: sólo las del enum cerrado, y sólo si tienen marcas vivas.
        const buckets = {};
        for (const name of ORIGENES) {
            const marks = name === key ? bucket : live(store.buckets[name]);
            if (marks.length > 0) buckets[name] = marks.slice(-(maxOrigen + 1));
        }

        const next = { buckets, global: global.slice(-(maxGlobal + 1)) };
        try {
            d.fsImpl.mkdirSync(path.dirname(d.rateFile), { recursive: true });
            d.fsImpl.writeFileSync(d.rateFile, JSON.stringify(next), 'utf8');
        } catch { /* el rate-limit degradado no debe abrir el camino de firma */ }
    }

    return { allowed, count, global: globalCount, scope };
}

/**
 * CA-A6.b — rota el log de rechazos cuando supera `REJECT_FILE_MAX_BYTES`.
 *
 * El log de rechazos es un ANILLO ACOTADO de forense, **no** la cadena de no
 * repudio (esa es la del audit del gate, que nunca se rota). Sin esto, cada
 * intento hostil paga un `appendChained` que relee el archivo entero
 * (`audit-log.js:286` → `readLastHash:71`): el costo por intento crece con el
 * archivo que el camino legítimo también relee.
 *
 * El corte de cadena queda TRAZADO: la primera entrada del archivo nuevo declara
 * el hash con el que cerraba el rotado, así el forense puede empalmar.
 *
 * @returns {string|null} hash de cierre del archivo rotado, o `null` si no rotó.
 */
function rotateRejectFileIfNeeded(d) {
    let size = 0;
    try {
        size = Number(d.fsImpl.statSync(d.rejectFile).size) || 0;
    } catch {
        return null; // no existe todavía ⇒ nada que rotar
    }
    if (size < REJECT_FILE_MAX_BYTES) return null;

    let lastHash = null;
    try {
        const lines = d.fsImpl.readFileSync(d.rejectFile, 'utf8').split('\n').filter(Boolean);
        const last = lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : null;
        lastHash = (last && typeof last.hash === 'string') ? last.hash : null;
    } catch { /* ilegible ⇒ se rota igual: lo que importa es acotar */ }

    try {
        d.fsImpl.renameSync(d.rejectFile, `${d.rejectFile}.1`);
    } catch {
        // No se pudo rotar: se trunca. Acotar el archivo es el invariante; el
        // histórico de rechazos no es autoridad de nada.
        try { d.fsImpl.writeFileSync(d.rejectFile, '', 'utf8'); } catch { /* best-effort */ }
    }
    return lastHash;
}

/**
 * Registra un intento rechazado (CA-A6). El registro se construye por
 * **enumeración explícita** de `{gate, issue, origen, actor, at}` — NO por copia
 * del objeto de entrada + redacción.
 *
 * Ese orden importa: `redact.js` deja pasar un nonce de 24 hex tal cual (no
 * matchea `SECRET_VALUE_PATTERNS` ni llega al mínimo de entropía), así que
 * copiar+redactar filtraría el nonce del intento. `redactObject` es la SEGUNDA
 * línea de defensa, no la primera.
 */
function recordRejectedAttempt({ gate, issue, origen, actor, reason }, d) {
    // CA-A6.b — anillo acotado: el archivo se rota ANTES de crecer sin techo.
    const rotatedFrom = rotateRejectFileIfNeeded(d);

    const entry = {
        type: 'approval_channel_rejected',
        // Enumeración explícita — ningún campo del input se copia en bloque.
        gate: typeof gate === 'string' ? gate.slice(0, 64) : null,
        issue: isValidIssueId(issue) ? Number(issue) : null,
        // `origen` ya viene normalizado contra el enum cerrado por el caller;
        // el `slice` es defensa redundante.
        origen: origen == null ? null : String(origen).slice(0, 64),
        actor: actor == null ? null : String(actor).slice(0, 128),
        // `reason` es texto propio del kernel (constantes de este módulo), nunca
        // eco del input del cliente.
        reason: reason == null ? null : String(reason).slice(0, 200),
        at: new Date(d.now()).toISOString(),
    };
    if (rotatedFrom !== null) entry.chain_rotated_from = rotatedFrom;
    try {
        d.auditImpl.appendChained({
            file: d.rejectFile,
            entry: redact.redactObject(entry), // segunda línea
            fsImpl: d.fsImpl,
        });
        return true;
    } catch {
        return false;
    }
}

// -----------------------------------------------------------------------------
// requestSignature — el adaptador PIDE
// -----------------------------------------------------------------------------

/**
 * Construye el `SignatureRequest` de un gate y lo deja en el depósito para que
 * los medios (Telegram #6207, bandeja #6208) lo presenten.
 *
 * El ancla se recalcula server-side (CA-A2). El contrato de presentación
 * (`title`/`question`/`options`/`evidence`) lo fija ESTE módulo — los medios
 * eligen el envoltorio, no el vocabulario (CA-UX1): así el operador ve la misma
 * pregunta y las mismas opciones en Telegram y en el dashboard.
 *
 * @param {object} p
 * @param {string} p.gate            - ∈ GATES.
 * @param {number|string} p.issue
 * @param {string} [p.body]          - material fuente del gate `definicion`.
 * @param {string} [p.commit]        - material fuente del gate `aceptacion`.
 * @param {string} [p.titleText]     - asunto del issue (para el `title`).
 * @param {Array<{kind:string,ref:string}>} [p.evidence] - referencias, nunca payloads.
 * @param {object} [deps]
 * @returns {{ok:true, request:object, path:string}|{ok:false, reason:string, retained?:boolean, alert?:string}}
 *   En `ok:true`, `request` lleva DOS capabilities que no están en el depósito:
 *   `token` (siempre) y `nonce` (sólo gate `aceptacion`, emitido server-side por
 *   `operator-signature.issueNonce`). El adaptador los devuelve tal cual en
 *   `submitSignature`; con eso el gate `aceptacion` es operable end-to-end SIN
 *   que el adaptador toque nunca el audit chain del gate.
 *
 * CA-A2.b — **el modo NO se acepta de la entrada.** Lo recalcula el kernel leyendo
 * `config.yaml` (`resolveGateMode`). Antes venía del payload con default
 * `'dry-run'`, así que un adaptador que omitía el campo hacía que un texto
 * hostil se emitiera igual en vez de retenerse (REQ-SEC-5).
 */
function requestSignature(p = {}, deps = {}) {
    const d = resolveDeps(deps);

    // 1 · CA-A1 — gate ∈ enum ANTES de construir ningún path.
    const g = resolveGate(p.gate);
    if (!g.ok) return { ok: false, reason: g.reason };

    // CA-A2.b — modo REAL del gate, server-side. Nunca del payload.
    const gateMode = resolveGateMode(g.spec, d);

    // 2 · issue válido ANTES de tocar el FS.
    if (!isValidIssueId(p.issue)) {
        return { ok: false, reason: 'issue inválido (debe ser entero positivo)' };
    }
    const issue = Number(p.issue);

    // 3 · CA-A2 — ancla recalculada server-side. Un `p.anchor` del cliente NO se
    //     lee en ningún momento: no existe rama que lo consulte.
    const anchorRes = computeAnchor(g.spec.gate, { body: p.body, commit: p.commit });
    if (!anchorRes.ok) return { ok: false, reason: anchorRes.reason };
    const anchor = anchorRes.anchor;

    // 4 · REQ-SEC-5 — fidelidad "lo que ve = lo que firma".
    const sourceText = anchor.kind === 'body-hash' ? String(p.body) : anchor.value;
    const presentation = require('./operator-signoff-gate').sanitizeForPresentation(sourceText);
    if (!presentation.safe) {
        const alert = `Firma retenida: #${issue}, gate ${g.spec.gate}. `
            + 'El texto a firmar disparó el detector de inyección, así que no emití el pedido. '
            + 'Hay que mirar el issue a mano antes de firmarlo.';
        if (gateMode === 'enforce') {
            // Retiene y alerta: NO se emite el request ni se escribe el depósito.
            return { ok: false, reason: 'presentacion no segura (REQ-SEC-5)', retained: true, alert };
        }
        // dry-run: se emite marcado, para que el medio pueda mostrarlo igual.
        presentation.degraded = true;
        presentation.alert = alert;
    }

    // Recorte declarado: o el contenido presentado es byte-idéntico al anclado,
    // o el request DECLARA el recorte con marca + digest de lo presentado. La
    // marca viene con el texto ya resuelto por el kernel para que Telegram y el
    // dashboard la muestren igual (UX §4).
    const truncated = sourceText.length > PRESENTATION_MAX_CHARS;
    const presentedText = truncated ? sourceText.slice(0, PRESENTATION_MAX_CHARS) : sourceText;

    // 5 · Token con binding `(gate, issue, anchor)` dentro del payload firmado
    //     (CA-A3 / D-3). El nonce del token es el del canal.
    let token;
    try {
        token = tokenSigner(d).sign({
            issue,
            action: CARRIER_ACTION,
            gate: g.spec.gate,
            anchor,
        });
    } catch (e) {
        return { ok: false, reason: `no se pudo emitir el token del canal: ${e.message}` };
    }

    const createdAt = new Date(d.now()).toISOString();
    const request = {
        gate: g.spec.gate,
        issue,
        // CA-UX1 — una línea, ≤ 80 chars, QUÉ se firma. Sin verbos de acción.
        title: buildTitle(g.spec.gate, issue, p.titleText),
        // CA-UX1 — pregunta cerrada CON la consecuencia explícita de firmar.
        question: buildQuestion(g.spec.gate, issue),
        anchor,
        // CA-UX1 — enum cerrado; `value` viaja firmado, `label` se muestra. El
        // medio NO deriva el label de la clave.
        options: buildOptions(g.spec),
        evidence: normalizeEvidence(p.evidence),
        presented: {
            digest: digestText(presentedText),
            truncated,
            truncation_notice: truncated
                ? `Te muestro los primeros ${PRESENTATION_MAX_CHARS} caracteres. Firmás sobre el texto completo del issue #${issue}.`
                : null,
            text: presentedText,
        },
        presentation_safe: presentation.safe,
        // OJO: `token` NO va acá — se agrega sólo al valor DEVUELTO, más abajo.
        // El depósito es un índice legible por el dashboard y por Telegram, y el
        // token es una capability bearer: quien lo lee, firma (A01/A02). Por eso
        // ya estaba excluido del audit; persistirlo en el índice lo contradecía.
        created_at: createdAt,
        gate_mode: gateMode,
    };
    if (presentation.degraded) {
        request.presentation_alert = presentation.alert;
    }

    // 6 · `prepare` del gate: lo que el gate necesita emitir server-side ANTES
    //     de que exista un pedido presentable. Hoy es el nonce propio de
    //     `aceptacion` (CA-5 de `operator-signature`), que el kernel emite por
    //     el único camino legítimo (`issueNonce`) para que el adaptador NO
    //     tenga que escribir en el audit chain del gate. Sin esto, el gate
    //     `aceptacion` no era operable end-to-end desde el kernel.
    //
    //     Va DESPUÉS de la retención por presentación insegura (paso 4): un
    //     pedido retenido no quema un nonce ni deja rastro en la cadena del gate.
    const prepared = g.spec.prepare(d, {
        issue,
        anchor,
        evidenceHash: computeChannelEvidenceHash(request),
        gateMode,
    });
    if (!prepared.ok) return { ok: false, reason: prepared.reason };

    // 7 · Depósito (índice de presentación, CA-A4).
    const target = depositPathFor(d.depositDir, issue, g.spec.gate);
    if (target === null) return { ok: false, reason: 'path-escape' };
    try {
        d.fsImpl.mkdirSync(d.depositDir, { recursive: true });
        d.fsImpl.writeFileSync(target, JSON.stringify(request), 'utf8');
    } catch (e) {
        return { ok: false, reason: `no se pudo escribir el pendiente: ${e.message}` };
    }

    // 8 · Audit hash-chained del pedido. Ni el token ni el nonce del gate se
    //     auditan acá (son capabilities portables); sí su ancla y el gate.
    try {
        d.auditImpl.appendChained({
            file: d.auditFile,
            entry: redact.redactObject({
                type: 'approval_channel_request',
                gate: g.spec.gate,
                issue,
                anchor_kind: anchor.kind,
                anchor_value: anchor.value,
                presented_digest: request.presented.digest,
                truncated,
                gate_mode: gateMode,
                at: createdAt,
            }),
            fsImpl: d.fsImpl,
        });
    } catch { /* el audit del pedido no bloquea la presentación */ }

    // El token y el nonce del gate viajan SÓLO en la respuesta en memoria, nunca
    // en el depósito ni en el audit del canal. El adaptador que pidió la firma
    // los entrega por su canal (botón de Telegram, formulario del dashboard) y
    // los devuelve tal cual en `submitSignature`: **el adaptador pide, el kernel
    // ejecuta** — no hay ningún camino por el que el adaptador escriba una firma
    // ni un nonce por su cuenta.
    const emitted = { ...request, token };
    if (typeof prepared.nonce === 'string') emitted.nonce = prepared.nonce;
    return { ok: true, request: emitted, path: target };
}

/** CA-UX1 · `title`: una línea, ≤ 80 chars, sin verbos de acción. */
function buildTitle(gate, issue, titleText) {
    const gateLabel = gate === 'definicion' ? 'GATE 1 · Definición' : 'GATE 2 · Aceptación';
    const base = `${gateLabel} de #${issue}`;
    const extra = typeof titleText === 'string' && titleText.trim() !== ''
        ? ` — ${titleText.trim()}`
        : '';
    return `${base}${extra}`.slice(0, 80);
}

/** CA-UX1 · `question`: cerrada, en español, con la consecuencia explícita. */
function buildQuestion(gate, issue) {
    return gate === 'definicion'
        ? `¿Admitís #${issue} a desarrollo con estos criterios de aceptación?`
        : `¿Aceptás la entrega de #${issue} y la dejás avanzar a entrega?`;
}

/** CA-UX1 · `options`: enum cerrado, `value` firmado + `label` mostrado. */
function buildOptions(spec) {
    const LABELS = {
        signed: spec.gate === 'definicion' ? 'Admitir a desarrollo' : 'Aceptar la entrega',
        'rejected': spec.gate === 'definicion' ? 'Rechazar la definición' : 'Rechazar la entrega',
        're-definition': 'Devolver a definición',
    };
    return Object.freeze(spec.verdicts.map(v => Object.freeze({ value: v, label: LABELS[v] })));
}

/** UX: evidencia = REFERENCIAS, nunca payloads. `kind` de enum cerrado. */
function normalizeEvidence(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const it of raw) {
        if (!it || typeof it !== 'object') continue;
        const kind = String(it.kind == null ? '' : it.kind);
        const ref = String(it.ref == null ? '' : it.ref);
        if (!EVIDENCE_KINDS.includes(kind) || ref === '') continue;
        out.push({ kind, ref: ref.slice(0, 512) });
        if (out.length >= 20) break;
    }
    return out;
}

// -----------------------------------------------------------------------------
// submitSignature — el kernel EJECUTA
// -----------------------------------------------------------------------------

/**
 * Resuelve una firma. **El cliente aporta sólo `{verdict, nonce/token}`**: el
 * ancla se recalcula server-side desde el material fuente que trae el kernel
 * (`body`/`commit` recién leídos), nunca se acepta de la entrada (CA-A2).
 *
 * Orden de validación OBLIGATORIO, todo fail-closed:
 *   1. gate ∈ enum congelado          → sin tocar FS (CA-A1)
 *   2. issue válido                   → sin tocar FS
 *   3. rate-limit del camino de rechazo (SEC-3)
 *   4. `verify(token)` de action-token
 *   5. `g` y `h` PRESENTES            → ausencia ⇒ misma severidad que firma inválida (SEC-1)
 *   6. `g === gate` que se resuelve   → comparación explícita, no "si viene lo uso"
 *   7. `h === ancla recalculada`      → cubre CA-A2 y CA-A7 a la vez
 *   8. verdict ∈ enum del gate
 *   9. `writerExtras` del gate        → campos del acta resueltos SERVER-SIDE
 *  10. despacho al writer del registry + companion de audit (D-2)
 *
 * @param {object} p
 * @param {string} p.gate
 * @param {number|string} p.issue
 * @param {string} p.token       - token del canal (lleva el nonce del canal).
 * @param {string} p.verdict     - ∈ `spec.verdicts`.
 * @param {string} p.signedBy    - identidad del firmante (la autoriza el gate).
 * @param {string} [p.body]      - material fuente actual (gate `definicion`).
 * @param {string} [p.commit]    - material fuente actual (gate `aceptacion`).
 * @param {string} [p.nonce]     - **gate `aceptacion` únicamente.** Nonce PROPIO
 *                                 del gate (CA-5 de `operator-signature`), tal
 *                                 como lo devolvió `requestSignature` en
 *                                 `request.nonce`. Distinto del nonce del token,
 *                                 que es el del canal. El adaptador lo transporta
 *                                 y lo devuelve; NO lo emite (lo emitió el kernel
 *                                 vía `issueNonce`). Se valida de forma
 *                                 (`GATE_NONCE_RE`) y contra el registro
 *                                 `nonce_issued` del audit del gate antes de
 *                                 despachar.
 * @param {string} [p.actor]     - identidad de origen para el registro de rechazos.
 * @param {string} [p.origen]    - medio de origen ('telegram' | 'dashboard' | ...).
 *
 * NO existe `p.writerOptions`: las opciones del writer (allowlist de firmantes,
 * `pipelineDir`, `fsImpl`, reloj, rate-limit) las construye el kernel server-side
 * en `buildWriterOptions`. El cliente aporta sólo `{ verdict, nonce }` + material
 * fuente (CA-A2); nada de lo que manda decide quién puede firmar.
 *
 * CA-A2.b — **el `evidence_hash` NO se acepta de la entrada.** Queda en el acta
 * hash-chained de GATE 2 (`operator-signature.js:816`); antes se reenviaba crudo
 * del payload, sin validación de forma ni de largo. Ahora lo resuelve
 * `writerExtras` leyendo el `nonce_issued` que escribió este mismo kernel. El
 * campo del payload ya no se lee en ningún punto del módulo — invariante
 * verificado por grep en `approval-channel-aceptacion.test.js`.
 *
 * @param {object} [deps]
 * @returns {{ok:boolean, reason?:string, entry?:object, gate?:string, issue?:number}}
 */
function submitSignature(p = {}, deps = {}) {
    const d = resolveDeps(deps);
    // CA-A6.b — la llave del contador sale del ENUM CERRADO de medios, no del
    // payload. `actor` se sigue registrando como dato forense, pero NO llavea
    // nada: rotarlo ya no compra intentos.
    const origen = normalizeOrigen(p.origen);
    const ctx = { gate: p.gate, issue: p.issue, origen, actor: p.actor || p.signedBy };

    // 0 · CA-A6.b — RATE-LIMIT ANTES DEL PASO 1.
    //
    //     Antes se consultaba recién en el paso 3, y los dos rechazos más
    //     baratos (gate fuera del enum, issue inválido) salían por un `reject()`
    //     que no consultaba ni consumía el contador: 40 intentos escribían 40
    //     entradas en un JSONL hash-chained cuyo append relee el archivo entero.
    //     Ahora NINGÚN camino de rechazo esquiva el techo, y por encima del techo
    //     no se escribe nada (el intento hostil no paga `appendChained`).
    const rate = checkRejectRate(origen, d, { record: false });
    if (!rate.allowed) {
        return {
            ok: false,
            reason: `rate-limit de rechazos excedido (${rate.scope === 'global' ? rate.global : rate.count} en ventana, alcance ${rate.scope})`,
            rate_limited: true,
            scope: rate.scope,
        };
    }

    /**
     * ÚNICA salida de rechazo de `submitSignature`. Consume el contador y
     * registra. No existe otra función de rechazo: no hay camino que esquive el
     * techo (ese era exactamente el defecto de rev-2).
     */
    const rejectAndCount = (reason) => {
        checkRejectRate(origen, d, { record: true });
        recordRejectedAttempt({ ...ctx, reason }, d);
        return { ok: false, reason };
    };

    // 1 · CA-A1 — gate ∈ enum ANTES de construir ningún path.
    const g = resolveGate(p.gate);
    if (!g.ok) {
        // Se registra el intento, pero NO se construye ningún path con el gate
        // crudo: `recordRejectedAttempt` sólo lo trunca como dato del registro.
        return rejectAndCount(g.reason);
    }

    // 2 · issue válido ANTES de tocar el FS.
    if (!isValidIssueId(p.issue)) {
        return rejectAndCount('issue inválido (debe ser entero positivo)');
    }
    const issue = Number(p.issue);

    // 3 · CA-A2.b — el modo del gate lo determina el KERNEL leyendo config.
    //     Un `gateMode` que venga en la entrada se ignora: un campo que
    //     gobierna comportamiento fail-closed no se acepta del payload del
    //     cliente. El literal no se escribe ni en comentario (mismo criterio
    //     grep-able que SEC-2).
    const gateMode = resolveGateMode(g.spec, d);

    // 4 · verificar y CONSUMIR el token. Consumirlo incluso si después se
    //     rechaza es deliberado: una capability que tocó el canal se quema.
    //     `verify()` NO es una función total (#5461): lanza con el vault cerrado
    //     o sin secreto, y desde #6206 también si el store de nonces es
    //     ilegible. Sin este catch la excepción escapa al proceso adaptador
    //     (Telegram / dashboard) y lo mata. Fail-closed: la firma NO se registra.
    let res;
    try {
        res = tokenSigner(d).verify(p.token);
    } catch (e) {
        // Se registra el `code` acotado, no el `message` crudo: el mensaje de un
        // error arbitrario podría arrastrar material sensible al log.
        const code = (e && typeof e.code === 'string') ? e.code : 'unknown';
        return rejectAndCount(`verificador de token no disponible (${code}) — firma NO registrada`);
    }
    if (!res || !res.ok) {
        return rejectAndCount(`token ${(res && res.reason) || 'invalid'}`);
    }

    // 5 · SEC-1 — `g`/`h` OBLIGATORIOS acá (no en `verify()`). Un token del
    //     camino de botones (`operator-gate.register` / `human-block.js`) valida
    //     el HMAC pero NO trae binding ⇒ se rechaza con la misma severidad que
    //     una firma inválida. Sin esto, el botón de un gate firma otro (R-1).
    if (typeof res.g !== 'string' || typeof res.h !== 'string') {
        return rejectAndCount('token sin binding (g/h) — no habilitado para el canal');
    }

    // 6 · comparación EXPLÍCITA contra el gate que se está resolviendo.
    if (res.g !== g.spec.gate) {
        return rejectAndCount('el token está atado a otro gate');
    }

    // 7 · issue del token === issue que se resuelve.
    if (Number(res.issue) !== issue) {
        return rejectAndCount('el token está atado a otro issue');
    }

    // 8 · CA-A2 + CA-A7 — ancla recalculada server-side. El mismatch cubre a la
    //     vez "el cliente mandó su propia ancla" y "editaron el body después de
    //     firmar": en ambos casos la huella difiere y se pide firma nueva.
    const anchorRes = computeAnchor(g.spec.gate, { body: p.body, commit: p.commit });
    if (!anchorRes.ok) {
        return rejectAndCount(anchorRes.reason);
    }
    const expectedH = actionToken.serializeAnchor(anchorRes.anchor);
    if (expectedH === null || res.h !== expectedH) {
        return rejectAndCount('lo firmado cambió — hace falta una firma nueva (CA-A7)');
    }

    // 9 · verdict ∈ enum del gate.
    if (!g.spec.verdicts.includes(p.verdict)) {
        return rejectAndCount(`verdict inválido para el gate ${g.spec.gate}`);
    }

    // 10 · CA-A2.b — campos que van al acta del gate y NO pueden salir del
    //      payload. Para `aceptacion`: el nonce propio del gate (que emitió
    //      `requestSignature` por `issueNonce`) y el `evidence_hash`, que se lee
    //      del registro `nonce_issued` server-side, no de la entrada.
    //
    //      Va ANTES del companion de audit a propósito: un nonce ausente,
    //      rotado o de otro artefacto se rechaza sin dejar una entrada
    //      "accepted-before-transition" de una firma que nunca ocurrió.
    const extrasRes = g.spec.writerExtras(d, { issue, anchor: anchorRes.anchor, nonce: p.nonce });
    if (!extrasRes.ok) {
        return rejectAndCount(extrasRes.reason);
    }
    const writerExtras = extrasRes.extras;

    // 11 · D-2 — companion de audit ANTES del despacho. Si no se puede dejar
    //      constancia, NO se firma (mismo criterio que `operator-gate.js:351`,
    //      donde un audit fallido aborta la transición).
    if (g.spec.auditCompanion) {
        try {
            d.auditCompanion({
                actor: p.signedBy,
                action: VERDICT_TO_ACTION[p.verdict] || 'approve',
                issue,
                tenant: null,
                gate: null, // pre-transición: `operator-wait.js` lo ignora como salida
                nonce: res.nonce,
                result: 'accepted-before-transition',
            });
        } catch (e) {
            return rejectAndCount(`no se pudo registrar la firma en el audit companion: ${e.message}`);
        }
    }

    // 12 · Despacho al writer del gate. La autoridad sobre autorización,
    //      rate-limit de firma e integridad sigue siendo DEL GATE — el kernel no
    //      la duplica.
    //      Las `options` se construyen SERVER-SIDE por enumeración explícita
    //      (`buildWriterOptions`): el cliente no aporta ni la allowlist de
    //      firmantes, ni el `pipelineDir` del audit, ni el reloj, ni el
    //      rate-limit. Ver el comentario de `buildWriterOptions`. Los campos
    //      específicos del gate que quedan en el acta salen de `writerExtras`
    //      (paso 10), también server-side.
    const writer = g.spec.writer();
    const writerOptions = buildWriterOptions(d, g.spec);
    let out;
    try {
        out = g.spec.gate === 'definicion'
            ? writer({
                issueId: issue,
                signedBy: p.signedBy,
                body: p.body,
                verdict: p.verdict,
                // CA-A2.b — modo REAL del kernel, no el del payload.
                gateMode,
                options: writerOptions,
            })
            : writer({
                issueId: issue,
                signedBy: p.signedBy,
                signedCommit: anchorRes.anchor.value,
                verdict: p.verdict,
                // CA-A2.b — `nonce` + `evidenceHash` resueltos SERVER-SIDE en
                // `writerExtras` contra el `nonce_issued` que escribió el
                // kernel. Nada de esto se reenvía crudo del payload.
                ...writerExtras,
                // CA-A2.b — modo REAL del kernel, no el del payload.
                gateMode,
                options: writerOptions,
            });
    } catch (e) {
        return rejectAndCount(`el writer del gate falló: ${e.message}`);
    }

    if (!out || out.ok !== true) {
        // El writer rechazó (firmante no autorizado, rate-limit del gate, nonce
        // inválido...). Se registra como intento rechazado igual que el resto.
        return rejectAndCount(`el gate rechazó la firma: ${(out && out.reason) || 'sin motivo'}`);
    }

    // 13 · D-2 — companion post-despacho CON `gate` no nulo: ésta es la entrada
    //      que `operator-wait.js:167` lee como cierre del gate.
    if (g.spec.auditCompanion) {
        try {
            d.auditCompanion({
                actor: p.signedBy,
                action: VERDICT_TO_ACTION[p.verdict] || 'approve',
                issue,
                tenant: null,
                gate: g.spec.gate,
                nonce: res.nonce,
                result: p.verdict,
            });
        } catch { /* la firma ya está persistida; la constancia previa existe */ }
    }

    // 14 · Audit propio del canal + limpieza del pendiente (índice, no autoridad).
    try {
        d.auditImpl.appendChained({
            file: d.auditFile,
            entry: redact.redactObject({
                type: 'approval_channel_signature',
                gate: g.spec.gate,
                issue,
                verdict: p.verdict,
                anchor_kind: anchorRes.anchor.kind,
                anchor_value: anchorRes.anchor.value,
                signed_by: String(p.signedBy == null ? '' : p.signedBy),
                channel: p.origen == null ? null : String(p.origen),
                at: new Date(d.now()).toISOString(),
            }),
            fsImpl: d.fsImpl,
        });
    } catch { /* el audit del canal no invalida la firma ya persistida en el gate */ }

    resolvePending(issue, g.spec.gate, deps);

    return {
        ok: true,
        gate: g.spec.gate,
        issue,
        verdict: p.verdict,
        anchor: anchorRes.anchor,
        entry: out.entry,
        hash_self: out.hash_self,
    };
}

// -----------------------------------------------------------------------------
// CA-A4 · Depósito = índice de presentación, JAMÁS autoridad
// -----------------------------------------------------------------------------

/**
 * Lista los pendientes del depósito.
 *
 * **INVARIANTE (CA-A4/SEC-5):** esto es un índice para PRESENTAR, no una fuente
 * de verdad. La autoridad sobre si un issue está firmado es
 * `operator-signoff-gate.evaluate()` / `operator-signature.evaluate()`, que leen
 * su audit hash-chain y NO consultan este depósito. **Ausencia de pendiente
 * jamás implica firma.**
 *
 * Depósito ausente o corrupto en `enforce` ⇒ `degraded: true` + `alert`: el
 * caller retiene y alerta, nunca interpreta la lista vacía como "todo firmado".
 *
 * CA-A2.b — **el modo NO sale de `opts`.** Antes `opts.gateMode` decidía si el
 * depósito ausente se reportaba como `degraded`, con default `'dry-run'`: un
 * adaptador que omitía el campo recibía una lista vacía con `degraded:false`,
 * **indistinguible de "está todo firmado"**. Eso es exactamente lo que CA-A4
 * prohíbe. Ahora el modo lo lee el kernel de `config.yaml`: `listPending` es
 * transversal a los gates, así que basta que UNO esté en `enforce` para retener
 * y alertar (fail-closed).
 *
 * @param {object} [opts] - reservado (ya no lleva `gateMode`).
 * @param {object} [deps]
 * @returns {{ok:boolean, pending:Array, corrupt:Array, degraded:boolean, alert:string|null}}
 */
function listPending(opts = {}, deps = {}) {
    const d = resolveDeps(deps);
    const enforce = Object.values(GATES).some(spec => resolveGateMode(spec, d) === 'enforce');
    const pending = [];
    const corrupt = [];

    let names;
    try {
        names = d.fsImpl.readdirSync(d.depositDir);
    } catch (e) {
        if (e && e.code === 'ENOENT') {
            // Depósito ausente. En enforce esto NO es "no hay nada que firmar":
            // es que perdimos el índice.
            return {
                ok: true,
                pending: [],
                corrupt: [],
                degraded: enforce,
                alert: enforce
                    ? 'El depósito de pendientes de firma no existe. La lista vacía no significa que esté todo firmado: retengo y aviso.'
                    : null,
            };
        }
        return {
            ok: false,
            pending: [],
            corrupt: [],
            degraded: true,
            alert: `No pude leer el depósito de pendientes de firma (${e.message}). Retengo y aviso.`,
        };
    }

    for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const full = path.join(d.depositDir, name);
        try {
            const parsed = JSON.parse(d.fsImpl.readFileSync(full, 'utf8'));
            // Un pendiente sin gate del enum o sin issue válido es basura: se
            // reporta como corrupto, no se presenta.
            if (!parsed || !resolveGate(parsed.gate).ok || !isValidIssueId(parsed.issue)) {
                corrupt.push({ file: name, reason: 'estructura inválida' });
                continue;
            }
            pending.push(parsed);
        } catch (e) {
            corrupt.push({ file: name, reason: e.message });
        }
    }

    const degraded = enforce && corrupt.length > 0;
    return {
        ok: true,
        pending,
        corrupt,
        degraded,
        alert: degraded
            ? `Hay ${corrupt.length} pendiente(s) de firma ilegibles en el depósito. Retengo y aviso: no puedo presentarlos y su ausencia no implica firma.`
            : null,
    };
}

/**
 * Limpia el pendiente de `(issue, gate)`. Idempotente: si no existe, `ok:true`
 * con `removed:false`. **Borrar el depósito no cambia ningún veredicto** — la
 * firma vive en el audit chain del gate.
 *
 * @returns {{ok:boolean, removed:boolean, reason?:string}}
 */
function resolvePending(issue, gate, deps = {}) {
    const d = resolveDeps(deps);
    const g = resolveGate(gate);
    if (!g.ok) return { ok: false, removed: false, reason: g.reason };
    if (!isValidIssueId(issue)) return { ok: false, removed: false, reason: 'issue inválido' };

    const target = depositPathFor(d.depositDir, issue, g.spec.gate);
    if (target === null) return { ok: false, removed: false, reason: 'path-escape' };
    try {
        d.fsImpl.unlinkSync(target);
        return { ok: true, removed: true };
    } catch (e) {
        if (e && e.code === 'ENOENT') return { ok: true, removed: false };
        return { ok: false, removed: false, reason: e.message };
    }
}

module.exports = {
    // Entry points del contrato
    requestSignature,
    submitSignature,
    listPending,
    resolvePending,

    // Helpers (exportados para tests + partes 2/3 del split)
    resolveGate,
    computeAnchor,
    isValidIssueId,
    checkRejectRate,
    depositPathFor,
    // #6206 rev-3 — superficie nueva de los tres fixes bloqueantes.
    normalizeOrigen,          // CA-A6.b — llave del rate-limit, enum cerrado
    resolveGateMode,          // CA-A2.b — modo del gate, server-side
    resolveDefinicionSigners, // CA-A5.b — allowlist de GATE 1 (== pulpo.js:5906)
    resolveAceptacionSigners, // CA-A5.b + D-4 — allowlist de GATE 2 (== delivery.js:100)
    // #6206 rev-4 — el gate `aceptacion` es operable end-to-end desde el kernel.
    computeChannelEvidenceHash,   // CA-A2.b — digest de lo presentado, server-side
    issueAceptacionNonce,         // CA-5 — el KERNEL emite el nonce de GATE 2
    resolveAceptacionWriterExtras,// CA-A2.b — `evidence_hash` del acta, server-side

    // Constantes
    GATES,
    ORIGENES,
    ANCHOR_KINDS,
    EVIDENCE_KINDS,
    VERDICT_TO_ACTION,
    CARRIER_ACTION,
    DEFAULT_DEPOSIT_DIR,
    DEFAULT_AUDIT_FILE,
    DEFAULT_REJECT_FILE,
    DEFAULT_RATE_FILE,
    DEFAULT_REJECT_RATE,
    REJECT_FILE_MAX_BYTES,
    PRESENTATION_MAX_CHARS,
    GATE_NONCE_RE,
};
