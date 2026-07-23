// =============================================================================
// architect-verify.js — Fase 2 de verificación del rol `architect` (#3643)
//
// Implementa el chequeo determinístico de adherencia código vs receta firmada
// en pre-admisión. Se invoca desde el rol `architect` en `aprobacion`, después
// de review/po/ux (orden documentado en docs/pipeline/architect-role.md §9 y
// en config.yaml `skills_por_fase.aprobacion`).
//
// Spec:
//   - Issue paraguas: #3559 (architect role completo).
//   - Historia madre: #3615 (split B6+B7+piloto+comms).
//   - Bootstrap previo: #3613 (skill registrado + audit JSONL operativo).
//   - Gate Fase 1: #3614 (firma `architect-signoff` en `criterios → Ready`).
//   - Esta historia: #3643 (Fase 2 verificación post-dev).
//
// Reglas inquebrantables (decisiones cerradas en la receta firmada del issue):
//
//  R1. **Split-then-sanitize** — el split del `gh pr diff` por header
//      `^diff --git a/...` ocurre ANTES de invocar `handoff.detectInjection`.
//      Si un patrón aparece en el chunk N, el chunk N+1 sigue procesándose
//      independiente. Sin esto, `detectInjection` trunca al primer hit con
//      `[TRUNCATED:prompt_injection]` y rompe la verificación del resto.
//      (Mitigación R2 de guru sobre el body original de #3643.)
//
//  R2. **Marker estricto con round-trip** — la regex captura `issue=(\d+)` y
//      `commit=([a-f0-9]{7,40})`. Casteamos issue a entero y verificamos que
//      `String(parseInt(raw, 10)) === raw` para rechazar padding `00042`,
//      negativos, signos, decimales o caracteres invisibles. Mismatch →
//      ignorar marker silenciosamente + `audit.appendMarkerMismatch`.
//
//  R3. **Anti-stale por `headRefOid`** — `verifyPrAdherence` lee
//      `gh pr view <N> --json headRefOid` y compara contra el SHA citado en
//      la receta firmada (campo opcional `signed_commit` del marker). Si el
//      PR avanzó desde la firma, rechazo con motivo accionable; no se
//      compara código contra un SHA viejo (CA-PO-2).
//
//  R4. **Idempotencia anti-spam** — antes de postear `architect-rejection`,
//      `hasAlreadyRejected` busca un marker `commit=<headOid>` en los
//      comments existentes del PR. Si existe → no duplica (CA-PO-6). Esto
//      evita que rebotes en cadena spamen el issue con el mismo análisis.
//
//  R5. **Audit append-only** — el nuevo writer `appendMarkerMismatch` vive
//      en `architect-audit.js` y respeta R1 del módulo audit (appendFileSync
//      en modo `'a'`). El test estático con grep falla si aparece
//      `writeFileSync` apuntando al path de `markerMismatches`.
//
// Lo que NO hace este módulo:
//   - NO invoca al LLM. Toda la lógica de Fase 2 es determinística (la receta
//     ya fue producida por el architect Fase 1 con LLM).
//   - NO modifica el PR. Solo devuelve `{decision, motivo, structured_comment}`
//     — el caller (rol architect en `aprobacion`) decide si postea el comment
//     y rebota el issue.
//   - NO lee credentials ni `.env` (defensa Gemini hereda de architect-audit).
// =============================================================================
'use strict';

const { execFileSync } = require('child_process');
const audit = require('./architect-audit');
const handoff = require('./handoff');

// -----------------------------------------------------------------------------
// Constantes
// -----------------------------------------------------------------------------

/**
 * Regex estricta del marker de rechazo (CA-IMPL-B7-MARKER-STRICT).
 *
 * Estructura esperada literal: `<!-- architect-rejection issue=NNNN commit=SHA -->`.
 *
 * - `\d+` captura uno o más dígitos para luego validar round-trip.
 * - `[a-f0-9]{7,40}` SHA git corto o completo en hex minúscula. Mayúsculas
 *   se rechazan deliberadamente (git output siempre minúscula).
 * - El whitespace está fijo a un único espacio en cada separación. Tabs,
 *   doble espacio o whitespace extra rompen el match (defensa anti-fuzzing
 *   de markers homógrafos).
 */
const REJECTION_MARKER_RE = /<!-- architect-rejection issue=(-?\d+) commit=([A-Za-z0-9]+) -->/;

/**
 * Regex de captura del marker de signoff (Fase 1, #3614). Conviene aceptar
 * variantes pero validar campos. El módulo `architect-signoff-gate.js` ya
 * cubre la validación canónica; acá lo usamos solo para extraer el SHA
 * firmado del comment si el architect lo persiste explícitamente.
 *
 * Estructura aceptada:
 *   - `<!-- architect-signoff issue=NNNN -->` (formato canónico actual)
 *   - `<!-- architect-signoff issue=NNNN commit=SHA -->` (extensión opcional)
 */
const SIGNOFF_MARKER_RE = /<!-- architect-signoff issue=(\d+)(?:\s+commit=([a-f0-9]{7,40}))?\s*-->/;

/**
 * Regex de split del diff por archivo. Mantenemos el lookbehind con flag
 * multiline para que cada chunk arranque con su header `diff --git a/...`.
 */
const DIFF_CHUNK_SPLIT_RE = /(?=^diff --git )/m;

/**
 * Regex de extracción del path destino del chunk. Captura el `b/<path>` del
 * header (post-rename, post-copy), que es el path efectivo después del
 * commit del PR.
 */
const DIFF_HEADER_RE = /^diff --git a\/(.+?) b\/(.+?)$/m;

// -----------------------------------------------------------------------------
// Parsing del diff (CA-IMPL-B7-SANITIZE-DIFF refinado: split-then-sanitize)
// -----------------------------------------------------------------------------

/**
 * Parte el texto crudo de `gh pr diff` en chunks por archivo. NO sanitiza —
 * el split ocurre ANTES de tocar `handoff.detectInjection` para que un patrón
 * de injection en un chunk no rompa el parseo del resto (R1 de este módulo,
 * mitigación R2 de guru).
 *
 * Cada chunk conserva su header `diff --git a/... b/...` para que el caller
 * pueda recomputarlo si necesita re-emitir el diff con metadata.
 *
 * @param {string} diffText - texto crudo de `gh pr diff <N>`
 * @returns {Array<{file_path: string|null, raw: string}>}
 */
function parsePrDiff(diffText) {
    if (typeof diffText !== 'string' || diffText.length === 0) return [];

    const parts = diffText.split(DIFF_CHUNK_SPLIT_RE).filter(Boolean);
    const chunks = [];
    for (const raw of parts) {
        if (!raw.startsWith('diff --git ')) continue;
        const m = DIFF_HEADER_RE.exec(raw);
        // Si el header está malformado, conservamos el chunk con file_path=null
        // para que el caller pueda detectarlo y rechazar explícitamente.
        chunks.push({
            file_path: m ? m[2] : null,
            raw: raw,
        });
    }
    return chunks;
}

/**
 * Sanitiza cada chunk del diff de forma independiente. Si `detectInjection`
 * matchea en un chunk, registra una entrada en `prompt-injection-attempts.jsonl`
 * con `source: "pr-diff"` + `pr_number` + `commit_sha` + `file_path`, y
 * marca el chunk como hit. El resto de los chunks NO se ve afectado.
 *
 * @param {Array<{file_path: string|null, raw: string}>} chunks - resultado de `parsePrDiff`
 * @param {object} ctx
 * @param {string|number} ctx.issue_id
 * @param {number} ctx.pr_number
 * @param {string} ctx.commit_sha
 * @param {object} [opts]
 * @returns {{
 *   chunks: Array<{file_path: string|null, raw: string, sanitized: string, hits: Array<string>}>,
 *   injectionHits: Array<{file_path: string|null, pattern: string}>
 * }}
 */
function sanitizeDiffByChunk(chunks, ctx, opts) {
    if (!Array.isArray(chunks)) {
        throw new Error('architect-verify: chunks debe ser array (resultado de parsePrDiff)');
    }
    if (!ctx || ctx.issue_id == null) {
        throw new Error('architect-verify: ctx.issue_id requerido en sanitizeDiffByChunk');
    }

    const out = [];
    const injectionHits = [];

    for (const chunk of chunks) {
        const r = handoff.detectInjection(chunk.raw);
        if (r.hits.length > 0) {
            // CA-IMPL-B7-SANITIZE-DIFF: source="pr-diff" con metadata granular
            // (pr_number, commit_sha, file_path) para trazabilidad por archivo.
            // El `source_id` sintético codifica `pr:file@sha` para que el
            // operador pueda mapear el hit al diff exacto sin abrir el PR.
            audit.appendPromptInjection({
                issue_id: ctx.issue_id,
                phase: 'aprobacion',
                source: 'pr-diff',
                source_id: `pr-diff:${ctx.pr_number}:${chunk.file_path || 'unknown-path'}@${ctx.commit_sha}`,
                author: '',
                pattern_matched: r.hits[0],
                action_taken: 'rejected_pr_promotion',
            }, opts);

            injectionHits.push({
                file_path: chunk.file_path,
                pattern: r.hits[0],
            });
        }
        out.push({
            file_path: chunk.file_path,
            raw: chunk.raw,
            sanitized: r.text,
            hits: r.hits,
        });
    }

    return { chunks: out, injectionHits };
}

// -----------------------------------------------------------------------------
// Marker parsing (CA-IMPL-B7-MARKER-STRICT)
// -----------------------------------------------------------------------------

/**
 * Parsea un marker `<!-- architect-rejection issue=NNNN commit=SHA -->` de
 * un body de comment de PR. Si el marker no aparece, devuelve `null` sin
 * loguear. Si aparece pero falla validación de campos, devuelve `null` y
 * loguea en `architect-marker-mismatches.jsonl`.
 *
 * Reglas de validación (CA-IMPL-B7-MARKER-STRICT refinado por PO):
 *   - `issue`: round-trip `String(parseInt(raw, 10)) === raw` + `> 0`. Esto
 *     rechaza padding (`00042`), negativos (`-5`), decimales (`1.5`),
 *     signos (`+42`), separadores (`1_000`), y cualquier carácter no
 *     numérico ASCII.
 *   - `commit`: hex 7-40 chars exactos en minúscula. Mayúsculas se rechazan
 *     (git emite SHA en minúscula).
 *   - Cualquier whitespace extra (tab, doble espacio) rompe el match en la
 *     regex previa — defensa contra fuzzing de markers homógrafos.
 *
 * @param {string} commentBody - cuerpo del comment GitHub
 * @param {object} ctx
 * @param {string|number} ctx.issue_id - issue del contexto (no del marker)
 * @param {number} [ctx.pr_number] - PR del comment, para `source_pr` del log
 * @param {object} [opts]
 * @param {boolean} [opts.silent] - si true, no loguea mismatches (uso interno de `hasAlreadyRejected`)
 * @returns {{issue_id: number, commit_sha: string} | null}
 */
function parseRejectionMarker(commentBody, ctx, opts) {
    if (typeof commentBody !== 'string') return null;
    const m = REJECTION_MARKER_RE.exec(commentBody);
    if (!m) return null;

    const rawIssue = m[1];
    const rawCommit = m[2];
    const silent = !!(opts && opts.silent);

    // Validación round-trip del issue id.
    const parsedIssue = parseInt(rawIssue, 10);
    if (String(parsedIssue) !== rawIssue || parsedIssue <= 0) {
        if (!silent) {
            try {
                audit.appendMarkerMismatch({
                    issue_id: ctx && ctx.issue_id ? ctx.issue_id : 1,
                    raw_marker: m[0],
                    reason: 'issue_id non-canonical (padding, negativo, signo o no-entero)',
                    source_pr: ctx && typeof ctx.pr_number === 'number' ? ctx.pr_number : undefined,
                }, opts);
            } catch (_) { /* best-effort */ }
        }
        return null;
    }

    // Validación hex estricta del SHA. Mayúsculas y caracteres no-hex
    // (z, g, &, etc.) caen acá. NB: la regex permite [A-Za-z0-9]+ a
    // propósito para capturar payloads hostiles y poder loguearlos.
    if (!/^[a-f0-9]{7,40}$/.test(rawCommit)) {
        if (!silent) {
            try {
                audit.appendMarkerMismatch({
                    issue_id: ctx && ctx.issue_id ? ctx.issue_id : 1,
                    raw_marker: m[0],
                    reason: 'commit no-hex o longitud fuera de [7,40]',
                    source_pr: ctx && typeof ctx.pr_number === 'number' ? ctx.pr_number : undefined,
                }, opts);
            } catch (_) { /* best-effort */ }
        }
        return null;
    }

    return { issue_id: parsedIssue, commit_sha: rawCommit };
}

// -----------------------------------------------------------------------------
// Parsing de la receta firmada (Fase 1 → consumido por Fase 2)
// -----------------------------------------------------------------------------

/**
 * Extrae la lista de archivos esperados de la sección `## Detalles Técnicos`
 * → subsección `### Archivos a tocar` del body del issue. El formato es:
 *
 *   ### Archivos a tocar
 *   - `path/al/archivo.ext:123-145` — comentario opcional
 *   - `path/sin-rango.ext` — comentario
 *
 * Devuelve `{ expected_files, signed_commit }`:
 *   - `expected_files`: array de `{path, range}` donde `range` puede ser
 *     `null` si el bullet no especifica.
 *   - `signed_commit`: SHA del commit que la receta firmó (opcional, leído
 *     del marker `architect-signoff` si tiene el campo extendido).
 *
 * Devuelve `null` si no encuentra la sección `## Detalles Técnicos` o la
 * subsección `### Archivos a tocar`. El caller rechaza con motivo
 * `"no hay receta firmada"` (CA-PO-1).
 *
 * @param {string} issueBody
 * @param {string} [signoffMarkerBody] - body del comment con marker (opcional)
 * @returns {{expected_files: Array<{path: string, range: string|null}>, signed_commit: string|null} | null}
 */
function parseSignoffRecipe(issueBody, signoffMarkerBody) {
    if (typeof issueBody !== 'string') return null;

    // Buscamos la sección `## Detalles Técnicos` y dentro la subsección
    // `### Archivos a tocar`. Usamos un parser simple por líneas: no
    // queremos meter heurísticas pesadas que sean explotables.
    const lines = issueBody.split(/\r?\n/);
    let inSection = false;
    let inFilesList = false;
    const expected = [];

    for (const line of lines) {
        // Detectamos entrada a la sección.
        if (/^##\s+Detalles\s+T[eé]cnicos\s*$/i.test(line)) {
            inSection = true;
            continue;
        }
        if (inSection && /^##\s+/.test(line)) {
            // Salimos de la sección al ver otro `## ` (no `### `).
            break;
        }
        if (!inSection) continue;

        // Subsección `### Archivos a tocar`.
        if (/^###\s+Archivos\s+a\s+tocar\s*$/i.test(line)) {
            inFilesList = true;
            continue;
        }
        if (inFilesList && /^###\s+/.test(line)) {
            // Salimos de la subsección al ver otra `### `.
            inFilesList = false;
            continue;
        }
        if (!inFilesList) continue;

        // Bullet con backtick: `- \`path:range\` — texto opcional`.
        const bulletMatch = /^\s*-\s+`([^`]+)`/.exec(line);
        if (!bulletMatch) continue;
        const pathSpec = bulletMatch[1].trim();
        const rangeMatch = /^(.+?):(\d+(?:-\d+)?)$/.exec(pathSpec);
        if (rangeMatch) {
            expected.push({ path: rangeMatch[1], range: rangeMatch[2] });
        } else {
            expected.push({ path: pathSpec, range: null });
        }
    }

    if (!inSection) return null;

    // SHA firmado: si el marker de signoff lo trae como `commit=SHA`, lo
    // exponemos para que el caller compare contra HEAD del PR (CA-PO-2).
    let signedCommit = null;
    if (typeof signoffMarkerBody === 'string') {
        const m = SIGNOFF_MARKER_RE.exec(signoffMarkerBody);
        if (m && m[2]) signedCommit = m[2];
    }

    return { expected_files: expected, signed_commit: signedCommit };
}

// -----------------------------------------------------------------------------
// Anti-stale (CA-PO-2)
// -----------------------------------------------------------------------------

/**
 * Compara el `signed_commit` de la receta firmada contra el `head_oid` del PR.
 * Si difieren, la receta está stale y el caller debe rechazar con motivo
 * accionable. Si `signed_commit` es `null` (la receta no codificó el SHA),
 * devuelve `false` — la verificación se hace solo contra archivos.
 *
 * @param {string|null} signedCommit
 * @param {string|null} headOid
 * @returns {boolean}
 */
function isStaleAgainstHead(signedCommit, headOid) {
    if (!signedCommit || !headOid) return false;
    // Comparación case-insensitive en hex porque git emite siempre minúscula
    // pero gh JSON podría normalizar.
    return signedCommit.toLowerCase() !== headOid.toLowerCase();
}

// -----------------------------------------------------------------------------
// Idempotencia anti-spam (CA-PO-6)
// -----------------------------------------------------------------------------

/**
 * Determina si el architect ya rechazó este PR sobre el mismo SHA de HEAD.
 * Busca el marker `architect-rejection commit=<headOid>` en los comments
 * existentes del PR. Si lo encuentra, NO duplicamos el comment (idempotencia).
 *
 * @param {object} params
 * @param {Array<{body: string}>} params.pr_comments
 * @param {string} params.head_oid
 * @returns {boolean}
 */
function hasAlreadyRejected(params) {
    if (!params || !Array.isArray(params.pr_comments) || !params.head_oid) return false;
    const headLower = params.head_oid.toLowerCase();
    for (const c of params.pr_comments) {
        if (!c || typeof c.body !== 'string') continue;
        const m = REJECTION_MARKER_RE.exec(c.body);
        if (!m) continue;
        // Reusamos la validación estricta — el comment puede tener un marker
        // canónico (lo emitimos nosotros mismos) o malformado (ignoramos).
        // `silent: true` porque los markers que vemos acá NO son nuestros
        // (vienen de comments del PR): no queremos llenar
        // `architect-marker-mismatches.jsonl` con ruido externo, ni tampoco
        // tocar disco con cada comment al chequear idempotencia.
        const parsed = parseRejectionMarker(c.body, { issue_id: 1 }, { silent: true });
        if (!parsed) continue;
        if (parsed.commit_sha.toLowerCase() === headLower) return true;
    }
    return false;
}

// -----------------------------------------------------------------------------
// Formato del comment de rechazo (CA-PO-3)
// -----------------------------------------------------------------------------

/**
 * Produce el markdown del comment de rechazo `architect-rejection` con las
 * 4 secciones en orden literal (CA-PO-3):
 *
 *   1. Marker `<!-- architect-rejection issue=NNNN commit=SHA -->`.
 *   2. `### Archivos esperados (de la receta firmada)` con bullets.
 *   3. `### Archivos tocados (en commit SHA)` con `✅` o `⚠️ NO estaba`.
 *   4. `### Decisión requerida` con 3 opciones.
 *
 * @param {object} params
 * @param {number} params.issue
 * @param {string} params.commit_sha
 * @param {Array<{path: string, range: string|null}>} params.expected
 * @param {Array<{path: string, in_recipe: boolean}>} params.actual
 * @returns {string}
 */
function formatRejectionComment(params) {
    const lines = [];
    lines.push(`<!-- architect-rejection issue=${params.issue} commit=${params.commit_sha} -->`);
    lines.push('## ❌ Arquitecto — desviación detectada');
    lines.push('');
    lines.push('### Archivos esperados (de la receta firmada)');
    if (params.expected.length === 0) {
        lines.push('- _(la receta firmada no listó archivos)_');
    } else {
        for (const e of params.expected) {
            const rangeStr = e.range ? `:${e.range}` : '';
            lines.push(`- \`${e.path}${rangeStr}\``);
        }
    }
    lines.push('');
    lines.push(`### Archivos tocados (en commit \`${params.commit_sha}\`)`);
    if (params.actual.length === 0) {
        lines.push('- _(el PR no toca archivos — diff vacío)_');
    } else {
        for (const a of params.actual) {
            const mark = a.in_recipe ? '✅' : '⚠️ NO estaba en la receta';
            lines.push(`- \`${a.path}\` ${mark}`);
        }
    }
    lines.push('');
    lines.push('### Decisión requerida');
    lines.push('- Justificar inclusión del archivo fuera de receta en este issue, o');
    lines.push('- Mover ese cambio a un issue separado, o');
    lines.push('- Pedir update de la receta (rebote a Arquitecto Fase 1)');
    return lines.join('\n');
}

// -----------------------------------------------------------------------------
// Orquestador principal: verifyPrAdherence
// -----------------------------------------------------------------------------

/**
 * `gh` shell-out helper. Se inyecta vía `opts.gh` en tests para no depender
 * del binario real. En producción usa `execFileSync` con `gh` en PATH.
 *
 * @param {Array<string>} args
 * @param {object} [opts]
 * @returns {string}
 */
function runGh(args, opts) {
    if (opts && typeof opts.gh === 'function') {
        return opts.gh(args);
    }
    return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Verifica adherencia del PR a la receta firmada. Orquesta todo el flow:
 *
 *   1. Lee el PR con `gh pr view <N> --json headRefOid,body,comments`.
 *   2. Lee el body del issue (puede venir inyectado en `opts.issueBody` para
 *      tests, o se lee con `gh issue view <issue> --json body,comments`).
 *   3. Extrae la receta firmada de la sección `## Detalles Técnicos`.
 *   4. Lee el diff del PR (`gh pr diff <N>`).
 *   5. Sanitiza por chunk (split-then-sanitize).
 *   6. Compara expected vs actual.
 *   7. Devuelve veredicto + comentario estructurado.
 *
 * Casos de rechazo determinístico (CA-PO-1, CA-PO-2, CA-IMPL-B7-SANITIZE-DIFF):
 *   - No hay receta firmada → "no hay receta firmada (#3614 no ejecutó o fue inválido)".
 *   - Receta firmada vacía → "receta firmada está vacía, re-ejecutar Fase 1".
 *   - PR avanzó vs receta → "PR avanzó (HEAD=X) desde la receta firmada (commit=Y)".
 *   - Diff con prompt-injection → "patrón de prompt-injection detectado en diff de archivo X".
 *   - Archivos fuera de receta → comment estructurado con `architect-rejection`.
 *
 * Caso de aprobación:
 *   - Todos los archivos tocados están listados en la receta (matching por
 *     `path` exacto, ignorando `range`).
 *
 * @param {object} params
 * @param {number} params.issue
 * @param {number} params.pr_number
 * @param {object} [opts]
 * @param {function} [opts.gh] - mock de gh para tests
 * @param {string} [opts.issueBody] - mock del issue body
 * @param {Array<{body: string, author?: object}>} [opts.issueComments]
 * @param {string} [opts.pipelineDir] - tmpdir para audit en tests
 * @returns {{
 *   decision: 'aprobado'|'rechazado',
 *   motivo: string,
 *   expected: Array<{path: string, range: string|null}>,
 *   actual: Array<{path: string, in_recipe: boolean}>,
 *   structured_comment: string|null,
 *   already_rejected: boolean,
 *   head_oid: string|null
 * }}
 */
function verifyPrAdherence(params, opts) {
    opts = opts || {};
    if (!params || !Number.isInteger(params.issue) || params.issue <= 0) {
        throw new Error('architect-verify: params.issue debe ser entero positivo');
    }
    if (!Number.isInteger(params.pr_number) || params.pr_number <= 0) {
        throw new Error('architect-verify: params.pr_number debe ser entero positivo');
    }

    // 1) PR metadata
    let prJson;
    try {
        const raw = runGh(['pr', 'view', String(params.pr_number), '--json', 'headRefOid,comments'], opts);
        prJson = JSON.parse(raw);
    } catch (e) {
        return rejected({
            issue: params.issue, headOid: null, expected: [], actual: [],
            motivo: `no se pudo leer el PR #${params.pr_number}: ${e.message}`,
        });
    }
    const headOid = (prJson && prJson.headRefOid) ? String(prJson.headRefOid) : null;
    const prComments = (prJson && Array.isArray(prJson.comments)) ? prJson.comments : [];

    // 2) Issue body (puede venir mockeado en opts)
    let issueBody = opts.issueBody;
    let issueComments = opts.issueComments;
    if (typeof issueBody !== 'string') {
        try {
            const raw = runGh(['issue', 'view', String(params.issue), '--json', 'body,comments'], opts);
            const j = JSON.parse(raw);
            issueBody = j.body || '';
            issueComments = j.comments || [];
        } catch (e) {
            return rejected({
                issue: params.issue, headOid, expected: [], actual: [],
                motivo: `no se pudo leer el issue #${params.issue}: ${e.message}`,
            });
        }
    }

    // 3) Idempotencia anti-spam (CA-PO-6): si ya rechazamos sobre este HEAD,
    // no producimos un comment nuevo (pero seguimos devolviendo veredicto).
    const alreadyRejected = hasAlreadyRejected({ pr_comments: prComments, head_oid: headOid });

    // 4) Recipe parsing (CA-PO-1)
    // Buscamos el comment con marker `architect-signoff` para extraer el
    // SHA firmado opcional. NB: si no hay marker → la receta puede igual
    // existir en el body, pero sin SHA firmado el chequeo anti-stale es
    // permisivo.
    let signoffCommentBody = null;
    if (Array.isArray(issueComments)) {
        for (const c of issueComments) {
            if (c && typeof c.body === 'string' && SIGNOFF_MARKER_RE.test(c.body)) {
                signoffCommentBody = c.body;
                break;
            }
        }
    }
    const recipe = parseSignoffRecipe(issueBody, signoffCommentBody);
    if (!recipe) {
        return finalize({
            issue: params.issue, headOid, expected: [], actual: [],
            alreadyRejected,
            decision: 'rechazado',
            motivo: 'no hay receta firmada (#3614 no ejecutó o fue inválido)',
            structured: null,
        });
    }
    if (recipe.expected_files.length === 0) {
        return finalize({
            issue: params.issue, headOid, expected: [], actual: [],
            alreadyRejected,
            decision: 'rechazado',
            motivo: 'receta firmada está vacía, re-ejecutar Fase 1',
            structured: null,
        });
    }

    // 5) Anti-stale (CA-PO-2)
    if (isStaleAgainstHead(recipe.signed_commit, headOid)) {
        return finalize({
            issue: params.issue, headOid, expected: recipe.expected_files, actual: [],
            alreadyRejected,
            decision: 'rechazado',
            motivo: `PR avanzó (HEAD=${headOid}) desde la receta firmada (commit=${recipe.signed_commit}). Re-ejecutar Fase 1 contra HEAD actual o justificar.`,
            structured: null,
        });
    }

    // 6) PR diff + sanitize por chunk
    let diffText;
    try {
        diffText = runGh(['pr', 'diff', String(params.pr_number)], opts);
    } catch (e) {
        return finalize({
            issue: params.issue, headOid, expected: recipe.expected_files, actual: [],
            alreadyRejected,
            decision: 'rechazado',
            motivo: `no se pudo leer el diff del PR #${params.pr_number}: ${e.message}`,
            structured: null,
        });
    }
    const chunks = parsePrDiff(diffText);
    const sanitizeCtx = {
        issue_id: params.issue,
        pr_number: params.pr_number,
        commit_sha: headOid || 'unknown',
    };
    const { injectionHits } = sanitizeDiffByChunk(chunks, sanitizeCtx, opts);
    if (injectionHits.length > 0) {
        const hit = injectionHits[0];
        return finalize({
            issue: params.issue, headOid, expected: recipe.expected_files, actual: [],
            alreadyRejected,
            decision: 'rechazado',
            motivo: `patrón de prompt-injection detectado en diff de archivo ${hit.file_path || '(unknown path)'}`,
            structured: null,
        });
    }

    // 7) Comparación expected vs actual.
    const expectedPaths = new Set(recipe.expected_files.map(e => e.path));
    const actualPaths = chunks.filter(c => c.file_path).map(c => c.file_path);
    const actual = actualPaths.map(p => ({ path: p, in_recipe: expectedPaths.has(p) }));
    const desviaciones = actual.filter(a => !a.in_recipe);

    if (desviaciones.length === 0) {
        return finalize({
            issue: params.issue, headOid, expected: recipe.expected_files, actual,
            alreadyRejected,
            decision: 'aprobado',
            motivo: 'todos los archivos tocados están listados en la receta firmada',
            structured: null,
        });
    }

    // Rechazo con comment estructurado.
    const structured = formatRejectionComment({
        issue: params.issue,
        commit_sha: headOid || 'unknown',
        expected: recipe.expected_files,
        actual,
    });
    return finalize({
        issue: params.issue, headOid, expected: recipe.expected_files, actual,
        alreadyRejected,
        decision: 'rechazado',
        motivo: `desviación detectada: ${desviaciones.length} archivo(s) fuera de receta — ${desviaciones.map(d => d.path).join(', ')}`,
        structured,
    });
}

// -----------------------------------------------------------------------------
// Gate de Fase 2 — kill switch + grandfathering + dry-run (#4246)
// -----------------------------------------------------------------------------
//
// PROBLEMA RAÍZ (#4246, recurrente en #3954 / #4235): `verifyPrAdherence` es el
// chequeo determinístico crudo y SIEMPRE intenta leer el PR + la receta firmada.
// Cuando la feature architect está apagada (`architect.enabled !== true`) o en
// piloto (`gate_mode: dry-run`), o cuando el issue es legacy (anterior a
// `go_live_date`), Fase 2 igual rechazaba — porque NO existe PR en `aprobacion`
// (el PR lo crea `entrega`, fase posterior) ni receta (`## Detalles Técnicos`
// la produce architect Fase 1, que con kill switch OFF nunca corrió).
//
// El gate de Fase 1 (`architect-signoff-gate.js`) ya respeta R1 (kill switch),
// R3 (dry-run no bloquea) y R10 (grandfathering). Fase 2 carecía del guard
// equivalente. `evaluateGate` cierra ese gap: es el entry point que el rol
// `architect` en `aprobacion` debe invocar ANTES de rechazar, en vez de llamar
// `verifyPrAdherence` directo.
//
// Reglas (espejo de architect-signoff-gate.js):
//   R1 — kill switch: `config.enabled !== true` → no se verifica nada,
//        decision `aprobado`, `skipped: true`, `gate_mode: 'disabled'`.
//   R10 — grandfathering: `issue.createdAt < config.go_live_date` → `aprobado`,
//        `skipped: true` (no se penaliza un issue anterior al rollout).
//   R3 — dry-run: si el gate está activo (`enabled === true`) pero
//        `gate_mode !== 'enforce'`, se ejecuta `verifyPrAdherence` para registrar
//        la decisión lógica, pero el `decision` efectivo NUNCA es `rechazado`
//        (se expone `original_decision` para auditoría).
//   enforce — `gate_mode === 'enforce'` con `enabled === true`: delega tal cual
//        a `verifyPrAdherence` y respeta su veredicto.
//
// `evaluateGate` NO toca disco por sí mismo (cuando saltea por kill switch /
// grandfathering retorna sin invocar `verifyPrAdherence`, que es lo único que
// escribe audit). Esto mantiene el cortocircuito limpio del kill switch.

/**
 * Entry point gateado de Fase 2. Aplica kill switch, grandfathering y dry-run
 * antes de delegar en `verifyPrAdherence`.
 *
 * @param {object} params
 * @param {number} params.issue
 * @param {number} [params.pr_number] - puede faltar si aún no hay PR
 * @param {object} [params.config] - sección `architect` de config.yaml
 *   `{ enabled, gate_mode, go_live_date }`
 * @param {string} [params.issue_created_at] - ISO8601 createdAt del issue (R10)
 * @param {object} [opts] - inyección de `gh`/`pipelineDir` para tests
 * @returns {{
 *   decision: 'aprobado'|'rechazado',
 *   original_decision?: 'aprobado'|'rechazado',
 *   motivo: string,
 *   gate_mode: 'disabled'|'dry-run'|'enforce',
 *   skipped: boolean,
 *   expected?: Array, actual?: Array,
 *   structured_comment?: string|null,
 *   already_rejected?: boolean,
 *   head_oid?: string|null
 * }}
 */
function evaluateGate(params, opts) {
    params = params || {};
    const config = params.config || {};
    const gateMode = config.gate_mode === 'enforce' ? 'enforce' : 'dry-run';

    // R1 — Kill switch: si la feature architect no está habilitada, Fase 2 no
    // verifica nada. Cortocircuito completo (no se toca el PR ni el audit).
    if (config.enabled !== true) {
        return {
            decision: 'aprobado',
            motivo: 'architect Fase 2 deshabilitado (kill switch: architect.enabled !== true) — verificación de adherencia omitida',
            gate_mode: 'disabled',
            skipped: true,
            expected: [],
            actual: [],
            structured_comment: null,
            already_rejected: false,
            head_oid: null,
        };
    }

    // R10 — Grandfathering: issues anteriores a go_live_date no se verifican.
    const goLiveDate = config.go_live_date || null;
    const createdAt = typeof params.issue_created_at === 'string' ? params.issue_created_at : null;
    if (goLiveDate && createdAt && createdAt < goLiveDate) {
        return {
            decision: 'aprobado',
            motivo: `grandfathered (issue.createdAt ${createdAt} < architect.go_live_date ${goLiveDate}) — verificación de adherencia omitida`,
            gate_mode: gateMode,
            skipped: true,
            expected: [],
            actual: [],
            structured_comment: null,
            already_rejected: false,
            head_oid: null,
        };
    }

    // Gate activo: delegamos al chequeo determinístico crudo.
    const result = verifyPrAdherence({ issue: params.issue, pr_number: params.pr_number }, opts);

    // R3 — dry-run nunca bloquea efectivamente. Persistimos `original_decision`
    // para que el go/no-go del piloto pueda medir falsos positivos.
    if (gateMode !== 'enforce' && result.decision === 'rechazado') {
        return Object.assign({}, result, {
            decision: 'aprobado',
            original_decision: 'rechazado',
            motivo: `dry-run (no bloquea promoción): ${result.motivo}`,
            gate_mode: 'dry-run',
            skipped: false,
        });
    }

    return Object.assign({}, result, { gate_mode: gateMode, skipped: false });
}

// -----------------------------------------------------------------------------
// Helpers internos de resultado
// -----------------------------------------------------------------------------

function rejected(params) {
    return {
        decision: 'rechazado',
        motivo: params.motivo,
        expected: params.expected || [],
        actual: params.actual || [],
        structured_comment: null,
        already_rejected: false,
        head_oid: params.headOid || null,
    };
}

function finalize(params) {
    return {
        decision: params.decision,
        motivo: params.motivo,
        expected: params.expected,
        actual: params.actual,
        // Idempotencia anti-spam: si ya rechazamos sobre este HEAD no exponemos
        // el comment estructurado nuevo (caller se queda con `null` y NO postea).
        structured_comment: params.alreadyRejected ? null : params.structured,
        already_rejected: !!params.alreadyRejected,
        head_oid: params.headOid || null,
    };
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
    // Parsing
    parsePrDiff,
    sanitizeDiffByChunk,
    parseRejectionMarker,
    parseSignoffRecipe,

    // Verificación
    verifyPrAdherence,
    evaluateGate,

    // Format / idempotencia / anti-stale
    formatRejectionComment,
    isStaleAgainstHead,
    hasAlreadyRejected,

    // Constantes (útiles para tests)
    REJECTION_MARKER_RE,
    SIGNOFF_MARKER_RE,
};
