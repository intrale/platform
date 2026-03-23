#!/usr/bin/env node
// affected-modules.js — Detecta módulos Gradle afectados por el diff contra origin/main
// Evita ejecutar build/check cuando solo cambiaron scripts, docs, hooks, etc.
//
// Uso como módulo:
//   const { detectAffectedModules, getChangedFiles } = require("./affected-modules");
//   const result = detectAffectedModules(getChangedFiles(workDir));
//   if (result.skipBuild) { /* no invocar Gradle */ }
//
// Uso CLI:
//   node affected-modules.js [workDir]             → JSON completo
//   node affected-modules.js --check [workDir]     → resumen legible
//   node affected-modules.js --tasks [workDir]     → tareas Gradle (o "SKIP")

const { execSync } = require("child_process");
const path = require("path");

// --- Mapeo de paths a modulos Gradle ---

const MODULE_MAP = [
    { pattern: /^app\/composeApp\//, module: "app", gradlePath: ":app:composeApp" },
    { pattern: /^app\//, module: "app", gradlePath: ":app:composeApp" },
    { pattern: /^backend\//, module: "backend", gradlePath: ":backend" },
    { pattern: /^users\//, module: "users", gradlePath: ":users" },
    { pattern: /^shared\//, module: "shared", gradlePath: ":shared" },
    { pattern: /^tools\//, module: "tools", gradlePath: ":tools:forbidden-strings-processor" },
];

// Paths que fuerzan rebuild completo
const FULL_BUILD_TRIGGERS = [
    /^build\.gradle\.kts$/,
    /^settings\.gradle\.kts$/,
    /^gradle\.properties$/,
    /^gradle\//,
    /^buildSrc\//,
    /^gradle\/libs\.versions\.toml$/,
];

// Paths que NO son modulos Gradle — skip build
const NON_GRADLE_PATHS = [
    /^scripts\//,
    /^docs\//,
    /^\.claude\//,
    /^\.github\//,
    /^agents\//,
    /^qa\//,
    /^\.maestro\//,
    /^\.gitignore$/,
    /^\.editorconfig$/,
    /^CLAUDE\.md$/,
    /^README\.md$/,
];

// Dependencias entre modulos (si X cambia, rebuild Y tambien)
const DEPENDENCY_GRAPH = {
    shared: ["backend", "users", "app"],
    backend: ["users"],
};

// --- Core ---

function getChangedFiles(workDir) {
    try {
        return execSync("git diff origin/main...HEAD --name-only", {
            cwd: workDir, encoding: "utf8", timeout: 10000, windowsHide: true,
        }).trim().split("\n").filter(f => f.trim());
    } catch (e) {
        try {
            return execSync("git diff HEAD~1 --name-only", {
                cwd: workDir, encoding: "utf8", timeout: 10000, windowsHide: true,
            }).trim().split("\n").filter(f => f.trim());
        } catch (e2) { return []; }
    }
}

function detectAffectedModules(changedFiles) {
    var result = {
        changedFiles: changedFiles.length,
        fullBuild: false,
        skipBuild: false,
        directlyAffected: new Set(),
        transitivelyAffected: new Set(),
        gradleTasks: { check: [], build: [] },
        reason: "",
    };

    if (changedFiles.length === 0) {
        result.skipBuild = true;
        result.reason = "sin archivos modificados";
        return result;
    }

    var hasGradleFiles = false;

    for (var i = 0; i < changedFiles.length; i++) {
        var file = changedFiles[i].replace(/\\/g, "/");

        // Full build triggers
        if (FULL_BUILD_TRIGGERS.some(function(p) { return p.test(file); })) {
            result.fullBuild = true;
            result.reason = "config Gradle modificado: " + file;
            break;
        }

        // Non-Gradle paths → skip
        if (NON_GRADLE_PATHS.some(function(p) { return p.test(file); })) continue;

        // Map to module
        var match = MODULE_MAP.find(function(m) { return m.pattern.test(file); });
        if (match) {
            hasGradleFiles = true;
            result.directlyAffected.add(match.module);
        } else if (/\.(kt|kts|java|gradle)$/.test(file)) {
            result.fullBuild = true;
            result.reason = "archivo fuente no mapeado: " + file;
            break;
        }
    }

    if (result.fullBuild) {
        result.gradleTasks.check = ["check"];
        result.gradleTasks.build = ["build"];
        return result;
    }

    if (result.directlyAffected.size === 0) {
        result.skipBuild = true;
        result.reason = result.reason || "solo cambios en scripts/docs/config (sin modulos Gradle)";
        return result;
    }

    // Resolver dependencias transitivas
    result.directlyAffected.forEach(function(mod) {
        var deps = DEPENDENCY_GRAPH[mod];
        if (deps) deps.forEach(function(dep) {
            if (!result.directlyAffected.has(dep)) result.transitivelyAffected.add(dep);
        });
    });

    // Generar tareas Gradle
    var allAffected = new Set([].concat(
        Array.from(result.directlyAffected),
        Array.from(result.transitivelyAffected)
    ));
    allAffected.forEach(function(mod) {
        var mapping = MODULE_MAP.find(function(m) { return m.module === mod; });
        if (mapping) {
            result.gradleTasks.check.push(mapping.gradlePath + ":check");
            result.gradleTasks.build.push(mapping.gradlePath + ":build");
        }
    });

    if (allAffected.has("app")) {
        result.gradleTasks.check.push("verifyNoLegacyStrings");
    }

    result.reason = "modulos afectados: " +
        Array.from(result.directlyAffected).join(", ") +
        (result.transitivelyAffected.size > 0
            ? " (+ transitivos: " + Array.from(result.transitivelyAffected).join(", ") + ")"
            : "");

    return result;
}

// --- Exports ---

module.exports = { detectAffectedModules, getChangedFiles, MODULE_MAP, DEPENDENCY_GRAPH };

// --- CLI ---

if (require.main === module) {
    var args = process.argv.slice(2);
    var checkMode = args.indexOf("--check") !== -1;
    var tasksMode = args.indexOf("--tasks") !== -1;
    var workDir = args.find(function(a) { return !a.startsWith("--"); }) || process.cwd();

    var files = getChangedFiles(workDir);
    var result = detectAffectedModules(files);

    if (tasksMode) {
        console.log(result.skipBuild ? "SKIP" : result.gradleTasks.build.join(" "));
    } else if (checkMode) {
        console.log("[affected-modules] " + files.length + " archivos en diff");
        console.log("[affected-modules] " + result.reason);
        if (result.skipBuild) console.log("[affected-modules] SKIP BUILD");
        else if (result.fullBuild) console.log("[affected-modules] FULL BUILD");
        else console.log("[affected-modules] SELECTIVE: " + result.gradleTasks.build.join(" "));
    } else {
        var out = JSON.parse(JSON.stringify(result));
        out.directlyAffected = Array.from(result.directlyAffected);
        out.transitivelyAffected = Array.from(result.transitivelyAffected);
        console.log(JSON.stringify(out, null, 2));
    }
    process.exit(result.skipBuild ? 2 : 0);
}
