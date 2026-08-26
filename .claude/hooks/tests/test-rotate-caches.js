// Tests de rotate-caches.js — rotacion de caches de maquina.
//
// El foco esta en las dos decisiones que, si se equivocan, borran trabajo:
//   1. que version de Chrome conservar (un orden lexicografico borra la mas nueva)
//   2. que worktree considerar inactivo (un heartbeat mal leido borra un build vivo)

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
    compareVersions, dirSize, hasFreshHeartbeat, BUILD_ARTIFACTS, WALK_SKIP,
} = require("../rotate-caches.js");

function tmpDir(name) {
    const d = path.join(os.tmpdir(), "rotate-caches-test-" + name + "-" + process.pid);
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });
    return d;
}

test("compareVersions ordena por segmento numerico, no lexicograficamente", () => {
    // El caso que rompe el orden por string: "76" > "153" alfabeticamente.
    assert.ok(compareVersions("win64-146.0.7680.76", "win64-146.0.7680.153") < 0);
    assert.ok(compareVersions("win64-150.0.7871.24", "win64-146.0.7680.153") > 0);
    assert.strictEqual(compareVersions("win64-146.0.7680.31", "win64-146.0.7680.31"), 0);
});

test("compareVersions deja la version mas nueva al final del sort", () => {
    const versiones = [
        "win64-145.0.7632.77", "win64-146.0.7680.153", "win64-146.0.7680.31",
        "win64-146.0.7680.66", "win64-146.0.7680.76", "win64-150.0.7871.24",
    ];
    versiones.sort(compareVersions);
    assert.strictEqual(versiones[versiones.length - 1], "win64-150.0.7871.24");
});

test("hasFreshHeartbeat detecta un agente trabajando ahora", () => {
    const d = tmpDir("hb-fresh");
    fs.mkdirSync(path.join(d, ".claude", "hooks"), { recursive: true });
    fs.writeFileSync(path.join(d, ".claude", "hooks", "agent-1.heartbeat"), "");
    assert.strictEqual(hasFreshHeartbeat(d), true);
    fs.rmSync(d, { recursive: true, force: true });
});

test("hasFreshHeartbeat ignora un heartbeat viejo", () => {
    const d = tmpDir("hb-stale");
    fs.mkdirSync(path.join(d, ".claude", "hooks"), { recursive: true });
    const f = path.join(d, ".claude", "hooks", "agent-1.heartbeat");
    fs.writeFileSync(f, "");
    const hace1h = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(f, hace1h, hace1h);
    assert.strictEqual(hasFreshHeartbeat(d), false);
    fs.rmSync(d, { recursive: true, force: true });
});

test("hasFreshHeartbeat devuelve false sin directorio de hooks", () => {
    const d = tmpDir("hb-none");
    assert.strictEqual(hasFreshHeartbeat(d), false);
    assert.strictEqual(hasFreshHeartbeat(path.join(d, "no-existe")), false);
    fs.rmSync(d, { recursive: true, force: true });
});

test("hasFreshHeartbeat ignora archivos que no son heartbeat", () => {
    const d = tmpDir("hb-otros");
    fs.mkdirSync(path.join(d, ".claude", "hooks"), { recursive: true });
    fs.writeFileSync(path.join(d, ".claude", "hooks", "agent-1.heartbeat.stale"), "");
    fs.writeFileSync(path.join(d, ".claude", "hooks", "hook-debug.log"), "x");
    assert.strictEqual(hasFreshHeartbeat(d), false);
    fs.rmSync(d, { recursive: true, force: true });
});

test("el walk nunca entra a .pipeline: ahi `build` es una fase, no un artefacto", () => {
    // .pipeline/desarrollo/build es un directorio de estado del pipeline
    // (pendiente/trabajando/listo). Borrarlo pierde trabajo encolado.
    assert.ok(WALK_SKIP.has(".pipeline"));
    assert.ok(WALK_SKIP.has(".git"));
    assert.ok(WALK_SKIP.has("qa"));   // qa/evidence es evidencia de gates
    assert.ok(BUILD_ARTIFACTS.has("build"));
});

test("dirSize suma recursivamente y no explota con paths inexistentes", () => {
    const d = tmpDir("size");
    fs.mkdirSync(path.join(d, "sub"), { recursive: true });
    fs.writeFileSync(path.join(d, "a.txt"), "x".repeat(100));
    fs.writeFileSync(path.join(d, "sub", "b.txt"), "y".repeat(250));
    assert.strictEqual(dirSize(d), 350);
    assert.strictEqual(dirSize(path.join(d, "no-existe")), 0);
    fs.rmSync(d, { recursive: true, force: true });
});
