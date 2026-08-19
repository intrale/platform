// =============================================================================
// project-context.test.js — resolución del proyecto en contexto (#5110 · E2).
//
// `project-context.js` es el CONTROL DE AISLAMIENTO del estado operativo: si
// resuelve mal, un proyecto lee y escribe el estado de otro. Por eso el objetivo
// de cobertura es 100% de ramas de `resolveProjectContext()` — una rama sin test
// es, literalmente, un default silencioso que nadie está mirando.
//
// Ejecutar:  node --test .pipeline/lib/__tests__/project-context.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MODULE = '../project-context';

function fresh() {
    delete require.cache[require.resolve(MODULE)];
    const mod = require(MODULE);
    mod._resetForTests();
    return mod;
}

/**
 * Sandbox con `descriptors/` poblado. Cada id produce un descriptor mínimo: el
 * módulo sólo mira el NOMBRE del archivo, no su contenido.
 */
function sandbox(projectIds = []) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projctx-'));
    fs.mkdirSync(path.join(dir, 'descriptors'), { recursive: true });
    for (const id of projectIds) {
        fs.writeFileSync(path.join(dir, 'descriptors', `${id}.json`), JSON.stringify({ identity: { projectId: id } }));
    }
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    return dir;
}

function cleanup(dir) {
    delete process.env.PIPELINE_DIR_OVERRIDE;
    delete process.env.PIPELINE_PROJECT_ID;
    delete process.env.PIPELINE_PROJECT_BINDING;
    delete process.env.PIPELINE_OPSTATE_NAMESPACED;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
}

// ─── Precedencia ────────────────────────────────────────────────────────────

test('precedencia 1 · projectId explícito gana sobre todo lo demás', () => {
    const dir = sandbox(['alpha', 'beta']);
    try {
        const pc = fresh();
        // Env presente y APUNTANDO A OTRO LADO: lo explícito igual manda.
        process.env.PIPELINE_PROJECT_ID = 'alpha';
        const ctx = pc.resolveProjectContext({ projectId: 'beta' });
        assert.equal(ctx.projectId, 'beta');
        assert.equal(ctx.source, 'explicit');
    } finally { cleanup(dir); }
});

test('lo explícito NO contamina el caché del proceso', () => {
    const dir = sandbox(['alpha']);
    try {
        const pc = fresh();
        assert.equal(pc.resolveProjectContext({ projectId: 'beta' }).projectId, 'beta');
        // La resolución ambiente sigue siendo la del único descriptor: un caller
        // puntual no debe reprogramar el contexto de todo el proceso.
        const ambient = pc.resolveProjectContext();
        assert.equal(ambient.projectId, 'alpha');
        assert.equal(ambient.source, 'single-project');
    } finally { cleanup(dir); }
});

test('precedencia 2 · env + binding válido resuelve como spawn-binding', () => {
    const dir = sandbox(['alpha', 'beta']);
    try {
        const pc = fresh();
        const { nonce } = pc.writeSpawnBinding({ projectId: 'beta', nonce: 'nonce1', skill: 'pipeline-dev' });
        process.env.PIPELINE_PROJECT_ID = 'beta';
        process.env.PIPELINE_PROJECT_BINDING = nonce;
        const ctx = pc.resolveProjectContext();
        assert.equal(ctx.projectId, 'beta');
        assert.equal(ctx.source, 'spawn-binding');
    } finally { cleanup(dir); }
});

test('precedencia 3 · un único descriptor y sin binding resuelve como single-project', () => {
    const dir = sandbox(['solo-proyecto']);
    try {
        const pc = fresh();
        const ctx = pc.resolveProjectContext();
        assert.equal(ctx.projectId, 'solo-proyecto');
        assert.equal(ctx.source, 'single-project');
    } finally { cleanup(dir); }
});

test('cero descriptores NO es ambigüedad: resuelve al host (compat CA-5)', () => {
    // Checkout sin `descriptors/`, fixture apuntando a un tmpdir, bootstrap
    // antes del primer descriptor. No hay "otro proyecto" en el que caer.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projctx-empty-'));
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    try {
        const pc = fresh();
        const ctx = pc.resolveProjectContext();
        assert.equal(ctx.projectId, pc.HOST_PROJECT_ID);
        assert.equal(ctx.source, 'host-fallback');
    } finally { cleanup(dir); }
});

// ─── Fail-closed (escenario Gherkin "falta el proyecto en contexto") ─────────

test('≥2 proyectos y sin contexto → EOPSTATE_NO_PROJECT_CONTEXT, sin caer en ninguno', () => {
    const dir = sandbox(['alpha', 'beta']);
    try {
        const pc = fresh();
        assert.throws(
            () => pc.resolveProjectContext(),
            (err) => {
                assert.equal(err.code, 'EOPSTATE_NO_PROJECT_CONTEXT');
                assert.equal(err.stage, 'isolation');
                // El mensaje nombra a los candidatos — es lo que hace accionable
                // el error para quien cablea el punto de entrada.
                assert.match(err.message, /alpha/);
                assert.match(err.message, /beta/);
                return true;
            },
        );
    } finally { cleanup(dir); }
});

test('env SIN binding → throw: el entorno no es autoridad (SEC-1 · A01/A07)', () => {
    const dir = sandbox(['alpha', 'beta']);
    try {
        const pc = fresh();
        // Exactamente el ataque: un agente exporta la var y espera que le crean.
        process.env.PIPELINE_PROJECT_ID = 'beta';
        assert.throws(
            () => pc.resolveProjectContext(),
            (err) => {
                assert.equal(err.code, 'EOPSTATE_NO_PROJECT_CONTEXT');
                assert.match(err.message, /binding de spawn/i);
                return true;
            },
        );
    } finally { cleanup(dir); }
});

test('env con binding de OTRO projectId → throw (no se sirve el del binding ni el del env)', () => {
    const dir = sandbox(['alpha', 'beta']);
    try {
        const pc = fresh();
        pc.writeSpawnBinding({ projectId: 'alpha', nonce: 'n1' });
        process.env.PIPELINE_PROJECT_ID = 'beta';   // miente respecto del binding
        process.env.PIPELINE_PROJECT_BINDING = 'n1';
        assert.throws(() => pc.resolveProjectContext(), (err) => {
            assert.equal(err.code, 'EOPSTATE_NO_PROJECT_CONTEXT');
            return true;
        });
    } finally { cleanup(dir); }
});

test('binding inexistente → throw (no degrada a single-project)', () => {
    const dir = sandbox(['alpha']);
    try {
        const pc = fresh();
        process.env.PIPELINE_PROJECT_ID = 'alpha';
        process.env.PIPELINE_PROJECT_BINDING = 'no-existe';
        // Aunque haya UN solo descriptor y "adivinar" daría el resultado
        // correcto, un binding roto es una señal de que algo está mal cableado.
        assert.throws(() => pc.resolveProjectContext(), (err) => {
            assert.equal(err.code, 'EOPSTATE_NO_PROJECT_CONTEXT');
            return true;
        });
    } finally { cleanup(dir); }
});

test('binding presente sin PIPELINE_PROJECT_ID → throw (el par va completo)', () => {
    const dir = sandbox(['alpha']);
    try {
        const pc = fresh();
        pc.writeSpawnBinding({ projectId: 'alpha', nonce: 'n1' });
        process.env.PIPELINE_PROJECT_BINDING = 'n1';
        assert.throws(() => pc.resolveProjectContext(), (err) => {
            assert.equal(err.code, 'EOPSTATE_NO_PROJECT_CONTEXT');
            return true;
        });
    } finally { cleanup(dir); }
});

// ─── Congelamiento ──────────────────────────────────────────────────────────

test('el contexto es inmutable: congelado y no reasignable', () => {
    const dir = sandbox(['alpha']);
    try {
        const pc = fresh();
        const ctx = pc.resolveProjectContext();
        assert.ok(Object.isFrozen(ctx), 'el contexto debe estar congelado');
        assert.throws(() => { 'use strict'; ctx.projectId = 'beta'; }, TypeError);
        assert.equal(ctx.projectId, 'alpha');
        // Y la lectura siguiente sigue devolviendo lo mismo (caché estable).
        assert.equal(pc.resolveProjectContext().projectId, 'alpha');
    } finally { cleanup(dir); }
});

test('_resetForTests invalida el caché por proceso', () => {
    let dir = sandbox(['alpha']);
    try {
        const pc = fresh();
        assert.equal(pc.resolveProjectContext().projectId, 'alpha');
        cleanup(dir);

        dir = sandbox(['beta']);
        pc._resetForTests();
        assert.equal(pc.resolveProjectContext().projectId, 'beta');
    } finally { cleanup(dir); }
});

// ─── assertOperationalNamespace (D1) ────────────────────────────────────────

test('D1 · el HOST se acepta como namespace aunque esté en RESERVED_PROJECT_IDS', () => {
    const dir = sandbox([]);
    try {
        const pc = fresh();
        const { isReservedProjectId } = require('../project-descriptor');
        // La premisa del test: si esto dejara de ser cierto, el caso ya no prueba nada.
        assert.ok(isReservedProjectId(pc.HOST_PROJECT_ID), 'el host DEBE seguir reservado como tenant');
        assert.equal(pc.assertOperationalNamespace(pc.HOST_PROJECT_ID), pc.HOST_PROJECT_ID);
    } finally { cleanup(dir); }
});

test('D1 · un id reservado que NO es el host se rechaza (la reserva no se levanta)', () => {
    const dir = sandbox([]);
    try {
        const pc = fresh();
        assert.throws(() => pc.assertOperationalNamespace('kernel-control-plane'), (err) => {
            assert.equal(err.code, 'EOPSTATE_RESERVED_PROJECT_ID');
            return true;
        });
    } finally { cleanup(dir); }
});

test('un projectId de tenant normal se acepta', () => {
    const dir = sandbox([]);
    try {
        const pc = fresh();
        assert.equal(pc.assertOperationalNamespace('mi-producto'), 'mi-producto');
    } finally { cleanup(dir); }
});

// ─── namespaceEnabled (flag de layout) ──────────────────────────────────────

test('el flag está APAGADO por default: stateDir es la raíz física (sin regresión)', () => {
    const dir = sandbox(['alpha']);
    try {
        const pc = fresh();
        assert.equal(pc.namespaceEnabled(), false);
        assert.equal(pc.stateDir(), path.resolve(dir));
    } finally { cleanup(dir); }
});

test('con el flag ENCENDIDO stateDir baja a projects/<projectId>/', () => {
    const dir = sandbox(['alpha']);
    try {
        process.env.PIPELINE_OPSTATE_NAMESPACED = '1';
        const pc = fresh();
        assert.equal(pc.namespaceEnabled(), true);
        assert.equal(pc.stateDir(), path.resolve(path.join(dir, 'projects', 'alpha')));
        assert.ok(fs.existsSync(pc.stateDir()), 'el namespace se crea al resolverse');
    } finally { cleanup(dir); }
});

test('con el flag APAGADO no se resuelve contexto: ni siquiera con ≥2 proyectos rompe', () => {
    // Garantía de no-regresión: mientras el rollout esté OFF, el camino caliente
    // de resolución de paths no puede tirar por contexto ambiguo.
    const dir = sandbox(['alpha', 'beta']);
    try {
        const pc = fresh();
        assert.doesNotThrow(() => pc.stateDir());
        assert.equal(pc.stateDir(), path.resolve(dir));
        // Y la variante no-throw devuelve null en vez de explotar.
        assert.equal(pc.currentProjectIdOrNull(), null);
    } finally { cleanup(dir); }
});

// ─── Bindings ───────────────────────────────────────────────────────────────

test('clearSpawnBinding es idempotente y el binding borrado deja de resolver', () => {
    const dir = sandbox(['alpha', 'beta']);
    try {
        const pc = fresh();
        pc.writeSpawnBinding({ projectId: 'beta', nonce: 'n1' });
        assert.equal(pc.readSpawnBinding('n1').projectId, 'beta');
        assert.equal(pc.clearSpawnBinding('n1'), true);
        assert.equal(pc.readSpawnBinding('n1'), null);
        assert.equal(pc.clearSpawnBinding('n1'), false, 'segundo borrado no rompe');
    } finally { cleanup(dir); }
});

test('writeSpawnBinding rechaza projectId reservado y nonce inseguro', () => {
    const dir = sandbox([]);
    try {
        const pc = fresh();
        assert.throws(() => pc.writeSpawnBinding({ projectId: '__proto__', nonce: 'n1' }));
        assert.throws(() => pc.writeSpawnBinding({ projectId: 'alpha', nonce: '../fuga' }), (err) => {
            assert.equal(err.code, 'EOPSTATE_INVALID_BINDING');
            return true;
        });
    } finally { cleanup(dir); }
});

// ─── Worktree · el binding vive en el repo principal ────────────────────────
//
// Los agentes de fase `dev` corren en un worktree aislado con su propia copia
// de `.pipeline/`. El binding lo escribe el pulpo en el repo PRINCIPAL. Si la
// resolución usara el `.pipeline/` local del worktree, todo agente de dev
// fallaría cerrado en cuanto se encienda el namespaceo.

test('worktree · bindingsDir sale de PIPELINE_REPO_ROOT, no del .pipeline local', () => {
    const principal = fs.mkdtempSync(path.join(os.tmpdir(), 'projctx-main-'));
    fs.mkdirSync(path.join(principal, '.pipeline', 'descriptors'), { recursive: true });
    process.env.PIPELINE_REPO_ROOT = principal;
    try {
        const pc = fresh();
        assert.equal(
            pc._paths().BINDINGS_DIR,
            path.join(principal, '.pipeline', 'state', 'project-bindings'),
        );
    } finally {
        delete process.env.PIPELINE_REPO_ROOT;
        try { fs.rmSync(principal, { recursive: true, force: true }); } catch { /* noop */ }
    }
});

test('worktree · el agente resuelve el binding que escribió el pulpo en el repo principal', () => {
    const principal = fs.mkdtempSync(path.join(os.tmpdir(), 'projctx-main2-'));
    fs.mkdirSync(path.join(principal, '.pipeline', 'state', 'project-bindings'), { recursive: true });
    process.env.PIPELINE_REPO_ROOT = principal;
    try {
        // El pulpo escribe el binding.
        const pc = fresh();
        pc.writeSpawnBinding({ projectId: 'alpha', nonce: 'wt1', skill: 'pipeline-dev' });

        // El agente (otro proceso, mismo repo principal por env) lo lee.
        const agente = fresh();
        process.env.PIPELINE_PROJECT_ID = 'alpha';
        process.env.PIPELINE_PROJECT_BINDING = 'wt1';
        const ctx = agente.resolveProjectContext();
        assert.equal(ctx.projectId, 'alpha');
        assert.equal(ctx.source, 'spawn-binding');
    } finally {
        delete process.env.PIPELINE_REPO_ROOT;
        delete process.env.PIPELINE_PROJECT_ID;
        delete process.env.PIPELINE_PROJECT_BINDING;
        try { fs.rmSync(principal, { recursive: true, force: true }); } catch { /* noop */ }
    }
});

test('PIPELINE_DIR_OVERRIDE tiene precedencia sobre PIPELINE_REPO_ROOT (sandbox hermético)', () => {
    const principal = fs.mkdtempSync(path.join(os.tmpdir(), 'projctx-main3-'));
    const dir = sandbox(['alpha']);
    process.env.PIPELINE_REPO_ROOT = principal;
    try {
        const pc = fresh();
        assert.equal(pc._paths().BINDINGS_DIR, path.join(dir, 'state', 'project-bindings'));
    } finally {
        delete process.env.PIPELINE_REPO_ROOT;
        cleanup(dir);
        try { fs.rmSync(principal, { recursive: true, force: true }); } catch { /* noop */ }
    }
});

// ─── Poda de bindings ───────────────────────────────────────────────────────

test('pruneStaleBindings borra los vencidos y conserva los vigentes', () => {
    const dir = sandbox(['alpha']);
    try {
        const pc = fresh();
        pc.writeSpawnBinding({ projectId: 'alpha', nonce: 'viejo' });
        pc.writeSpawnBinding({ projectId: 'alpha', nonce: 'nuevo' });

        // Envejecer uno más allá del TTL.
        const bdir = pc._paths().BINDINGS_DIR;
        const viejo = path.join(bdir, 'viejo.json');
        const pasado = new Date(Date.now() - pc.BINDING_TTL_MS - 60_000);
        fs.utimesSync(viejo, pasado, pasado);

        assert.equal(pc.pruneStaleBindings(), 1);
        assert.equal(fs.existsSync(viejo), false, 'el vencido se borra');
        assert.ok(fs.existsSync(path.join(bdir, 'nuevo.json')), 'el vigente se conserva');
    } finally { cleanup(dir); }
});

test('pruneStaleBindings no rompe si el directorio no existe', () => {
    const dir = sandbox(['alpha']);
    try {
        const pc = fresh();
        assert.equal(pc.pruneStaleBindings(), 0);
    } finally { cleanup(dir); }
});

// =============================================================================
// Ramas defensivas del control de aislamiento (#5110 · rebote rev-1)
//
// El issue exige 100% de RAMAS en este módulo: "una rama sin test es un default
// silencioso". La primera pasada quedó en 80% y el grueso de lo que faltaba eran
// checks de defensa en profundidad —contención de paths detrás de `isSafeId()`,
// fallbacks de config ilegible— que NO se pueden alcanzar por la API pública,
// justamente porque hay un validador más estricto adelante.
//
// Se resolvió extrayendo esos checks a helpers PUROS (`_internal`) en vez de
// borrarlos: la garantía sigue en el código y ahora además está probada con
// entradas que escapan de verdad.
// =============================================================================

// ─── ProjectContextError · defaults y cause ─────────────────────────────────

test('ProjectContextError sin opts usa code/stage por defecto', () => {
    const pc = fresh();
    const err = new pc.ProjectContextError('boom');
    assert.equal(err.name, 'ProjectContextError');
    assert.equal(err.code, 'EOPSTATE_NO_PROJECT_CONTEXT');
    assert.equal(err.stage, 'isolation');
    assert.equal('cause' in err, false, 'sin cause explícita no se inventa la propiedad');
    assert.ok(err instanceof Error);
});

test('ProjectContextError propaga code, stage y cause explícitos', () => {
    const pc = fresh();
    const raiz = new Error('raíz');
    const err = new pc.ProjectContextError('boom', { code: 'EOTRO', stage: 'otra', cause: raiz });
    assert.equal(err.code, 'EOTRO');
    assert.equal(err.stage, 'otra');
    assert.equal(err.cause, raiz);
});

// ─── Contención de paths (SEC-2) ────────────────────────────────────────────

test('containedUnder acepta lo que cuelga del root y rechaza lo que escapa', () => {
    const { containedUnder } = fresh()._internal;
    const root = path.resolve('/tmp/projects');

    assert.equal(containedUnder(path.join(root, 'alpha'), root), path.join(root, 'alpha'));
    // El propio root NO está contenido: un id que colapse a la raíz es un escape.
    assert.equal(containedUnder(root, root), null);
    // Hermano con prefijo compartido: `projects-evil` NO cuelga de `projects`.
    assert.equal(containedUnder(root + '-evil', root), null);
    assert.equal(containedUnder(path.resolve('/tmp/otro'), root), null);
});

test('requireContainedUnder tira EOPSTATE_PATH_ESCAPE ante un escape', () => {
    const { requireContainedUnder } = fresh()._internal;
    const root = path.resolve('/tmp/projects');

    assert.equal(requireContainedUnder(path.join(root, 'alpha'), root), path.join(root, 'alpha'));
    assert.throws(
        () => requireContainedUnder(path.resolve('/etc/passwd'), root),
        (e) => e.code === 'EOPSTATE_PATH_ESCAPE' && e.stage === 'isolation',
    );
    // Fail-closed también cuando colapsa exactamente al root.
    assert.throws(() => requireContainedUnder(root, root), { code: 'EOPSTATE_PATH_ESCAPE' });
});

// ─── Identidad del host ─────────────────────────────────────────────────────

test('parseHostProjectId extrae y trimmea, o devuelve null si no hay id usable', () => {
    const { parseHostProjectId } = fresh()._internal;

    assert.equal(parseHostProjectId('{"projectId":"  intrale-platform  "}'), 'intrale-platform');
    assert.equal(parseHostProjectId('null'), null, 'JSON null');
    assert.equal(parseHostProjectId('{}'), null, 'sin la clave');
    assert.equal(parseHostProjectId('{"projectId":42}'), null, 'no-string');
    assert.equal(parseHostProjectId('{"projectId":"   "}'), null, 'sólo espacios');
});

test('computeHostProjectId cae al literal del host si el config no se puede leer', () => {
    const { computeHostProjectId, HOST_FALLBACK_ID } = fresh()._internal;

    const lector = () => { throw new Error('ENOENT'); };
    assert.equal(computeHostProjectId(lector), HOST_FALLBACK_ID);
    // JSON corrupto entra por el mismo catch.
    assert.equal(computeHostProjectId(() => 'no-es-json{'), HOST_FALLBACK_ID);
    // Config legible pero sin projectId → mismo fallback.
    assert.equal(computeHostProjectId(() => '{}'), HOST_FALLBACK_ID);
    // Config que sí lo declara → gana el declarado.
    assert.equal(computeHostProjectId(() => '{"projectId":"otro-host"}'), 'otro-host');
});

test('computeHostProjectId rechaza un projectId inseguro declarado en el config', () => {
    const { computeHostProjectId } = fresh()._internal;
    for (const malo of ['../escape', 'a/b', 'a\\b', 'con espacio']) {
        assert.throws(
            () => computeHostProjectId(() => JSON.stringify({ projectId: malo })),
            (e) => e.code === 'EOPSTATE_INVALID_PROJECT_ID' && e.stage === 'isolation',
            'debía rechazar ' + malo,
        );
    }
});

test('HOST_PROJECT_ID resuelve la identidad del checkout', () => {
    const pc = fresh();
    assert.equal(pc.HOST_PROJECT_ID, 'intrale-platform');
    // Cacheado: dos lecturas dan lo mismo sin releer el archivo.
    assert.equal(pc.HOST_PROJECT_ID, pc.HOST_PROJECT_ID);
});

// ─── Flag de layout ─────────────────────────────────────────────────────────

test('namespacedFromConfig sólo enciende con enabled === true literal', () => {
    const { namespacedFromConfig } = fresh()._internal;

    assert.equal(namespacedFromConfig({ operational_state: { namespaced: { enabled: true } } }), true);

    // Formas degradadas del árbol → APAGADO (default seguro).
    assert.equal(namespacedFromConfig(null), false, 'config nulo');
    assert.equal(namespacedFromConfig(undefined), false, 'config ausente');
    assert.equal(namespacedFromConfig({}), false, 'sin operational_state');
    assert.equal(namespacedFromConfig({ operational_state: {} }), false, 'sin namespaced');
    assert.equal(namespacedFromConfig({ operational_state: { namespaced: {} } }), false, 'sin enabled');

    // Sin coerción: un flag que mueve el registro de olas no se prende por "truthy".
    for (const casi of ['true', 1, '1', 'yes']) {
        assert.equal(
            namespacedFromConfig({ operational_state: { namespaced: { enabled: casi } } }),
            false,
            JSON.stringify(casi) + ' no debe encender el namespaceo',
        );
    }
});

test('PIPELINE_OPSTATE_NAMESPACED=0 fuerza el layout plano', () => {
    const dir = sandbox(['alpha']);
    try {
        const pc = fresh();
        process.env.PIPELINE_OPSTATE_NAMESPACED = '0';
        assert.equal(pc.namespaceEnabled(), false);
        assert.equal(pc.stateDir(), path.resolve(dir), 'plano = la raíz física, sin namespace');

        process.env.PIPELINE_OPSTATE_NAMESPACED = '1';
        assert.equal(pc.namespaceEnabled(), true);
    } finally { cleanup(dir); }
});

// ─── stateDir · el mkdir es best-effort ─────────────────────────────────────

test('stateDir no tira si no puede crear el directorio: el write posterior falla ruidoso', () => {
    const dir = sandbox(['alpha']);
    try {
        const pc = fresh();
        process.env.PIPELINE_OPSTATE_NAMESPACED = '1';
        // `projects` como ARCHIVO ⇒ mkdirSync del namespace falla (ENOTDIR).
        fs.writeFileSync(path.join(dir, 'projects'), 'no soy un directorio');

        const resuelto = pc.stateDir();
        assert.equal(resuelto, path.join(path.resolve(dir), 'projects', 'alpha'));
        assert.equal(fs.existsSync(resuelto), false, 'el directorio no llegó a crearse');
    } finally { cleanup(dir); }
});

// ─── bindingsDir · fallback sin PIPELINE_REPO_ROOT ──────────────────────────

test('bindingsDir cae al .pipeline local si no hay override ni PIPELINE_REPO_ROOT', () => {
    const previoRepo = process.env.PIPELINE_REPO_ROOT;
    delete process.env.PIPELINE_REPO_ROOT;
    delete process.env.PIPELINE_DIR_OVERRIDE;
    try {
        const pc = fresh();
        const esperado = path.join(path.resolve(__dirname, '..', '..'), 'state', 'project-bindings');
        assert.equal(pc._paths().BINDINGS_DIR, esperado);
    } finally {
        if (previoRepo !== undefined) process.env.PIPELINE_REPO_ROOT = previoRepo;
    }
});

// ─── Bindings · entradas corruptas y nonces inseguros ───────────────────────

test('readSpawnBinding devuelve null ante un binding corrupto o sin projectId', () => {
    const dir = sandbox(['alpha']);
    try {
        const pc = fresh();
        pc.writeSpawnBinding({ projectId: 'alpha', nonce: 'semilla' });
        const bdir = pc._paths().BINDINGS_DIR;

        const casos = {
            'no-json': 'no soy json{',
            'json-null': 'null',
            'json-array': '[1,2,3]',
            'json-escalar': '"soy-un-string"',
            'sin-project': '{"nonce":"x"}',
            'project-no-string': '{"projectId":123}',
        };
        for (const [nonce, contenido] of Object.entries(casos)) {
            fs.writeFileSync(path.join(bdir, nonce + '.json'), contenido);
            assert.equal(pc.readSpawnBinding(nonce), null, 'debía rechazar ' + nonce);
        }

        // El binding sano sigue leyéndose.
        assert.equal(pc.readSpawnBinding('semilla').projectId, 'alpha');
    } finally { cleanup(dir); }
});

test('bindingFileFor rechaza nonces inseguros y no arma path', () => {
    const dir = sandbox(['alpha']);
    try {
        const pc = fresh();
        for (const malo of ['../fuga', 'a/b', 'a\\b', '..', null, undefined, 42, '']) {
            assert.equal(pc._internal.bindingFileFor(malo), null, 'debía rechazar ' + JSON.stringify(malo));
        }
        assert.ok(pc._internal.bindingFileFor('ok').endsWith(path.sep + 'ok.json'));
    } finally { cleanup(dir); }
});

test('readSpawnBinding y clearSpawnBinding rechazan nonces inseguros', () => {
    const dir = sandbox(['alpha']);
    try {
        const pc = fresh();
        for (const malo of ['../fuga', 'a/b', null, 42]) {
            assert.equal(pc.readSpawnBinding(malo), null);
            assert.equal(pc.clearSpawnBinding(malo), false);
        }
    } finally { cleanup(dir); }
});

test('writeSpawnBinding distingue nonce nulo de nonce inseguro en el mensaje', () => {
    const dir = sandbox(['alpha']);
    try {
        const pc = fresh();
        assert.throws(
            () => pc.writeSpawnBinding({ projectId: 'alpha', nonce: null }),
            (e) => e.code === 'EOPSTATE_INVALID_BINDING' && /null/.test(e.message),
        );
        assert.throws(
            () => pc.writeSpawnBinding({ projectId: 'alpha', nonce: '../fuga' }),
            (e) => e.code === 'EOPSTATE_INVALID_BINDING' && /fuga/.test(e.message),
        );
    } finally { cleanup(dir); }
});

// ─── Poda · entradas que no son bindings vigentes ───────────────────────────

test('pruneStaleBindings ignora lo que no es .json y sobrevive a un borrado imposible', () => {
    const dir = sandbox(['alpha']);
    try {
        const pc = fresh();
        pc.writeSpawnBinding({ projectId: 'alpha', nonce: 'vigente' });
        const bdir = pc._paths().BINDINGS_DIR;
        const pasado = new Date(Date.now() - pc.BINDING_TTL_MS - 60000);

        // Entrada que NO termina en .json: se saltea aunque esté vencida.
        const ajeno = path.join(bdir, 'README.txt');
        fs.writeFileSync(ajeno, 'no soy un binding');
        fs.utimesSync(ajeno, pasado, pasado);

        // Entrada .json vencida que es un DIRECTORIO: statSync pasa, unlinkSync
        // falla ⇒ el catch por-archivo la deja pasar sin tumbar la poda.
        const trampa = path.join(bdir, 'trampa.json');
        fs.mkdirSync(trampa);
        fs.utimesSync(trampa, pasado, pasado);

        assert.equal(pc.pruneStaleBindings(), 0, 'ninguna entrada podable');
        assert.ok(fs.existsSync(ajeno), 'el no-.json queda intacto');
        assert.ok(fs.existsSync(trampa), 'el que no se pudo borrar queda intacto');
        assert.ok(fs.existsSync(path.join(bdir, 'vigente.json')), 'el vigente se conserva');
    } finally { cleanup(dir); }
});

// ─── assertSameProject (paridad kernel-store · A01) ─────────────────────────

test('assertSameProject deja pasar la partición propia y corta la ajena', () => {
    const dir = sandbox(['alpha']);
    try {
        const pc = fresh();
        assert.equal(pc.assertSameProject('alpha', 'waves.save'), 'alpha');
        assert.throws(
            () => pc.assertSameProject('beta', 'waves.save'),
            (e) => e.code === 'EOPSTATE_CROSS_PROJECT'
                && e.stage === 'isolation'
                && /alpha/.test(e.message)
                && /beta/.test(e.message),
        );
    } finally { cleanup(dir); }
});
