// Tests de lib/config-schema.js (#3941, EP5-H4)
// node --test
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const {
    validateConfig,
    redactErrors,
    formatErrors,
    formatErrorsForHuman,
    sanitizeKeyName,
    resolveSide,
    describeConfigFailure,
    formatConfigFailureLog,
    formatConfigFailureTelegram,
    ConfigSchemaViolation,
    PROVIDER_ENUM,
    SIDE_MAP,
    AUTHORITY_PREFIXES,
    SCHEMA,
} = require('../config-schema');

// #5174 — La configuración EFECTIVA del repo: `.pipeline/config.yaml` (kernel)
// mergeado con `pipeline.config.json → productConfig`. Es lo que el pipeline
// enforza y lo único contra lo que tiene sentido afirmar «valida verde» o «todas
// las secciones están declaradas»: post-partición cada archivo por separado es,
// por construcción, un documento incompleto (al kernel le falta
// `pipelines.*.skills_por_fase`, que el schema exige).
const configResolver = require('../config-resolver');

function configReal() {
    return configResolver.resolveMergedForDiff({
        kernelText: fs.readFileSync(path.join(__dirname, '..', '..', 'config.yaml'), 'utf8'),
        productText: fs.readFileSync(path.join(__dirname, '..', '..', '..', 'pipeline.config.json'), 'utf8'),
    }).config;
}

// Config mínimo VÁLIDO con todas las claves críticas bien tipadas.
function validConfig() {
    return {
        circuit_breaker: {
            infra_escalate_threshold: 5,
            auto_resume_ok_threshold: 3,
        },
        resource_limits: {
            green_max_percent: 50,
            yellow_max_percent: 65,
            orange_max_percent: 80,
            red_max_percent: 90,
            priority_windows_activation_threshold: 3,
            max_concurrent_devs: 1,
        },
        concurrencia: { po: 2, 'backend-dev': 3 },
        handoff: { enabled: false, kill_switch: false, inject_in_phases: ['criterios'] },
        pipelines: {
            desarrollo: {
                fases: ['dev', 'build'],
                skills_por_fase: { dev: ['pipeline-dev'], build: ['build'] },
            },
        },
    };
}

test('config válido pasa la validación', () => {
    const { valid, errors } = validateConfig(validConfig());
    assert.strictEqual(valid, true);
    assert.deepStrictEqual(errors, []);
});

test('la configuración EFECTIVA del repo pasa la validación (no falsos positivos)', () => {
    // #5174 — kernel + producto resueltos. Validar `config.yaml` suelto daría un
    // falso NEGATIVO: post-partición le faltan las claves que viven en producto.
    const { valid, errors } = validateConfig(configReal());
    assert.strictEqual(valid, true, 'la config resuelta debe validar: ' + formatErrors(errors));
});

// #5173 — este test afirmaba lo contrario (raíz lenient). Con la raíz cerrada
// el comportamiento se invierte a propósito: es el corazón de la historia.
test('#5173 clave top-level no declarada YA NO pasa (raíz cerrada)', () => {
    const cfg = validConfig();
    cfg.una_feature_nueva = { cualquier: 'cosa', anidada: { x: 1 } };
    const { valid, errors } = validateConfig(cfg);
    assert.strictEqual(valid, false);
    assert.match(formatErrors(errors), /una_feature_nueva/);
});

test('#5173 clave extra dentro de una sección kernel/producto sigue pasando (lenient interno)', () => {
    const cfg = validConfig();
    cfg.pipelines.desarrollo.campo_nuevo = 42; // `pipelines` es kernel → lenient
    assert.strictEqual(validateConfig(cfg).valid, true);
});

test('#5173 clave extra dentro de una sección de AUTORIDAD es rechazada (estricta)', () => {
    const cfg = validConfig();
    cfg.circuit_breaker.un_campo_nuevo = 42; // `circuit_breaker` es autoridad → estricto
    const { valid, errors } = validateConfig(cfg);
    assert.strictEqual(valid, false);
    assert.match(formatErrors(errors), /un_campo_nuevo/);
});

test('typo en clave crítica del circuit breaker es rechazado (clave requerida faltante)', () => {
    const cfg = validConfig();
    delete cfg.circuit_breaker.auto_resume_ok_threshold;
    cfg.circuit_breaker.auto_resume_ok_treshold = 3; // typo
    const { valid, errors } = validateConfig(cfg);
    assert.strictEqual(valid, false);
    assert.ok(errors.some((e) => e.keyword === 'required' && /auto_resume_ok_threshold/.test(e.detail)));
});

test('tipo equivocado en umbral del circuit breaker es rechazado', () => {
    const cfg = validConfig();
    cfg.circuit_breaker.infra_escalate_threshold = 'cinco';
    const { valid, errors } = validateConfig(cfg);
    assert.strictEqual(valid, false);
    assert.ok(errors.some((e) => e.keyword === 'type'));
});

test('typo en ventana de prioridad (resource_limits) es rechazado', () => {
    const cfg = validConfig();
    delete cfg.resource_limits.priority_windows_activation_threshold;
    cfg.resource_limits.priority_windows_activaton_threshold = 3; // typo
    const { valid, errors } = validateConfig(cfg);
    assert.strictEqual(valid, false);
    assert.ok(errors.some((e) => /priority_windows_activation_threshold/.test(e.detail)));
});

test('porcentaje fuera de rango (0-100) es rechazado', () => {
    const cfg = validConfig();
    cfg.resource_limits.green_max_percent = 150;
    const { valid, errors } = validateConfig(cfg);
    assert.strictEqual(valid, false);
    assert.ok(errors.some((e) => e.keyword === 'maximum'));
});

test('valor no entero en concurrencia es rechazado', () => {
    const cfg = validConfig();
    cfg.concurrencia['backend-dev'] = 'tres';
    const { valid, errors } = validateConfig(cfg);
    assert.strictEqual(valid, false);
    assert.ok(errors.some((e) => e.keyword === 'type'));
});

test('typo en handoff (enabled) es rechazado', () => {
    const cfg = validConfig();
    delete cfg.handoff.enabled;
    cfg.handoff.enable = false; // typo
    const { valid, errors } = validateConfig(cfg);
    assert.strictEqual(valid, false);
    assert.ok(errors.some((e) => /enabled/.test(e.detail)));
});

test('pipeline sin skills_por_fase es rechazado', () => {
    const cfg = validConfig();
    delete cfg.pipelines.desarrollo.skills_por_fase;
    const { valid, errors } = validateConfig(cfg);
    assert.strictEqual(valid, false);
    assert.ok(errors.some((e) => /skills_por_fase/.test(e.detail)));
});

test('provider inválido en multi_provider.order es rechazado (SEC-4)', () => {
    const cfg = validConfig();
    cfg.multi_provider = { order: ['claude', 'provider-inexistente'] };
    const { valid, errors } = validateConfig(cfg);
    assert.strictEqual(valid, false);
    assert.ok(errors.some((e) => e.keyword === 'enum'));
});

test('multi_provider.order con providers válidos pasa', () => {
    const cfg = validConfig();
    cfg.multi_provider = { order: [...PROVIDER_ENUM] };
    const { valid } = validateConfig(cfg);
    assert.strictEqual(valid, true);
});

test('config no-objeto (string) es rechazado como corrupción de raíz', () => {
    const { valid } = validateConfig('no soy un objeto');
    assert.strictEqual(valid, false);
});

test('SEC-2: los errores NO contienen el valor crudo del input', () => {
    const cfg = validConfig();
    const SECRETO = 'sk-super-secret-token-1234567890';
    cfg.circuit_breaker.infra_escalate_threshold = SECRETO; // valor crudo sensible
    const { valid, errors } = validateConfig(cfg);
    assert.strictEqual(valid, false);
    const serialized = JSON.stringify(errors) + '|' + formatErrors(errors);
    assert.ok(!serialized.includes(SECRETO), 'el valor crudo NO debe aparecer en los errores');
    // Pero sí debe indicar path + tipo esperado.
    assert.ok(errors.some((e) => e.path.includes('infra_escalate_threshold') && /integer/.test(e.detail)));
});

test('valor por debajo del mínimo en circuit breaker es rechazado', () => {
    const cfg = validConfig();
    cfg.circuit_breaker.auto_resume_ok_threshold = 0; // mínimo es 1
    const { valid, errors } = validateConfig(cfg);
    assert.strictEqual(valid, false);
    assert.ok(errors.some((e) => e.keyword === 'minimum' && /mínimo permitido: 1/.test(e.detail)));
});

test('SEC-2: redactErrors tolera input no-array', () => {
    assert.deepStrictEqual(redactErrors(null), []);
    assert.deepStrictEqual(redactErrors(undefined), []);
});

test('redactErrors mapea cada keyword a un detalle SIN valor crudo (additionalProperties/default)', () => {
    const synthetic = [
        { instancePath: '/x', keyword: 'additionalProperties', params: { additionalProperty: 'clave_extra' } },
        { instancePath: '/y', keyword: 'pattern', params: {}, message: 'must match pattern' }, // default branch
        { instancePath: '', keyword: 'type', params: { type: 'integer' } }, // path raíz → '(root)'
    ];
    const out = redactErrors(synthetic);
    assert.strictEqual(out[0].detail, "clave no permitida: 'clave_extra'");
    assert.strictEqual(out[1].detail, 'must match pattern');
    assert.strictEqual(out[2].path, '(root)');
});

test('formatErrors devuelve string vacío sin errores', () => {
    assert.strictEqual(formatErrors([]), '');
    assert.strictEqual(formatErrors(null), '');
});

test('ConfigSchemaViolation tiene name estable y guarda errores', () => {
    const err = new ConfigSchemaViolation('boom', [{ path: '/x', keyword: 'type', detail: 'tipo esperado: integer' }]);
    assert.strictEqual(err.name, 'ConfigSchemaViolation');
    assert.ok(err instanceof Error);
    assert.strictEqual(err.errors.length, 1);
});

// --- #4576 · firma_operador -------------------------------------------------

test('#4576 firma_operador válido pasa la validación', () => {
    const cfg = validConfig();
    cfg.firma_operador = {
        enabled: false, kill_switch: false, modo: 'dry-run',
        umbral_acuerdo_pct: 95, muestras_minimas: 20, decay_dias: 30,
        auditoria_pct: 10, go_live_date: null,
    };
    const { valid, errors } = validateConfig(cfg);
    assert.strictEqual(valid, true, formatErrors(errors));
});

test('#4576 firma_operador sin claves requeridas falla', () => {
    const cfg = validConfig();
    cfg.firma_operador = { umbral_acuerdo_pct: 95 }; // faltan enabled/kill_switch/modo.
    const { valid, errors } = validateConfig(cfg);
    assert.strictEqual(valid, false);
    const detalles = formatErrors(errors);
    assert.match(detalles, /enabled/);
    assert.match(detalles, /modo/);
});

test('#4576 firma_operador con modo fuera del enum falla', () => {
    const cfg = validConfig();
    cfg.firma_operador = { enabled: true, kill_switch: false, modo: 'auto-siempre' };
    const { valid, errors } = validateConfig(cfg);
    assert.strictEqual(valid, false);
    assert.match(formatErrors(errors), /enum/);
});

test('#4576 firma_operador con umbral fuera de rango falla', () => {
    const cfg = validConfig();
    cfg.firma_operador = { enabled: true, kill_switch: false, modo: 'enforce', umbral_acuerdo_pct: 150 };
    const { valid, errors } = validateConfig(cfg);
    assert.strictEqual(valid, false);
    assert.match(formatErrors(errors), /máximo/);
});

test('#4576 firma_operador go_live_date acepta string o null', () => {
    const cfg = validConfig();
    cfg.firma_operador = { enabled: true, kill_switch: false, modo: 'enforce', go_live_date: '2026-07-01T00:00:00Z' };
    assert.strictEqual(validateConfig(cfg).valid, true);
    cfg.firma_operador.go_live_date = null;
    assert.strictEqual(validateConfig(cfg).valid, true);
    cfg.firma_operador.go_live_date = 123; // número inválido.
    assert.strictEqual(validateConfig(cfg).valid, false);
});

// =============================================================================
// #5173 · Raíz cerrada + clasificación por lado (Entrega B de #5111)
// =============================================================================

// #5174 — post-partición el sujeto de estas afirmaciones es la configuración
// EFECTIVA (kernel + producto), no el archivo del kernel suelto: éste ya no es
// un documento completo por construcción (le falta `pipelines.*.skills_por_fase`
// y las 9 secciones que se mudaron a `pipeline.config.json`).
const realConfig = () => configReal();

// --- 1 · CA-7: sin cambio de comportamiento ---------------------------------

test('#5173 el config.yaml de HEAD valida verde contra el schema cerrado', () => {
    const { valid, errors } = validateConfig(realConfig());
    assert.strictEqual(valid, true,
        'config.yaml NO debe editarse para que valide: ' + formatErrors(errors));
});

// --- 2 · CA-1/CA-15: cobertura schema ↔ config ↔ SIDE_MAP -------------------

test('#5173 toda sección top-level de config.yaml está declarada en el schema y tiene lado', () => {
    const secciones = Object.keys(realConfig());
    const sinSchema = secciones.filter((k) => !(k in SCHEMA.properties));
    const sinLado = secciones.filter((k) => !(k in SIDE_MAP));
    assert.deepStrictEqual(sinSchema, [],
        'secciones sin declarar en SCHEMA.properties (el pipeline arrancaría pausado)');
    assert.deepStrictEqual(sinLado, [],
        'secciones sin lado declarado en SIDE_MAP');
    // Y al revés: el schema no declara secciones fantasma.
    const fantasma = Object.keys(SCHEMA.properties).filter((k) => !secciones.includes(k));
    assert.deepStrictEqual(fantasma, [], 'SCHEMA declara secciones que no existen en config.yaml');
});

test('#5173 la raíz del schema está cerrada', () => {
    assert.strictEqual(SCHEMA.additionalProperties, false);
});

// --- 3 · CA-2: los arrays y escalares se tipan con su forma real -------------

test('#5173 los arrays y las escalares top-level validan con su tipo real', () => {
    const cfg = realConfig();
    const ARRAYS = ['dev_routing_priority', 'pipeline_scope_keywords', 'prioridad_labels'];
    const ESCALARES = ['sherlock_enabled', 'sherlock_provider_budget_ms',
        'sherlock_max_reelaboraciones', 'sherlock_wait_budget_ms', 'telegram_burst_window_ms'];
    for (const k of ARRAYS) {
        assert.ok(Array.isArray(cfg[k]), k + ' debe ser array en config.yaml');
        assert.strictEqual(SCHEMA.properties[k].type, 'array', k + ' mal tipado en el schema');
    }
    for (const k of ESCALARES) {
        assert.ok(typeof cfg[k] !== 'object', k + ' debe ser escalar en config.yaml');
        assert.ok(['boolean', 'number'].includes(SCHEMA.properties[k].type),
            k + ' mal tipado en el schema');
    }
    // Tiparlos como `object` es la vía #1 de romper el arranque: lo verificamos.
    const roto = realConfig();
    roto.dev_routing_priority = { no: 'soy array' };
    assert.strictEqual(validateConfig(roto).valid, false);
});

// --- 4 · CA-8: la lista de autoridad es inmutable y vive en código -----------

test('#5173 la lista de autoridad es inmutable y no se sobreescribe desde configuración', () => {
    assert.ok(Object.isFrozen(AUTHORITY_PREFIXES), 'AUTHORITY_PREFIXES debe estar congelada');
    assert.ok(Object.isFrozen(SIDE_MAP), 'SIDE_MAP debe estar congelado');
    const antes = AUTHORITY_PREFIXES.slice();
    try { AUTHORITY_PREFIXES.push('firma_operador_falsa'); } catch { /* strict mode */ }
    try { AUTHORITY_PREFIXES[0] = 'nada'; } catch { /* strict mode */ }
    assert.deepStrictEqual(AUTHORITY_PREFIXES.slice(), antes);

    // Y no se puede degradar desde el config: el lado resuelto no depende del YAML.
    const cfg = realConfig();
    cfg.firma_operador.modo = 'dry-run';
    assert.strictEqual(resolveSide('firma_operador.modo'), 'autoridad');
});

// --- 5 · CA-9: la autoridad entra por sección entera, no por sub-clave suelta -

test('#5173 toda clave de una sección de autoridad está cubierta por la lista congelada', () => {
    const cfg = realConfig();
    const SECCIONES_AUTORIDAD = Object.keys(SIDE_MAP)
        .filter((k) => SIDE_MAP[k] === 'autoridad' && !k.includes('.'));
    assert.ok(SECCIONES_AUTORIDAD.length >= 11, 'deben declararse al menos 11 secciones de autoridad');
    for (const sec of SECCIONES_AUTORIDAD) {
        assert.strictEqual(resolveSide(sec), 'autoridad', sec + ' debe resolver a autoridad');
        for (const sub of Object.keys(cfg[sec] || {})) {
            assert.strictEqual(resolveSide(sec + '.' + sub), 'autoridad',
                sec + '.' + sub + ' quedó fuera de la cobertura de autoridad');
        }
    }
    // Las que el snippet original del issue dejaba editables por enumerar
    // sub-claves sueltas en vez de prefijos de sección:
    for (const p of ['firma_operador.modo', 'operator_signoff.gate_mode',
        'operator_signature.nonce_ttl_seconds', 'gates.gate3.timeout_ms',
        'gates.gate3.timeout_ms.reseed-wave', 'commander_products.default_product',
        'commander_products.products.Intrale.operators', 'cross_repo_delivery.repos']) {
        assert.strictEqual(resolveSide(p), 'autoridad', p + ' debe ser autoridad');
    }
    // `architect` NO entra entera: su calibración es producto.
    assert.strictEqual(resolveSide('architect.enabled'), 'autoridad');
    assert.strictEqual(resolveSide('architect.poll_cap_min'), 'producto');
});

test('#5173 una clave sin lado declarado cae a kernel (fail-closed), nunca a producto', () => {
    assert.strictEqual(resolveSide('seccion_que_no_existe'), 'kernel');
    assert.strictEqual(resolveSide('routing.algo.muy.anidado'), 'kernel');
    assert.strictEqual(resolveSide(''), 'kernel');
    assert.strictEqual(resolveSide(null), 'kernel');
});

test('#5173 el split de una sección gana sobre el lado de la sección', () => {
    assert.strictEqual(resolveSide('pipelines'), 'kernel');
    assert.strictEqual(resolveSide('pipelines.desarrollo.fases'), 'kernel');
    assert.strictEqual(resolveSide('pipelines.desarrollo.skills_por_fase'), 'producto');
    assert.strictEqual(resolveSide('multi_provider'), 'kernel');
    assert.strictEqual(resolveSide('multi_provider.order'), 'producto');
    assert.strictEqual(resolveSide('deliverable_notifications.skills'), 'producto');
});

// --- 6 · CA-10 / REQ-UX-5: saneo del nombre de clave -------------------------

test('#5173 sanea claves hostiles en los tres caminos que llegan a Telegram', () => {
    const CLAVE_HOSTIL = 'ev*il' + String.fromCharCode(10) + '_INYECTADO_`x';
    const anidado = validConfig();
    anidado.concurrencia[CLAVE_HOSTIL] = 'no-integer';
    const raiz = validConfig();
    raiz[CLAVE_HOSTIL] = 1;

    const casos = [
        validateConfig(anidado),
        validateConfig(raiz),
        validateConfig({ [CLAVE_HOSTIL]: 1 }, { origin: 'producto' }),
    ];
    for (const { valid, errors } of casos) {
        assert.strictEqual(valid, false);
        const salida = formatErrorsForHuman(errors);
        // Se mide la variante que alimenta Telegram, no el formato completo del log.
        assert.ok(!salida.includes(String.fromCharCode(10)), 'el aviso debe quedar en una sola línea');
        assert.ok(!salida.includes('ev*il'), 'el asterisco crudo no debe viajar');
        // La clave sigue siendo reconocible aunque sus caracteres hostiles se colapsen.
        assert.match(salida, /ev\?il\?_INYECTADO_\?x/);
        assert.strictEqual((salida.match(/\*/g) || []).length % 2, 0);
        assert.strictEqual((salida.match(/`/g) || []).length % 2, 0);
    }
});

// Construye la violación tipada tal como la emite `config-resolver.resolve()`,
// que es la ÚNICA entrada de `haltOnConfigCorruption` desde #5172.
function violacionDeSchema(cfg) {
    const { valid, errors } = validateConfig(cfg);
    assert.strictEqual(valid, false, 'el caso de prueba tiene que ser inválido');
    const e = new ConfigSchemaViolation(formatErrors(errors), errors,
        { archivo: '/repo/.pipeline/config.yaml', via: 'default' });
    e.causa = 'schema-invalido';
    return e;
}

// Desde #5172 el texto que viaja a Telegram ya NO lo arma pulpo.js con un
// template inline: sale de `describeConfigFailure` + `formatConfigFailureTelegram`.
// El test de arriba mide `formatErrorsForHuman`, que es un ESLABÓN de esa cadena,
// no su salida. Sin este test el saneo queda protegido en el eslabón y desprotegido
// en la superficie real — exactamente el agujero que rebotó tres veces, corrido un
// nivel más arriba.
// Metacaracteres del Markdown legacy de Telegram que, en cantidad IMPAR, hacen
// que la API responda `400 Bad Request: can't parse entities` y el mensaje NO se
// entregue. `servicio-telegram` reintenta con el mismo parse_mode y archiva en
// `fallido/`, así que un desbalanceo = alerta de halt perdida.
// El `_` entra acá desde el rebote de seguridad de #5173: todas las claves del
// pipeline son snake_case, así que es el metacaracter MÁS probable, no el menos.
const METACHARS_MARKDOWN_LEGACY = [
    { nombre: 'asterisco', re: /\*/g },
    { nombre: 'backtick', re: /`/g },
    { nombre: 'guion bajo', re: /_/g },
];

/**
 * Cuenta ocurrencias NO escapadas (las precedidas por `\` ya no delimitan).
 * Telegram interpreta `\_` como un `_` literal, así que ese no cuenta.
 */
function contarSinEscapar(texto, re) {
    let n = 0;
    for (let i = 0; i < texto.length; i++) {
        if (texto[i] === '\\') { i++; continue; }
        re.lastIndex = 0;
        if (re.test(texto[i])) n++;
    }
    return n;
}

/** Un mensaje sólo es entregable si cada delimitador queda balanceado. */
function assertMarkdownEntregable(texto, contexto) {
    for (const { nombre, re } of METACHARS_MARKDOWN_LEGACY) {
        assert.strictEqual(contarSinEscapar(texto, re) % 2, 0,
            `${contexto}: cantidad impar de ${nombre} — Telegram devuelve 400 y la alerta se pierde`);
    }
}

test('#5173 el copy que viaja a Telegram sanea la clave hostil (superficie de #5172)', () => {
    // Impar a propósito: con 2 `_` el caso daba par de casualidad y el agujero
    // del `_` pasaba verde (así se coló en el PR anterior).
    const CLAVE_HOSTIL = 'ev*il' + String.fromCharCode(10) + '_INYECTADO_`x_impar';
    const anidado = validConfig();
    anidado.concurrencia[CLAVE_HOSTIL] = 'no-integer';
    const raiz = validConfig();
    raiz[CLAVE_HOSTIL] = 1;

    for (const cfg of [anidado, raiz]) {
        const err = violacionDeSchema(cfg);
        const telegram = formatConfigFailureTelegram(
            describeConfigFailure(err, { contexto: 'halt-auto', maxErrores: 5 }),
            { pausaPreexistente: false });
        const log = formatConfigFailureLog(
            describeConfigFailure(err, { contexto: 'halt-auto' }),
            { titulo: 'CONFIG INVÁLIDA' });

        for (const texto of [telegram, log]) {
            assert.ok(!texto.includes('ev*il'), 'el asterisco crudo no debe viajar');
            assert.ok(!texto.includes('ev*il' + String.fromCharCode(10)),
                'el salto de línea crudo falsificaría un renglón de la alerta');
            // Saneada, no omitida: el operador tiene que poder identificar la
            // clave. Se comparan los `\` de escape aparte (abajo): son del
            // transporte Markdown, no del nombre.
            assert.match(texto.replace(/\\/g, ''), /ev\?il\?_INYECTADO_\?x_impar/);
        }
        // La paridad sólo aplica al saliente Markdown; el log va a disco en plano.
        assertMarkdownEntregable(telegram, 'clave hostil');
    }
});

// El rebote de seguridad de #5173: el guardián de arriba usa una clave INVENTADA
// y por eso no representaba el caso real. Las claves que de verdad van a aparecer
// en la alerta son las del config.yaml VIVO, y son todas snake_case: cada error
// de tipo mete tantos `_` como la clave tenga. Sobre 18 casos simulados, 8 daban
// `_` impar => 8 alertas de halt que Telegram descartaba con 400.
test('#5173 toda clave de la config real produce una alerta ENTREGABLE por Telegram', () => {
    const real = configReal();   // #5174 — kernel + producto: el universo de claves vivas
    assert.ok(real && typeof real === 'object', 'no se pudo resolver la config real');

    // Un error de tipo por sección top-level: reproduce "el operador editó el
    // config y se equivocó en una clave", que es el disparador real del halt.
    const casos = [];
    for (const [seccion, valor] of Object.entries(real)) {
        if (valor && typeof valor === 'object' && !Array.isArray(valor)) {
            for (const clave of Object.keys(valor)) casos.push([seccion, clave]);
        } else {
            casos.push([seccion, null]);
        }
    }
    assert.ok(casos.length > 0, 'el config.yaml real no aportó casos');

    let evaluados = 0;
    for (const [seccion, clave] of casos) {
        const cfg = JSON.parse(JSON.stringify(real));
        // Valor que no valida contra ningún tipo escalar esperado.
        if (clave === null) cfg[seccion] = 'valor-de-tipo-invalido-#5173';
        else cfg[seccion][clave] = 'valor-de-tipo-invalido-#5173';

        const res = validateConfig(cfg);
        if (res.valid) continue; // esa clave admite string: no dispara halt.
        const err = new ConfigSchemaViolation('config inválida', res.errors);
        const texto = formatConfigFailureTelegram(
            describeConfigFailure(err, { contexto: 'halt-auto', maxErrores: 5 }),
            { pausaPreexistente: false });

        assertMarkdownEntregable(texto, `${seccion}${clave ? '.' + clave : ''}`);
        // Legibilidad (REQ-UX-5): el nombre de la clave sigue siendo el real,
        // sin colapsar a `?`, una vez quitados los escapes de transporte.
        if (clave !== null) {
            assert.ok(texto.replace(/\\/g, '').includes(clave),
                `la alerta debe nombrar la clave ${clave} de forma legible`);
        }
        evaluados++;
    }
    assert.ok(evaluados >= 5,
        `se esperaban varias claves que disparen halt, se evaluaron ${evaluados}`);
});

// CA-11 sobre la superficie real: el cap es del generador, no del call-site.
test('#5173 el copy de Telegram va acotado y el del log completo', () => {
    const cfg = validConfig();
    for (let i = 0; i < 20; i++) cfg['seccion_desconocida_' + i] = { x: 1 };
    const err = violacionDeSchema(cfg);

    const telegram = formatConfigFailureTelegram(
        describeConfigFailure(err, { contexto: 'halt-auto', maxErrores: 5 }),
        { pausaPreexistente: false });
    const log = formatConfigFailureLog(
        describeConfigFailure(err, { contexto: 'halt-auto' }),
        { titulo: 'CONFIG INVÁLIDA' });

    assert.ok(telegram.length < 4096, 'Telegram corta en 4096 chars');
    assert.match(telegram, /\(\+\d+ error\/es más/);
    // #5173 (rebote seguridad) — el saliente lleva los `_` escapados para que
    // Telegram no los lea como itálica; el nombre real se recupera quitando los
    // `\` de transporte, que es lo que el operador termina viendo renderizado.
    const telegramRenderizado = telegram.replace(/\\/g, '');
    const nombradasEnTelegram = [...Array(20).keys()]
        .filter((i) => telegramRenderizado.includes('seccion_desconocida_' + i)).length;
    assert.strictEqual(nombradasEnTelegram, 5, 'la alerta nombra 5 y cuenta el resto');
    assertMarkdownEntregable(telegram, 'copy acotado de CA-11');

    // El log es la vía de diagnóstico: no pierde ninguna, y sigue siendo una sola
    // línea (el visor de logs del dashboard sirve por línea).
    for (let i = 0; i < 20; i++) assert.match(log, new RegExp('seccion_desconocida_' + i));
    assert.strictEqual(log.split(String.fromCharCode(10)).length, 1);

    // CA-13: con la raíz cerrada, el copy apunta a declarar la sección nueva.
    assert.match(telegram, /config-schema\.js/);
});

test('#5173 sanitizeKeyName acota a 64 chars y colapsa lo no imprimible', () => {
    assert.strictEqual(sanitizeKeyName('ok_key.name-1'), 'ok_key.name-1');
    assert.strictEqual(sanitizeKeyName('a'.repeat(200)).length, 64);
    assert.strictEqual(sanitizeKeyName('a b'), 'a?b');
});

// --- 7 · CA-11: la notificación se acota, el log no ---------------------------

test('#5173 con más de 5 errores la notificación trae 5 más un contador y el log trae todos', () => {
    const cfg = validConfig();
    for (let i = 0; i < 9; i++) cfg['clave_mala_' + i] = 1;
    const { valid, errors } = validateConfig(cfg);
    assert.strictEqual(valid, false);
    assert.ok(errors.length >= 9);

    const humano = formatErrorsForHuman(errors);
    const completo = formatErrors(errors);
    assert.ok(humano.length < completo.length, 'la notificación debe ser más corta que el log');
    assert.match(humano, /\(\+\d+ error\/es más/);
    assert.strictEqual(humano.split('; ').length, 6, '5 errores + 1 línea de contador');
    // El log conserva TODOS: no se pierde diagnóstico.
    for (let i = 0; i < 9; i++) assert.match(completo, new RegExp('clave_mala_' + i));
});

test('#5173 formatErrorsForHuman no recorta cuando hay 5 errores o menos', () => {
    assert.strictEqual(formatErrorsForHuman([]), '');
    assert.strictEqual(formatErrorsForHuman(null), '');
    const pocos = [{ path: '/a', detail: 'x' }, { path: '/b', detail: 'y' }];
    assert.strictEqual(formatErrorsForHuman(pocos), formatErrors(pocos));
});

// --- 8 · CA-12: sugerencia de clave cercana ----------------------------------

test('#5173 circuit_breker sugiere circuit_breaker y una clave lejana no sugiere nada', () => {
    const cerca = validateConfig(Object.assign(validConfig(), { circuit_breker: {} }));
    const salidaCerca = formatErrors(cerca.errors);
    assert.match(salidaCerca, /¿quisiste decir 'circuit_breaker'\?/);
    // Una sola candidata, nunca una lista.
    assert.strictEqual((salidaCerca.match(/quisiste decir/g) || []).length, 1);

    const lejos = validateConfig(Object.assign(validConfig(), { zzzzzzzzzzzzzzz: {} }));
    assert.ok(!formatErrors(lejos.errors).includes('quisiste decir'),
        'distancia > 2 no debe sugerir nada');
});

// --- 9 · CA-12 / hallazgo BAJA-A09: el mensaje no filtra la lista congelada ---

test('#5173 el mensaje de lado autoridad no enumera la lista congelada', () => {
    const { errors } = validateConfig({ gates: { gate3: {} } }, { origin: 'producto' });
    const salida = formatErrors(errors);
    assert.match(salida, /autoridad/);
    const filtradas = AUTHORITY_PREFIXES
        .filter((p) => !p.startsWith('gates'))
        .filter((p) => salida.includes(p));
    assert.deepStrictEqual(filtradas, [],
        'el mensaje sólo puede nombrar el path que falló, no el resto de la lista');
});

// --- 10 · CA-4 + CA-7: las dos ramas de `origin` -----------------------------

test('#5173 validateConfig sin origin NO aplica chequeo de lado', () => {
    // El config real es 100% "monolito": tiene kernel + producto + autoridad
    // junto. Sin `origin` debe pasar igual (es exactamente el caso de pulpo hoy).
    assert.strictEqual(validateConfig(realConfig()).valid, true);
    assert.strictEqual(validateConfig(realConfig(), {}).valid, true);
    assert.strictEqual(validateConfig(realConfig(), { origin: 'monolito' }).valid, true);
});

test('#5173 con origin producto una clave de autoridad falla nombrando clave y lado', () => {
    const { valid, errors } = validateConfig(
        { firma_operador: { enabled: false, kill_switch: false, modo: 'dry-run' } },
        { origin: 'producto' }
    );
    assert.strictEqual(valid, false);
    const salida = formatErrors(errors);
    assert.match(salida, /firma_operador/, 'debe nombrar la clave');
    assert.match(salida, /autoridad/, 'debe nombrar el lado');
    assert.ok(errors.some((e) => e.keyword === 'side' && e.lado === 'autoridad'));
});

test('#5173 con origin producto una clave de kernel también falla, y una de producto pasa', () => {
    const soloProducto = {
        build: { java_home_allowlist: [] },
        telegram: { bot_username: 'x' },
        dev_skill_mapping: { 'area:pipeline': 'pipeline-dev' },
        pipelines: { desarrollo: { skills_por_fase: { dev: ['pipeline-dev'] } } },
        architect: { poll_cap_min: 5 },
    };
    const ok = validateConfig(soloProducto, { origin: 'producto' });
    assert.strictEqual(ok.valid, true, formatErrors(ok.errors));

    // El mismo bloque + una clave de kernel del split ⇒ falla en el path exacto.
    const conKernel = JSON.parse(JSON.stringify(soloProducto));
    conKernel.pipelines.desarrollo.fases = ['dev'];
    const r = validateConfig(conKernel, { origin: 'producto' });
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => e.path === '/pipelines/desarrollo/fases' && e.lado === 'kernel'));
});

// --- SEC: los errores de lado tampoco vuelcan el valor crudo -----------------

test('#5173 el chequeo de lado no vuelca el valor crudo', () => {
    const SECRETO = 'sk-super-secret-token-1234567890';
    const { errors } = validateConfig(
        { commander_products: { default_product: SECRETO, products: {} } },
        { origin: 'producto' }
    );
    const serializado = JSON.stringify(errors) + '|' + formatErrors(errors)
        + '|' + formatErrorsForHuman(errors);
    assert.ok(!serializado.includes(SECRETO), 'el valor crudo NO debe aparecer');
});

// --- 11 · CA-13 / REQ-UX-6: vocabulario único en el doc ----------------------

test('#5173 §2.4 del contrato usa vocabulario único kernel/producto/autoridad', () => {
    const docPath = path.join(__dirname, '..', '..', '..',
        'docs', 'pipeline', 'contrato-kernel-adaptador.md');
    const doc = fs.readFileSync(docPath, 'utf8');
    const desde = doc.indexOf('### 2.4.');
    assert.ok(desde > 0, 'debe existir la sección §2.4');
    const hasta = doc.indexOf('### 2.5.', desde);
    const s24 = doc.slice(desde, hasta > 0 ? hasta : undefined);

    assert.ok(!/a-decidir/.test(s24), '§2.4 no puede seguir usando `a-decidir`');
    assert.ok(!/\badaptador\b/.test(s24), '§2.4 debe decir `producto`, no `adaptador`');
    // Y están las 58 secciones clasificadas.
    for (const sec of Object.keys(realConfig())) {
        assert.ok(s24.includes('`' + sec + '`'), '§2.4 no clasifica la sección ' + sec);
    }
});
