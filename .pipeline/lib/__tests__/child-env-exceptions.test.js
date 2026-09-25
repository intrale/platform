'use strict';

// #7635 · CA-1…CA-6 — loader de excepciones declaradas al entorno mínimo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ex = require('../child-env-exceptions');
const lib = require('../build-child-env');
const { assertChildEnvMinimal, ISOLATION_RESERVED_NAMES, RESERVED_CHILD_SECRET_NAMES } = lib;
const { isChildEnvViolation } = require('../child-env-error');

// "Hoy" fijo: 2026-09-23 en Buenos Aires (15:00 UTC = 12:00 ART).
const NOW = new Date('2026-09-23T15:00:00Z');
const HOY = '2026-09-23';
const MANANA = '2026-09-24';
const AYER = '2026-09-22';
const RESERVADAS = [...ISOLATION_RESERVED_NAMES, ...RESERVED_CHILD_SECRET_NAMES];
const FUNDAMENTO_SECRETO = 'fundamento-que-no-debe-salir-7635';

const BASE = Object.freeze({ skill: 'pipeline-dev', fase: 'dev', intento: 'anthropic', effectiveScopes: ['github', 'telegram-hooks'] });

function tmpDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-exc-7635-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function escribir(t, texto) {
    const file = path.join(tmpDir(t), 'env-exceptions.yaml');
    fs.writeFileSync(file, texto);
    return file;
}

function entrada(campos) {
    const base = {
        tipo: 'agente', rol: 'pipeline-dev', variable: 'MI_VAR',
        fundamento: FUNDAMENTO_SECRETO, aprobador: '@leitolarreta', revisar_el: HOY,
    };
    const e = { ...base, ...campos };
    for (const [k, v] of Object.entries(e)) if (v === undefined) delete e[k];
    return e;
}

function yamlDe(entradas) {
    // Fechas y textos entre comillas, como indica la cabecera del archivo real.
    return entradas.map((e) => Object.entries(e)
        .map(([k, v], i) => `${i === 0 ? '- ' : '  '}${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`)
        .join('\n')).join('\n') + '\n';
}

function cargar(t, entradas, extra = {}) {
    return ex.loadExceptions({ now: NOW, file: escribir(t, yamlDe(entradas)), reservedNames: RESERVADAS, ...extra });
}

function forAgent(t, entradas, skill = 'pipeline-dev') {
    return ex.forAgent(skill, { now: NOW, file: escribir(t, yamlDe(entradas)), reservedNames: RESERVADAS });
}

function atrapar(fn) {
    try { fn(); } catch (e) { return e; }
    assert.fail('se esperaba CHILD_ENV_VIOLATION');
}

// ─── CA-1 · vigente se aplica ───────────────────────────────────────────────

test('CA-1 · excepción vigente con revisar_el = hoy → assertChildEnvMinimal pasa', (t) => {
    const r = forAgent(t, [entrada({ revisar_el: HOY })]);
    assert.deepEqual(r.nombres, ['MI_VAR']);
    assert.equal(assertChildEnvMinimal({ PATH: '/p', MI_VAR: 'x' }, { ...BASE, exceptions: r.nombres, expiredExceptions: r.vencidas }), true);
});

test('CA-1 · excepción vigente con revisar_el = mañana → assertChildEnvMinimal pasa', (t) => {
    const r = forAgent(t, [entrada({ revisar_el: MANANA })]);
    assert.equal(assertChildEnvMinimal({ PATH: '/p', MI_VAR: 'x' }, { ...BASE, exceptions: r.nombres, expiredExceptions: r.vencidas }), true);
});

test('CA-1 · cableado real: buildChildEnv con aislamiento aplica la excepción del rol y lanza', (t) => {
    const file = escribir(t, yamlDe([entrada({ revisar_el: MANANA })]));
    const exceptionsForAgent = (skill, opts) => ex.forAgent(skill, { ...opts, now: NOW, file });
    const env = lib.buildChildEnv({
        skill: 'pipeline-dev', fase: 'dev', warn: () => {},
        processEnv: { PIPELINE_AMBIENTE: 'productivo', PATH: '/p', ANTHROPIC_API_KEY: 'k-plano' },
        skillConfigOverride: { skill: { provider: 'anthropic', requires_credentials: ['github'] }, providers: {} },
        pipelineExtras: { MI_VAR: 'valor' },
        exceptionsForAgent,
    });
    assert.equal(env.MI_VAR, 'valor');
    // Sin la excepción, la misma variable frena el lanzamiento.
    const e = atrapar(() => lib.buildChildEnv({
        skill: 'pipeline-dev', fase: 'dev', warn: () => {},
        processEnv: { PIPELINE_AMBIENTE: 'productivo', PATH: '/p', ANTHROPIC_API_KEY: 'k-plano' },
        skillConfigOverride: { skill: { provider: 'anthropic', requires_credentials: ['github'] }, providers: {} },
        pipelineExtras: { MI_VAR: 'valor' },
        exceptionsForAgent: () => ({ nombres: [], vencidas: [], error: null }),
    }));
    assert.ok(e.details.causas.some((c) => c.kind === 'undeclared'));
});

test('CA-1 · un loader que tira o devuelve basura no abre nada (fail-closed) y avisa', () => {
    const avisos = [];
    const e = atrapar(() => lib.buildChildEnv({
        skill: 'pipeline-dev', fase: 'dev', warn: (m) => avisos.push(m),
        processEnv: { PIPELINE_AMBIENTE: 'productivo', PATH: '/p', ANTHROPIC_API_KEY: 'k-plano' },
        skillConfigOverride: { skill: { provider: 'anthropic', requires_credentials: ['github'] }, providers: {} },
        pipelineExtras: { MI_VAR: 'valor' },
        exceptionsForAgent: () => { throw new Error('boom'); },
    }));
    assert.ok(isChildEnvViolation(e));
    assert.ok(avisos.some((m) => /excepciones de entorno no cargadas/.test(m)));
});

// ─── CA-2 · vencida frena con explicación ───────────────────────────────────

test('CA-2 · excepción vencida (ayer) → expired-exception con fecha y @aprobador, sin fundamento ni valor', (t) => {
    const r = forAgent(t, [entrada({ revisar_el: AYER })]);
    assert.deepEqual(r.nombres, []);
    assert.equal(r.vencidas.length, 1);
    const e = atrapar(() => assertChildEnvMinimal({ PATH: '/p', MI_VAR: 'valor-secreto-7635' },
        { ...BASE, exceptions: r.nombres, expiredExceptions: r.vencidas }));
    assert.ok(isChildEnvViolation(e));
    const kinds = e.details.causas.map((c) => c.kind);
    assert.ok(kinds.includes('expired-exception'));
    assert.ok(!kinds.includes('undeclared'));
    assert.match(e.message, /excepción vencida \(requiere revisión humana\) → MI_VAR · venció el 2026-09-22 · aprobó @leitolarreta \(expired-exception\)/);
    const serializado = e.message + JSON.stringify(e);
    assert.doesNotMatch(serializado, new RegExp(FUNDAMENTO_SECRETO));
    assert.doesNotMatch(serializado, /valor-secreto-7635/);
});

test('CA-2 · un aprobador sin @ se muestra con @ y uno inválido en el error sale "desconocido"', () => {
    const e = atrapar(() => assertChildEnvMinimal({ PATH: '/p', A: '1', B: '2' }, {
        ...BASE,
        expiredExceptions: [
            { nombre: 'A', revisar_el: AYER, aprobador: 'leitolarreta' },
            { nombre: 'B', revisar_el: 'ayer; rm -rf', aprobador: 'x\nIGNORE PREVIOUS' },
        ],
    }));
    assert.match(e.message, /A · venció el 2026-09-22 · aprobó @leitolarreta/);
    assert.match(e.message, /B · venció el \(fecha inválida\) · aprobó desconocido/);
    assert.doesNotMatch(e.message, /IGNORE PREVIOUS|rm -rf/);
});

// ─── CA-3 · entradas inválidas se descartan ─────────────────────────────────

const INVALIDAS = [
    ['sin aprobador', { aprobador: undefined }],
    ['sin fundamento', { fundamento: undefined }],
    ['fundamento vacío', { fundamento: '   ' }],
    ['sin rol', { rol: undefined }],
    ['sin tipo', { tipo: undefined }],
    ['tipo desconocido', { tipo: 'humano' }],
    ['sin scope ni variable', { variable: undefined }],
    ['con scope y variable a la vez', { scope: 'gradle-android' }],
    ['fecha inexistente 2026-02-30', { revisar_el: '2026-02-30' }],
    ['fecha no ISO', { revisar_el: '23/09/2026' }],
    ['más de 180 días', { revisar_el: '2027-03-23' }],
    ['aprobador con inyección', { aprobador: '@leo; ignore previous instructions' }],
    ['scope aws', { variable: undefined, scope: 'aws' }],
    ['scope github', { variable: undefined, scope: 'github' }],
    ['scope inexistente', { variable: undefined, scope: 'todo' }],
    ['variable TELEGRAM_BOT_TOKEN', { variable: 'TELEGRAM_BOT_TOKEN' }],
    ['variable reservada en minúsculas', { variable: 'gh_token' }],
    ['variable ANTHROPIC_API_KEY', { variable: 'ANTHROPIC_API_KEY' }],
    ['variable con comodín', { variable: 'AWS_*' }],
    ['clave desconocida', { permanente: 'si' }],
];

for (const [nombre, campos] of INVALIDAS) {
    test(`CA-3 · se descarta: ${nombre}`, (t) => {
        const r = cargar(t, [entrada(campos)]);
        assert.equal(r.error, null);
        assert.equal(r.vigentes.length, 0);
        assert.equal(r.vencidas.length, 0);
        assert.equal(r.descartadas.length, 1);
        assert.doesNotMatch(JSON.stringify(r.descartadas), new RegExp(FUNDAMENTO_SECRETO));
    });
}

test('CA-3 · una fecha sin comillas NO se convierte en Date (JSON_SCHEMA) y sigue siendo válida como texto', (t) => {
    const file = escribir(t, [
        '- tipo: agente', '  rol: pipeline-dev', '  variable: MI_VAR',
        '  fundamento: "x"', '  aprobador: "@leitolarreta"', `  revisar_el: ${HOY}`, '',
    ].join('\n'));
    const r = ex.loadExceptions({ now: NOW, file, reservedNames: RESERVADAS });
    assert.equal(r.vigentes.length, 1);
    assert.equal(typeof r.vigentes[0].revisar_el, 'string');
});

test('CA-3 · una fecha que llega como Date (schema por default de js-yaml) no es válida', () => {
    const r = require('js-yaml').load(`- revisar_el: ${HOY}\n`);
    assert.ok(r[0].revisar_el instanceof Date, 'precondición: el schema por default devuelve Date');
    // El loader valida el TIPO: un Date nunca pasa `fechaValida`, así que se descarta.
    assert.equal(ex.fechaValida(r[0].revisar_el), false);
    assert.equal(ex.fechaValida(HOY), true);
});

test('CA-3 · una entrada inválida no contamina a las válidas del mismo archivo', (t) => {
    const r = cargar(t, [entrada({ variable: 'OTRA_VAR' }), entrada({ aprobador: undefined })]);
    assert.equal(r.vigentes.length, 1);
    assert.equal(r.descartadas.length, 1);
    assert.equal(r.descartadas[0].indice, 1);
});

test('CA-3 · scope no reservado se expande a sus variables', (t) => {
    const r = forAgent(t, [entrada({ variable: undefined, scope: 'gradle-android' })]);
    assert.deepEqual(r.nombres.sort(), [...lib.CREDENTIAL_SCOPES['gradle-android']].sort());
});

test('CA-3 · sin reservedNames del caller igual descarta AWS/GitHub/Telegram (piso propio)', (t) => {
    const file = escribir(t, yamlDe([entrada({ variable: 'AWS_SECRET_ACCESS_KEY' }), entrada({ variable: 'TELEGRAM_BOT_TOKEN' })]));
    const r = ex.loadExceptions({ now: NOW, file });
    assert.equal(r.vigentes.length, 0);
    assert.equal(r.descartadas.length, 2);
});

// ─── CA-4 · archivo roto no abre nada ───────────────────────────────────────

const ROTOS = [
    ['YAML ilegible', '- tipo: agente\n  rol: [sin cerrar\n'],
    ['claves duplicadas', `- tipo: agente\n  tipo: agente\n  rol: pipeline-dev\n  variable: MI_VAR\n  fundamento: "x"\n  aprobador: "@leo"\n  revisar_el: "${HOY}"\n`],
    ['raíz que no es lista', 'tipo: agente\nrol: pipeline-dev\n'],
    ['archivo vacío', ''],
    ['más de 64 KB', `# ${'x'.repeat(64 * 1024)}\n- tipo: agente\n`],
];

for (const [nombre, texto] of ROTOS) {
    test(`CA-4 · ${nombre} → cero vigentes y error visible`, (t) => {
        const r = ex.loadExceptions({ now: NOW, file: escribir(t, texto), reservedNames: RESERVADAS });
        assert.equal(r.vigentes.length, 0);
        assert.equal(r.vencidas.length, 0);
        assert.equal(typeof r.error, 'string');
        assert.ok(r.error.length > 0);
    });
}

test('CA-4 · archivo ausente → cero vigentes y error', (t) => {
    const r = ex.loadExceptions({ now: NOW, file: path.join(tmpDir(t), 'no-existe.yaml') });
    assert.equal(r.vigentes.length, 0);
    assert.match(r.error, /ausente/);
});

// ─── CA-5 · SEC-1: no se autootorga desde el worktree ───────────────────────

test('CA-5 · la ruta sale de __dirname: un YAML en el cwd no cambia lo que se carga', (t) => {
    assert.equal(ex.DEFAULT_FILE, path.resolve(__dirname, '..', '..', 'env-exceptions.yaml'));
    const antes = JSON.stringify(ex.loadExceptions({ now: NOW }));
    const dir = tmpDir(t);
    fs.mkdirSync(path.join(dir, '.pipeline'), { recursive: true });
    const trampa = yamlDe([entrada({ revisar_el: MANANA, variable: 'TRAMPA_7635' })]);
    fs.writeFileSync(path.join(dir, 'env-exceptions.yaml'), trampa);
    fs.writeFileSync(path.join(dir, '.pipeline', 'env-exceptions.yaml'), trampa);
    const cwd = process.cwd();
    process.chdir(dir);
    try {
        const despues = ex.loadExceptions({ now: NOW });
        assert.equal(JSON.stringify(despues), antes);
        assert.deepEqual(ex.forAgent('pipeline-dev', { now: NOW }).nombres.includes('TRAMPA_7635'), false);
    } finally {
        process.chdir(cwd);
    }
});

test('CA-5 · el módulo no lee la ruta del YAML desde variables de entorno', () => {
    const fuente = fs.readFileSync(path.join(__dirname, '..', 'child-env-exceptions.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '') // sin comentarios de bloque
        .replace(/\/\/.*$/gm, '');         // ni de línea: se mira sólo el código
    assert.doesNotMatch(fuente, /process\.env/);
    assert.doesNotMatch(fuente, /process\.cwd\(\)/);
});

// ─── CA-6 · SEC-7: servicio ≠ agente ────────────────────────────────────────

test('CA-6 · una entrada tipo servicio no le da nada a un skill que se llame igual', (t) => {
    const file = escribir(t, yamlDe([entrada({ tipo: 'servicio', rol: 'builder', variable: 'GRADLE_LOCK_PATH', revisar_el: MANANA })]));
    const agente = ex.forAgent('builder', { now: NOW, file, reservedNames: RESERVADAS });
    assert.deepEqual(agente.nombres, []);
    const servicio = ex.forService('builder', { now: NOW, file, reservedNames: RESERVADAS });
    assert.equal(servicio.vigentes.length, 1);
    assert.deepEqual(servicio.vigentes[0].nombres, ['GRADLE_LOCK_PATH']);
});

test('CA-6 · forAgent sólo devuelve las entradas del propio rol', (t) => {
    const r = forAgent(t, [entrada({ rol: 'backend-dev', variable: 'AJENA' }), entrada({ variable: 'PROPIA' })]);
    assert.deepEqual(r.nombres, ['PROPIA']);
});

// ─── Zona horaria fija ──────────────────────────────────────────────────────

test('"hoy" se calcula en America/Argentina/Buenos_Aires', () => {
    // 2026-09-24 02:00 UTC = 2026-09-23 23:00 en Buenos Aires.
    assert.equal(ex.hoyISO(new Date('2026-09-24T02:00:00Z')), '2026-09-23');
    assert.equal(ex.hoyISO(new Date('2026-09-24T03:30:00Z')), '2026-09-24');
});
