'use strict';

// =============================================================================
// #6496 rev-2 — El GATE 3 corre en el CAMINO REAL de la fase `entrega`.
//
// QUÉ ARREGLA ESTE ARCHIVO
// -----------------------------------------------------------------------------
// La rev anterior implementó el gate sólo en `.pipeline/delivery.js` y lo probó
// sólo ahí. Ese archivo NO es el camino de la fase `entrega`: la fase corre el
// skill determinístico `.pipeline/skills-deterministicos/delivery.js`
// (`DETERMINISTIC_SKILLS` en `lib/agent-launcher/providers/deterministic.js`).
// Resultado: 100 tests en verde y, en producción, un veredicto de QA caduco se
// integraba igual mientras `drenarRequeueVerificacion` quedaba inerte.
//
// Por eso acá NO se testea una función aislada: se ejercita el archivo que el
// pipeline ejecuta de verdad, con `spawnSync` sobre repos git REALES, y se deja
// un guardián de regresión que falla si ese archivo pierde el chequeo.
//
// NINGÚN test escribe en GitHub. El remoto de los fixtures es un repo bare en
// `os.tmpdir()` y `GH_REPO` apunta a un repo inexistente, así que toda llamada a
// `gh` falla de forma inocua (mismo criterio que la suite hermana, #6496 rev-1).
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const yaml = require('js-yaml');

const seal = require('../qa-evidence-seal');
const freshnessGate = require('../delivery/freshness-gate');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SKILL_DELIVERY = path.join(REPO_ROOT, '.pipeline', 'skills-deterministicos', 'delivery.js');
const CLI_DELIVERY = path.join(REPO_ROOT, '.pipeline', 'delivery.js');
const PULPO_JS = path.join(REPO_ROOT, '.pipeline', 'pulpo.js');

const HEAD_FALSO = 'a'.repeat(40);

// Número FUERA del rango de issues reales del repo: ningún fixture puede
// nombrar un issue vivo (lección del rebote de `security` en rev-1).
const ISSUE_FIXTURE = 999496;
const BRANCH_FIXTURE = `agent/${ISSUE_FIXTURE}-pipeline-dev`;

// `gh` no puede resolver este repo, así que cualquier llamada falla sin efecto.
const REPO_INEXISTENTE = 'intrale/no-existe-test-999496';

function tmpDir(prefijo) {
    return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefijo));
}

/**
 * Worktree del agente: repo git real, con remoto bare, parado en
 * `agent/<issue>-pipeline-dev` y con un commit por delante de `origin/main`
 * (que es lo que el skill exige para no caer al early-exit de "entrega previa").
 */
function crearWorktree() {
    const dir = tmpDir('seal-entrega-');
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
    execFileSync('git', ['init', '-q', '-b', 'main', dir], { encoding: 'utf8', windowsHide: true });
    git('config', 'user.email', 'pipeline@intrale.test');
    git('config', 'user.name', 'pipeline');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'uno');
    git('add', '.');
    git('commit', '-q', '-m', 'commit inicial');

    const remoto = tmpDir('seal-entrega-remote-');
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', remoto], { windowsHide: true });
    git('remote', 'add', 'origin', remoto);
    git('push', '-q', 'origin', 'main');

    git('checkout', '-q', '-b', BRANCH_FIXTURE);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'dos');
    git('add', '.');
    git('commit', '-q', '-m', 'feat: cambio por delante de main');

    return { dir, remoto, git, head: git('rev-parse', 'HEAD').trim() };
}

/** Estructura mínima del `.pipeline/` de ESTADO (el del repo principal). */
function crearEstado() {
    const dir = tmpDir('seal-entrega-state-');
    for (const fase of ['verificacion', 'entrega']) {
        for (const sub of ['procesado', 'pendiente', 'trabajando', 'listo', 'archivado']) {
            fs.mkdirSync(path.join(dir, 'desarrollo', fase, sub), { recursive: true });
        }
    }
    fs.mkdirSync(path.join(dir, 'servicios', 'github', 'pendiente'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    return dir;
}

function escribirVeredicto(estado, data) {
    const file = path.join(estado, 'desarrollo', 'verificacion', 'procesado', `${ISSUE_FIXTURE}.qa`);
    fs.writeFileSync(file, yaml.dump(data, { lineWidth: -1 }));
    return file;
}

function crearMarker(estado) {
    const file = path.join(estado, 'desarrollo', 'entrega', 'trabajando', `${ISSUE_FIXTURE}.delivery`);
    fs.writeFileSync(file, `issue: ${ISSUE_FIXTURE}\nfase: entrega\npipeline: desarrollo\n`, 'utf8');
    return file;
}

function leerMarker(file) {
    const out = {};
    for (const ln of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = ln.match(/^([\w_]+)\s*:\s*(.*)$/);
        if (!m) continue;
        let v = m[2].trim();
        if (v.startsWith('"') && v.endsWith('"')) { try { v = JSON.parse(v); } catch { /* literal */ } }
        out[m[1]] = v;
    }
    return out;
}

function ordenesRequeue(estado) {
    const dir = path.join(estado, ...seal.REQUEUE_QUEUE_DIR);
    let files;
    try { files = fs.readdirSync(dir); } catch { return []; }
    return files.filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

function ordenesGithub(estado) {
    const dir = path.join(estado, 'servicios', 'github', 'pendiente');
    let files;
    try { files = fs.readdirSync(dir); } catch { return []; }
    return files.filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

function refsDelRemoto(wt) {
    return execFileSync('git', ['-C', wt.remoto, 'for-each-ref', '--format=%(refname) %(objectname)'],
        { encoding: 'utf8', windowsHide: true }).trim();
}

/** Corre el SKILL DETERMINÍSTICO — el archivo que el pipeline ejecuta de verdad. */
function correrEntrega(wt, estado, marker, extraArgs = []) {
    return spawnSync(process.execPath, [SKILL_DELIVERY, String(ISSUE_FIXTURE), `--trabajando=${marker}`, ...extraArgs], {
        cwd: wt.dir, encoding: 'utf8', windowsHide: true, timeout: 90000,
        env: {
            ...process.env,
            PIPELINE_ISSUE: String(ISSUE_FIXTURE),
            PIPELINE_WORKTREE: wt.dir,
            PIPELINE_REPO_ROOT: path.dirname(estado),
            PIPELINE_STATE_DIR: estado,
            GH_REPO: REPO_INEXISTENTE,
            DEBUG: '',
        },
    });
}

// ---------------------------------------------------------------------------
// GUARDIÁN DE REGRESIÓN — el pedido explícito del rebote desde `aprobacion`
// ---------------------------------------------------------------------------

test('el skill deterministico de entrega NO puede perder el chequeo de frescura', () => {
    // GUARDIÁN. Este archivo es el camino REAL de la fase `entrega`
    // (`DETERMINISTIC_SKILLS`). Si alguien saca el gate de acá, los tests del CLI
    // `.pipeline/delivery.js` siguen en verde y en producción vuelve a integrarse
    // un veredicto que nadie verificó: exactamente el defecto de rev-1.
    const src = fs.readFileSync(SKILL_DELIVERY, 'utf8');

    assert.match(src, /require\(['"]\.\.\/lib\/delivery\/freshness-gate['"]\)/,
        'el skill determinístico tiene que consumir el módulo del GATE 3');
    assert.match(src, /freshnessGate\.evaluateFreshnessGate\(/,
        'el skill determinístico tiene que EVALUAR el gate, no sólo importarlo');

    // Y el gate tiene que quedar ANTES del push: un chequeo posterior no sirve,
    // el remoto ya se movió.
    const posGate = src.indexOf('freshnessGate.evaluateFreshnessGate(');
    const posPush = src.indexOf('git.pushAndVerify(');
    assert.ok(posGate > 0 && posPush > 0, 'ambos puntos tienen que existir');
    assert.ok(posGate < posPush,
        'el chequeo de frescura corre ANTES del push, nunca después');

    // El allowlist de skills determinísticos sigue incluyendo `delivery`: si
    // dejara de hacerlo, este guardián estaría cuidando un archivo muerto y
    // habría que mover el gate al camino nuevo.
    const provider = fs.readFileSync(
        path.join(REPO_ROOT, '.pipeline', 'lib', 'agent-launcher', 'providers', 'deterministic.js'), 'utf8');
    assert.match(provider, /DETERMINISTIC_SKILLS\s*=\s*new Set\(\[[^\]]*'delivery'/,
        'si `delivery` sale de DETERMINISTIC_SKILLS, el camino real cambió y el gate hay que moverlo');
});

test('los dos caminos de entrega consumen el MISMO modulo de caducidad', () => {
    // El rebote pedía explícitamente NO duplicar el gate en dos archivos. La
    // política vive en `lib/delivery/freshness-gate.js`; los orquestadores sólo
    // la traducen a su contrato de salida.
    const skill = fs.readFileSync(SKILL_DELIVERY, 'utf8');
    const cli = fs.readFileSync(CLI_DELIVERY, 'utf8');
    for (const [nombre, src] of [['skill determinístico', skill], ['CLI', cli]]) {
        assert.match(src, /delivery\/freshness-gate/, `${nombre} tiene que requerir el módulo compartido`);
        assert.match(src, /evaluateFreshnessGate\(/, `${nombre} tiene que llamar a la política compartida`);
    }
    // Y ninguno de los dos vuelve a implementar la decisión por su cuenta.
    for (const [nombre, src] of [['skill determinístico', skill], ['CLI', cli]]) {
        assert.doesNotMatch(src, /seal\.checkVerdictFreshness\(|qaEvidenceSeal\.checkVerdictFreshness\(/,
            `${nombre} no puede re-implementar el chequeo: lo consume del módulo`);
    }
});

test('el barrido del pulpo consulta la politica de veredicto caduco', () => {
    // Sin este cableado el marker `veredicto_caduco` sería un campo que nadie
    // lee, y la entrega frenada rebotaría igual a `dev` (rev++, circuit breaker)
    // por un problema que no es de dev.
    const src = fs.readFileSync(PULPO_JS, 'utf8');
    assert.match(src, /require\(['"]\.\/lib\/delivery\/freshness-gate['"]\)/);
    // SEC (#6496, rebote security — A04): el barrido tiene que pasarle además el
    // `issue` y el `pipelineDir` del ESTADO. Sin esos dos la política no puede
    // corroborar el flag contra nada que haya escrito el pipeline, y vuelve a
    // creerle al agente.
    assert.match(src, /isStaleVerdictRejection\(\{\s*fase,\s*rechazados,\s*issue,\s*pipelineDir: PIPELINE,?\s*\}\)/,
        'el barrido tiene que preguntarle a la política pasándole issue + pipelineDir');
});

// ---------------------------------------------------------------------------
// La política (función pura)
// ---------------------------------------------------------------------------

test('un veredicto caduco no rebota a dev ni escala a needs-human', () => {
    const caduco = { skill: 'delivery', resultado: 'rechazado', veredicto_caduco: true };
    // La reparación REAL existe: `requeueVerification` dejó su contador en disco.
    // Sin eso el flag del agente no alcanza (ver el guardián de acá abajo).
    const estado = crearEstado();
    seal.requeueVerification({
        pipelineDir: estado, issue: ISSUE_FIXTURE, motivo: 'head-desincronizado',
        headSellado: HEAD_FALSO, headActual: 'b'.repeat(40),
    });
    const ctx = { issue: ISSUE_FIXTURE, pipelineDir: estado };

    assert.strictEqual(
        freshnessGate.isStaleVerdictRejection({ ...ctx, fase: 'entrega', rechazados: [caduco] }), true);

    // Sólo en `entrega`: el gate no corre en ninguna otra fase, así que el flag
    // ahí es ruido y NO puede cancelar un rechazo real.
    assert.strictEqual(
        freshnessGate.isStaleVerdictRejection({ ...ctx, fase: 'verificacion', rechazados: [caduco] }), false);

    // Un rechazo de contenido en la misma tanda MANDA sobre la caducidad.
    assert.strictEqual(freshnessGate.isStaleVerdictRejection({
        ...ctx,
        fase: 'entrega',
        rechazados: [caduco, { skill: 'review', resultado: 'rechazado', motivo: 'bug real' }],
    }), false);

    // El flag es el booleano estructurado, nunca prosa ni un string "true".
    for (const falso of ['true', 1, 'veredicto caduco', null, undefined]) {
        assert.strictEqual(freshnessGate.isStaleVerdictRejection({
            ...ctx, fase: 'entrega', rechazados: [{ veredicto_caduco: falso }],
        }), false, `veredicto_caduco=${JSON.stringify(falso)} no puede cancelar un rechazo`);
    }

    // Lote vacío ⇒ no hay nada que cancelar.
    assert.strictEqual(
        freshnessGate.isStaleVerdictRejection({ ...ctx, fase: 'entrega', rechazados: [] }), false);
});

test('el flag veredicto_caduco declarado por el agente NO se cree sin corroboracion', () => {
    // GUARDIÁN SEC (#6496, rebote security — A04: Insecure Design).
    //
    // `veredicto_caduco` sale del YAML del work-file, y `roles/delivery.md` le
    // pide explícitamente al agente de `entrega` que lo escriba. Que el campo sea
    // ESTRUCTURADO no lo hace confiable: es exactamente la clase de input contra
    // la que existe `stripDeclaredSeal` (CA-5).
    //
    // Sin corroboración, un agente cuya entrega falló DE VERDAD (conflictos, CI en
    // rojo) escribía `rechazado` + `veredicto_caduco: true` y se auto-cancelaba el
    // rechazo: sin rebote a dev, sin rev++, sin circuit breaker y sin
    // `needs-human`. Y como no había orden real en la cola, nadie re-encolaba nada
    // y el issue desaparecía del pipeline en silencio.
    const caduco = { skill: 'delivery', resultado: 'rechazado', veredicto_caduco: true };

    // Estado LIMPIO: nadie encoló ninguna reparación. El flag es puro dicho del agente.
    const sinReparacion = crearEstado();
    assert.strictEqual(freshnessGate.isStaleVerdictRejection({
        fase: 'entrega', rechazados: [caduco], issue: ISSUE_FIXTURE, pipelineDir: sinReparacion,
    }), false, 'sin contador ni orden en la cola, el flag del agente no cancela nada');

    // Y sin `issue` no hay contra qué corroborar ⇒ fail-closed.
    assert.strictEqual(freshnessGate.isStaleVerdictRejection({
        fase: 'entrega', rechazados: [caduco], pipelineDir: sinReparacion,
    }), false, 'sin issue no se puede corroborar: es un rechazo normal');
    assert.strictEqual(freshnessGate.isStaleVerdictRejection({
        fase: 'entrega', rechazados: [caduco], issue: '../../etc', pipelineDir: sinReparacion,
    }), false, 'un issue no normalizable tampoco corrobora');

    // Con la reparación REAL encolada por el pipeline, el mismo flag SÍ vale.
    const conReparacion = crearEstado();
    seal.requeueVerification({
        pipelineDir: conReparacion, issue: ISSUE_FIXTURE, motivo: 'head-desincronizado',
        headSellado: HEAD_FALSO, headActual: 'b'.repeat(40),
    });
    assert.strictEqual(freshnessGate.isStaleVerdictRejection({
        fase: 'entrega', rechazados: [caduco], issue: ISSUE_FIXTURE, pipelineDir: conReparacion,
    }), true, 'con el contador que sólo escribe requeueVerification, el flag se honra');
});

test('el gate compartido es fail-closed con un issue invalido', () => {
    // SEC-B — un `--issue` que no es un número no puede construir ni el path del
    // contador ni el del dropfile. El llamador tiene que abortar sin tocar el remoto.
    const r = freshnessGate.evaluateFreshnessGate({ issue: '../../etc', cwd: process.cwd() });
    assert.strictEqual(r.issueInvalido, true);
    assert.strictEqual(r.caduco, true, 'un issue inválido nunca se lee como "fresco"');
    assert.strictEqual(r.aplica, false);
});

// ---------------------------------------------------------------------------
// End-to-end sobre el archivo que corre el pipeline
// ---------------------------------------------------------------------------

test('la entrega real NO pushea cuando el veredicto esta caduco', () => {
    // CA-15 — el chequeo corre ANTES del push. Este es EL test que rev-1 no
    // tenía: el que ejercita el binario que el Pulpo spawnea.
    const wt = crearWorktree();
    const estado = crearEstado();
    escribirVeredicto(estado, { resultado: 'aprobado', sello: { version: 1, head: HEAD_FALSO, artefactos: [] } });
    const marker = crearMarker(estado);

    const antes = refsDelRemoto(wt);
    const res = correrEntrega(wt, estado, marker);

    assert.strictEqual(res.status, 0, `la entrega frenada sale con 0 (stderr: ${res.stderr})`);
    assert.strictEqual(refsDelRemoto(wt), antes, 'el remoto no se movió');
    assert.ok(!/refs\/heads\/agent\/999496/.test(refsDelRemoto(wt)),
        'la rama del agente no llegó al remoto');
});

test('el camino caduco del skill deterministico emite el contrato veredicto_caduco', () => {
    // CA-14 / SEC-D — el contrato machine-readable también viaja por el camino
    // real, para que el marker y el reporte no dependan de parsear prosa.
    const wt = crearWorktree();
    const estado = crearEstado();
    escribirVeredicto(estado, { resultado: 'aprobado', sello: { version: 1, head: HEAD_FALSO, artefactos: [] } });
    const marker = crearMarker(estado);

    const res = correrEntrega(wt, estado, marker);
    assert.strictEqual(res.status, 0);

    const contrato = JSON.parse(res.stdout.trim().split(/\r?\n/).pop());
    assert.strictEqual(contrato.estado, 'veredicto_caduco');
    assert.strictEqual(contrato.issue, ISSUE_FIXTURE);
    assert.strictEqual(contrato.motivo, 'head-desincronizado');
    assert.strictEqual(contrato.escalado, false);
    assert.strictEqual(contrato.intentos, 1);
});

test('el marker de la entrega real NUNCA sale aprobado con veredicto caduco', () => {
    // GUARDIÁN CA-11/CA-14 sobre el camino real. `resultado: aprobado` acá es el
    // falso positivo de R3 en `delivery-status.js` (#5220/#5244): el issue se
    // pintaría como Entregado con el PR sin mergear.
    const wt = crearWorktree();
    const estado = crearEstado();
    escribirVeredicto(estado, { resultado: 'aprobado', sello: { version: 1, head: HEAD_FALSO, artefactos: [] } });
    const marker = crearMarker(estado);

    correrEntrega(wt, estado, marker);

    const m = leerMarker(marker);
    assert.strictEqual(m.resultado, 'rechazado', 'nunca aprobado');
    assert.strictEqual(m.veredicto_caduco, 'true', 'el flag estructurado viaja al marker');
    assert.strictEqual(m.delivery_merge_sha, undefined, 'no hubo merge: no puede haber sha de merge');
    assert.match(m.motivo, /caduco/i);

    // Y el predicado del barrido lee ese marker como "no rebotar" — corroborado
    // contra el contador que la propia entrega acaba de dejar en `estado`.
    assert.strictEqual(freshnessGate.isStaleVerdictRejection({
        fase: 'entrega',
        issue: ISSUE_FIXTURE,
        pipelineDir: estado,
        rechazados: [{ ...m, veredicto_caduco: m.veredicto_caduco === 'true' }],
    }), true);
});

test('la entrega real alimenta la cola de re-encolado que drena el pulpo', () => {
    // El defecto que reportó el reviewer: `drenarRequeueVerificacion` era código
    // muerto porque NADIE en el camino real escribía en la cola.
    const wt = crearWorktree();
    const estado = crearEstado();
    escribirVeredicto(estado, { resultado: 'aprobado', sello: { version: 1, head: HEAD_FALSO, artefactos: [] } });
    const marker = crearMarker(estado);

    assert.deepStrictEqual(ordenesRequeue(estado), [], 'arranca vacía');
    correrEntrega(wt, estado, marker);

    const ordenes = ordenesRequeue(estado);
    assert.strictEqual(ordenes.length, 1, 'la entrega real encoló la reparación');
    assert.strictEqual(ordenes[0].tipo, seal.REQUEUE_TYPE);
    assert.strictEqual(ordenes[0].issue, ISSUE_FIXTURE);
    assert.strictEqual(ordenes[0].head_sellado, HEAD_FALSO);
    assert.strictEqual(ordenes[0].head_actual, wt.head);
    // CA-11 — la orden no re-firma nada.
    assert.strictEqual(ordenes[0].resultado, undefined);
    assert.strictEqual(ordenes[0].sello, undefined);

    // CA-12 / SEC-C — el label del issue se degrada en el MISMO acto.
    const gate = ordenesGithub(estado).filter((o) => o.action === 'label');
    assert.ok(gate.some((o) => o.label === 'qa:pending'), 'el gate del issue baja a qa:pending');
    assert.ok(!gate.some((o) => o.label === 'needs-human'),
        'CA-2 — un caduco reparable NO aplica needs-human');
    assert.ok(!gate.some((o) => o.label === 'qa:passed'));

    // CA-13 — delivery no tocó el lifecycle del dropfile de verificación.
    assert.deepStrictEqual(
        fs.readdirSync(path.join(estado, 'desarrollo', 'verificacion', 'pendiente')), [],
        'encolar la fase es trabajo del Pulpo al drenar, no de la entrega');
    assert.ok(fs.existsSync(path.join(estado, 'desarrollo', 'verificacion', 'procesado', `${ISSUE_FIXTURE}.qa`)),
        'el dropfile de procesado/ sigue donde estaba');
});

test('la entrega real con veredicto fresco pasa el gate y llega al push', () => {
    // Contra-prueba de no-vacuidad: si el gate rechazara SIEMPRE, todos los tests
    // de arriba pasarían igual y no probarían nada. Acá el sello coincide con el
    // HEAD real, así que el gate deja pasar y el remoto SÍ recibe la rama.
    const wt = crearWorktree();
    const estado = crearEstado();
    escribirVeredicto(estado, { resultado: 'aprobado', sello: { version: 1, head: wt.head, artefactos: [] } });
    const marker = crearMarker(estado);

    const res = correrEntrega(wt, estado, marker);

    assert.ok(!/veredicto_caduco/.test(res.stdout || ''),
        `un veredicto fresco no puede emitir el contrato de caducidad (stdout: ${(res.stdout || '').slice(0, 300)})`);
    assert.match(refsDelRemoto(wt), new RegExp(`refs/heads/${BRANCH_FIXTURE}\\s+${wt.head}`),
        'el remoto recibió EXACTAMENTE el SHA verificado');
    assert.deepStrictEqual(ordenesRequeue(estado), [], 'no se encoló ninguna reparación');
});

test('se pushea el sha verificado, no la rama simbolica', () => {
    // CA-15 / SEC-F — hoy se verifica un SHA y se pushea un nombre que pudo
    // avanzar entre el chequeo y el push (TOCTOU). Se simula la ventana: el gate
    // verifica `head`, y ANTES de que el push corra aparece otro commit encima.
    const git = require('../../skills-deterministicos/lib/git-ops');
    const wt = crearWorktree();
    const verificado = wt.head;

    // Commit que entra en la ventana TOCTOU — nadie lo verificó.
    fs.writeFileSync(path.join(wt.dir, 'c.txt'), 'tres');
    wt.git('add', '.');
    wt.git('commit', '-q', '-m', 'commit que nadie verifico');
    const intruso = wt.git('rev-parse', 'HEAD').trim();
    assert.notStrictEqual(intruso, verificado);

    const res = git.pushAndVerify(wt.dir, BRANCH_FIXTURE, { sha: verificado });
    assert.strictEqual(res.exit_code, 0, `el push del SHA verificado tiene que funcionar: ${res.stderr}`);

    const remoto = refsDelRemoto(wt);
    assert.match(remoto, new RegExp(`refs/heads/${BRANCH_FIXTURE}\\s+${verificado}`),
        'el remoto quedó en el SHA VERIFICADO');
    assert.ok(!remoto.includes(intruso),
        'el commit que entró en la ventana TOCTOU no se subió');
});

test('el push sin sha verificado sigue subiendo la rama (compat)', () => {
    // El carril de exención de migración pre-sellado (CA-4) no tiene SHA contra
    // qué pinnear: el push por nombre tiene que seguir funcionando igual.
    const git = require('../../skills-deterministicos/lib/git-ops');
    const wt = crearWorktree();
    const res = git.pushAndVerify(wt.dir, BRANCH_FIXTURE);
    assert.strictEqual(res.exit_code, 0, `${res.stderr}`);
    assert.match(refsDelRemoto(wt), new RegExp(`refs/heads/${BRANCH_FIXTURE}\\s+${wt.head}`));
});

// ---------------------------------------------------------------------------
// El merge tampoco integra un árbol que el gate no verificó
// ---------------------------------------------------------------------------

test('el merge se bloquea si el head del PR no es el sha verificado', () => {
    // CA-15 / SEC-F, segunda mitad: entre el push y el merge hay una ventana real
    // (creación del PR, propagación de labels, polling de mergeabilidad). El PUT
    // no puede salir hacia un head que GATE 3 no vio.
    const delivery = require('../../skills-deterministicos/delivery.js');
    const verificado = 'c'.repeat(40);
    const otro = 'd'.repeat(40);
    let mergeLlamado = false;

    const out = delivery.attemptMergeWithGates({
        prNumber: 42,
        expectedHeadSha: verificado,
        getSnapshot: () => ({
            ok: true, labels: ['qa:passed'], files: ['docs/x.md'],
            headRefOid: otro, headRefName: BRANCH_FIXTURE,
            mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', state: 'OPEN',
            statusCheckRollup: [], reviewDecision: null,
        }),
        loadOwners: () => ({ ok: true, rules: [] }),
        verifyOrigin: () => ({ ok: true }),
        mergePR: () => { mergeLlamado = true; return { exit_code: 0, stdout: '{"merged":true}' }; },
        sleepImpl: () => {},
    });

    assert.strictEqual(out.status, 'blocked');
    assert.strictEqual(out.gate, 'sha-verificado');
    assert.strictEqual(mergeLlamado, false, 'no se puede haber llamado al merge');
});

test('el merge procede cuando el head del PR ES el sha verificado', () => {
    // Contra-prueba: el guard no puede bloquear el camino feliz.
    const delivery = require('../../skills-deterministicos/delivery.js');
    const verificado = 'c'.repeat(40);
    let mergeLlamado = false;

    const out = delivery.attemptMergeWithGates({
        prNumber: 42,
        expectedHeadSha: verificado,
        getSnapshot: () => ({
            ok: true, labels: ['qa:passed'], files: ['docs/x.md'],
            headRefOid: verificado, headRefName: BRANCH_FIXTURE,
            mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', state: 'OPEN',
            statusCheckRollup: [{ name: 'build', conclusion: 'SUCCESS', status: 'COMPLETED' }],
            reviewDecision: 'APPROVED',
        }),
        loadOwners: () => ({ ok: true, rules: [] }),
        verifyOrigin: () => ({ ok: true }),
        mergePR: () => {
            mergeLlamado = true;
            return { exit_code: 0, stdout: JSON.stringify({ merged: true, sha: verificado }) };
        },
        sleepImpl: () => {},
    });

    assert.strictEqual(mergeLlamado, true, `el merge tenía que salir (status=${out.status})`);
    assert.strictEqual(out.status, 'merged');
});

test('sin expectedHeadSha el guard no aplica (compat con las suites de gates)', () => {
    const delivery = require('../../skills-deterministicos/delivery.js');
    let mergeLlamado = false;
    const out = delivery.attemptMergeWithGates({
        prNumber: 42,
        getSnapshot: () => ({
            ok: true, labels: ['qa:passed'], files: ['docs/x.md'],
            headRefOid: 'e'.repeat(40), headRefName: BRANCH_FIXTURE,
            mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', state: 'OPEN',
            statusCheckRollup: [{ name: 'build', conclusion: 'SUCCESS', status: 'COMPLETED' }],
            reviewDecision: 'APPROVED',
        }),
        loadOwners: () => ({ ok: true, rules: [] }),
        verifyOrigin: () => ({ ok: true }),
        mergePR: () => {
            mergeLlamado = true;
            return { exit_code: 0, stdout: JSON.stringify({ merged: true, sha: 'e'.repeat(40) }) };
        },
        sleepImpl: () => {},
    });
    assert.strictEqual(mergeLlamado, true);
    assert.strictEqual(out.status, 'merged');
});

// ---------------------------------------------------------------------------
// CA-12 sobre el camino real: el gate no viaja al PR con re-encolado abierto
// ---------------------------------------------------------------------------

test('la entrega real no propaga el gate al PR con un re-encolado abierto', () => {
    const delivery = require('../../skills-deterministicos/delivery.js');
    const estado = crearEstado();

    // Sin re-encolado: la propagación decide normalmente.
    const libre = delivery.buildPrGatePropagation({
        issue: ISSUE_FIXTURE, prNumber: 99, branch: BRANCH_FIXTURE,
        issueLabels: ['qa:passed'], prLabels: [],
        prHead: { number: 99, isCrossRepository: false, headRepositoryOwner: { login: 'intrale' }, headRefName: BRANCH_FIXTURE },
        pipelineDir: estado,
    });
    assert.strictEqual(libre.ok, true);
    assert.strictEqual(libre.target, 'qa:passed');

    // Con el re-encolado abierto: el gate NO viaja al PR.
    seal.requeueVerification({ pipelineDir: estado, issue: ISSUE_FIXTURE, motivo: 'head-desincronizado' });
    assert.strictEqual(seal.hasOpenRequeue({ pipelineDir: estado, issue: ISSUE_FIXTURE }), true);

    const bloqueado = delivery.buildPrGatePropagation({
        issue: ISSUE_FIXTURE, prNumber: 99, branch: BRANCH_FIXTURE,
        issueLabels: ['qa:passed'], prLabels: [],
        prHead: { number: 99, isCrossRepository: false, headRepositoryOwner: { login: 'intrale' }, headRefName: BRANCH_FIXTURE },
        pipelineDir: estado,
    });
    assert.strictEqual(bloqueado.ok, false);
    assert.strictEqual(bloqueado.reason, 're_encolado_de_verificacion_abierto');
});

// ---------------------------------------------------------------------------
// CA-8 — la regla de reset sigue siendo única, también por el camino real
// ---------------------------------------------------------------------------

test('el contador se borra recien cuando la entrega real integra un veredicto fresco', () => {
    const wt = crearWorktree();
    const estado = crearEstado();
    const marker = crearMarker(estado);

    // 1ª vuelta: caduco ⇒ contador en 1, nada pusheado.
    escribirVeredicto(estado, { resultado: 'aprobado', sello: { version: 1, head: HEAD_FALSO, artefactos: [] } });
    correrEntrega(wt, estado, marker);
    assert.strictEqual(seal.readSealRetries({ pipelineDir: estado, issue: ISSUE_FIXTURE }).intentos, 1,
        'un re-encolado exitoso NO resetea: incrementa');

    // 2ª vuelta con veredicto fresco: pasa el gate, pushea y RECIÉN AHÍ resetea.
    escribirVeredicto(estado, { resultado: 'aprobado', sello: { version: 1, head: wt.head, artefactos: [] } });
    correrEntrega(wt, estado, marker);
    assert.strictEqual(seal.readSealRetries({ pipelineDir: estado, issue: ISSUE_FIXTURE }).intentos, 0,
        'el contador se borra al integrar un veredicto fresco');
    assert.match(refsDelRemoto(wt), new RegExp(`refs/heads/${BRANCH_FIXTURE}\\s+${wt.head}`));
});

test('escala a humano recien en la tercera caducidad tambien por el camino real', () => {
    // CA-9 — máximo 2 re-encolados automáticos. La tercera aplica `needs-human`
    // con la ficha de decisión, y no encola una tercera re-verificación.
    const wt = crearWorktree();
    const estado = crearEstado();
    const marker = crearMarker(estado);
    escribirVeredicto(estado, { resultado: 'aprobado', sello: { version: 1, head: HEAD_FALSO, artefactos: [] } });

    correrEntrega(wt, estado, marker);
    correrEntrega(wt, estado, marker);
    assert.strictEqual(ordenesRequeue(estado).length, 2, 'dos re-encolados automáticos');
    assert.ok(!ordenesGithub(estado).some((o) => o.label === 'needs-human'),
        'todavía no escaló');

    const res = correrEntrega(wt, estado, marker);
    const contrato = JSON.parse(res.stdout.trim().split(/\r?\n/).pop());
    assert.strictEqual(contrato.escalado, true, 'la tercera escala');
    assert.strictEqual(ordenesRequeue(estado).length, 2, 'no se encoló una tercera re-verificación');
    assert.ok(ordenesGithub(estado).some((o) => o.action === 'label' && o.label === 'needs-human'),
        'recién acá aparece needs-human');

    // Y aun escalado, el remoto sigue intacto.
    assert.ok(!/refs\/heads\/agent\/999496/.test(refsDelRemoto(wt)));
});
