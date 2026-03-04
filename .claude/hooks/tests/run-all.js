// run-all.js — Runner para todos los tests P-01 a P-16
// Uso: node run-all.js
const { execSync } = require("child_process");
const path = require("path");

const testsDir = __dirname;

console.log("╔══════════════════════════════════════════════╗");
console.log("║  Tests P-01 a P-16 — Verificación integral  ║");
console.log("╚══════════════════════════════════════════════╝");
console.log("");

try {
    const result = execSync("node --test " + path.join(testsDir, "test-p*.js"), {
        cwd: path.resolve(testsDir, ".."),
        encoding: "utf8",
        stdio: "inherit",
        timeout: 60000
    });
} catch (e) {
    // node --test sale con código 1 si hay failures, pero los muestra
    process.exit(e.status || 1);
}
