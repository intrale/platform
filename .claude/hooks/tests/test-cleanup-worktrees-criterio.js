// Tests del criterio de reclamacion de worktrees (cleanup-worktrees.js).
//
// El criterio viejo era `contents.length <= 1`: un worktree con codigo NUNCA
// calificaba, por mergeado que estuviera su PR. Asi se acumularon 100+ copias
// del repo (~250 MB cada una) hasta llenar el disco, mientras el limpiador
// reportaba "0.00 GB liberables".
//
// El criterio nuevo reclama un worktree cuyo contenido ya vive en origin/main y
// que no tiene trabajo local. Estos tests fijan las cuatro respuestas que, si se
// invierten, borran trabajo de alguien.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const {
    classifyWorktree, isIntegratedInMain, hasUncommittedWork, NOISE_RE,
} = require("../cleanup-worktrees.js");

function git(cwd, ...args) {
    return execFileSync("git", args, {
        cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
}

// Construye un repo real con un worktree: el criterio consulta git de verdad,
// asi que un mock del filesystem no probaria nada.
function makeRepo(name) {
    const root = path.join(os.tmpdir(), "cleanup-crit-" + name + "-" + process.pid);
    fs.rmSync(root, { recursive: true, force: true });
    const origin = path.join(root, "origin");
    const clone = path.join(root, "clone");
    fs.mkdirSync(origin, { recursive: true });

    git(origin, "init", "--bare", "--initial-branch=main");
    fs.mkdirSync(clone, { recursive: true });
    git(clone, "init", "--initial-branch=main");
    git(clone, "config", "user.email", "t@t.t");
    git(clone, "config", "user.name", "t");
    fs.writeFileSync(path.join(clone, "a.txt"), "base\n");
    git(clone, "add", "-A");
    git(clone, "commit", "-m", "base");
    git(clone, "remote", "add", "origin", origin);
    git(clone, "push", "-u", "origin", "main");
    return { root, clone };
}

function addWorktree(clone, name, ref) {
    const wt = path.join(path.dirname(clone), name);
    git(clone, "worktree", "add", "--detach", wt, ref);
    return wt;
}

test("worktree integrado en main y limpio: se reclama", () => {
    const { root, clone } = makeRepo("integrado");
    const wt = addWorktree(clone, "wt-integrado", "origin/main");

    const v = classifyWorktree(wt);
    assert.strictEqual(v.dead, true, "deberia reclamarse: su contenido ya esta en main");
    assert.match(v.reason, /integrado en main/);

    fs.rmSync(root, { recursive: true, force: true });
});

test("worktree con commit que NO esta en main: se conserva", () => {
    const { root, clone } = makeRepo("adelantado");
    const wt = addWorktree(clone, "wt-adelantado", "origin/main");
    fs.writeFileSync(path.join(wt, "feature.txt"), "trabajo\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-m", "feature sin pushear");

    const v = classifyWorktree(wt);
    assert.strictEqual(v.dead, false, "tiene un commit que main no tiene");
    assert.match(v.reason, /fuera de main/);

    fs.rmSync(root, { recursive: true, force: true });
});

test("worktree integrado pero con cambios sin commitear: se conserva", () => {
    const { root, clone } = makeRepo("sucio");
    const wt = addWorktree(clone, "wt-sucio", "origin/main");
    fs.writeFileSync(path.join(wt, "borrador.txt"), "sin commitear\n");

    const v = classifyWorktree(wt);
    assert.strictEqual(v.dead, false, "hay trabajo local que se perderia");
    assert.match(v.reason, /sin commitear/);

    fs.rmSync(root, { recursive: true, force: true });
});

test("el ruido operativo no cuenta como trabajo: se reclama igual", () => {
    // .pipeline/, .claude/ y los .log se reescriben solos en cada corrida del
    // pipeline. Si contaran como "trabajo", ningun worktree se reclamaria nunca
    // y volveriamos al problema original.
    const { root, clone } = makeRepo("ruido");
    const wt = addWorktree(clone, "wt-ruido", "origin/main");
    fs.mkdirSync(path.join(wt, ".pipeline"), { recursive: true });
    fs.writeFileSync(path.join(wt, ".pipeline", "estado.json"), "{}");

    assert.strictEqual(hasUncommittedWork(wt), false);
    assert.strictEqual(classifyWorktree(wt).dead, true);

    fs.rmSync(root, { recursive: true, force: true });
});

test("un heartbeat fresco gana sobre cualquier otra senal", () => {
    // Ultima linea de defensa: aunque el worktree este integrado y limpio, si hay
    // un agente escribiendo ahi ahora, no se toca.
    const { root, clone } = makeRepo("heartbeat");
    const wt = addWorktree(clone, "wt-heartbeat", "origin/main");
    fs.mkdirSync(path.join(wt, ".claude", "hooks"), { recursive: true });
    fs.writeFileSync(path.join(wt, ".claude", "hooks", "agent-9999.heartbeat"), "");

    const v = classifyWorktree(wt);
    assert.strictEqual(v.dead, false);
    assert.match(v.reason, /heartbeat activo/);

    fs.rmSync(root, { recursive: true, force: true });
});

test("directorio vacio o inexistente sigue siendo reclamable (criterio historico)", () => {
    const d = path.join(os.tmpdir(), "cleanup-crit-vacio-" + process.pid);
    fs.rmSync(d, { recursive: true, force: true });
    assert.strictEqual(classifyWorktree(d).dead, true);
    fs.mkdirSync(d, { recursive: true });
    assert.strictEqual(classifyWorktree(d).dead, true);
    fs.rmSync(d, { recursive: true, force: true });
});

test("hasUncommittedWork es fail-closed cuando git no responde", () => {
    // Si no se puede determinar el estado, la respuesta segura es "hay trabajo":
    // conservar de mas cuesta disco, borrar de mas cuesta el trabajo de alguien.
    const noEsRepo = path.join(os.tmpdir(), "cleanup-crit-norepo-" + process.pid);
    fs.rmSync(noEsRepo, { recursive: true, force: true });
    fs.mkdirSync(noEsRepo, { recursive: true });
    assert.strictEqual(hasUncommittedWork(noEsRepo), true);
    assert.strictEqual(isIntegratedInMain(noEsRepo), false);
    fs.rmSync(noEsRepo, { recursive: true, force: true });
});

test("NOISE_RE no clasifica codigo de produccion como ruido", () => {
    assert.ok(NOISE_RE.test(".pipeline/estado.json"));
    assert.ok(NOISE_RE.test(".claude/hooks/x.js"));
    assert.ok(NOISE_RE.test("logs/agente.log"));
    assert.ok(!NOISE_RE.test("app/composeApp/src/Main.kt"));
    assert.ok(!NOISE_RE.test("backend/src/Function.kt"));
    // Un archivo que solo menciona "pipeline" en su nombre no es ruido.
    assert.ok(!NOISE_RE.test("docs/pipeline-guia.md"));
});
