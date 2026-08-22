// V3 Human-block helpers — estado transversal "bloqueado-humano" (issue #2478, #2549).
//
// Cualquier skill puede invocar reportHumanBlock() cuando detecte ambigüedad real
// que una intervención corta del humano resolvería. El issue queda pausado:
// no rebota, no consume tokens, hasta que se invoque unblockIssue().
//
// Marker en disco: <pipeline>/<phase>/bloqueado-humano/<issue>.<skill>
// Label GitHub: needs-human (color #B60205, ya gestionado por servicio-github)
// Eventos activity-log: human:blocked / human:unblocked
//
// #2549 — el pulpo también clasifica motivos de rechazo y, si detecta "bloqueo
// humano" (PR mergeable bloqueado por CODEOWNERS, merge manual pendiente, etc),
// llama a reportHumanBlock automáticamente en vez de relanzar el skill al infinito.
// La heurística vive en isHumanBlockReason() — extender ahí los patrones nuevos.
//
// Directiva PO (Leo, 2026-04-22): preferir acumulación de issues bloqueados antes
// que rebotes automáticos sin sentido. La eficiencia de tokens es prioritaria.

'use strict';

const fs = require('fs');
const path = require('path');
// #6226 - escritura fail-closed de dropfiles.
const dropfileWriter = require('./dropfile-writer');
const trace = require('./traceability');
const { redactAll } = require('./sherlock-audit-jsonl');
// #5337 CA-6 — discriminador compartido "recomendación de agente" vs "bloqueo real".
const { isRecommendationIssue, normalizeLabelNames } = require('./recommendation-labels');

const PIPELINE_DIR = path.join(trace.REPO_ROOT, '.pipeline');
const PIPELINES = ['desarrollo', 'definicion'];
const BLOCK_SUBDIR = 'bloqueado-humano';
const ACTIVE_STATES = ['pendiente', 'trabajando', 'listo'];
const GH_QUEUE_DIR = path.join(PIPELINE_DIR, 'servicios', 'github', 'pendiente');
const NEEDS_HUMAN_LABEL = 'needs-human';

// #2880 — encolar comando de label en la cola del servicio-github. Centralizar
// acá la aplicación del label evita que cada caller (pause-all, scripts manuales,
// pulpo en barrido) tenga que duplicar la lógica y olvide aplicarlo.
function enqueueNeedsHumanLabel(issue) {
    try {
        fs.mkdirSync(GH_QUEUE_DIR, { recursive: true });
        const filename = `${issue}-${NEEDS_HUMAN_LABEL}-block-${Date.now()}.json`;
        // #6226 - escritura fail-closed: dos bloqueos del mismo issue en el
        // mismo milisegundo resolvian al mismo path y el segundo pisaba al
        // primero. Se conserva el nombre; solo ante colision se desambigua.
        dropfileWriter.writeUniqueFileSync({
            dir: GH_QUEUE_DIR,
            filename,
            data: JSON.stringify({ action: 'label', issue: Number(issue), label: NEEDS_HUMAN_LABEL }),
            onCollision: (name, attempt) => console.warn(
                `[human-block] colision de nombre de orden github (${name}, intento ${attempt + 1}) - se reintenta, no se sobreescribe`
            ),
        });
        return true;
    } catch {
        return false;
    }
}

function emitBlocked(opts) {
    trace.appendEvent({
        event: 'human:blocked',
        skill: opts.skill || null,
        issue: Number(opts.issue) || null,
        phase: opts.phase || null,
        pipeline: opts.pipeline || null,
        reason: opts.reason || '',
        question: opts.question || '',
        ts: new Date().toISOString(),
        pid: process.pid,
    });
}

function emitUnblocked(opts) {
    trace.appendEvent({
        event: 'human:unblocked',
        skill: opts.skill || null,
        issue: Number(opts.issue) || null,
        phase: opts.phase || null,
        pipeline: opts.pipeline || null,
        target_phase: opts.target_phase || opts.phase || null,
        guidance: opts.guidance || '',
        unlocker: opts.unlocker || 'commander',
        ts: new Date().toISOString(),
        pid: process.pid,
    });
}

function emitDismissed(opts) {
    trace.appendEvent({
        event: 'human:dismissed',
        skill: opts.skill || null,
        issue: Number(opts.issue) || null,
        phase: opts.phase || null,
        pipeline: opts.pipeline || null,
        reason: opts.reason || '',
        unlocker: opts.unlocker || 'commander',
        ts: new Date().toISOString(),
        pid: process.pid,
    });
}

// Artifacts auxiliares (.reason.json metadata, .guidance.txt de destrabe humano,
// .comment.md de criterios PO, etc.) no son markers de skill. Detección
// centralizada en `lib/marker-artifact.js` (#3638 CA-F-1) — re-export para
// preservar la API histórica (`require('./human-block').isMarkerArtifact`).
const { isMarkerArtifact } = require('./marker-artifact');

function findActiveMarker(issue) {
    const prefix = String(issue) + '.';
    for (const pipeline of PIPELINES) {
        const pipeRoot = path.join(PIPELINE_DIR, pipeline);
        let phases = [];
        try { phases = fs.readdirSync(pipeRoot).filter(f => fs.statSync(path.join(pipeRoot, f)).isDirectory()); }
        catch { continue; }
        for (const phase of phases) {
            for (const state of ACTIVE_STATES) {
                const dir = path.join(pipeRoot, phase, state);
                let entries = [];
                try { entries = fs.readdirSync(dir); } catch { continue; }
                for (const f of entries) {
                    if (f.startsWith(prefix) && f !== '.gitkeep' && !isMarkerArtifact(f)) {
                        return {
                            pipeline, phase, state,
                            skill: f.slice(prefix.length),
                            file: path.join(dir, f),
                        };
                    }
                }
            }
        }
    }
    return null;
}

function findBlockedMarker(issue) {
    const prefix = String(issue) + '.';
    for (const pipeline of PIPELINES) {
        const pipeRoot = path.join(PIPELINE_DIR, pipeline);
        let phases = [];
        try { phases = fs.readdirSync(pipeRoot).filter(f => fs.statSync(path.join(pipeRoot, f)).isDirectory()); }
        catch { continue; }
        for (const phase of phases) {
            const dir = path.join(pipeRoot, phase, BLOCK_SUBDIR);
            let entries = [];
            try { entries = fs.readdirSync(dir); } catch { continue; }
            for (const f of entries) {
                if (f.startsWith(prefix) && f !== '.gitkeep' && !isMarkerArtifact(f)) {
                    return {
                        pipeline, phase,
                        skill: f.slice(prefix.length),
                        file: path.join(dir, f),
                    };
                }
            }
        }
    }
    return null;
}

function reasonFilePath(blockedFile) {
    return blockedFile + '.reason.json';
}

function guidanceFilePath(targetDir, marker) {
    return path.join(targetDir, marker + '.guidance.txt');
}

/**
 * #6296 SEC-A — canal de guidance de origen AGENTE, separado del humano.
 *
 * El `.guidance.txt` lo escribe un OPERADOR autenticado y `pulpo.js` lo inyecta
 * al prompt bajo el header "INDICACIONES HUMANAS … NO la ignores". Con el carril
 * de rebote automático de #6296 el productor deja de ser un humano y pasa a ser
 * un agente que CITA texto de issues/PRs de terceros. Reusar el mismo archivo le
 * daría a ese texto autoridad de operador: escalada de privilegio por artefacto.
 *
 * Por eso la extensión es distinta y NO hay forma de confundirlos ni por
 * accidente: son dos lecturas separadas, con dos headers separados, y el header
 * de este declara explícitamente que NO es autoritativo.
 */
function guidanceAgentFilePath(targetDir, marker) {
    return path.join(targetDir, marker + '.guidance.agent.txt');
}

// #4748 — Precondición del freeze. Dos tipos:
//   - 'human_judgment' (default, fail-closed): requiere juicio humano genuino
//     (rechazo semántico, decisión de negocio). NUNCA se auto-suelta.
//   - 'dependency': el freeze depende de que ciertos issues/PRs cierren. Es
//     objetivamente verificable → el brazo de desbloqueo lo re-evalúa cada
//     ciclo y lo suelta cuando `depends_on` está todo cerrado.
const HUMAN_JUDGMENT = { type: 'human_judgment' };

/**
 * Normaliza/valida un objeto precondition antes de persistirlo o exponerlo.
 * Cualquier forma inválida colapsa a `human_judgment` (fail-closed, SEC-4).
 * Para `dependency`, coacciona `depends_on` a enteros positivos únicos; si no
 * queda ninguno, degrada a `human_judgment` (una precondición de dependencia
 * sin dependencias no es auto-re-evaluable).
 */
function normalizePrecondition(pc) {
    if (!pc || typeof pc !== 'object') return { ...HUMAN_JUDGMENT };
    if (pc.type !== 'dependency') return { ...HUMAN_JUDGMENT };
    const raw = Array.isArray(pc.depends_on) ? pc.depends_on : [];
    const seen = new Set();
    const deps = [];
    for (const v of raw) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0 && !seen.has(n)) {
            seen.add(n);
            deps.push(n);
        }
    }
    if (deps.length === 0) return { ...HUMAN_JUDGMENT };
    return { type: 'dependency', depends_on: deps.sort((a, b) => a - b) };
}

/**
 * #4748 — Clasifica la precondición de un freeze a partir de hints
 * ESTRUCTURALES explícitos, NUNCA por extracción laxa de `#NNNN` del texto
 * libre del motivo (SEC-1). Fuentes válidas:
 *   - campo YAML `depende_de` / `precondicion_issues` de cada rechazo.
 *   - `extraDeps`: issue numbers derivados por el llamador SÓLO de la rama
 *     `source === 'structured_hint'` de `detectDependencyBlock`.
 * Ante cualquier duda → juicio humano (fail-closed).
 *
 * @param {Array<Object>} rechazados  YAMLs de rechazo (con posibles
 *   `depende_de` / `precondicion_issues`).
 * @param {Array<string|number>} [extraDeps]  deps ya validadas por hint estructural.
 * @returns {{type:'dependency',depends_on:number[]}|{type:'human_judgment'}}
 */
function classifyPrecondition(rechazados, extraDeps = []) {
    const list = Array.isArray(rechazados) ? rechazados : [];
    const deps = [];
    for (const r of list) {
        if (!r || typeof r !== 'object') continue;
        const raw = r.depende_de != null ? r.depende_de : r.precondicion_issues;
        const arr = Array.isArray(raw) ? raw : (raw != null ? [raw] : []);
        for (const v of arr) deps.push(v);
    }
    if (Array.isArray(extraDeps)) for (const v of extraDeps) deps.push(v);
    // normalizePrecondition dedup + ordena + degrada a human_judgment si vacío.
    return normalizePrecondition({ type: 'dependency', depends_on: deps });
}

function reportHumanBlock(opts) {
    const issue = Number(opts.issue);
    const skill = String(opts.skill || '').trim();
    const phase = String(opts.phase || '').trim();
    const reason = String(opts.reason || '').trim();
    const question = String(opts.question || '').trim();
    if (!issue || !skill || !phase) {
        throw new Error('reportHumanBlock requiere issue, skill, phase');
    }
    if (!reason || !question) {
        throw new Error('reportHumanBlock requiere reason y question (justificación obligatoria)');
    }

    let pipeline = opts.pipeline;
    let srcFile = null;
    if (!pipeline || opts.moveFromActive !== false) {
        const active = findActiveMarker(issue);
        if (active) {
            pipeline = pipeline || active.pipeline;
            srcFile = active.file;
        }
    }
    pipeline = pipeline || 'desarrollo';

    const targetDir = path.join(PIPELINE_DIR, pipeline, phase, BLOCK_SUBDIR);
    fs.mkdirSync(targetDir, { recursive: true });
    const marker = `${issue}.${skill}`;
    const targetFile = path.join(targetDir, marker);

    if (srcFile && fs.existsSync(srcFile)) {
        try { fs.renameSync(srcFile, targetFile); }
        catch { fs.writeFileSync(targetFile, ''); }
    } else if (!fs.existsSync(targetFile)) {
        fs.writeFileSync(targetFile, '');
    }

    // #4748 — Congelar la precondición del freeze en el momento del escalado.
    // El brazo de desbloqueo la lee de acá y JAMÁS re-deriva del body/comments
    // de GitHub (SEC-2). Default fail-closed: si el llamador no clasificó una
    // precondición estructurada → juicio humano → nunca auto-re-evaluable (SEC-4).
    const precondition = normalizePrecondition(opts.precondition);

    fs.writeFileSync(reasonFilePath(targetFile), JSON.stringify({
        issue, skill, phase, pipeline, reason, question,
        precondition,
        blocked_at: new Date().toISOString(),
    }, null, 2));

    emitBlocked({ issue, skill, phase, pipeline, reason, question });

    // #2880 — aplicar label `needs-human` en GitHub. Sin esto el intake del
    // pulpo no excluye al issue y vuelve a inyectarlo en pendiente/, dejando
    // el bloqueo inconsistente entre filesystem y GitHub.
    if (opts.skipGithubLabel !== true) {
        enqueueNeedsHumanLabel(issue);
    }

    return { issue, skill, phase, pipeline, precondition, marker_path: targetFile };
}

function listBlockedIssues() {
    const result = [];
    for (const pipeline of PIPELINES) {
        const pipeRoot = path.join(PIPELINE_DIR, pipeline);
        let phases = [];
        try { phases = fs.readdirSync(pipeRoot).filter(f => fs.statSync(path.join(pipeRoot, f)).isDirectory()); }
        catch { continue; }
        for (const phase of phases) {
            const dir = path.join(pipeRoot, phase, BLOCK_SUBDIR);
            let entries = [];
            try { entries = fs.readdirSync(dir); } catch { continue; }
            for (const f of entries) {
                if (f === '.gitkeep' || isMarkerArtifact(f)) continue;
                const dot = f.indexOf('.');
                if (dot <= 0) continue;
                const issue = Number(f.slice(0, dot));
                const skill = f.slice(dot + 1);
                if (!Number.isFinite(issue)) continue;
                const file = path.join(dir, f);
                let reason = '', question = '', blockedAt = null, precondition = null;
                try {
                    const meta = JSON.parse(fs.readFileSync(reasonFilePath(file), 'utf8'));
                    reason = meta.reason || '';
                    question = meta.question || '';
                    blockedAt = meta.blocked_at || null;
                    precondition = meta.precondition || null;
                } catch {}
                // #4748 — Markers legacy sin `precondition` (backward-compat,
                // SEC-4) o con forma inválida → default juicio humano → jamás
                // elegibles para auto-destrabe.
                precondition = normalizePrecondition(precondition);
                let mtime;
                try { mtime = fs.statSync(file).mtimeMs; } catch { mtime = Date.now(); }
                const ageHours = (Date.now() - mtime) / 3600000;
                result.push({
                    issue, skill, phase, pipeline,
                    reason, question, precondition,
                    blocked_at: blockedAt || new Date(mtime).toISOString(),
                    age_hours: Math.round(ageHours * 10) / 10,
                    marker_path: file,
                });
            }
        }
    }
    return result.sort((a, b) => b.age_hours - a.age_hours);
}

// #4653 — Labels de GitHub que implican "esperando intervención humana" pero que
// NO siempre dejan un marker en `bloqueado-humano/` (p.ej. el Commander aplica
// `blocked:routing-manual` sobre el issue sin tocar el filesystem del pipeline).
// El handler `bloqueados` los subcontaba: la lista FS no los veía y respondía
// "no hay bloqueados" aunque la tabla de la ola sí los contaba.
const GITHUB_HUMAN_BLOCK_LABELS = ['blocked:routing-manual'];

/**
 * Fusiona la lista de bloqueos del filesystem (`listBlockedIssues()`) con issues
 * que tienen labels `blocked:*` de intervención humana en GitHub. Dedup por
 * número de issue: si el issue YA está en la lista FS (contexto más rico), se
 * preserva la entrada FS y NO se duplica. Los issues que solo existen como label
 * de GitHub se agregan con metadata mínima (`skill:'—'`, `phase:'routing-manual'`).
 *
 * Función pura y determinística → testeable sin tocar red ni disco.
 *
 * @param {Array}  fsList    Salida de `listBlockedIssues()` (o subconjunto).
 * @param {Array}  ghIssues  Entradas `{ issue|number, title?, labels?, ... }`.
 * @returns {Array} Lista fusionada, dedupeada por issue.
 */
function mergeGithubBlockedLabels(fsList, ghIssues) {
    const merged = Array.isArray(fsList) ? fsList.slice() : [];
    const seen = new Set(
        merged.map((b) => Number(b && b.issue)).filter((n) => Number.isFinite(n)),
    );
    for (const gi of (Array.isArray(ghIssues) ? ghIssues : [])) {
        if (!gi) continue;
        const num = Number(gi.issue != null ? gi.issue : gi.number);
        if (!Number.isFinite(num) || seen.has(num)) continue;
        const labelNames = normalizeLabelNames(gi.labels);
        // #5337 CA-6 — las recomendaciones de agentes también llevan `needs-human`
        // pero NO son bloqueos: nadie está frenado esperando al operador, son
        // backlog esperando triaje. Medición 2026-08-01: 865 de 880 issues con
        // `needs-human` eran recomendaciones. Sin este filtro la notificación de
        // bloqueo nace ahogada en 98,3% de ruido y deja de ser señal.
        //
        // Sólo aplica a las entradas que vienen SOLO de GitHub. Un marker en
        // disco (rama `fsList`) lo crea `reportHumanBlock`, o sea que hubo un
        // agente frenado de verdad: ése no se filtra nunca.
        if (isRecommendationIssue(labelNames)) continue;
        seen.add(num);
        const blockLabel = labelNames.find((l) => GITHUB_HUMAN_BLOCK_LABELS.includes(l));
        merged.push({
            issue: num,
            skill: gi.skill || '—',
            phase: gi.phase || (blockLabel ? blockLabel.replace(/^blocked:/, '') : 'routing-manual'),
            pipeline: gi.pipeline || null,
            reason: gi.reason || gi.title || (blockLabel ? `Label ${blockLabel} en GitHub` : ''),
            question: gi.question || '',
            blocked_at: gi.blocked_at || null,
            age_hours: Number.isFinite(gi.age_hours) ? gi.age_hours : 0,
            source: 'github-label',
        });
    }
    return merged;
}

// #4231 — Colas normales de fase (no bloqueado-humano). Un marker de fase en
// cualquiera de estas colas representa trabajo del issue en esa etapa. La vista
// del pipeline las lee como "trabajo activo".
const PHASE_QUEUE_STATES = ['pendiente', 'trabajando', 'listo', 'procesado'];

// #4231 — Lista los markers de fase que viven en las colas NORMALES
// (pendiente/trabajando/listo/procesado), NO en bloqueado-humano/. Análogo a
// listBlockedIssues() pero sobre el flujo normal del pipeline.
//
// El reconciler lo usa para cerrar el hueco de markers huérfanos: cuando un
// issue cierra en GitHub, sus markers de fase en estas colas quedaban sin
// archivar (el barrido de bloqueado-humano no las mira, y el limpiador de ghost
// artifacts por diseño no toca markers de fase). Devuelve entries con la cola
// (`state`) para que el caller sepa de dónde mover el marker a archivado/.
//
// @param {object} [opts]
// @param {string[]} [opts.states] — subconjunto de colas a recorrer (default: todas).
// @returns {Array<{issue,skill,phase,pipeline,state,marker_path}>}
function listPhaseMarkers(opts = {}) {
    const states = Array.isArray(opts.states) && opts.states.length
        ? opts.states
        : PHASE_QUEUE_STATES;
    const result = [];
    for (const pipeline of PIPELINES) {
        const pipeRoot = path.join(PIPELINE_DIR, pipeline);
        let phases = [];
        try { phases = fs.readdirSync(pipeRoot).filter(f => fs.statSync(path.join(pipeRoot, f)).isDirectory()); }
        catch { continue; }
        for (const phase of phases) {
            for (const state of states) {
                const dir = path.join(pipeRoot, phase, state);
                let entries = [];
                try { entries = fs.readdirSync(dir); } catch { continue; }
                for (const f of entries) {
                    if (f === '.gitkeep' || isMarkerArtifact(f)) continue;
                    const dot = f.indexOf('.');
                    if (dot <= 0) continue;
                    const issue = Number(f.slice(0, dot));
                    const skill = f.slice(dot + 1);
                    if (!Number.isInteger(issue) || !skill) continue;
                    result.push({
                        issue, skill, phase, pipeline, state,
                        marker_path: path.join(dir, f),
                    });
                }
            }
        }
    }
    return result;
}

function unblockIssue(opts) {
    const issue = Number(opts.issue);
    if (!issue) throw new Error('unblockIssue requiere issue');
    const guidance = String(opts.guidance || '').trim();
    const unlocker = opts.unlocker || 'commander';

    const blocked = findBlockedMarker(issue);
    if (!blocked) {
        return { ok: false, error: `Issue ${issue} no está en bloqueado-humano/` };
    }

    const targetPhase = opts.target_phase || blocked.phase;
    const targetDir = path.join(PIPELINE_DIR, blocked.pipeline, targetPhase, 'pendiente');
    fs.mkdirSync(targetDir, { recursive: true });
    const marker = `${issue}.${blocked.skill}`;
    const targetFile = path.join(targetDir, marker);

    try { fs.renameSync(blocked.file, targetFile); }
    catch { fs.writeFileSync(targetFile, ''); try { fs.unlinkSync(blocked.file); } catch {} }

    if (guidance) {
        try { fs.writeFileSync(guidanceFilePath(targetDir, marker), guidance); } catch {}
    }
    try { fs.unlinkSync(reasonFilePath(blocked.file)); } catch {}

    emitUnblocked({
        issue, skill: blocked.skill, phase: blocked.phase, pipeline: blocked.pipeline,
        target_phase: targetPhase, guidance, unlocker,
    });

    return {
        ok: true, issue, skill: blocked.skill, pipeline: blocked.pipeline,
        from_phase: blocked.phase, to_phase: targetPhase, marker_path: targetFile,
    };
}

function dismissBlockedIssue(opts) {
    const issue = Number(opts.issue);
    if (!issue) throw new Error('dismissBlockedIssue requiere issue');
    const reason = String(opts.reason || '').trim();
    const unlocker = opts.unlocker || 'commander';

    const blocked = findBlockedMarker(issue);
    if (!blocked) {
        return { ok: false, error: `Issue ${issue} no está en bloqueado-humano/` };
    }

    try { fs.unlinkSync(blocked.file); } catch {}
    try { fs.unlinkSync(reasonFilePath(blocked.file)); } catch {}

    emitDismissed({
        issue, skill: blocked.skill, phase: blocked.phase, pipeline: blocked.pipeline,
        reason, unlocker,
    });

    return {
        ok: true, issue, skill: blocked.skill, pipeline: blocked.pipeline,
        phase: blocked.phase, reason,
    };
}

// #2549 — Heurística para detectar motivos de rechazo que en realidad son
// bloqueos humanos (PR esperando merge manual, CODEOWNERS, etc).
//
// El pulpo usa esto antes de procesar un rechazo como "rebote técnico". Si
// match → reportHumanBlock() en vez de incrementar rev y devolver a pendiente.
//
// Patrones literales (case-insensitive, sin regex backtracking):
const HUMAN_BLOCK_PATTERNS = [
    /\bbloqueo\s+humano\b/i,
    /\bbloqueo[-_\s]humano\b/i,
    /\bbloqueado(?:\s+por)?\s+humano\b/i,
    /\bnecesita(?:\s+intervenci[oó]n)?\s+humana?\b/i,
    /\brequiere(?:\s+intervenci[oó]n)?\s+humana?\b/i,
    /\bneeds[-_:\s]?human\b/i,
    /\bhuman[-_\s]review\s+required\b/i,
    /\bmerge\s+(?:manual|humano|bloqueado)\b/i,
    /\bmerge\s+pendiente\s+humano\b/i,
    /\bcodeowners?\b.*\b(?:bloque|merge|aprobaci|review)/i,
    /\bPR\s+#?\d+\s+(?:mergeable|esperando|pendiente)\b.*\b(?:merge|humano|review)/i,
    /\bpending\s+human\s+(?:review|merge|approval)\b/i,
    /\baprobaci[oó]n\s+humana\s+pendiente\b/i,

    // #5337 CA-3 — los 4 casos del 2026-08-01 que NO disparaban notificación.
    // Cada patrón exige la señal Y su calificador (sin resolver / bloquea /
    // pendiente): un motivo que apenas MENCIONA "seguridad" o "merge" mientras
    // describe otra cosa no debe congelar el issue. Los mismos casos también se
    // detectan por estado objetivo en `human-block-triggers.js`; estos patrones
    // cubren la vía textual, cuando el agente lo redactó en su `motivo`.

    // (1) Hallazgos de seguridad / code-scanning sin resolver.
    /\bhallazgos?\s+de\s+seguridad\b[\s\S]{0,80}?\b(?:sin\s+resolver|pendientes?|bloque)/i,
    /\bcode[-_\s]?scanning\b[\s\S]{0,80}?\b(?:sin\s+resolver|abiert|bloque)/i,
    /\bruleset\s+de\s+main\b[\s\S]{0,80}?\b(?:exige|bloque|impide)/i,

    // (2) Conflicto de merge que no se resuelve mecánicamente.
    /\bconflictos?\s+de\s+merge\b/i,
    /\bmerge\s+conflict\b/i,

    // (3) Un gate devuelve pidiendo una DECISIÓN del operador, no una corrección.
    /\bdecisi[oó]n\s+(?:del?\s+)?(?:operador|humano|negocio|producto)\b/i,
    /\brequiere\s+(?:una\s+)?decisi[oó]n\b/i,
    /\bescalar?\s+(?:la\s+)?decisi[oó]n\b/i,
    /\bcriterio\s+de\s+negocio\s+pendiente\b/i,

    // (4) Review manual exigida por CODEOWNERS / ruleset.
    /\breview\s+manual\s+(?:exigid|requerid|pendiente|obligatori)/i,
];

/**
 * Devuelve true si el motivo (string) indica un bloqueo humano.
 * Usado por pulpo.js antes de tratar el rechazo como rebote técnico.
 */
function isHumanBlockReason(motivo) {
    if (!motivo || typeof motivo !== 'string') return false;
    const txt = motivo.trim();
    if (!txt) return false;
    for (const re of HUMAN_BLOCK_PATTERNS) {
        if (re.test(txt)) return true;
    }
    return false;
}

/**
 * Genera una pregunta razonable a partir del motivo cuando el agente no la dejó
 * explícita (reportHumanBlock requiere question no vacía).
 */
function inferHumanBlockQuestion(motivo, opts = {}) {
    const m = String(motivo || '').slice(0, 280).trim();
    const skill = opts.skill ? `[${opts.skill}] ` : '';
    if (/\bPR\s+#?\d+/i.test(m)) {
        return `${skill}¿Podés mergear el PR mencionado o quitar el bloqueo de CODEOWNERS para que el pipeline siga? Detalle: ${m}`;
    }
    if (/codeowners/i.test(m)) {
        return `${skill}¿Podés revisar/aprobar este cambio? CODEOWNERS está pidiendo intervención humana. Detalle: ${m}`;
    }
    return `${skill}¿Podés revisar este bloqueo y darnos orientación? Detalle: ${m}`;
}

/**
 * Construye un texto Markdown listando TODOS los bloqueados (Telegram-friendly).
 * Usado al notificar un nuevo bloqueo: además del incidente nuevo, mostramos
 * el panorama completo de qué requiere intervención humana.
 *
 * #5337 CA-2 — el mensaje tiene que decir las TRES cosas: qué issue, qué se
 * necesita del operador, y qué opciones hay con la recomendación del pipeline
 * cuando exista. Faltaba la recomendación: se agrega como bloque `💡`, y se
 * omite entero si no hay (guideline UX: nunca escribir "sin recomendación",
 * que ocupa una línea para no decir nada).
 *
 * Las opciones concretas las ejecuta la botonera (`buildBlockedActionMarkup`):
 * acá el texto DESCRIBE, los botones EJECUTAN. No se enumera un set de opciones
 * en el texto que pueda contradecir a los botones.
 *
 * @param {object} opts
 * @param {object} [opts.highlight] — Issue recién bloqueado a destacar al inicio.
 * @param {Array}  [opts.blocked]   — Lista (default: listBlockedIssues()).
 * @param {string} [opts.highlight.recommendation] — Recomendación del pipeline (#5337).
 */
function buildBlockedSummaryMarkdown(opts = {}) {
    return renderBlockedSummary(opts, { plain: false });
}

/**
 * Igual que `buildBlockedSummaryMarkdown` pero en TEXTO PLANO, sin un solo
 * metacarácter de markup emitido por nosotros (#5421, decisión del operador
 * 2026-08-06).
 *
 * **Por qué existe (leer antes de "mejorarlo" volviendo a Markdown).**
 * Esta alerta es el aviso de `needs-human`: el mensaje que le dice al operador
 * que el pipeline se detuvo y necesita una decisión. Si se pierde, el pipeline
 * queda parado sin que nadie lo sepa. Enviado con `parse_mode: 'Markdown'`, se
 * perdía por HTTP 400 de Telegram cada vez que el markup quedaba mal balanceado,
 * y el saliente es fire-and-forget vía dropfile (`pulpo.js` no ve el 400: el
 * `catch` de fallback nunca corre y `markNotified` sella el dedup 24h igual, así
 * que la alerta se pierde SIN RASTRO).
 *
 * Se intentó cerrarlo escapando/saneando durante seis ciclos de QA y siempre
 * quedó una vía: además de los metacaracteres que venían en el email del
 * committer (input no confiable, ya acotado por CA-11/CA-12), los `slice(280)` y
 * `slice(160)` de esta función pueden cortar el texto EN EL MEDIO de un code
 * span y dejar paridad impar de backticks con un email perfectamente válido y
 * benigno (verificado en el barrido del ciclo 6: 11 de 15 largos válidos rompían
 * la paridad, y el propio control `backend-dev-agent@intrale` la rompía en el
 * listado). El truncado no se puede "escapar": es un corte posicional.
 *
 * Por eso la decisión no es escapar mejor, es **no depender del formato**: sin
 * `parse_mode` no hay nada que Telegram pueda rechazar, y el peor caso de un
 * truncado infeliz es cosmético (una línea cortada) en vez de la pérdida total
 * del aviso. El énfasis visual (negritas/itálicas) es un lujo que un aviso
 * crítico no puede pagar con su propia entrega.
 *
 * El caller DEBE enviarlo con `{ plain: true }` para que no se agregue
 * `parse_mode`; si se envía como Markdown, el texto igual es seguro (no emitimos
 * markup) pero pierde sentido el ejercicio.
 *
 * @param {object} opts — misma forma que `buildBlockedSummaryMarkdown`.
 * @returns {string} texto plano listo para `sendTelegram*(..., { plain: true })`.
 */
function buildBlockedSummaryPlain(opts = {}) {
    return renderBlockedSummary(opts, { plain: true });
}

/**
 * Implementación compartida de los dos renderers. `plain:true` omite todo
 * markup; `plain:false` conserva byte por byte el formato histórico (los tests
 * de no-regresión de #4068/#5337 siguen apuntando a ese dialecto).
 *
 * Se resuelve con un helper por decoración en vez de dos funciones paralelas
 * para que el CONTENIDO no pueda divergir entre dialectos: un dato nuevo se
 * agrega una sola vez y aparece en los dos.
 */
function renderBlockedSummary(opts, { plain }) {
    const blocked = Array.isArray(opts.blocked) ? opts.blocked : listBlockedIssues();
    const highlight = opts.highlight || null;
    // Decoradores: en plano son la identidad, así que el texto sale sin `*`, `_`
    // ni backticks — nada que Telegram tenga que parsear.
    const b = (s) => (plain ? s : `*${s}*`);
    const i = (s) => (plain ? s : `_${s}_`);
    const code = (s) => (plain ? s : `\`${s}\``);
    const lines = [];

    if (highlight) {
        const tag = highlight.skill ? ` (${highlight.skill})` : '';
        lines.push(`🚧 ${b(`Issue #${highlight.issue}${tag} marcado como needs-human`)}`);
        if (highlight.reason) {
            lines.push(`📝 ${String(highlight.reason).slice(0, 280)}`);
        }
        if (highlight.question) {
            lines.push(`❓ ${String(highlight.question).slice(0, 280)}`);
        }
        // #5337 CA-2 — recomendación del pipeline. Sólo si existe.
        const reco = String(highlight.recommendation || '').trim();
        if (reco) {
            lines.push(`💡 ${b('Recomendación:')} ${reco.slice(0, 280)}`);
        }
        lines.push('');
    }

    if (!blocked.length) {
        lines.push(i('(sin otros incidentes bloqueados actualmente)'));
        return lines.join('\n');
    }

    lines.push(`📋 ${b('Incidentes bloqueados esperando humano')} (${blocked.length})`);
    for (const bl of blocked) {
        const ageStr = bl.age_hours < 1
            ? `${Math.max(1, Math.round(bl.age_hours * 60))}min`
            : `${Math.round(bl.age_hours)}h`;
        lines.push(`• ${b(`#${bl.issue}`)} — ${bl.skill} en ${bl.phase} ${i(`(${ageStr})`)}`);
        const detail = (bl.question || bl.reason || '').toString().trim();
        if (detail) lines.push(`   ↳ ${detail.slice(0, 160)}`);
    }
    lines.push('');
    lines.push(`${i('Usá')} ${code('/unblock <issue> <orientación>')} ${i('para desbloquear.')}`);
    return lines.join('\n');
}

// =============================================================================
// #4068 — Botones de acción rápida en la alerta de needs-human (Opción A).
//
// Metadata de las 4 acciones que SÍ cierran el ciclo del bloqueo. `pausar` queda
// FUERA por decisión de producto (PO #4068): no resuelve el bloqueo, solo lo
// congela, y la pausa global ya tiene su propio mecanismo.
//
// Orden del teclado 2×2 (guideline UX #4068): acción positiva/segura arriba-
// izquierda; la de mayor impacto (devolver a definición, descarta trabajo) abajo.
// =============================================================================
const ACTION_META = Object.freeze({
    'unblock':             { emoji: '✅', label: 'Aprobar (unblock)',     highImpact: false,
        consequence: 'Vas a desbloquear el issue y devolverlo a la cola del pipeline.' },
    'mas-contexto':        { emoji: '💬', label: 'Pedir contexto',        highImpact: false,
        consequence: 'Vas a pedir más contexto; el issue queda bloqueado hasta que respondas.' },
    'devolver-definicion': { emoji: '↩️', label: 'Devolver a definición', highImpact: true,
        consequence: 'Vas a devolver el issue a definición. Se descarta el trabajo de desarrollo en curso y vuelve a re-analizarse.' },
    'priorizar':           { emoji: '⬆️', label: 'Priorizar',            highImpact: false,
        consequence: 'Vas a subir la prioridad de este issue y desbloquearlo.' },
});
// Filas del teclado (2×2). Single source para markup y validación de cobertura.
const ACTION_KEYBOARD_ROWS = Object.freeze([
    ['unblock', 'mas-contexto'],
    ['devolver-definicion', 'priorizar'],
]);
const HUMAN_BLOCK_ACTIONS = Object.freeze(ACTION_KEYBOARD_ROWS.flat());

// #5923 — namespace de `callback_data` cuando el botón degrada de `url` a
// callback. Single source: lo usan el emisor (buildBlockedActionMarkup) y el
// router (`.claude/hooks/commander/callback-handler.js`).
const HUMAN_BLOCK_CALLBACK_PREFIX = 'hb';

function isQuickAction(action) {
    return HUMAN_BLOCK_ACTIONS.includes(action);
}

// Encolar una orden genérica en la cola del servicio-github (label / remove-label
// / comment). Generaliza enqueueNeedsHumanLabel. Fire-and-forget vía filesystem:
// nunca bloquea ni invoca `gh` en proceso (regla "el pipeline no puede morir").
function enqueueGithub(action, payload = {}) {
    try {
        fs.mkdirSync(GH_QUEUE_DIR, { recursive: true });
        const issue = Number(payload.issue);
        const rnd = Math.random().toString(36).slice(2, 8);
        const filename = `${issue}-${action}-hb-${Date.now()}-${rnd}.json`;
        fs.writeFileSync(
            path.join(GH_QUEUE_DIR, filename),
            JSON.stringify({ ...payload, action, issue }),
        );
        return true;
    } catch {
        return false;
    }
}

/**
 * #4068 / CA-1 — Construye el `reply_markup` (inline_keyboard 2×2) con los 4
 * botones de acción rápida sobre un issue bloqueado.
 *
 * #5923 — El modo de emisión ya NO es siempre `url`. La decisión la centraliza
 * `telegram-button-url.js`:
 *
 *   - Dashboard público (`https:`) Y habilitado en `DASHBOARD_PUBLIC_HOSTS`
 *     ⇒ botón `url` con token HMAC, exactamente como antes (sin regresión).
 *   - Cualquier otra cosa (el default `http://localhost:3200`, una IP literal,
 *     un host interno, `http://` pelado) ⇒ botón `callback_data` con prefijo
 *     `hb:`, que resuelve NUESTRO propio host vía listener → callback-handler.
 *
 * En el camino degradado `actionToken.sign()` NO se invoca (CA-7): firmar una
 * capability que no se va a usar es superficie muerta, y volcar esa URL en el
 * mensaje sería una fuga de secreto. `buildUrl` sólo lo llama el helper cuando
 * el modo `url` está realmente habilitado.
 *
 * NO cambia la firma de buildBlockedSummaryMarkdown (CA-Q1) — es un helper
 * aparte. Si no queda ningún botón emitible devuelve `undefined`: el caller
 * manda igual el resumen de texto, solo sin botones (degradación con gracia,
 * nunca rompe la notificación).
 *
 * @param {number} issue
 * @param {object} [opts]
 * @param {object} [opts.actionToken]   - módulo de token (inyectable en tests).
 * @param {string} [opts.dashboardUrl]  - base URL del dashboard.
 * @param {string[]|string|null} [opts.hostAllowlist] - override de DASHBOARD_PUBLIC_HOSTS.
 * @returns {object|undefined} `{ inline_keyboard: [...] }` o undefined.
 */
function buildBlockedActionMarkup(issue, opts = {}) {
    const i = Number(issue);
    if (!Number.isInteger(i) || i <= 0 || i > 999999) return undefined;

    let buttonUrl;
    try { buttonUrl = opts.buttonUrl || require('./telegram-button-url'); }
    catch { return undefined; }

    const dashUrl = (opts.dashboardUrl || process.env.DASHBOARD_URL || 'http://localhost:3200').replace(/\/+$/, '');

    const rows = ACTION_KEYBOARD_ROWS.map((row) => row
        .map((action) => {
            const meta = ACTION_META[action];
            if (!meta) return null;
            return { action, text: `${meta.emoji} ${meta.label}`, issue: i };
        })
        .filter(Boolean));

    // Lazy: el módulo de token sólo se resuelve si realmente vamos por `url`.
    let actionToken = null;
    const built = buttonUrl.buildActionKeyboard(rows, {
        dashboardUrl: dashUrl,
        callbackPrefix: HUMAN_BLOCK_CALLBACK_PREFIX,
        hostAllowlist: opts.hostAllowlist,
        buildUrl: (action, iss) => {
            if (!actionToken) actionToken = opts.actionToken || require('./action-token');
            const token = actionToken.sign({ issue: Number(iss), action });
            if (!token) return null;
            return `${dashUrl}/?action=${action}&issue=${iss}&token=${encodeURIComponent(token)}`;
        },
    });
    return built.markup;
}

// Reactiva TODOS los markers bloqueados de un issue (un issue puede tener varios
// skills pausados en paralelo). Idempotente: si no hay ninguno, no-op.
function reactivateAllBlocked(issue, opts = {}) {
    const unblock = opts.unblockIssue || unblockIssue;
    const reactivated = [];
    for (let k = 0; k < 20; k++) {
        let r;
        try { r = unblock({ issue, guidance: opts.guidance || '', unlocker: opts.unlocker || 'human-block-action' }); }
        catch { break; }
        if (!r || !r.ok) break;
        reactivated.push(r);
    }
    return reactivated;
}

/**
 * #4068 / CA-2 — Ejecuta la acción rápida sobre el issue. Mutaciones vía la cola
 * del servicio-github (no `gh` en proceso). Idempotente / state-checked: si el
 * issue ya no está bloqueado, las acciones que dependen del bloqueo son no-op
 * (link viejo / doble-click = no-op, SEC-5).
 *
 * NO autoriza: el caller (handler dashboard con token válido, o commander con
 * allowlist de operadores) decide autorización ANTES de invocar.
 *
 * @param {object} args
 * @param {number} args.issue
 * @param {string} args.action  - una de HUMAN_BLOCK_ACTIONS.
 * @param {object} [args.deps]  - overrides para tests.
 * @returns {{ok:boolean, action?:string, issue?:number, msg?:string, error?:string}}
 */
function executeQuickAction({ issue, action, deps = {} } = {}) {
    const i = Number(issue);
    if (!Number.isInteger(i) || i <= 0 || i > 999999) return { ok: false, error: 'issue inválido' };
    if (!isQuickAction(action)) return { ok: false, error: 'action inválida' };

    const enqueue = deps.enqueueGithub || enqueueGithub;
    const findBlocked = deps.findBlockedMarker || findBlockedMarker;
    const dismiss = deps.dismissBlockedIssue || dismissBlockedIssue;
    const reactivate = (extra) => reactivateAllBlocked(i, { ...deps, ...extra });

    // #5690 SEC-B — el guardrail de `servicio-github.js` rechaza toda orden de
    // cola que remueva `needs-human` sin procedencia declarada. Estas acciones
    // SÍ la tienen: `executeQuickAction` sólo se invoca después de que el
    // caller autorizó (token HMAC de la alerta de Telegram, o allowlist de
    // operadores del commander). Sin este marcador, los botones de destrabe
    // dejarían de funcionar.
    const procedencia = {
        guardrail_authorized: true,
        authorized_by: `human-block:${action}`,
    };

    switch (action) {
        case 'unblock': {
            const reactivated = reactivate({ unlocker: 'human-block-action:unblock' });
            enqueue('remove-label', { issue: i, label: NEEDS_HUMAN_LABEL, ...procedencia });
            if (reactivated.length === 0) {
                return { ok: true, action, issue: i, noop: true, msg: `#${i} ya no estaba bloqueado (acción ya resuelta).` };
            }
            enqueue('comment', { issue: i, body: `## ✅ Desbloqueado desde la alerta de Telegram\n\nSkills reactivados: ${reactivated.map((r) => `\`${r.skill}\``).join(', ')}. Vuelve a la cola del pipeline.` });
            return { ok: true, action, issue: i, reactivated: reactivated.length, msg: `#${i} desbloqueado (${reactivated.length} skill${reactivated.length === 1 ? '' : 's'}).` };
        }
        case 'mas-contexto': {
            // Mantiene el bloqueo; registra el pedido de contexto.
            enqueue('comment', { issue: i, body: `## 💬 Se pidió más contexto\n\nUn humano pidió más contexto desde la alerta de Telegram. El issue queda en \`needs-human\` hasta que se responda.` });
            return { ok: true, action, issue: i, msg: `Se pidió más contexto en #${i}; queda bloqueado.` };
        }
        case 'devolver-definicion': {
            const blocked = findBlocked(i);
            let dismissed = false;
            if (blocked) {
                try { const r = dismiss({ issue: i, reason: 'Devuelto a definición desde la alerta de Telegram', unlocker: 'human-block-action:devolver' }); dismissed = !!(r && r.ok); }
                catch { /* best-effort */ }
            }
            enqueue('remove-label', { issue: i, label: NEEDS_HUMAN_LABEL, ...procedencia });
            enqueue('label', { issue: i, label: 'needs-definition' });
            enqueue('comment', { issue: i, body: `## ↩️ Devuelto a definición\n\nUn humano devolvió #${i} a definición desde la alerta de Telegram. Se descarta el trabajo de desarrollo en curso y el issue vuelve a re-analizarse.` });
            return { ok: true, action, issue: i, dismissed, msg: `#${i} devuelto a definición.` };
        }
        case 'priorizar': {
            // Sube prioridad Y desbloquea (PO #4068: "sube prioridad y sigue").
            const reactivated = reactivate({ unlocker: 'human-block-action:priorizar' });
            // #4371 CA-3 — la mutación del label priority:* pasa por el punto
            // único `setPriorityLabel`, que además emite el audit `priority_changed`.
            // El actor es el subsistema que ejecutó la acción autorizada (el humano
            // ya se autenticó vía token HMAC upstream); `deps.actor` permite
            // sobreescribirlo si el caller lo propaga.
            const setPriorityLabel = (deps.setPriorityLabel || require('./priority-label').setPriorityLabel);
            setPriorityLabel({
                issue: i,
                priority: 'priority:high',
                enqueue,
                actor: deps.actor || 'human-block:priorizar',
                note: 'Prioridad elevada desde la alerta de Telegram',
            });
            enqueue('remove-label', { issue: i, label: NEEDS_HUMAN_LABEL, ...procedencia });
            enqueue('comment', { issue: i, body: `## ⬆️ Prioridad elevada\n\nUn humano subió la prioridad de #${i} a \`priority:high\` desde la alerta de Telegram${reactivated.length ? ' y lo desbloqueó' : ''}.` });
            return { ok: true, action, issue: i, reactivated: reactivated.length, msg: `Prioridad de #${i} elevada a priority:high.` };
        }
        default:
            return { ok: false, error: 'action inválida' };
    }
}

/**
 * #4068 / CA-SEC-2 — Asienta la acción rápida (autorizada o rechazada) en un
 * audit-log dedicado `audit/human-block-actions-YYYY-MM-DD.jsonl`. Nunca lanza:
 * el audit no debe romper la operación.
 */
function auditQuickAction(entry = {}) {
    try {
        const deps = entry.deps || {};
        const dir = deps.auditDir || path.join(PIPELINE_DIR, 'audit');
        const createAuditLog = deps.createAuditLog || require('./commander/audit-log').createAuditLog;
        let redact = deps.redact;
        if (typeof redact !== 'function') {
            try { redact = require('./redact').redactSensitive; } catch { redact = (s) => s; }
        }
        const audit = createAuditLog({
            dir,
            filenamePrefix: 'human-block-actions',
            redact,
            // #4631 — campos de delegación para reconstrucción forense: quién actuó
            // (delegate), en nombre de quién (grantor), sobre qué grant (grant_nonce)
            // y si el uso fue delegado. Strings pasan por el redactor; `delegated` es
            // booleano. NUNCA se reflejan en la respuesta HTTP/Telegram (solo audit).
            extraFields: [
                'issue', 'action', 'remote_address', 'message_id',
                'delegated', 'delegate', 'grantor', 'grant_nonce',
            ],
        });
        return audit.record({
            from: entry.from || null,
            chat_id: entry.chat_id,
            raw_command: entry.action ? `/${entry.action} ${entry.issue || ''}`.trim() : '',
            intent_class: 'human-block-action',
            handler: entry.action || null,
            result_status: entry.result_status || 'ok',
            duration_ms: entry.duration_ms,
            issue: Number.isFinite(Number(entry.issue)) ? Number(entry.issue) : null,
            action: entry.action || null,
            remote_address: entry.remote_address || null,
            message_id: entry.message_id || null,
            // Delegación (#4631): sólo presentes cuando el uso pasó por el gate delegado.
            delegated: entry.delegated === true,
            delegate: entry.delegate || null,
            grantor: entry.grantor || null,
            grant_nonce: entry.grant_nonce || null,
        });
    } catch (e) {
        try { process.stderr.write(`[human-block] auditQuickAction falló: ${e.message}\n`); } catch (_) {}
        return null;
    }
}

/**
 * Construye el guion narrable corto (español) para el audio TTS de la alerta
 * `needs-human` (issue #4067, split de #4050). Único lugar donde vive la
 * redacción explícita del texto fuente y el armado del guion.
 *
 * SEC-3: `reason` y `question` crudos pasan por `redactAll` ANTES de armar el
 * texto y ANTES de cualquier síntesis de voz aguas abajo. Un secreto sintetizado
 * en audio no se puede redactar después; `sanitizeForTts` del adapter es defensa
 * en profundidad, NO sustituto de esta llamada.
 *
 * G-2 (UX): el guion arranca SIEMPRE con el encabezado fijo de alerta, que
 * funciona como "earcon verbal" reconocible. No se parametriza por issue.
 * G-3 (UX): orden narrativo fijo (alerta → motivo → decisión) y cap de longitud
 * para que el audio se escuche de corrido sin fatiga. Degrada a alerta mínima si
 * el input viene vacío/parcial (mejor un alerta genérico que un audio roto).
 *
 * @param {object} opts
 * @param {string} [opts.reason]   — Motivo crudo del bloqueo.
 * @param {string} [opts.question] — Decisión/pregunta cruda que requiere humano.
 * @returns {string} Guion narrable, redactado y acotado (≤ 600 chars).
 */
function buildNeedHumanAudioText({ reason, question, recommendation } = {}) {
    const motivo = redactAll(String(reason || '').trim());
    const decision = redactAll(String(question || '').trim());
    // #5337 CA-2 — la recomendación también se narra. El audio es el canal que
    // funciona cuando el operador no está mirando la pantalla; si el texto le
    // dice qué le conviene hacer y el audio no, el audio queda a medias.
    // Va ÚLTIMA y es lo primero que se recorta si el guion excede el cap: el
    // orden narrativo fijo (alerta → motivo → decisión) no se altera (G-3).
    const sugerencia = redactAll(String(recommendation || '').trim());
    const partes = [];
    if (motivo) partes.push(`El motivo del bloqueo es: ${motivo}.`);
    if (decision) partes.push(`La decisión que necesitamos es: ${decision}.`);
    if (sugerencia) partes.push(`Sugerencia del pipeline: ${sugerencia}.`);
    const cuerpo = partes.length ? ` ${partes.join(' ')}` : '';
    return `Atención: un issue requiere intervención humana.${cuerpo}`.slice(0, 600);
}

/**
 * Orquesta el envío best-effort del audio TTS de la alerta needs-human (#4067).
 * Dependencias inyectadas (multimedia/credenciales) para mantener este módulo
 * libre de la cadena pesada de `multimedia.js` y para que el flujo sea testeable.
 *
 * SEC-4: NUNCA lanza. Cualquier error (TTS/timeout/red) queda contenido y se
 * devuelve en el resultado. El call-site ya envió el texto antes de llamar acá,
 * así que una falla de audio jamás rompe la notificación de texto ni el barrido.
 * SEC-3: la redacción del texto fuente ocurre dentro de `buildNeedHumanAudioText`.
 *
 * NOTA SEC-5: este helper NO conoce el estado de bloqueo; la idempotencia la
 * garantiza el call-site invocándolo SOLO dentro del gate `if (!yaBloqueado)`.
 *
 * @param {object} deps
 * @param {string} [deps.reason]
 * @param {string} [deps.question]
 * @param {string} [deps.profile='need-human']
 * @param {string} [deps.botToken]
 * @param {string} [deps.chatId]
 * @param {function} [deps.textToSpeechWithMeta] — (text, {profile}) => Promise<{buffer}>
 * @param {function} [deps.sendVoiceTelegram]    — (buffer, token, chatId) => Promise<boolean>
 * @returns {Promise<{sent: boolean, skipped?: string, error?: string}>}
 */
async function sendNeedHumanAudio(deps = {}) {
    const {
        reason, question, recommendation, profile = 'need-human',
        botToken, chatId, textToSpeechWithMeta, sendVoiceTelegram,
    } = deps;
    try {
        if (!botToken || !chatId) return { sent: false, skipped: 'no-credentials' };
        if (typeof textToSpeechWithMeta !== 'function' || typeof sendVoiceTelegram !== 'function') {
            return { sent: false, skipped: 'no-tts' };
        }
        const audioText = buildNeedHumanAudioText({ reason, question, recommendation });
        const meta = await textToSpeechWithMeta(audioText, { profile });
        if (!meta || !meta.buffer) return { sent: false, skipped: 'no-buffer' };
        const ok = await sendVoiceTelegram(meta.buffer, botToken, chatId);
        return { sent: !!ok };
    } catch (e) {
        return { sent: false, error: e && e.message ? e.message : String(e) };
    }
}

module.exports = {
    reportHumanBlock,
    unblockIssue,
    dismissBlockedIssue,
    listBlockedIssues,
    mergeGithubBlockedLabels,
    GITHUB_HUMAN_BLOCK_LABELS,
    listPhaseMarkers,
    PHASE_QUEUE_STATES,
    findActiveMarker,
    findBlockedMarker,
    isHumanBlockReason,
    inferHumanBlockQuestion,
    classifyPrecondition,
    normalizePrecondition,
    buildBlockedSummaryMarkdown,
    buildBlockedSummaryPlain,
    buildNeedHumanAudioText,
    sendNeedHumanAudio,
    enqueueNeedsHumanLabel,
    HUMAN_BLOCK_PATTERNS,
    PIPELINE_DIR,
    PIPELINES,
    BLOCK_SUBDIR,
    NEEDS_HUMAN_LABEL,
    isMarkerArtifact,
    // #4068 — acciones rápidas de needs-human
    ACTION_META,
    ACTION_KEYBOARD_ROWS,
    HUMAN_BLOCK_ACTIONS,
    // #5923 — prefijo de callback_data del camino degradado.
    HUMAN_BLOCK_CALLBACK_PREFIX,
    isQuickAction,
    enqueueGithub,
    buildBlockedActionMarkup,
    executeQuickAction,
    auditQuickAction,
    // #5337 — discriminador recomendación vs bloqueo real (CA-6). Re-export del
    // módulo compartido para que los consumidores de human-block no tengan que
    // conocer un segundo módulo sólo para filtrar ruido.
    isRecommendationIssue,
    normalizeLabelNames,
    // #6296 SEC-A — canales de guidance: humano (autoritativo) vs agente (dato).
    guidanceFilePath,
    guidanceAgentFilePath,
};
