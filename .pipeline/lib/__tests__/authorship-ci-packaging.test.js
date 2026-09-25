'use strict';
// #7632 — Contrato de empaquetado del CLI de autoría en CI.
//
// El job `authorship-trailer` (pr-checks.yml) y la auditoría de main
// (authorship-main-audit.yml) corren `cli.js` bajo un sparse-checkout acotado y
// SIN `npm install`. Este test resuelve de forma recursiva los `require` de
// `cli.js` (incluidos los lazy) y exige:
//   1. que cada archivo relativo figure en el sparse-checkout de ambos jobs;
//   2. que todo require no relativo sea un built-in de Node;
//   3. que el CLI cargue con EXACTAMENTE esos archivos copiados a un tmp.
// Si alguien suma `require('js-yaml')` a trailer.js, esto rompe antes que CI.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { builtinModules } = require('node:module');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, '.pipeline', 'lib', 'authorship', 'cli.js');
const REQUIRE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;

function rel(p) { return path.relative(ROOT, p).split(path.sep).join('/'); }

function closure(entry) {
    const files = new Set();
    const external = new Set();
    const pending = [entry];
    while (pending.length) {
        const file = pending.pop();
        if (files.has(file)) continue;
        files.add(file);
        const src = fs.readFileSync(file, 'utf8');
        for (const m of src.matchAll(REQUIRE)) {
            const spec = m[1];
            if (spec.startsWith('.')) {
                let target = path.resolve(path.dirname(file), spec);
                if (!target.endsWith('.js')) target += '.js';
                pending.push(target);
            } else {
                external.add(spec);
            }
        }
    }
    return { files: [...files].map(rel).sort(), external: [...external].sort() };
}

function sparseList(workflowFile, jobName) {
    const wf = yaml.load(fs.readFileSync(path.join(ROOT, '.github', 'workflows', workflowFile), 'utf8'));
    const job = wf.jobs[jobName];
    assert.ok(job, `falta el job ${jobName} en ${workflowFile}`);
    const checkout = job.steps.find((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/checkout@'));
    assert.ok(checkout, `el job ${jobName} no hace checkout`);
    assert.strictEqual(checkout.with['sparse-checkout-cone-mode'], false);
    return String(checkout.with['sparse-checkout']).split('\n').map((l) => l.trim()).filter(Boolean);
}

const { files, external } = closure(CLI);

test('el cierre de require de cli.js incluye verify, trailer y commit-builder', () => {
    for (const f of ['.pipeline/lib/authorship/verify.js', '.pipeline/lib/authorship/trailer.js', '.pipeline/lib/delivery/commit-builder.js']) {
        assert.ok(files.includes(f), `falta ${f} en el cierre: ${files.join(', ')}`);
    }
});

test('todo require no relativo del cierre es un built-in de Node', () => {
    const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
    const noBuiltin = external.filter((m) => !builtins.has(m));
    assert.deepStrictEqual(noBuiltin, [], `dependencias no built-in (el job no hace npm install): ${noBuiltin.join(', ')}`);
});

for (const [wf, job] of [['pr-checks.yml', 'authorship-trailer'], ['authorship-main-audit.yml', 'authorship-main-audit']]) {
    test(`el sparse-checkout de ${job} cubre el cierre de require + config.yaml`, () => {
        const list = sparseList(wf, job);
        const faltan = files.filter((f) => !list.includes(f));
        assert.deepStrictEqual(faltan, [], `${wf}/${job}: faltan en el sparse-checkout: ${faltan.join(', ')}`);
        assert.ok(list.includes('.pipeline/config.yaml'), 'el modo sale del config.yaml de la base');
        for (const f of list) assert.ok(fs.existsSync(path.join(ROOT, f)), `el sparse-checkout lista un archivo inexistente: ${f}`);
    });
}

test('cli.js carga y responde --help con SOLO los archivos del sparse-checkout', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'authorship-pack-'));
    try {
        for (const f of sparseList('pr-checks.yml', 'authorship-trailer')) {
            const dst = path.join(tmp, f);
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.copyFileSync(path.join(ROOT, f), dst);
        }
        const { main } = require(path.join(tmp, '.pipeline', 'lib', 'authorship', 'cli.js'));
        const out = [];
        const code = await main(['--help'], { stdout: { write: (s) => out.push(s) } });
        assert.strictEqual(code, 0);
        assert.match(out.join(''), /CONSISTENCIA, NO AUTENTICIDAD/);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
