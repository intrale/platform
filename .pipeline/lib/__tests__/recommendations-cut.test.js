// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// Tests de #7673 — corte transitorio de recomendaciones (`lib/recommendations-cut.js`).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cut = require('../recommendations-cut');

function configCon(contenido) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), '7673-cfg-'));
    const file = path.join(dir, 'config.yaml');
    if (contenido != null) fs.writeFileSync(file, contenido);
    return file;
}

test.beforeEach(() => cut._resetCacheForTests());

// -----------------------------------------------------------------------------
// isCreationEnabled — SEC-1 fail-closed
// -----------------------------------------------------------------------------

test('isCreationEnabled: crear_issues true (booleano) ⇒ true', () => {
    assert.strictEqual(cut.isCreationEnabled({ configPath: configCon('recomendaciones:\n  crear_issues: true\n') }), true);
});

test('isCreationEnabled: crear_issues false ⇒ false', () => {
    assert.strictEqual(cut.isCreationEnabled({ configPath: configCon('recomendaciones:\n  crear_issues: false\n') }), false);
});

test('isCreationEnabled: ausente, null, "true", 1 o sección no-mapa ⇒ false', () => {
    const casos = [
        'otra_cosa: 1\n',
        'recomendaciones: {}\n',
        'recomendaciones:\n  crear_issues: null\n',
        'recomendaciones:\n  crear_issues: "true"\n',
        'recomendaciones:\n  crear_issues: 1\n',
        'recomendaciones: true\n',
        'recomendaciones:\n  crear_issues: yes-please\n',
    ];
    for (const c of casos) {
        cut._resetCacheForTests();
        assert.strictEqual(cut.isCreationEnabled({ configPath: configCon(c) }), false, c);
    }
});

test('isCreationEnabled: YAML roto, vacío o archivo inexistente ⇒ false', () => {
    assert.strictEqual(cut.isCreationEnabled({ configPath: configCon('recomendaciones: [\n  : : :\n') }), false);
    cut._resetCacheForTests();
    assert.strictEqual(cut.isCreationEnabled({ configPath: configCon('') }), false);
    cut._resetCacheForTests();
    assert.strictEqual(cut.isCreationEnabled({ configPath: configCon(null) }), false);
});

test('isCreationEnabled: fs que tira ⇒ false (nunca propaga)', () => {
    const fsImpl = { readFileSync() { throw new Error('EACCES'); } };
    assert.strictEqual(cut.isCreationEnabled({ configPath: 'x/config.yaml', fsImpl }), false);
});

test('isCreationEnabled: respeta el TTL de la caché y relee al vencer (SEC-6)', () => {
    const file = configCon('recomendaciones:\n  crear_issues: false\n');
    const t0 = 1_000_000;
    assert.strictEqual(cut.isCreationEnabled({ configPath: file, now: t0 }), false);
    fs.writeFileSync(file, 'recomendaciones:\n  crear_issues: true\n');
    // Dentro del TTL: sigue el valor cacheado.
    assert.strictEqual(cut.isCreationEnabled({ configPath: file, now: t0 + cut.CACHE_TTL_MS - 1 }), false);
    // Vencido: relee.
    assert.strictEqual(cut.isCreationEnabled({ configPath: file, now: t0 + cut.CACHE_TTL_MS }), true);
});

test('isCreationEnabled: el TTL nunca supera 60 s aunque se pida más', () => {
    assert.ok(cut.CACHE_TTL_MS <= 60_000);
    const file = configCon('recomendaciones:\n  crear_issues: false\n');
    const t0 = 5_000_000;
    assert.strictEqual(cut.isCreationEnabled({ configPath: file, now: t0, ttlMs: 10 * 60_000 }), false);
    fs.writeFileSync(file, 'recomendaciones:\n  crear_issues: true\n');
    assert.strictEqual(cut.isCreationEnabled({ configPath: file, now: t0 + 60_000, ttlMs: 10 * 60_000 }), true);
});

test('isCreationEnabled: el config.yaml real del repo trae el corte activo', () => {
    const real = path.join(__dirname, '..', '..', 'config.yaml');
    assert.strictEqual(cut.isCreationEnabled({ configPath: real }), false);
});

// -----------------------------------------------------------------------------
// hasRecommendationLabel
// -----------------------------------------------------------------------------

test('hasRecommendationLabel: CSV, array, mayúsculas y espacios', () => {
    assert.strictEqual(cut.hasRecommendationLabel('enhancement,tipo:recomendacion'), true);
    assert.strictEqual(cut.hasRecommendationLabel(' SOURCE:Recommendation '), true);
    assert.strictEqual(cut.hasRecommendationLabel(['bug', 'Tipo:Recomendacion']), true);
    assert.strictEqual(cut.hasRecommendationLabel(['bug', 'area:pipeline']), false);
    assert.strictEqual(cut.hasRecommendationLabel('recommendation:approved'), false);
    assert.strictEqual(cut.hasRecommendationLabel(null), false);
});

// -----------------------------------------------------------------------------
// matchBashCommand — variantes SEC-3
// -----------------------------------------------------------------------------

const POSITIVOS = [
    ['--label con comillas dobles', 'gh issue create --title "x" --label "enhancement,tipo:recomendacion" --body "b"'],
    ['--label=X', 'gh issue create --label=source:recommendation --title t'],
    ['-l X', 'gh issue create -l tipo:recomendacion -t t -b b'],
    ['-lX pegado', 'gh issue create -ltipo:recomendacion -t t'],
    ['comillas simples', "gh issue create --label 'tipo:recomendacion' --title 'x'"],
    ['varios --label', 'gh issue create --label enhancement --label priority:low --label source:recommendation'],
    ['mayúsculas', 'gh issue create --label "Tipo:Recomendacion"'],
    ['flags en otro orden y --repo', 'gh issue create --repo intrale/platform --body "hola" --title "t" -l "enhancement, tipo:recomendacion"'],
    ['con PATH exportado antes', 'export PATH="/c/Workspaces/gh-cli/bin:$PATH"; gh issue create --label "tipo:recomendacion"'],
    ['con && antes', 'cd /x && gh issue create --label tipo:recomendacion'],
    ['binario con path absoluto', '/c/Workspaces/gh-cli/bin/gh.exe issue create --label tipo:recomendacion'],
    ['multilínea con continuación', 'gh issue create \\\n  --title "[guru] x" \\\n  --label "enhancement,source:recommendation,tipo:recomendacion,needs:triage-backlog,priority:low" \\\n  --body "## Contexto\n\nalgo; con punto y coma | y pipe"'],
    ['gh issue edit --add-label', 'gh issue edit 123 --add-label tipo:recomendacion'],
    ['gh issue edit --add-label=', 'gh issue edit 123 --add-label=source:recommendation,priority:low'],
    ['gh api -f labels[]=', "gh api repos/intrale/platform/issues -f title=x -f 'labels[]=tipo:recomendacion'"],
    ['gh api -F labels[]= sobre /labels', 'gh api repos/intrale/platform/issues/5/labels -F "labels[]=Source:Recommendation"'],
    ['gh api --field', 'gh api -X POST repos/o/r/issues --field labels[]=tipo:recomendacion'],
];

for (const [nombre, cmd] of POSITIVOS) {
    test(`matchBashCommand detecta: ${nombre}`, () => {
        const m = cut.matchBashCommand(cmd);
        assert.ok(m, `debió coincidir: ${cmd}`);
        assert.ok(m.labels.length >= 1);
        for (const l of m.labels) assert.ok(cut.RECOMMENDATION_LABELS.includes(l));
    });
}

const NEGATIVOS = [
    ['gh issue list', 'gh issue list --label tipo:recomendacion --state all'],
    ['gh issue edit con otro label', 'gh issue edit 5 --add-label priority:low'],
    ['gh issue edit remove-label de recomendación', 'gh issue edit 5 --remove-label tipo:recomendacion'],
    ['git commit con el texto', 'git commit -m "tipo:recomendacion"'],
    ['gh issue create sin labels de recomendación', 'gh issue create --label "enhancement,needs-definition" --title "x" --body "tipo:recomendacion en el body"'],
    ['gh issue view', 'gh issue view 7673 --json labels | grep tipo:recomendacion'],
    ['grep en el repo', 'grep -rn "source:recommendation" .pipeline/roles'],
    ['gh api de lectura sin labels', 'gh api "repos/o/r/issues?labels=tipo:recomendacion"'],
    ['echo', 'echo gh issue create --label tipo:recomendacion'],
    ['vacío', ''],
];

for (const [nombre, cmd] of NEGATIVOS) {
    test(`matchBashCommand NO bloquea: ${nombre}`, () => {
        assert.strictEqual(cut.matchBashCommand(cmd), null, cmd);
    });
}

test('matchBashCommand: título recortado a 120 y sin body en el resultado', () => {
    const m = cut.matchBashCommand(`gh issue create --title "${'A'.repeat(300)}" --body "SECRETO" -l tipo:recomendacion`);
    assert.ok(m);
    assert.strictEqual(m.kind, 'create');
    assert.strictEqual(m.title.length, 120);
    assert.ok(!JSON.stringify(m).includes('SECRETO'));
});

test('matchBashCommand: input no-string no tira', () => {
    assert.strictEqual(cut.matchBashCommand(null), null);
    assert.strictEqual(cut.matchBashCommand({}), null);
    assert.strictEqual(cut.matchBashCommand(42), null);
});

// -----------------------------------------------------------------------------
// CA-1 / CA-2 — los 5 roles emisores
// -----------------------------------------------------------------------------

const ROLES = ['guru', 'security', 'review', 'ux', 'po'];
const rolesDir = path.join(__dirname, '..', '..', 'roles');

for (const rol of ROLES) {
    test(`rol ${rol}: no instruye crear issues de recomendación y usa "Otras oportunidades observadas"`, () => {
        const texto = fs.readFileSync(path.join(rolesDir, `${rol}.md`), 'utf8');
        assert.ok(!/tipo:recomendacion/i.test(texto), `${rol}.md no puede mencionar tipo:recomendacion`);
        assert.ok(!/source:recommendation/i.test(texto), `${rol}.md no puede mencionar source:recommendation`);
        // Ningún bloque de código del protocolo trae una receta `gh issue create`
        // (la prosa sí la nombra, para prohibirla).
        const protocolo = texto.slice(texto.indexOf('## Protocolo de oportunidades de mejora'));
        const bloques = protocolo.match(/```[\s\S]*?```/g) || [];
        for (const b of bloques) {
            assert.ok(!/gh\s+(issue\s+create|api)/.test(b), `${rol}.md: el protocolo no puede traer una receta gh: ${b}`);
        }
        assert.ok(texto.includes('### Otras oportunidades observadas'), `${rol}.md debe tener el formato "Otras oportunidades observadas"`);
        assert.ok(/M[aá]ximo 3 oportunidades/.test(texto), `${rol}.md debe limitar a 3 oportunidades`);
        assert.ok(texto.includes('#7361'), `${rol}.md debe aclarar que el corte es transitorio hasta #7361`);
        assert.ok(texto.includes('recomendaciones.crear_issues'), `${rol}.md debe nombrar la bandera`);
    });
}

test('rol security: SEC-5 — vulnerabilidad explotable nunca va a "Otras oportunidades"', () => {
    const texto = fs.readFileSync(path.join(rolesDir, 'security.md'), 'utf8');
    assert.match(texto, /gravedad: grave/);
    assert.match(texto, /needs-definition/);
    assert.match(texto, /writeDeliverable\(\.\.\., sensible: true\)/);
    assert.ok(!/issue de recomendaci[oó]n con `needs:triage-backlog`/.test(texto), 'la línea de "Ruido" ya no manda a recomendación');
    assert.ok(!/Excepci[oó]n\*\*: vulnerabilidad explotable detectada \(priority:high/.test(texto), 'se elimina la excepción priority:high');
});
