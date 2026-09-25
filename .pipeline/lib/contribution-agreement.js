// =============================================================================
// contribution-agreement.js — Gate del Acuerdo de Contribución (CLA) · #7599
//
// Decide si un PR puede mergearse según el CLA de `docs/legal/CLA.md`:
//   - PR y commits de miembros (OWNER/MEMBER) o de cuentas de la allowlist
//     por ID numérico ⇒ no requieren firma.
//   - Cualquier otro autor (del PR o de un commit) ⇒ tiene que haber firmado
//     el CLA vigente (atado al sha256 del texto).
//
// Lo consume `.github/workflows/contribution-agreement.yml` vía `require()`
// desde `actions/github-script`, con un sparse-checkout de `main`. Ese
// sparse-checkout ES el contrato de empaquetado (#5680): este módulo sólo
// puede depender de builtins de Node. Si agregás un `require` local, agregá
// el archivo al sparse-checkout del workflow en el MISMO commit (lo cubre
// el test T13).
//
// Reglas de seguridad (CA-S1..S9 del issue):
//   - CA-S3: la clasificación se decide SOLO por ID numérico de GitHub y
//     `author_association`. Nunca por email, nombre ni login.
//   - CA-S4: una firma vale sólo si la comenta el propio autor que la debe,
//     con la frase exacta, y queda atada al hash vigente del CLA.
//   - CA-S6: el registro no guarda email ni PII.
//   - CA-S7: fail-closed. Toda entrada inválida, error de API o caso no
//     previsto termina en `failure`, nunca en `success`.
//   - CA-S9: los textos al contribuyente son estáticos (sin echo del PR).
// =============================================================================

'use strict';

const crypto = require('node:crypto');

// --- Constantes públicas ------------------------------------------------------

/** Contexto del commit status. Es el que se exige en el ruleset de `main`. */
const STATUS_CONTEXT = 'contribution-agreement';

/**
 * Frase exacta de firma. Única fuente: el comentario del bot, CONTRIBUTING.md
 * y CLA.md la repiten literal (lo verifica un test). Sin tildes ni signos que
 * los teclados alteren (guideline G2 de UX).
 */
const SIGN_PHRASE = 'I have read the Intrale CLA and I hereby sign it';

/** Marker HTML del comentario del bot (idempotencia). */
const COMMENT_MARKER = '<!-- contribution-agreement -->';

/** ID numérico de `github-actions[bot]`: único autor válido del comentario. */
const GITHUB_ACTIONS_BOT_ID = 41898282;

/**
 * Allowlist de cuentas que no requieren CLA, por ID numérico (CA-S3).
 * Verificados con `gh api users/<login> --jq .id` el 25/09/2026.
 * El login va sólo como comentario: la decisión NUNCA usa el login.
 */
const INTERNAL_ALLOWLIST = Object.freeze({
    16225095: 'internal',   // leitolarreta (operador, OWNER)
    215716766: 'internal',  // leitocodexbot (cuenta del operador, MEMBER)
    41898282: 'bot',        // github-actions[bot]
    49699333: 'bot',        // dependabot[bot]
});
const INTERNAL_ALLOWLIST_IDS = Object.freeze(Object.keys(INTERNAL_ALLOWLIST).map(Number));

/** `author_association` que cuentan como internos (sólo de la API de GitHub). */
const INTERNAL_ASSOCIATIONS = Object.freeze(['OWNER', 'MEMBER']);

/** Centinela para commits sin cuenta de GitHub vinculada: nunca puede firmar. */
const UNLINKED = 'unlinked';

/** Límite de `pulls.listCommits` (la API no devuelve más de 250 commits). */
const MAX_COMMITS = 250;

/** Rama huérfana y archivo del registro de firmas. */
const SIGNATURES_BRANCH = 'cla-signatures';
const SIGNATURES_PATH = 'signatures.json';
const CLA_PATH = 'docs/legal/CLA.md';

const REPO_URL = 'https://github.com/intrale/platform';
const CONTRIBUTING_URL = `${REPO_URL}/blob/main/CONTRIBUTING.md`;
const CLA_URL = `${REPO_URL}/blob/main/${CLA_PATH}`;

/** Descripciones del status (≤140 chars, guideline G3 de UX). */
const DESCRIPTIONS = Object.freeze({
    pending: 'Verificando el acuerdo de contribución…',
    recording: 'Registrando la firma del acuerdo de contribución…',
    missing: 'Falta aceptar el CLA — ver el comentario del PR / CLA not signed, see PR comment',
    signed: 'CLA aceptado por todos los autores',
    internal: 'Contribución interna: no requiere CLA',
    error: 'No se pudo verificar el CLA. Re-ejecutá el workflow o avisá a un mantenedor',
    tooManyCommits: 'El PR tiene más de 250 commits y no se puede verificar el CLA. Dividilo en PRs más chicos',
});

// --- Helpers puros -------------------------------------------------------------

function isPositiveInt(v) {
    return Number.isSafeInteger(v) && v > 0;
}

function toIdSet(ids) {
    const set = new Set();
    for (const id of ids || []) if (isPositiveInt(id)) set.add(id);
    return set;
}

/** Normaliza saltos de línea y bordes de un comentario (CA-S4). */
function normalizeBody(body) {
    if (typeof body !== 'string') return null;
    return body.replace(/\r\n?/g, '\n').trim();
}

/** sha256 del texto del CLA con saltos de línea normalizados a LF. */
function computeClaHash(claText) {
    if (typeof claText !== 'string' || !claText.trim()) {
        throw new Error('CLA vacío o ilegible');
    }
    const normalized = claText.replace(/\r\n?/g, '\n');
    return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/** Lee `Versión: X.Y` del encabezado del CLA. */
function parseClaVersion(claText) {
    if (typeof claText !== 'string') return null;
    const m = claText.match(/^\s*\**\s*Versi[oó]n\s*\**\s*:\s*\**\s*([0-9]+(?:\.[0-9]+)*)/mi);
    return m ? m[1] : null;
}

// --- API pública pura -----------------------------------------------------------

/**
 * Clasifica una cuenta de GitHub.
 * @returns {'internal'|'bot'|'external'}
 */
function classifyActor({ userId, authorAssociation, allowlistIds } = {}) {
    if (!isPositiveInt(userId)) return 'external';
    const ids = toIdSet(allowlistIds || INTERNAL_ALLOWLIST_IDS);
    if (ids.has(userId)) return INTERNAL_ALLOWLIST[userId] === 'bot' ? 'bot' : 'internal';
    if (INTERNAL_ASSOCIATIONS.includes(authorAssociation)) return 'internal';
    return 'external';
}

/**
 * IDs que exigen firma: el autor del PR si es externo y cada autor de commit
 * que no sea interno. Un commit sin cuenta vinculada aporta `UNLINKED`.
 *
 * Para los commits, GitHub no expone `author_association`: un autor de commit
 * es interno sólo si está en la allowlist o si es el mismo autor (interno)
 * del PR. Nunca se mira el email ni el nombre git (CA-S3, test T5).
 */
function collectExternalAuthors({ prAuthor, commits, allowlistIds } = {}) {
    const ids = allowlistIds || INTERNAL_ALLOWLIST_IDS;
    if (!prAuthor || !isPositiveInt(prAuthor.id)) throw new Error('autor del PR inválido');
    if (!Array.isArray(commits)) throw new Error('lista de commits inválida');

    const required = [];
    const add = (v) => { if (!required.includes(v)) required.push(v); };

    const prClass = classifyActor({
        userId: prAuthor.id, authorAssociation: prAuthor.authorAssociation, allowlistIds: ids,
    });
    if (prClass === 'external') add(prAuthor.id);

    for (const commit of commits) {
        if (!commit || typeof commit !== 'object') throw new Error('commit inválido');
        const author = commit.author;
        if (author === null || author === undefined) { add(UNLINKED); continue; }
        if (!isPositiveInt(author.id)) { add(UNLINKED); continue; }
        if (author.id === prAuthor.id) {
            if (prClass === 'external') add(author.id);
            continue;
        }
        const cls = classifyActor({ userId: author.id, authorAssociation: undefined, allowlistIds: ids });
        if (cls === 'external') add(author.id);
    }
    return required;
}

/**
 * ¿Este comentario es una firma válida? Sólo si lo escribe uno de los autores
 * que deben firmar, el body es EXACTAMENTE la frase y hay un hash vigente al
 * que atarla (CA-S4, tests T7/T8).
 */
function isValidSignature({ comment, requiredUserIds, claHash } = {}) {
    if (!comment || typeof comment !== 'object') return false;
    if (typeof claHash !== 'string' || !/^[0-9a-f]{64}$/.test(claHash)) return false;
    const userId = comment.user && comment.user.id;
    if (!isPositiveInt(userId)) return false;
    if (!Array.isArray(requiredUserIds) || !requiredUserIds.includes(userId)) return false;
    return normalizeBody(comment.body) === SIGN_PHRASE;
}

/** Valida el shape del registro. Cualquier desvío ⇒ throw (fail-closed). */
function parseSignatures(raw) {
    if (raw === null || raw === undefined) return { version: 1, signatures: [] };
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!data || typeof data !== 'object' || !Array.isArray(data.signatures)) {
        throw new Error('registro de firmas malformado');
    }
    for (const s of data.signatures) {
        if (!s || !isPositiveInt(s.user_id) || typeof s.cla_hash !== 'string') {
            throw new Error('registro de firmas malformado');
        }
    }
    return { version: data.version || 1, signatures: data.signatures };
}

function hasSigned(signatures, userId, claHash) {
    return signatures.some(s => s.user_id === userId && s.cla_hash === claHash);
}

/**
 * Evalúa el PR. Fail-closed: cualquier entrada inválida ⇒ `failure`.
 *
 * @param {object} p
 * @param {{ user: {id:number}, author_association: string, commits?: number }} p.pr
 * @param {Array<{author: ?{id:number}}>} p.commits
 * @param {Array<object>} p.signatures  registros del JSON de `cla-signatures`
 * @param {string} p.claHash
 * @returns {{ state: 'success'|'failure', description: string, kind: string, missing: Array<number|string>, required: Array<number|string> }}
 */
function evaluate({ pr, commits, signatures, claHash, allowlistIds } = {}) {
    const fail = (description, kind, extra = {}) => ({
        state: 'failure', description, kind, missing: [], required: [], ...extra,
    });
    try {
        if (!pr || !pr.user || !isPositiveInt(pr.user.id)) return fail(DESCRIPTIONS.error, 'error');
        if (typeof claHash !== 'string' || !/^[0-9a-f]{64}$/.test(claHash)) return fail(DESCRIPTIONS.error, 'error');
        if (!Array.isArray(signatures)) return fail(DESCRIPTIONS.error, 'error');
        if (!Array.isArray(commits)) return fail(DESCRIPTIONS.error, 'error');
        if (Number(pr.commits) > MAX_COMMITS || commits.length > MAX_COMMITS) {
            return fail(DESCRIPTIONS.tooManyCommits, 'too-many-commits');
        }
        if (commits.length === 0) return fail(DESCRIPTIONS.error, 'error');

        const required = collectExternalAuthors({
            prAuthor: { id: pr.user.id, authorAssociation: pr.author_association },
            commits,
            allowlistIds,
        });
        if (required.length === 0) {
            return { state: 'success', description: DESCRIPTIONS.internal, kind: 'internal', missing: [], required };
        }
        const missing = required.filter(id => id === UNLINKED || !hasSigned(signatures, id, claHash));
        if (missing.length > 0) {
            return { state: 'failure', description: DESCRIPTIONS.missing, kind: 'missing', missing, required };
        }
        return { state: 'success', description: DESCRIPTIONS.signed, kind: 'signed', missing: [], required };
    } catch (_) {
        return fail(DESCRIPTIONS.error, 'error');
    }
}

/**
 * Firmas nuevas a registrar a partir de los comentarios del PR.
 *
 * - Sólo comentarios de autores que deben firmar, con la frase exacta.
 * - Sólo comentarios posteriores al último cambio del CLA en `main`
 *   (`claUpdatedAt`): una frase escrita bajo un texto anterior no vale para
 *   el texto nuevo (CA-S4, test T9).
 * - Un `comment_id` ya usado en cualquier registro no se reutiliza.
 */
function findNewSignatures({ comments, required, signatures, claHash, claVersion, claUpdatedAt, prNumber, now }) {
    if (!Array.isArray(comments)) throw new Error('comentarios inválidos');
    const updatedAtMs = Date.parse(claUpdatedAt);
    if (!Number.isFinite(updatedAtMs)) throw new Error('fecha del CLA inválida');
    const usedComments = new Set(signatures.map(s => s.comment_id).filter(isPositiveInt));
    const out = [];
    for (const c of comments) {
        if (!isValidSignature({ comment: c, requiredUserIds: required, claHash })) continue;
        const createdMs = Date.parse(c.created_at);
        if (!Number.isFinite(createdMs) || createdMs < updatedAtMs) continue;
        if (isPositiveInt(c.id) && usedComments.has(c.id)) continue;
        if (hasSigned(signatures, c.user.id, claHash)) continue;
        if (out.some(s => s.user_id === c.user.id)) continue;
        out.push({
            user_id: c.user.id,
            login_at_signing: typeof c.user.login === 'string' ? c.user.login : null,
            signed_at: (now || new Date()).toISOString(),
            cla_version: claVersion || null,
            cla_hash: claHash,
            pr: prNumber,
            comment_id: isPositiveInt(c.id) ? c.id : null,
        });
    }
    return out;
}

/**
 * Comentario al contribuyente. Texto ESTÁTICO (CA-S9): no incluye título,
 * body, logins ni nada del PR. `missingCount` sólo decide una frase.
 */
function getContributorMessage(missingCount) {
    const n = Number.isSafeInteger(missingCount) && missingCount > 0 ? missingCount : 1;
    const several = n > 1
        ? 'En este PR hay commits de varias personas: cada una tiene que comentar la frase desde su propia cuenta.'
        : 'Si en el PR hay commits de otras personas, cada una tiene que comentar la frase desde su propia cuenta.';
    return [
        COMMENT_MARKER,
        '### ✍️ Falta aceptar el acuerdo de contribución',
        '',
        '¡Gracias por tu aporte! Antes de poder integrarlo necesitamos que aceptes el',
        `[Acuerdo de Licencia de Contribución (CLA)](${CLA_URL}). Es un trámite de una sola vez.`,
        '',
        '**Cómo aceptarlo:** comentá en este PR exactamente esta frase, desde la cuenta que hizo los commits:',
        '',
        '```',
        SIGN_PHRASE,
        '```',
        '',
        `El chequeo se actualiza solo en uno o dos minutos. ${several}`,
        `Más información en [CONTRIBUTING.md](${CONTRIBUTING_URL}).`,
        '',
        '---',
        `**English:** Thanks for contributing! Please accept our [CLA](${CLA_URL}) by commenting the exact sentence above on this PR, from the account that made the commits. Every commit author must sign. The check updates automatically. See [CONTRIBUTING.md](${CONTRIBUTING_URL}).`,
    ].join('\n');
}

/** Comentario de cierre cuando todas las firmas están (guideline G4). */
function getAcceptedMessage() {
    return [
        COMMENT_MARKER,
        '### ✅ Acuerdo de contribución aceptado, ¡gracias!',
        '',
        '**English:** Contribution agreement accepted, thank you!',
    ].join('\n');
}

/** Comentario propio del bot (marker + autor github-actions[bot] por ID). */
function findBotComment(comments) {
    if (!Array.isArray(comments)) return null;
    return comments.find(c => c && c.user && c.user.id === GITHUB_ACTIONS_BOT_ID
        && typeof c.body === 'string' && c.body.startsWith(COMMENT_MARKER)) || null;
}

// --- Orquestación (la usa el workflow; el cliente de GitHub se inyecta) ---------

function httpStatus(e) {
    return e && (e.status || (e.response && e.response.status));
}

/** Lee `signatures.json` de la rama dedicada. 404 ⇒ registro vacío. */
async function readSignatures(github, owner, repo) {
    try {
        const { data } = await github.rest.repos.getContent({
            owner, repo, path: SIGNATURES_PATH, ref: SIGNATURES_BRANCH,
        });
        if (!data || Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') {
            throw new Error('registro de firmas no es un archivo');
        }
        const text = Buffer.from(data.content, data.encoding || 'base64').toString('utf8');
        return { registry: parseSignatures(text), sha: data.sha };
    } catch (e) {
        if (httpStatus(e) === 404) return { registry: parseSignatures(null), sha: null };
        throw e;
    }
}

function serializeRegistry(registry) {
    return JSON.stringify({ version: registry.version || 1, signatures: registry.signatures }, null, 2) + '\n';
}

/** Crea la rama huérfana con el primer registro. */
async function createSignaturesBranch(github, owner, repo, registry) {
    const { data: blob } = await github.rest.git.createBlob({
        owner, repo, content: serializeRegistry(registry), encoding: 'utf-8',
    });
    const { data: tree } = await github.rest.git.createTree({
        owner, repo, tree: [{ path: SIGNATURES_PATH, mode: '100644', type: 'blob', sha: blob.sha }],
    });
    const { data: commit } = await github.rest.git.createCommit({
        owner, repo, message: 'cla: registro inicial de firmas', tree: tree.sha, parents: [],
    });
    await github.rest.git.createRef({ owner, repo, ref: `refs/heads/${SIGNATURES_BRANCH}`, sha: commit.sha });
}

/**
 * Agrega firmas con control optimista. Ante un conflicto (409/422) relee y
 * reintenta UNA vez; si vuelve a fallar, throw (⇒ `failure`, CA-S7).
 */
async function appendSignatures(github, owner, repo, newSignatures) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const { registry, sha } = await readSignatures(github, owner, repo);
        const toAdd = newSignatures.filter(n => !hasSigned(registry.signatures, n.user_id, n.cla_hash));
        if (toAdd.length === 0) return registry.signatures;
        const next = { version: registry.version || 1, signatures: registry.signatures.concat(toAdd) };
        try {
            if (sha === null) {
                await createSignaturesBranch(github, owner, repo, next);
            } else {
                await github.rest.repos.createOrUpdateFileContents({
                    owner, repo, path: SIGNATURES_PATH, branch: SIGNATURES_BRANCH, sha,
                    message: `cla: firma registrada (PR #${toAdd[0].pr})`,
                    content: Buffer.from(serializeRegistry(next), 'utf8').toString('base64'),
                });
            }
            return next.signatures;
        } catch (e) {
            const st = httpStatus(e);
            if ((st === 409 || st === 422) && attempt === 0) continue;
            throw e;
        }
    }
    throw new Error('no se pudo registrar la firma');
}

/** Fecha del último commit de `main` que tocó el CLA. Sin fecha ⇒ throw. */
async function getClaUpdatedAt(github, owner, repo, baseRef) {
    const { data } = await github.rest.repos.listCommits({
        owner, repo, sha: baseRef, path: CLA_PATH, per_page: 1,
    });
    const c = Array.isArray(data) && data[0];
    const date = c && c.commit && c.commit.committer && c.commit.committer.date;
    if (!date || !Number.isFinite(Date.parse(date))) throw new Error('sin fecha del CLA');
    return date;
}

/** Publica o edita el comentario único del bot. No-fatal. */
async function upsertComment({ github, owner, repo, number, comments, result, core }) {
    try {
        const existing = findBotComment(comments);
        if (result.kind === 'missing') {
            const body = getContributorMessage(result.missing.length);
            if (!existing) {
                await github.rest.issues.createComment({ owner, repo, issue_number: number, body });
            } else if (existing.body !== body) {
                await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
            }
        } else if (result.kind === 'signed' && existing) {
            const body = getAcceptedMessage();
            if (existing.body !== body) {
                await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
            }
        }
    } catch (e) {
        if (core) core.warning(`No se pudo publicar/editar el comentario del CLA: ${e.message}`);
    }
}

/**
 * Corre el gate completo.
 *
 * @param {object} p
 * @param {object} p.github   cliente Octokit de github-script
 * @param {object} p.context  contexto de github-script
 * @param {object} p.core     @actions/core
 * @param {string} p.claText  contenido de `docs/legal/CLA.md` del checkout de `main`
 * @param {'evaluate'|'record'} p.mode
 *   - `evaluate` (sin `contents: write`): si hay firmas nuevas deja el status
 *     en `pending` y devuelve `{ record: true }` para que corra el job de
 *     registro. Si no, emite el status final.
 *   - `record` (con `contents: write`): recalcula TODO desde la API (no confía
 *     en el job anterior), registra las firmas y emite el status final.
 */
async function run({ github, context, core, claText, mode = 'evaluate', now } = {}) {
    const { owner, repo } = context.repo;
    const payload = context.payload || {};
    let number;
    if (context.eventName === 'issue_comment') {
        if (!payload.issue || !payload.issue.pull_request) {
            core.info('Comentario en un issue (no PR): no-op');
            return { record: false, skipped: true };
        }
        number = payload.issue.number;
    } else if (payload.pull_request) {
        number = payload.pull_request.number;
    }
    if (!isPositiveInt(number)) throw new Error('no se pudo resolver el número de PR');

    const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number });
    if (pr.state !== 'open') {
        core.info(`PR #${number} no está abierto: no-op`);
        return { record: false, skipped: true };
    }
    const headSha = pr.head && pr.head.sha;
    if (typeof headSha !== 'string' || !/^[0-9a-f]{40}$/.test(headSha)) throw new Error('head.sha inválido');

    const setStatus = (state, description) => github.rest.repos.createCommitStatus({
        owner, repo, sha: headSha, state, context: STATUS_CONTEXT, description, target_url: CONTRIBUTING_URL,
    });

    try {
        // En `issue_comment`, sólo nos interesan comentarios que sean la frase.
        // Cualquier otro comentario no toca el status (evita ruido, G4).
        if (context.eventName === 'issue_comment' && mode === 'evaluate') {
            const body = normalizeBody(payload.comment && payload.comment.body);
            if (body !== SIGN_PHRASE) {
                core.info('El comentario no es la frase de firma: no-op');
                return { record: false, skipped: true };
            }
        }

        if (mode === 'evaluate') await setStatus('pending', DESCRIPTIONS.pending);

        const claHash = computeClaHash(claText);
        const claVersion = parseClaVersion(claText);

        if (Number(pr.commits) > MAX_COMMITS) {
            await setStatus('failure', DESCRIPTIONS.tooManyCommits);
            return { record: false, state: 'failure', kind: 'too-many-commits' };
        }
        const commits = await github.paginate(github.rest.pulls.listCommits, {
            owner, repo, pull_number: number, per_page: 100,
        });
        const { registry } = await readSignatures(github, owner, repo);
        let signatures = registry.signatures;

        let result = evaluate({ pr, commits, signatures, claHash });
        let comments = null;

        if (result.kind === 'missing') {
            comments = await github.paginate(github.rest.issues.listComments, {
                owner, repo, issue_number: number, per_page: 100,
            });
            const baseRef = (pr.base && pr.base.repo && pr.base.repo.default_branch) || 'main';
            const claUpdatedAt = await getClaUpdatedAt(github, owner, repo, baseRef);
            const fresh = findNewSignatures({
                comments, required: result.required, signatures, claHash, claVersion, claUpdatedAt,
                prNumber: number, now,
            });
            if (fresh.length > 0) {
                if (mode === 'evaluate') {
                    await setStatus('pending', DESCRIPTIONS.recording);
                    core.info(`Hay ${fresh.length} firma(s) nueva(s): se delega el registro al job record-signature`);
                    return { record: true, state: 'pending', kind: 'recording' };
                }
                signatures = await appendSignatures(github, owner, repo, fresh);
                core.info(`Registradas ${fresh.length} firma(s) nueva(s)`);
                result = evaluate({ pr, commits, signatures, claHash });
            }
        }

        await setStatus(result.state, result.description);
        core.info(`Status ${STATUS_CONTEXT}=${result.state} (${result.kind})`);

        if (result.kind === 'missing' || result.kind === 'signed') {
            if (!comments) {
                comments = await github.paginate(github.rest.issues.listComments, {
                    owner, repo, issue_number: number, per_page: 100,
                });
            }
            await upsertComment({ github, owner, repo, number, comments, result, core });
        }
        return { record: false, state: result.state, kind: result.kind };
    } catch (e) {
        // CA-S7: cualquier error termina en failure, nunca en success.
        core.error(`Error verificando el CLA: ${e && e.message}`);
        try { await setStatus('failure', DESCRIPTIONS.error); } catch (_) { /* sin status ⇒ igual bloquea */ }
        return { record: false, state: 'failure', kind: 'error' };
    }
}

module.exports = {
    STATUS_CONTEXT,
    SIGN_PHRASE,
    COMMENT_MARKER,
    GITHUB_ACTIONS_BOT_ID,
    INTERNAL_ALLOWLIST,
    INTERNAL_ALLOWLIST_IDS,
    INTERNAL_ASSOCIATIONS,
    UNLINKED,
    MAX_COMMITS,
    SIGNATURES_BRANCH,
    SIGNATURES_PATH,
    CLA_PATH,
    CONTRIBUTING_URL,
    CLA_URL,
    DESCRIPTIONS,
    normalizeBody,
    computeClaHash,
    parseClaVersion,
    classifyActor,
    collectExternalAuthors,
    isValidSignature,
    parseSignatures,
    evaluate,
    findNewSignatures,
    getContributorMessage,
    getAcceptedMessage,
    findBotComment,
    readSignatures,
    appendSignatures,
    run,
};
