#!/usr/bin/env node
// find-hooks.js <pattern>
// Localiza hooks (.claude/hooks/*.js) y scripts del pipeline (.pipeline/*.js)
// que contienen un patron literal o regex. Reemplaza Glob+Grep iterativo
// del agente pipeline-dev por una invocacion determinista.
//
// Exit codes: 0 = matches encontrados; 1 = sin matches; 2 = error de uso o IO.

const fs = require('fs');
const path = require('path');

function usage() {
    console.error('Uso: node find-hooks.js <pattern> [--regex]');
    console.error('  <pattern>  texto literal (default) o regex con --regex');
    console.error('  --regex    interpretar el pattern como regex JS');
    process.exit(2);
}

const args = process.argv.slice(2);
if (args.length === 0) usage();

const useRegex = args.includes('--regex');
const pattern = args.find(a => !a.startsWith('--'));
if (!pattern) usage();

const matcher = useRegex
    ? new RegExp(pattern)
    : { test: (text) => text.includes(pattern) };

const ROOTS = [
    path.resolve(__dirname, '..', '..', '.claude', 'hooks'),
    path.resolve(__dirname, '..'),
];

function listJsFiles(root, files = []) {
    let entries;
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (err) {
        return files;
    }
    for (const entry of entries) {
        const full = path.join(root, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'tests' || entry.name.startsWith('.')) continue;
            listJsFiles(full, files);
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            files.push(full);
        }
    }
    return files;
}

const files = ROOTS.flatMap(root => listJsFiles(root));
const matches = [];

for (const file of files) {
    let content;
    try {
        content = fs.readFileSync(file, 'utf8');
    } catch (err) {
        continue;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        if (matcher.test(lines[i])) {
            matches.push({ file: path.relative(process.cwd(), file), line: i + 1, text: lines[i].trim().slice(0, 200) });
        }
    }
}

if (matches.length === 0) {
    console.log(JSON.stringify({ pattern, matches: [], total: 0 }, null, 2));
    process.exit(1);
}

console.log(JSON.stringify({ pattern, matches, total: matches.length }, null, 2));
process.exit(0);
