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
//   La allowlist se resuelve server-side uniendo las DOS fuentes que YA son
//   autoridad en producción — `operator-gate.resolveOperatorAllowlist` (la del
//   camino de botones) y `cua.operator_chat_ids` de `config.yaml` (la que usa
//   `delivery.js` para GATE 2) — y es fail-closed si queda vacía.
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

// Rate-limit del camino de RECHAZO (SEC-3). Contador propio: ver `checkRejectRate`.
const DEFAULT_REJECT_RATE = Object.freeze({ windowMs: 60 * 1000, maxPerWindow: 5 });
// Cotas duras del store de rate-limit: sin esto un atacante que rota `actor`
// engorda un archivo que el camino legítimo relee entero.
const RATE_MAX_ACTORS = 200;

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
    }),
    aceptacion: Object.freeze({
        gate: 'aceptacion',
        anchorKind: 'commit-sha',
        verdicts: Object.freeze(['signed', 'rejected']),
        auditCompanion: true,
        writer: () => require('./operator-signature').recordAcceptanceSignature,
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
 * Allowlist de firmantes autorizados, resuelta **siempre server-side**.
 *
 * NO se crea una lista paralela: se unen las DOS fuentes que ya son autoridad en
 * producción, para que el canal no pueda divergir de los caminos que reemplaza.
 *
 *   1. `TELEGRAM_LEO_OPERATOR_CHAT_ID` — vía `operator-gate.resolveOperatorAllowlist`,
 *      la misma que autoriza el camino de BOTONES (`operator-gate.handleSignature`).
 *   2. `cua.operator_chat_ids` de `config.yaml` — la misma unión que hace
 *      `delivery.resolveAuthorizedSigners:100`, que es hoy el consumidor real de
 *      GATE 2. Sin esto, un aprobador de respaldo designado por config podría
 *      firmar por `delivery` pero no por el canal.
 *
 * **Fail-closed**: sin allowlist configurada devuelve `[]`, y el writer del gate
 * rechaza toda firma (`authorizedSigners.size === 0` ⇒ "firmante no autorizado").
 * Si la config no se puede leer, se degrada a la fuente (1), que es
 * ESTRICTAMENTE MÁS ANGOSTA — nunca se degrada a "cualquiera firma".
 *
 * @returns {Array<string>}
 */
function resolveAuthorizedSigners(d) {
    const ids = new Set();

    // 1 · credential dedicada del operador (misma fuente que el camino de botones).
    try {
        for (const id of require('./operator-gate').resolveOperatorAllowlist(d.env)) ids.add(id);
    } catch { /* módulo roto ⇒ no aporta firmantes (nunca abre el camino) */ }

    // 2 · allowlist de config, leída SERVER-SIDE (jamás del payload del cliente).
    try {
        const config = d.config !== null
            ? d.config
            : require('./config-resolver').resolve({ pipelineDir: d.writerPipelineDir || undefined });
        const cua = (config && config.cua) || {};
        if (Array.isArray(cua.operator_chat_ids)) {
            for (const raw of cua.operator_chat_ids) {
                const s = String(raw == null ? '' : raw).trim();
                if (s) ids.add(s);
            }
        }
    } catch { /* config ilegible ⇒ queda sólo (1): más angosto, nunca más ancho */ }

    return Array.from(ids);
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
 */
function buildWriterOptions(d) {
    const options = {
        // A01 — server-side, nunca del input.
        authorizedSigners: resolveAuthorizedSigners(d),
        // Reloj del kernel: el gate deriva `signed_at` de acá. `nowISO` NO se
        // pasa, así que el timestamp del chain de no repudio no es inyectable.
        now: Number(d.now()),
    };
    if (d.writerPipelineDir !== null) options.pipelineDir = d.writerPipelineDir;
    if (d.fsImpl !== fs) options.fsImpl = d.fsImpl;
    if (d.writerRateLimit !== null) options.rateLimit = d.writerRateLimit;
    return options;
}

// -----------------------------------------------------------------------------
// CA-A6 · Registro de intentos no autorizados + rate-limit del rechazo
// -----------------------------------------------------------------------------

/**
 * Rate-limit del camino de RECHAZO (SEC-3), con **contador propio y acotado** en
 * store separado.
 *
 * Por qué no se reusa `operator-signoff-gate.checkSignatureRateLimit`: ese lee
 * sólo firmas YA PERSISTIDAS, y el no autorizado retorna sin escribir nada ⇒
 * cuenta siempre 0 ⇒ intentos ilimitados.
 *
 * Por qué el contador NO se deriva del log de rechazos: si el registro de
 * intentos fuera la fuente del contador, el atacante controlaría su propio
 * límite y engordaría un archivo que el camino legítimo relee entero.
 *
 * @returns {{allowed:boolean, count:number}}
 */
function checkRejectRate(actor, d, { record = true } = {}) {
    const key = String(actor == null || actor === '' ? 'anonimo' : actor).slice(0, 128);
    const nowMs = Number(d.now());
    const since = nowMs - d.rejectRate.windowMs;

    let store = { actors: {} };
    try {
        const raw = d.fsImpl.readFileSync(d.rateFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.actors && typeof parsed.actors === 'object') {
            store = parsed;
        }
    } catch { /* ausente o corrupto → se reconstruye (fail-closed: cuenta desde 0) */ }

    // Poda de la ventana + cota por actor.
    const prev = Array.isArray(store.actors[key]) ? store.actors[key] : [];
    const inWindow = prev.map(Number).filter(t => Number.isFinite(t) && t >= since);
    const count = inWindow.length;
    const allowed = count < d.rejectRate.maxPerWindow;

    if (record) {
        // Cota dura: nunca más de maxPerWindow+1 marcas por actor.
        inWindow.push(nowMs);
        store.actors[key] = inWindow.slice(-(d.rejectRate.maxPerWindow + 1));

        // Poda global: actores sin marcas en ventana se descartan; si aún así se
        // pasa de RATE_MAX_ACTORS, se quedan los más recientes.
        const pruned = {};
        for (const [k, v] of Object.entries(store.actors)) {
            const live = (Array.isArray(v) ? v : []).map(Number).filter(t => Number.isFinite(t) && t >= since);
            if (live.length > 0) pruned[k] = live;
        }
        const keys = Object.keys(pruned)
            .sort((a, b) => Math.max(...pruned[b]) - Math.max(...pruned[a]))
            .slice(0, RATE_MAX_ACTORS);
        store.actors = Object.fromEntries(keys.map(k => [k, pruned[k]]));

        try {
            d.fsImpl.mkdirSync(path.dirname(d.rateFile), { recursive: true });
            d.fsImpl.writeFileSync(d.rateFile, JSON.stringify(store), 'utf8');
        } catch { /* el rate-limit degradado no debe abrir el camino de firma */ }
    }

    return { allowed, count };
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
    const entry = {
        type: 'approval_channel_rejected',
        // Enumeración explícita — ningún campo del input se copia en bloque.
        gate: typeof gate === 'string' ? gate.slice(0, 64) : null,
        issue: isValidIssueId(issue) ? Number(issue) : null,
        origen: origen == null ? null : String(origen).slice(0, 64),
        actor: actor == null ? null : String(actor).slice(0, 128),
        // `reason` es texto propio del kernel (constantes de este módulo), nunca
        // eco del input del cliente.
        reason: reason == null ? null : String(reason).slice(0, 200),
        at: new Date(d.now()).toISOString(),
    };
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

/** Rechazo uniforme: registra + consume rate-limit + devuelve la forma estándar. */
function reject(reason, ctx, d) {
    recordRejectedAttempt({ ...ctx, reason }, d);
    return { ok: false, reason };
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
 * @param {string} [p.gateMode]      - 'dry-run' | 'enforce'.
 * @param {object} [deps]
 * @returns {{ok:true, request:object, path:string}|{ok:false, reason:string, retained?:boolean, alert?:string}}
 */
function requestSignature(p = {}, deps = {}) {
    const d = resolveDeps(deps);
    const gateMode = p.gateMode === 'enforce' ? 'enforce' : 'dry-run';

    // 1 · CA-A1 — gate ∈ enum ANTES de construir ningún path.
    const g = resolveGate(p.gate);
    if (!g.ok) return { ok: false, reason: g.reason };

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

    // 6 · Depósito (índice de presentación, CA-A4).
    const target = depositPathFor(d.depositDir, issue, g.spec.gate);
    if (target === null) return { ok: false, reason: 'path-escape' };
    try {
        d.fsImpl.mkdirSync(d.depositDir, { recursive: true });
        d.fsImpl.writeFileSync(target, JSON.stringify(request), 'utf8');
    } catch (e) {
        return { ok: false, reason: `no se pudo escribir el pendiente: ${e.message}` };
    }

    // 7 · Audit hash-chained del pedido. El token NO se audita (es una
    //     capability portable); sí su ancla y el gate.
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

    // El token viaja SÓLO en la respuesta en memoria, nunca en el depósito ni en
    // el audit. El adaptador que pidió la firma lo entrega por su canal (botón de
    // Telegram, formulario del dashboard) y lo devuelve en `submitSignature`.
    return { ok: true, request: { ...request, token }, path: target };
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
 *   9. despacho al writer del registry + companion de audit (D-2)
 *
 * @param {object} p
 * @param {string} p.gate
 * @param {number|string} p.issue
 * @param {string} p.token       - token del canal (lleva el nonce del canal).
 * @param {string} p.verdict     - ∈ `spec.verdicts`.
 * @param {string} p.signedBy    - identidad del firmante (la autoriza el gate).
 * @param {string} [p.body]      - material fuente actual (gate `definicion`).
 * @param {string} [p.commit]    - material fuente actual (gate `aceptacion`).
 * @param {string} [p.nonce]     - nonce PROPIO del gate `aceptacion` (el emitido
 *                                 por `operator-signature.issueNonce`). Distinto
 *                                 del nonce del token, que es el del canal.
 * @param {string} [p.actor]     - identidad de origen para el registro de rechazos.
 * @param {string} [p.origen]    - medio de origen ('telegram' | 'dashboard' | ...).
 *
 * NO existe `p.writerOptions`: las opciones del writer (allowlist de firmantes,
 * `pipelineDir`, `fsImpl`, reloj, rate-limit) las construye el kernel server-side
 * en `buildWriterOptions`. El cliente aporta sólo `{ verdict, nonce }` + material
 * fuente (CA-A2); nada de lo que manda decide quién puede firmar.
 *
 * @param {object} [deps]
 * @returns {{ok:boolean, reason?:string, entry?:object, gate?:string, issue?:number}}
 */
function submitSignature(p = {}, deps = {}) {
    const d = resolveDeps(deps);
    const ctx = { gate: p.gate, issue: p.issue, origen: p.origen, actor: p.actor || p.signedBy };

    // 1 · CA-A1 — gate ∈ enum ANTES de construir ningún path.
    const g = resolveGate(p.gate);
    if (!g.ok) {
        // Se registra el intento, pero NO se construye ningún path con el gate
        // crudo: `recordRejectedAttempt` sólo lo trunca como dato del registro.
        return reject(g.reason, ctx, d);
    }

    // 2 · issue válido ANTES de tocar el FS.
    if (!isValidIssueId(p.issue)) {
        return reject('issue inválido (debe ser entero positivo)', ctx, d);
    }
    const issue = Number(p.issue);

    // 3 · SEC-3 — rate-limit del camino de rechazo. Se consulta SIN consumir; el
    //     consumo ocurre sólo cuando efectivamente se rechaza.
    const actorKey = String(p.actor || p.signedBy || 'anonimo');
    const rate = checkRejectRate(actorKey, d, { record: false });
    if (!rate.allowed) {
        return { ok: false, reason: `rate-limit de rechazos excedido (${rate.count} en ventana)`, rate_limited: true };
    }

    const rejectAndCount = (reason) => {
        checkRejectRate(actorKey, d, { record: true });
        return reject(reason, ctx, d);
    };

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

    // 10 · D-2 — companion de audit ANTES del despacho. Si no se puede dejar
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

    // 11 · Despacho al writer del gate. La autoridad sobre autorización,
    //      rate-limit de firma e integridad sigue siendo DEL GATE — el kernel no
    //      la duplica.
    //      Las `options` se construyen SERVER-SIDE por enumeración explícita
    //      (`buildWriterOptions`): el cliente no aporta ni la allowlist de
    //      firmantes, ni el `pipelineDir` del audit, ni el reloj, ni el
    //      rate-limit. Ver el comentario de `buildWriterOptions`.
    const writer = g.spec.writer();
    const writerOptions = buildWriterOptions(d);
    let out;
    try {
        out = g.spec.gate === 'definicion'
            ? writer({
                issueId: issue,
                signedBy: p.signedBy,
                body: p.body,
                verdict: p.verdict,
                gateMode: p.gateMode,
                options: writerOptions,
            })
            : writer({
                issueId: issue,
                signedBy: p.signedBy,
                signedCommit: anchorRes.anchor.value,
                nonce: p.nonce,
                verdict: p.verdict,
                evidenceHash: p.evidenceHash,
                gateMode: p.gateMode,
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

    // 12 · D-2 — companion post-despacho CON `gate` no nulo: ésta es la entrada
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

    // 13 · Audit propio del canal + limpieza del pendiente (índice, no autoridad).
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
 * @param {object} [opts] - `{ gateMode }`
 * @param {object} [deps]
 * @returns {{ok:boolean, pending:Array, corrupt:Array, degraded:boolean, alert:string|null}}
 */
function listPending(opts = {}, deps = {}) {
    const d = resolveDeps(deps);
    const enforce = opts.gateMode === 'enforce';
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

    // Constantes
    GATES,
    ANCHOR_KINDS,
    EVIDENCE_KINDS,
    VERDICT_TO_ACTION,
    CARRIER_ACTION,
    DEFAULT_DEPOSIT_DIR,
    DEFAULT_AUDIT_FILE,
    DEFAULT_REJECT_FILE,
    DEFAULT_RATE_FILE,
    DEFAULT_REJECT_RATE,
    PRESENTATION_MAX_CHARS,
};
