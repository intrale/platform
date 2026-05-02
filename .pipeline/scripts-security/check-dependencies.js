#!/usr/bin/env node
// check-dependencies.js
// Lista las dependencias declaradas en el monorepo Gradle (build.gradle.kts +
// libs.versions.toml) en formato JSON para que el agente /security pueda
// consultar versiones contra GHSA / NVD sin parsear archivos a mano.
//
// Reemplaza el paso AU1 del SKILL.md de /security.
//
// Uso:
//   node check-dependencies.js
//
// Exit codes:
//   0 = listado generado (independiente de hallazgos)
//   2 = error de IO

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const IGNORE_DIRS = new Set(['.git', 'node_modules', 'build', '.gradle', '.idea', 'dist', 'out', '.kotlin']);

function walk(dir, predicate, out) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (IGNORE_DIRS.has(e.name)) continue;
            walk(full, predicate, out);
        } else if (predicate(e.name)) {
            out.push(full);
        }
    }
}

function parseGradleKts(file) {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch { return []; }
    const deps = [];
    // implementation("group:artifact:version") | api(...) | classpath(...) | testImplementation(...)
    const re = /(implementation|api|classpath|testImplementation|androidTestImplementation|kapt|ksp|runtimeOnly|compileOnly)\s*\(\s*"([^":\s]+):([^":\s]+):([^"\s]+)"\s*\)/g;
    let m;
    while ((m = re.exec(content)) !== null) {
        deps.push({
            scope: m[1],
            group: m[2],
            artifact: m[3],
            version: m[4],
            source: file,
        });
    }
    return deps;
}

function parseVersionsToml(file) {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch { return { versions: [], libraries: [] }; }
    const lines = content.split(/\r?\n/);
    let section = null;
    const versions = [];
    const libraries = [];
    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const sec = line.match(/^\[([a-z-]+)\]$/i);
        if (sec) { section = sec[1].toLowerCase(); continue; }
        if (section === 'versions') {
            const m = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*"([^"]+)"/);
            if (m) versions.push({ key: m[1], value: m[2] });
        } else if (section === 'libraries') {
            const m = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*(.+)$/);
            if (m) libraries.push({ key: m[1], spec: m[2] });
        }
    }
    return { versions, libraries };
}

function main() {
    const gradleFiles = [];
    walk(ROOT, n => n === 'build.gradle.kts' || n === 'settings.gradle.kts', gradleFiles);

    const tomlFiles = [];
    walk(ROOT, n => n.endsWith('.versions.toml'), tomlFiles);

    const allDeps = [];
    for (const f of gradleFiles) allDeps.push(...parseGradleKts(f));

    const tomlData = [];
    for (const f of tomlFiles) {
        tomlData.push({ file: f, ...parseVersionsToml(f) });
    }

    const result = {
        gradle_files: gradleFiles.length,
        toml_files: tomlFiles.length,
        dependencies_count: allDeps.length,
        dependencies: allDeps,
        version_catalogs: tomlData,
    };
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
}

main();
