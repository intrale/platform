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
