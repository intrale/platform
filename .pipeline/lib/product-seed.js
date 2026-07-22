'use strict';

// =============================================================================
// product-seed.js — Ejecutor de sembrado del repo de un producto nuevo (#4808)
//
// CONTEXTO
// --------
// El alta de producto (épico #4644, desacople kernel↔producto) crea un repo
// nuevo (#4800). Sin labels de admisión, el Pulpo del nuevo producto no admite
// ninguna issue → el producto "nace muerto". Este ejecutor deja el repo
// **operable de entrada**:
//   1. siembra `CLAUDE.md`/`agents.md` mínimos derivados del stack del wizard,
//   2. crea los labels base de admisión (`needs-definition`, `Ready` + los del
//      descriptor) de forma idempotente,
//   3. liga el repo a Project V2 (GraphQL) con un PAT de scope mínimo `project`.
//
// DISEÑO — Ports & Adapters (espejo de `provisioner-infra.js` · #4718)
// -------------------------------------------------------------------
// El corazón es un **driver port** `GitHubDriver` con la interfaz mínima que el
// sembrado necesita de GitHub: `putFile` / `createLabel` / `linkProjectV2`. Dos
// adapters:
//   - `createInMemoryGitHubDriver()`  — determinístico, sin red; base de tests.
//   - `createGhCliGitHubDriver({ run })` — delega en `gh api` / GraphQL vía un
//     runner inyectable `run(args, opts) => {code, stdout, stderr}` que hace
//     **spawn con args-array (nunca shell string)** — cero inyección de comandos.
//
// CONVENCIÓN DE RESULTADO (contrato §3, idéntico a `provisioner_infra`)
// --------------------------------------------------------------------
// Los errores se modelan como **datos** en el resultado
// (`status` + `diagnostics[]`), NUNCA como excepciones que crucen la frontera.
// `seedProduct()` jamás lanza. Estados:
//   - `ok`          — todo sembrado (items nuevos y/o `skipped` por idempotencia).
//   - `skipped`     — no había nada que hacer (re-run total; reservado).
//   - `human_block` — degradación por credenciales insuficientes para Project V2
//                     (CA-3): el producto queda NO operativo, requiere humano.
//   - `failed`      — falló un paso obligatorio (fail-closed CA-5): NO operativo.
//
// SEGURIDAD (5 requisitos OWASP de `security`, integrados)
// --------------------------------------------------------
//   SEC-1 prompt-injection de 2º orden: las semillas SON instrucciones que
//         ejecutan los agentes del producto. Todo dato del wizard pasa por
//         `handoff.detectInjection` + allowlist de charset antes de interpolar.
//   SEC-2 PAT: exclusivamente vía `credentials.resolveScopedRefs` (scope mínimo
//         `project`, fuente única `~/.claude/secrets/credentials.json`). Nunca
//         embebido ni logueado.
//   SEC-3 command/path injection: driver con args-array + spawn; `owner`/`repo`/
//         `slug` contra allowlist; `path` sin `..` ni `/` inicial.
//   SEC-4 fugas en diagnostics: el PAT NUNCA se escribe en `diagnostics[]`;
//         `redactScoped` para logging (sólo nombres de scope).
//   SEC-5 labels de admisión = control de acceso: la lista viene del descriptor
//         (#4803/#4807); este seeder sólo garantiza los mínimos de admisión y no
//         inyecta labels de auto-aprobación.
// =============================================================================

// -----------------------------------------------------------------------------
// Constantes del ejecutor / contrato
// -----------------------------------------------------------------------------

// Estados del resultado (contrato-kernel-adaptador §3 + degradación humana CA-3).
const STATUS = Object.freeze({
    OK: 'ok',
    FAILED: 'failed',
    SKIPPED: 'skipped',
    HUMAN_BLOCK: 'human_block',
});

// Estado operativo del producto persistido en el store del kernel (#4804).
const PRODUCT_STATUS = Object.freeze({
    OPERATIVO: 'operativo',
    NO_OPERATIVO: 'no_operativo',
});

// Labels base que el Pulpo exige para admitir issues (CA-2). El descriptor puede
// aportar más (labels de dominio, #4803/#4807); estos son el piso de admisión.
// Ownership: la lista completa la define el descriptor; acá sólo garantizamos que
// el mínimo de admisión exista para que el repo no "nazca muerto".
const REQUIRED_ADMISSION_LABELS = Object.freeze([
    { name: 'needs-definition', color: 'ededed', description: 'Requiere definición antes de desarrollo' },
    { name: 'Ready', color: 'ededed', description: 'Lista para desarrollo' },
]);

// Semillas mínimas obligatorias.
const SEED_FILES = Object.freeze(['CLAUDE.md', 'agents.md']);

// Scope mínimo del PAT para ligar Project V2 (SEC-2, menor privilegio).
const PROJECT_SCOPE = 'project';

// Allowlist de identificadores que se interpolan en comandos/paths (SEC-3).
// Owner GitHub ≤ 39, repo ≤ 100; usamos un charset común y validamos longitud
// aparte donde aplica. Rechaza espacios, `;`, `--flag`, `/../`, metacaracteres.
const SLUG_RE = /^[A-Za-z0-9._-]+$/;

// Charset de stack (se interpola en la semilla → debe ser inerte, SEC-1/SEC-3).
const STACK_RE = /^[A-Za-z0-9._-]+$/;

// Nombre de label: no vacío, ≤ 50, sin saltos de línea ni caracteres de control.
// Permisivo a propósito (GitHub admite `Ready` con mayúscula, `area:x`, etc.); el
// driver usa args-array así que no hay riesgo de inyección por el nombre.
const LABEL_NAME_RE = /^[^\x00-\x1F\x7F]{1,50}$/;

// Color de label: 6 hex (sin `#`) o vacío (default del driver).
const LABEL_COLOR_RE = /^[0-9a-fA-F]{6}$/;

// Labels que representan gates ya cumplidos o bypasses de control humano. El
// descriptor puede traer labels de dominio/admision, pero no estados de proceso.
const FORBIDDEN_GATE_LABEL_EXACT = new Set([
    'qa:passed',
    'qa:skipped',
    'recommendation:approved',
]);
const FORBIDDEN_GATE_LABEL_PATTERNS = Object.freeze([
    /^(qa|build|tester|review|po|ux|architect|security):(passed|approved|aprobado|skipped)$/i,
    /^gate[0-9_-]*:(passed|approved|aprobado|signed|firmado)$/i,
    /^auto-approved:/i,
]);

// -----------------------------------------------------------------------------
// Dependencias reusadas (inyectables para tests — nunca red en unit tests)
// -----------------------------------------------------------------------------

// Lazy require: mantiene el módulo cargable en cualquier contexto Node y permite
// inyectar fakes en tests sin mockear módulos globales.
function defaultDetectInjection() {
    return require('./handoff').detectInjection;
}
function defaultCredentials() {
    return require('./credentials');
}

// -----------------------------------------------------------------------------
// Validación del descriptor (errores como datos, NUNCA lanza)
// -----------------------------------------------------------------------------

/**
 * Valida el descriptor del producto a sembrar. Devuelve `{ ok, errors[], spec }`.
 *
 * Forma esperada del descriptor (subset del adaptador del wizard, §2):
 *   {
 *     productId?: string,          // id del producto en el store (#4804)
 *     owner: string,               // owner del repo (allowlist SEC-3)
 *     repo: string,                // repo (allowlist SEC-3)
 *     slug: string,                // slug del producto (allowlist SEC-3)
 *     name: string,                // nombre display (dato no confiable, SEC-1)
 *     stack: string,               // stack elegido (deriva la semilla)
 *     labels?: [{name,color?,description?}],  // labels de dominio (descriptor)
 *     projectV2?: { id, credentialRef, scopes? },  // target del link (CA-3)
 *     branchConvention?: string,   // dato display opcional (sanitizado)
 *   }
 *
 * @param {object} descriptor
 * @param {function} detectInjection  handoff.detectInjection (inyectable)
 * @returns {{ ok:boolean, errors:string[], spec:object|null }}
 */
function validateDescriptor(descriptor, detectInjection) {
    const errors = [];
    if (!descriptor || typeof descriptor !== 'object') {
        return { ok: false, errors: ['descriptor ausente o no es un objeto'], spec: null };
    }

    const { owner, repo, slug, stack } = descriptor;

    // SEC-3 — allowlist de identificadores antes de cualquier interpolación.
    if (typeof owner !== 'string' || !SLUG_RE.test(owner) || owner.length > 39) {
        errors.push(`owner inválido: "${owner}" (charset [A-Za-z0-9._-], ≤ 39)`);
    }
    if (typeof repo !== 'string' || !SLUG_RE.test(repo) || repo.length > 100) {
        errors.push(`repo inválido: "${repo}" (charset [A-Za-z0-9._-], ≤ 100)`);
    }
    if (typeof slug !== 'string' || !SLUG_RE.test(slug) || slug.length > 100) {
        errors.push(`slug inválido: "${slug}" (charset [A-Za-z0-9._-], ≤ 100)`);
    }
    if (typeof stack !== 'string' || !STACK_RE.test(stack) || stack.length > 50) {
        errors.push(`stack inválido: "${stack}" (charset [A-Za-z0-9._-], ≤ 50)`);
    }

    // SEC-1 — el nombre display es dato NO confiable del wizard. Se colapsa el
    // whitespace (impide inyectar estructura markdown por saltos de línea) y se
    // pasa por detectInjection. Si hay match de prompt-injection → fail-closed:
    // la semilla se RECHAZA (no se materializa una directiva maliciosa).
    let safeName = '';
    if (typeof descriptor.name !== 'string' || descriptor.name.trim() === '') {
        errors.push('name ausente o vacío');
    } else {
        const collapsed = descriptor.name.replace(/\s+/g, ' ').trim().slice(0, 100);
        const inj = detectInjection(collapsed);
        if (inj.hits && inj.hits.length > 0) {
            errors.push(
                `name contiene patrón de prompt-injection (SEC-1), rechazado: ${inj.hits.join(', ')}`,
            );
        } else {
            safeName = collapsed;
        }
    }

    // Labels de dominio del descriptor (opcionales; se unen a los de admisión).
    const domainLabels = [];
    if (descriptor.labels != null) {
        if (!Array.isArray(descriptor.labels)) {
            errors.push('labels debe ser un array de {name,color?,description?}');
        } else {
            for (const raw of descriptor.labels) {
                const l = validateLabel(raw, errors);
                if (l) domainLabels.push(l);
            }
        }
    }

    // Project V2 (opcional en forma, obligatorio para CA-3 — si falta, el paso de
    // link degrada a human_block con diagnóstico accionable, no rompe la validación).
    let projectV2 = null;
    if (descriptor.projectV2 != null) {
        const pv = descriptor.projectV2;
        if (typeof pv !== 'object') {
            errors.push('projectV2 debe ser un objeto { id, credentialRef, scopes? }');
        } else {
            projectV2 = {
                id: typeof pv.id === 'string' ? pv.id : null,
                credentialRef: typeof pv.credentialRef === 'string' ? pv.credentialRef : null,
                scopes: Array.isArray(pv.scopes) && pv.scopes.length ? pv.scopes.slice() : [PROJECT_SCOPE],
            };
        }
    }

    if (errors.length) return { ok: false, errors, spec: null };

    // Lista de labels final: admisión mínima (SEC-5) ∪ labels de dominio.
    // Los de admisión no se duplican si el descriptor ya los trae.
    const seen = new Set(domainLabels.map((l) => l.name.toLowerCase()));
    const labels = domainLabels.slice();
    for (const base of REQUIRED_ADMISSION_LABELS) {
        if (!seen.has(base.name.toLowerCase())) labels.push({ ...base });
    }

    return {
        ok: true,
        errors: [],
        spec: {
            productId: typeof descriptor.productId === 'string' ? descriptor.productId : null,
            repoFull: `${owner}/${repo}`,
            owner,
            repo,
            slug,
            stack,
            name: safeName,
            labels,
            projectV2,
        },
    };
}

/** Valida un label del descriptor. Devuelve `{name,color,description}` o null. */
function validateLabel(raw, errors) {
    if (!raw || typeof raw !== 'object') {
        errors.push('label ausente o no es un objeto');
        return null;
    }
    if (typeof raw.name !== 'string' || !LABEL_NAME_RE.test(raw.name)) {
        errors.push(`label.name inválido: "${raw && raw.name}" (1–50 chars, sin control)`);
        return null;
    }
    if (isForbiddenGateLabel(raw.name)) {
        errors.push(`label.name prohibido por SEC-5: "${raw.name}" representa un gate cumplido o bypass de control`);
        return null;
    }
    let color = '';
    if (raw.color != null) {
        const c = String(raw.color).replace(/^#/, '');
        if (!LABEL_COLOR_RE.test(c)) {
            errors.push(`label.color inválido: "${raw.color}" (6 hex)`);
            return null;
        }
        color = c.toLowerCase();
    }
    const description = typeof raw.description === 'string' ? raw.description.slice(0, 100) : '';
    return { name: raw.name, color, description };
}

function isForbiddenGateLabel(name) {
    const normalized = String(name).trim().toLowerCase();
    if (FORBIDDEN_GATE_LABEL_EXACT.has(normalized)) return true;
    return FORBIDDEN_GATE_LABEL_PATTERNS.some((pattern) => pattern.test(normalized));
}

// -----------------------------------------------------------------------------
// Semillas derivadas del stack (SEC-1: datos del wizard ya sanitizados por
// validateDescriptor antes de llegar acá)
// -----------------------------------------------------------------------------

// Descripción legible del stack para la semilla. NO hardcodea el CLAUDE.md de
// Intrale: deriva del stack elegido en el wizard. Stack desconocido → línea
// genérica con el identificador (ya validado por charset).
const STACK_DESCRIPTIONS = Object.freeze({
    'kotlin-compose': 'Kotlin Multiplatform + Compose (Android, iOS, Desktop/JVM, Web/Wasm).',
    node: 'Node.js.',
    'ktor-backend': 'Backend HTTP con Ktor (Kotlin).',
});

function stackDescription(stack) {
    return STACK_DESCRIPTIONS[stack] || `Stack \`${stack}\`.`;
}

/**
 * Construye las semillas mínimas `CLAUDE.md` / `agents.md`. El cuerpo del template
 * es texto de control del kernel; los únicos datos del wizard interpolados
 * (`name`, `slug`, `stack`) ya vienen sanitizados/allowlisted (SEC-1).
 *
 * @param {object} spec  spec validado (name/slug/stack).
 * @returns {Array<{path:string, content:string}>}
 */
function buildSeeds(spec) {
    const desc = stackDescription(spec.stack);
    const claude = [
        `# CLAUDE.md — ${spec.name}`,
        '',
        '> Repositorio generado por el alta de producto del kernel.',
        `> Producto: \`${spec.slug}\` · Stack: \`${spec.stack}\``,
        '',
        '## Stack',
        desc,
        '',
        '## Convenciones',
        '- Código: nombres en inglés.',
        '- Comentarios, docs y mensajes: español.',
        '- Ramas de agentes: `agent/<issue>-<slug>`, base `origin/main`.',
        '',
        '## Admisión del pipeline',
        'Este repositorio usa labels de admisión (`needs-definition`, `Ready`) para',
        'que el Pulpo tome issues. No borrar esos labels: sin admisión el pipeline',
        'no procesa nada.',
        '',
    ].join('\n');

    const agents = [
        `# agents.md — ${spec.name}`,
        '',
        '> Contrato mínimo para agentes automatizados del producto.',
        `> Producto: \`${spec.slug}\` · Stack: \`${spec.stack}\``,
        '',
        '## Reglas base',
        '- Trabajar siempre en ramas `agent/*` — nunca en la rama default directo.',
        '- Respetar los gates de QA antes de mergear.',
        '- Las semillas de este repo son configuración: cambios requieren revisión humana.',
        '',
    ].join('\n');

    return [
        { path: 'CLAUDE.md', content: claude },
        { path: 'agents.md', content: agents },
    ];
}

// -----------------------------------------------------------------------------
// Driver in-memory (base de tests y smoke offline)
// -----------------------------------------------------------------------------

/**
 * Driver de GitHub en memoria. Implementa el `GitHubDriver` port de forma
 * determinística y sin red. Idempotente por naturaleza: reusar la misma
 * instancia entre corridas reproduce la semántica de "ya existía → skipped".
 *
 * Opciones de test:
 *   - `seedLabels: string[]`  labels pre-existentes (fuerza `skipped` sin re-run).
 *   - `failLabels: string[]`  nombres cuyo createLabel LANZA (simula fallo CA-5).
 *   - `failFiles: string[]`   paths cuyo putFile LANZA.
 *   - `failLink: boolean`     linkProjectV2 LANZA.
 *
 * @param {object} [opts]
 * @returns {object} GitHubDriver + `_state` para introspección de tests.
 */
function createInMemoryGitHubDriver(opts = {}) {
    const files = new Map();   // `${repo}|${path}` → content
    const labels = new Map();  // repo → Set<labelName>
    const links = new Map();   // repo → Set<projectId>

    const failLabels = new Set(opts.failLabels || []);
    const failFiles = new Set(opts.failFiles || []);

    function labelSet(repo) {
        let s = labels.get(repo);
        if (!s) { s = new Set(opts.seedLabels || []); labels.set(repo, s); }
        return s;
    }

    return {
        kind: 'in-memory',

        async putFile({ repo, path, content }) {
            if (failFiles.has(path)) throw new Error(`fallo simulado putFile ${path}`);
            const k = `${repo}|${path}`;
            const existed = files.has(k);
            const same = existed && files.get(k) === content;
            files.set(k, content);
            return { path, created: !existed, existed, unchanged: same };
        },

        async createLabel({ repo, name }) {
            if (failLabels.has(name)) throw new Error(`fallo simulado createLabel ${name}`);
            const s = labelSet(repo);
            if (s.has(name)) return { name, created: false, existed: true };
            s.add(name);
            return { name, created: true, existed: false };
        },

        async linkProjectV2({ repo, projectId }) {
            if (opts.failLink) throw new Error('fallo simulado linkProjectV2');
            let s = links.get(repo);
            if (!s) { s = new Set(); links.set(repo, s); }
            const existed = s.has(projectId);
            s.add(projectId);
            return { projectId, linked: true, existed };
        },

        _state: { files, labels, links },
    };
}

// -----------------------------------------------------------------------------
// Driver gh CLI (adapter real, runner inyectable)
// -----------------------------------------------------------------------------

/**
 * Driver que delega en la GitHub CLI (`gh api` REST + GraphQL). El efecto se
 * aísla en un runner `run(args, opts) => Promise<{ code, stdout, stderr }>`:
 *   - en producción, `run` hace `spawn('gh', args, { env, shell:false })` (nunca
 *     shell string ⇒ sin inyección de comandos, SEC-3).
 *   - en test, `run` es un fake que devuelve JSON canned.
 *
 * Los identificadores (`owner`/`repo`/`slug`) ya vienen validados por
 * `validateDescriptor` (allowlist), así que no se interpolan datos crudos.
 *
 * @param {object} deps
 * @param {function} deps.run  runner del CLI (args-array).
 * @returns {object} GitHubDriver
 */
function createGhCliGitHubDriver({ run } = {}) {
    if (typeof run !== 'function') {
        throw new Error('createGhCliGitHubDriver requiere un runner `run(args, opts)`');
    }

    async function gh(args, opts) {
        const res = await run(args, opts);
        const code = res && typeof res.code === 'number' ? res.code : 0;
        const stdout = (res && res.stdout) || '';
        const stderr = (res && res.stderr) || '';
        return { code, stdout, stderr };
    }

    return {
        kind: 'gh-cli',

        async putFile({ repo, path, content }) {
            // GET del sha actual (idempotencia): si el archivo existe con el mismo
            // contenido, es no-op; si difiere, se actualiza con su sha; si no
            // existe (404), se crea. El contenido va base64 por la Contents API.
            const b64 = Buffer.from(content, 'utf8').toString('base64');
            const getRes = await gh(['api', `repos/${repo}/contents/${path}`]);
            let sha = null;
            let unchanged = false;
            if (getRes.code === 0 && getRes.stdout.trim()) {
                try {
                    const cur = JSON.parse(getRes.stdout);
                    sha = cur && cur.sha ? cur.sha : null;
                    if (cur && cur.content && String(cur.content).replace(/\s/g, '') === b64) {
                        unchanged = true;
                    }
                } catch { /* respuesta no-JSON: tratar como inexistente */ }
            }
            if (unchanged) return { path, created: false, existed: true, unchanged: true };

            const putArgs = [
                'api', '--method', 'PUT', `repos/${repo}/contents/${path}`,
                '-f', `message=chore: seed ${path} (alta de producto)`,
                '-f', `content=${b64}`,
            ];
            if (sha) putArgs.push('-f', `sha=${sha}`);
            const putRes = await gh(putArgs);
            if (putRes.code !== 0) {
                throw new Error(`putFile ${path}: ${String(putRes.stderr).trim() || `exit ${putRes.code}`}`);
            }
            return { path, created: !sha, existed: !!sha, unchanged: false };
        },

        async createLabel({ repo, name, color, description }) {
            const args = [
                'api', '--method', 'POST', `repos/${repo}/labels`,
                '-f', `name=${name}`,
            ];
            if (color) args.push('-f', `color=${color}`);
            if (description) args.push('-f', `description=${description}`);
            const res = await gh(args);
            if (res.code !== 0) {
                const raw = String(res.stderr || '').trim();
                // 422 already_exists ⇒ idempotencia (CA-4): skipped, no error.
                if (/already_exists/i.test(raw) || /HTTP 422/i.test(raw)) {
                    return { name, created: false, existed: true };
                }
                throw new Error(`createLabel ${name}: ${raw || `exit ${res.code}`}`);
            }
            return { name, created: true, existed: false };
        },

        async linkProjectV2({ repo, projectId, token }) {
            // Resolver el node_id del repo (necesario para el input del mutation).
            const idRes = await gh(['api', `repos/${repo}`, '--jq', '.node_id']);
            if (idRes.code !== 0 || !idRes.stdout.trim()) {
                throw new Error(`linkProjectV2: no se pudo resolver node_id de ${repo}: ${String(idRes.stderr).trim()}`);
            }
            const repoNodeId = idRes.stdout.trim();
            // El PAT viaja por env (GH_TOKEN), NUNCA por argv (evita fuga en
            // process listing y no queda en `diagnostics`). SEC-2/SEC-4.
            const env = token ? { GH_TOKEN: token } : undefined;
            const query = 'mutation($p:ID!,$r:ID!){linkProjectV2ToRepository(input:{projectId:$p,repositoryId:$r}){repository{id}}}';
            const res = await gh([
                'api', 'graphql',
                '-f', `query=${query}`,
                '-F', `p=${projectId}`,
                '-F', `r=${repoNodeId}`,
            ], { env });
            if (res.code !== 0) {
                const raw = String(res.stderr || '').trim();
                // Link ya existente ⇒ idempotencia (no-op).
                if (/already linked/i.test(raw) || /already exists/i.test(raw)) {
                    return { projectId, linked: true, existed: true };
                }
                throw new Error(`linkProjectV2: ${raw || `exit ${res.code}`}`);
            }
            return { projectId, linked: true, existed: false };
        },
    };
}

/**
 * Runner de producción para la GitHub CLI: `spawn('gh', args, {env, shell:false})`.
 * `args` viaja como ELEMENTOS SEPARADOS del array (nunca shell string ⇒ sin
 * inyección de comandos, SEC-3). El `opts.env` (p.ej. `{ GH_TOKEN }` para el
 * link de Project V2) se mergea sobre el env base heredado; el token NUNCA se
 * pasa por argv.
 *
 * @param {object} [deps]
 * @param {function} [deps.spawn]  inyección de child_process.spawn (tests).
 * @param {object}   [deps.baseEnv] env base (default process.env).
 * @returns {{ run: (args:string[], opts?:{env?:object}) => Promise<{code:number,stdout:string,stderr:string}> }}
 */
function createGhCliRunner(deps = {}) {
    const spawn = typeof deps.spawn === 'function' ? deps.spawn : require('child_process').spawn;
    const baseEnv = deps.baseEnv || process.env;
    return {
        run(args, opts = {}) {
            return new Promise((resolve, reject) => {
                const env = opts.env ? { ...baseEnv, ...opts.env } : baseEnv;
                const child = spawn('gh', args, { env, shell: false });
                let stdout = '';
                let stderr = '';
                if (child.stdout) child.stdout.on('data', (d) => { stdout += d; });
                if (child.stderr) child.stderr.on('data', (d) => { stderr += d; });
                child.on('error', reject);
                child.on('close', (code) => resolve({
                    code: typeof code === 'number' ? code : 0,
                    stdout,
                    stderr,
                }));
            });
        },
    };
}

// -----------------------------------------------------------------------------
// Orquestador: seedProduct
// -----------------------------------------------------------------------------

/**
 * Siembra el repo del producto y devuelve el contrato de resultado. NUNCA lanza:
 * los errores se modelan como datos (`status` + `diagnostics[]`).
 *
 * @param {object} descriptor  descriptor del wizard (ver validateDescriptor).
 * @param {object} [deps]
 * @param {object}   [deps.driver]          GitHubDriver (default: in-memory).
 * @param {function} [deps.run]             runner del gh-cli (si no se pasa driver).
 * @param {object}   [deps.store]           store del kernel (#4804) con putProduct.
 * @param {function} [deps.detectInjection] override de handoff.detectInjection.
 * @param {function} [deps.resolveScopedRefs] override de credentials.resolveScopedRefs.
 * @param {function} [deps.redactScoped]    override de credentials.redactScoped.
 * @returns {Promise<{status:string, artifacts:object[], diagnostics:object[]}>}
 */
async function seedProduct(descriptor, deps = {}) {
    const detectInjection = deps.detectInjection || defaultDetectInjection();
    const artifacts = [];
    const diagnostics = [];

    // 0. Validación del descriptor (errores como datos, fail-closed).
    const { ok, errors, spec } = validateDescriptor(descriptor, detectInjection);
    if (!ok) {
        const result = {
            status: STATUS.FAILED,
            artifacts,
            diagnostics: errors.map((e) => ({ stage: 'validate', message: e })),
        };
        await persistProductStatus(deps, descriptor, STATUS.FAILED, result.diagnostics);
        return result;
    }

    const driver = deps.driver
        || createGhCliGitHubDriver({ run: deps.run || (() => { throw new Error('falta driver o run'); }) });

    let mandatoryFailed = false;

    // 1. Semillas CLAUDE.md/agents.md (paso obligatorio → fail-closed).
    const seeds = buildSeeds(spec);
    for (const seed of seeds) {
        try {
            const r = await driver.putFile({ repo: spec.repoFull, path: seed.path, content: seed.content });
            artifacts.push({
                type: 'seed',
                path: seed.path,
                status: r && r.unchanged ? 'skipped' : (r && r.existed ? 'updated' : 'created'),
                detail: `${spec.repoFull}:${seed.path}`,
            });
        } catch (e) {
            mandatoryFailed = true;
            artifacts.push({ type: 'seed', path: seed.path, status: 'failed', detail: spec.repoFull });
            diagnostics.push({ stage: 'seed', message: `no se pudo sembrar ${seed.path}: ${errMsg(e)}` });
        }
    }

    // 2. Labels de admisión (paso obligatorio → fail-closed CA-5).
    for (const label of spec.labels) {
        try {
            const r = await driver.createLabel({
                repo: spec.repoFull, name: label.name, color: label.color, description: label.description,
            });
            artifacts.push({
                type: 'label',
                name: label.name,
                status: r && r.existed ? 'skipped' : 'created',
                detail: spec.repoFull,
            });
        } catch (e) {
            mandatoryFailed = true;
            artifacts.push({ type: 'label', name: label.name, status: 'failed', detail: spec.repoFull });
            diagnostics.push({ stage: 'label', message: `no se pudo crear el label "${label.name}": ${errMsg(e)}` });
        }
    }

    // 3. Link a Project V2 (CA-3). Sólo se intenta si los pasos obligatorios
    //    fueron OK; si degrada por credenciales/config → human_block.
    let humanBlock = false;
    if (!mandatoryFailed) {
        const linkOutcome = await linkProject(spec, driver, deps, artifacts, diagnostics);
        humanBlock = linkOutcome === 'human_block';
    } else {
        // No se intenta el link si ya falló algo obligatorio (fail-closed).
        artifacts.push({ type: 'project_v2', status: 'skipped', detail: 'no intentado: sembrado obligatorio falló' });
    }

    // Resolución del status final (precedencia: failed > human_block > ok).
    let status;
    if (mandatoryFailed) status = STATUS.FAILED;
    else if (humanBlock) status = STATUS.HUMAN_BLOCK;
    else status = STATUS.OK;

    // Persistencia del estado operativo/no-operativo en el store del kernel (#4804).
    await persistProductStatus(deps, descriptor, status, diagnostics, spec);

    return { status, artifacts, diagnostics };
}

/**
 * Intenta ligar el repo a Project V2 resolviendo el PAT por scope. Devuelve
 * `'ok'` | `'human_block'`. Muta `artifacts`/`diagnostics` como efecto.
 *
 * Contrato CA-3: si no hay projectV2 en el descriptor, o el PAT no tiene el scope
 * `project`, o falla el link por permisos → `human_block` con diagnóstico
 * accionable en español (UX-4). El PAT NUNCA se escribe en diagnostics (SEC-4).
 */
async function linkProject(spec, driver, deps, artifacts, diagnostics) {
    const pv = spec.projectV2;
    if (!pv || !pv.id) {
        artifacts.push({ type: 'project_v2', status: 'human_block', detail: 'sin projectV2 en el descriptor' });
        diagnostics.push({
            stage: 'project_v2',
            message: 'El descriptor no declara un Project V2 (`projectV2.id`) al que ligar el repo. '
                + 'El producto queda NO operativo hasta que se configure el project destino — requiere intervención humana.',
        });
        return 'human_block';
    }
    if (!pv.credentialRef) {
        artifacts.push({ type: 'project_v2', status: 'human_block', detail: 'sin credentialRef' });
        diagnostics.push({
            stage: 'project_v2',
            message: 'Falta la referencia de credencial (`projectV2.credentialRef`) para ligar Project V2. '
                + `Configurá un PAT con scope \`${PROJECT_SCOPE}\` en \`~/.claude/secrets/credentials.json\` — requiere intervención humana.`,
        });
        return 'human_block';
    }

    // SEC-2 — PAT exclusivamente vía credentials.resolveScopedRefs (scope mínimo).
    const credentials = {
        resolveScopedRefs: deps.resolveScopedRefs || defaultCredentials().resolveScopedRefs,
        redactScoped: deps.redactScoped || defaultCredentials().redactScoped,
    };
    const resolved = credentials.resolveScopedRefs(pv.credentialRef, pv.scopes);
    if (!resolved || !resolved.ok) {
        // Diagnóstico redactado: SÓLO nombres de scope, nunca valores (SEC-4).
        const redacted = credentials.redactScoped(resolved || {});
        artifacts.push({ type: 'project_v2', status: 'human_block', detail: 'PAT sin scope suficiente' });
        diagnostics.push({
            stage: 'project_v2',
            message: 'No se pudo ligar el repo a Project V2: el PAT no tiene los scopes necesarios '
                + `(faltan: ${(redacted.missing || []).join(', ') || PROJECT_SCOPE}). `
                + `Configurá un PAT con scope \`${PROJECT_SCOPE}\` org-level en \`~/.claude/secrets/credentials.json\`. `
                + 'El producto quedó NO operativo — requiere intervención humana.',
        });
        return 'human_block';
    }

    const token = resolved.scopes && resolved.scopes[PROJECT_SCOPE];
    try {
        const r = await driver.linkProjectV2({ repo: spec.repoFull, projectId: pv.id, token });
        artifacts.push({
            type: 'project_v2',
            projectId: pv.id,
            status: r && r.existed ? 'skipped' : 'linked',
            detail: spec.repoFull,
        });
        return 'ok';
    } catch (e) {
        // Fallo del link por permisos/infra → human_block (no falla silenciosa).
        // errMsg NO expone el token (viaja por env, no por argv/mensaje).
        artifacts.push({ type: 'project_v2', projectId: pv.id, status: 'human_block', detail: spec.repoFull });
        diagnostics.push({
            stage: 'project_v2',
            message: `No se pudo ligar el repo a Project V2 (${errMsg(e)}). `
                + 'Verificá que el PAT tenga permisos de escritura sobre el project org-level. '
                + 'El producto quedó NO operativo — requiere intervención humana.',
        });
        return 'human_block';
    }
}

/**
 * Persiste el estado operativo/no-operativo del producto en el store del kernel
 * (#4804) reusando `putProduct`/`sanitizeProduct`. Best-effort: si el store falla,
 * se anota un diagnostic pero no se re-lanza (errores como datos).
 *
 * `operativo` sólo si `status === ok`. `human_block`/`failed`/`skipped` ⇒ NO operativo.
 */
async function persistProductStatus(deps, descriptor, status, diagnostics, spec) {
    const store = deps.store;
    if (!store || typeof store.putProduct !== 'function') return;
    const productId = (spec && spec.productId) || (descriptor && descriptor.productId);
    if (!productId) return; // sin id no hay a quién persistir el estado.

    const operativo = status === STATUS.OK;
    const product = {
        productId,
        name: (spec && spec.name) || (descriptor && descriptor.name) || productId,
        status: operativo ? PRODUCT_STATUS.OPERATIVO : PRODUCT_STATUS.NO_OPERATIVO,
    };
    if (descriptor && typeof descriptor.descriptorRef === 'string') {
        product.descriptorRef = descriptor.descriptorRef;
    }
    try {
        await store.putProduct(product);
    } catch (e) {
        diagnostics.push({ stage: 'store', message: `no se pudo persistir el estado del producto: ${errMsg(e)}` });
    }
}

/** Extrae el mensaje de un error sin volcar objetos crudos (SEC-4). */
function errMsg(e) {
    return String(e && e.message ? e.message : e);
}

// -----------------------------------------------------------------------------
module.exports = {
    // constantes
    STATUS,
    PRODUCT_STATUS,
    REQUIRED_ADMISSION_LABELS,
    SEED_FILES,
    PROJECT_SCOPE,
    // validación / semillas
    validateDescriptor,
    buildSeeds,
    stackDescription,
    // drivers
    createInMemoryGitHubDriver,
    createGhCliGitHubDriver,
    createGhCliRunner,
    // orquestador
    seedProduct,
};
