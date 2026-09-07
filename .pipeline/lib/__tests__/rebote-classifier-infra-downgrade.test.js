// =============================================================================
// rebote-classifier-infra-downgrade.test.js — #6745
//
// Cubre el DECISOR ÚNICO de infra vs código: precedencia CA-8, piso de
// `security` fail-closed (CA-7 / SEC-B / SEC-C), degradado por señal de código
// (CA-2), invariante de asimetría (CA-10 / SEC-A) y el enum cerrado de
// `infra_downgraded_by` (SEC-E).
//
// POR QUÉ IMPORTA: `infra` es la ÚNICA clase de rebote sin cota superior —
// `rebote-counter.js` la excluye del circuit breaker genérico. Un rebote mal
// clasificado como `infra` reencola en la misma fase sin consumir budget, y si
// la acción pedida sólo la puede ejecutar un skill upstream, el issue queda en
// un bucle sin salida. Costo anotado en `pulpo.js` para el precedente #3741:
// ~$80–100/h.
//
// Todas las funciones bajo test son puras: cero mocks, cero filesystem.
// =============================================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const rc = require('../rebote-classifier');
const precheck = require('../../connectivity-precheck');
const { SKILLS_PISO_GRAVE } = require('../rejection-severity');

// Allowlist realista, con el mismo shape que produce
// `workfile-name.buildSkillAllowlist(config)`.
const ALLOWLIST = new Set([
  'po', 'ux', 'guru', 'architect',
  'backend-dev', 'android-dev', 'web-dev', 'pipeline-dev', 'dev',
  'build', 'tester', 'security', 'qa', 'linter', 'review', 'delivery',
]);

// Enum cerrado de CA-10 / SEC-E.
const DOWNGRADE_ENUM = ['security_floor', 'code_signal', 'phase_capability', null];

/**
 * Reproduce EXACTAMENTE el camino de decisión de `pulpo.js`: evidencia tipada
 * del pre-check + skill validado contra el allowlist.
 */
function veredicto(motivo, opts = {}) {
  const args = {
    motivo,
    classifyErrorDetail: precheck.classifyErrorDetailed(motivo),
    classifyErrorResult: precheck.classifyError(motivo),
    skillAllowlist: 'skillAllowlist' in opts ? opts.skillAllowlist : ALLOWLIST,
    ...opts,
  };
  delete args.skillAllowlistOmitida;
  return rc.classifyRebote(args);
}

// =============================================================================
// CA-1 + CA-2 — #6179: patrón de infra DENTRO de un identificador de código
//
// Los tres motivos de abajo son las reproducciones que `security` verificó
// contra `main` y publicó en el hilo de #6745: los tres clasificaban `infra`
// antes de este fix, con la palabra infra escondida en un identificador o en
// una referencia `archivo.ext:linea`.
// =============================================================================

test('#6179 CA-1 — patrón infra dentro de una constante citada como evidencia ⇒ NO infra', () => {
  const motivo = 'El gate falla: `LOCK_TIMEOUT_MS` está hardcodeado en 5000 y el '
    + 'criterio pedía leerlo de config. CA-2 incumplido.';
  const v = veredicto(motivo, { skill: 'review' });
  assert.notEqual(v.category, 'infra', 'un identificador citado no puede volver infra al rebote');
  assert.equal(v.category, 'code');
  assert.equal(v.counts_against_circuit_breaker, true, 'tiene que consumir budget del breaker');
});

test('#6179 CA-2 — "no esta commiteado" + ref archivo.ext:linea ⇒ NO infra', () => {
  const motivo = 'El cambio no esta commiteado: git status muestra dnsResolver.js:12 '
    + 'modificado sin agregar al índice.';
  const v = veredicto(motivo, { skill: 'linter' });
  assert.notEqual(v.category, 'infra');
  assert.equal(v.category, 'code');
  assert.equal(v.counts_against_circuit_breaker, true);
});

test('#6179 CA-1 — hallazgo de contenido con "dns" dentro de un método ⇒ NO infra', () => {
  const motivo = 'Secret hardcodeado en config.js:9 dentro de resolveDnsCache()';
  const v = veredicto(motivo, { skill: 'review' });
  assert.notEqual(v.category, 'infra');
  assert.equal(v.category, 'code');
});

test('#3741 verbatim — "timeout 15min" describiendo idempotencia del wizard ⇒ jamás infra', () => {
  // El caso está citado en `pulpo.js`: un motivo que hablaba de la idempotencia
  // del wizard mencionando "timeout 15min" clasificaba `infra` y salteaba el
  // handler de dependency_block, reencolando para siempre sin tocar el breaker.
  const motivo = 'El wizard no es idempotente: si el usuario reintenta dentro del '
    + 'timeout 15min se duplica el registro. Depende de #3700 todavía OPEN.';

  const conHint = veredicto(motivo, {
    skill: 'tester',
    rebote_categoria: 'dependency_block',
    dependsOn: [3700],
  });
  assert.equal(conHint.category, 'dependency_block');
  assert.notEqual(conHint.category, 'infra');

  // Y con señal de código en vez de hint de dependencia, tampoco puede ser infra:
  // ahí el degradado lo hace la señal de código, no el handler dep-block.
  const conSenalDeCodigo = veredicto(
    'El wizard no es idempotente: si el usuario reintenta dentro del timeout '
    + '15min se duplica el registro. WizardActivity.kt:88 quedó sin commitear.',
    { skill: 'tester' },
  );
  assert.notEqual(conSenalDeCodigo.category, 'infra');
  assert.equal(conSenalDeCodigo.category, 'code');
  assert.equal(conSenalDeCodigo.infra_downgraded_by, 'code_signal');
});

// =============================================================================
// CA-6 — REGRESIÓN: los casos legítimos de infra siguen siendo infra
// =============================================================================

test('CA-6 — prosa de red real sigue clasificando infra', () => {
  const v = veredicto('fallo por timeout de red a los 30s', { skill: 'qa' });
  assert.equal(v.category, 'infra');
  assert.equal(v.counts_against_circuit_breaker, false);
  assert.equal(v.infra_downgraded_by, null);
});

test('CA-6 — errno y machine tokens siguen clasificando infra', () => {
  for (const motivo of [
    'getaddrinfo ENOTFOUND api.github.com',
    'la conexión se cortó: ECONNRESET',
    'LINTER_BASE_UNAVAILABLE: no hay base confiable contra la cual comparar',
  ]) {
    const v = veredicto(motivo, { skill: 'linter' });
    assert.equal(v.category, 'infra', `esperaba infra para: ${motivo}`);
  }
});

// =============================================================================
// CA-8 — PRECEDENCIA: machine_token gana sobre code_signal (regresión de #6495)
// =============================================================================

test('#6495 CA-8 — LINTER_BASE_UNAVAILABLE + "git status" en el mismo motivo ⇒ infra', () => {
  // Si el machine token perdiera contra la señal de código, el fix de #6495 se
  // reintroduciría: un fetch caído volvería a rebotar a `dev` por algo que dev
  // no puede arreglar.
  const motivo = 'Excepción en linter.js: LINTER_BASE_UNAVAILABLE: no hay base '
    + "confiable contra la cual comparar ('origin/main'). Además git status "
    + 'reporta cambios sin commitear.';
  const v = veredicto(motivo, { skill: 'linter' });
  assert.equal(v.category, 'infra', 'el tier máquina NO se degrada por señal de código');
  assert.equal(v.infra_downgraded_by, null);
  // La acción pedida SÍ se reporta: la consume la regla de capacidad de fase
  // (CA-3), que puede cambiar el DESTINO sin cambiar la clasificación.
  assert.equal(v.accion_requerida, 'codigo');
});

test('CA-8 — errno también gana sobre la señal de código', () => {
  const v = veredicto('ETIMEDOUT contra la API. git status: 3 archivos sin commitear.', { skill: 'qa' });
  assert.equal(v.category, 'infra');
});

// =============================================================================
// CA-7 / SEC-B / SEC-C — PISO DE SECURITY, fail-closed de verdad
// =============================================================================

test('CA-7 — un rechazo de `security` NUNCA clasifica infra, aunque el motivo sea infra genuino', () => {
  const v = veredicto('ETIMEDOUT al contactar la API de verificación', { skill: 'security' });
  assert.notEqual(v.category, 'infra');
  assert.equal(v.category, 'code');
  assert.equal(v.infra_downgraded_by, 'security_floor');
  assert.equal(v.counts_against_circuit_breaker, true);
});

test('CA-7 — el piso se consume de `rejection-severity` como fuente única (sin duplicar la lista)', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'rebote-classifier.js'), 'utf8',
  );
  assert.ok(src.includes("require('./rejection-severity')"),
    'el piso tiene que importarse, no re-declararse');
  assert.ok(!/SKILLS_PISO_GRAVE\s*=/.test(src),
    'rebote-classifier.js NO puede definir su propia copia de SKILLS_PISO_GRAVE');
  // Y el skill del piso tiene que estar realmente ahí.
  assert.ok(SKILLS_PISO_GRAVE.includes('security'));
});

test('SEC-B — skill ausente ⇒ NO infra (fail-closed, no es un `if (!skill)` de adorno)', () => {
  for (const skill of [undefined, null, '', '   ']) {
    const v = veredicto('ETIMEDOUT al contactar la API', { skill });
    assert.notEqual(v.category, 'infra', `skill=${JSON.stringify(skill)} no puede habilitar infra`);
    assert.equal(v.infra_downgraded_by, 'security_floor');
  }
});

test('SEC-B — skill FUERA del allowlist (`secur1ty`) ⇒ NO infra', () => {
  // `skillFromFile('6745.secur1ty')` devuelve 'secur1ty', NO null: por eso el
  // fail-closed tiene que validar contra el allowlist y no contra la verdad.
  const v = veredicto('ETIMEDOUT al contactar la API', { skill: 'secur1ty' });
  assert.notEqual(v.category, 'infra');
  assert.equal(v.infra_downgraded_by, 'security_floor');
});

test('SEC-B — sin allowlist tampoco se puede validar ⇒ NO infra', () => {
  const v = veredicto('ETIMEDOUT al contactar la API', { skill: 'qa', skillAllowlist: null });
  assert.notEqual(v.category, 'infra');
  assert.equal(v.infra_downgraded_by, 'security_floor');
});

test('SEC-C — el piso es del REBOTE COMPLETO, no del motivo suelto', () => {
  // Agregación AND (`every`), tal como la calcula `pulpo.js`: alcanza con que un
  // motivo no sea infra para que TODO el rebote deje de serlo.
  const motivos = [
    { skill: 'security', motivo: 'ETIMEDOUT al contactar el escáner de dependencias' },
    { skill: 'qa', motivo: 'fallo por timeout de red a los 30s' },
  ];
  const veredictos = motivos.map(m => veredicto(m.motivo, { skill: m.skill }));

  assert.equal(veredictos[1].category, 'infra', 'el motivo de qa sí es infra genuino');
  assert.notEqual(veredictos[0].category, 'infra', 'el de security nunca');

  const esReboteDeInfra = veredictos.length > 0 && veredictos.every(v => v.category === 'infra');
  assert.equal(esReboteDeInfra, false, 'un solo motivo de security tumba el infra de todo el rebote');
});

// =============================================================================
// CA-10 / SEC-A / SEC-E — asimetría y enum cerrado
// =============================================================================

test('SEC-A — motivo vacío, nulo o no clasificable ⇒ `code`, NUNCA `infra`', () => {
  // Éste es el único freno si mañana alguien mete un `return 'infra'` de fallback.
  for (const motivo of ['', '   ', null, undefined, 'blah blah sin ninguna señal']) {
    const v = veredicto(motivo, { skill: 'qa' });
    assert.notEqual(v.category, 'infra', `motivo ${JSON.stringify(motivo)} no puede ser infra`);
    assert.equal(v.counts_against_circuit_breaker, true, 'el fallback seguro SÍ tiene cota');
  }
});

test('SEC-A — la invariante de asimetría está escrita en el módulo, en criollo', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'connectivity-precheck.js'), 'utf8');
  assert.ok(/INVARIANTE DE ASIMETR/i.test(src), 'falta el comentario de invariante (CA-10)');
  assert.ok(/EVIDENCIA POSITIVA/i.test(src));
  assert.ok(/NUNCA agregar un `return 'infra'` como default/.test(src));
});

test('SEC-E — `infra_downgraded_by` es un enum cerrado y no filtra NINGÚN fragmento del motivo', () => {
  const motivo = 'Hallazgo: el token sk-VERYSECRET-9 aparece en config.js:9 dentro de '
    + 'resolveDnsCache(), con ETIMEDOUT de fondo.';
  const casos = [
    veredicto(motivo, { skill: 'security' }),
    veredicto(motivo, { skill: 'review' }),
    veredicto('fallo por timeout de red a los 30s', { skill: 'qa' }),
    veredicto('El cambio no esta commiteado. git status lo confirma. `LOCK_TIMEOUT_MS`.', { skill: 'review' }),
  ];

  const palabras = motivo.split(/\s+/).filter(w => w.length >= 4);
  for (const v of casos) {
    assert.ok(DOWNGRADE_ENUM.includes(v.infra_downgraded_by),
      `valor fuera del enum cerrado: ${JSON.stringify(v.infra_downgraded_by)}`);
    if (v.infra_downgraded_by === null) continue;
    for (const w of palabras) {
      assert.ok(!v.infra_downgraded_by.includes(w),
        `el enum no puede contener "${w}" (SEC-E: nunca una cita del motivo)`);
    }
  }
});

test('CA-11 — `classifyError` sigue siendo un wrapper con la firma intacta', () => {
  assert.equal(precheck.classifyError(null), null);
  assert.equal(precheck.classifyError('getaddrinfo ENOTFOUND'), 'infra');
  assert.equal(precheck.classifyError('type mismatch'), 'codigo');
  assert.equal(precheck.classifyError({ code: 'ECONNREFUSED' }), 'infra');
  // Y la concatenación de tiers sigue exportándose igual.
  assert.deepEqual(
    precheck.INFRA_MESSAGE_PATTERNS.map(p => p.source),
    [...precheck.INFRA_MACHINE_TOKENS, ...precheck.INFRA_PROSE_PATTERNS].map(p => p.source),
  );
});

test('SEC-D — la ventana de truncado es ÚNICA en todo el camino de decisión', () => {
  assert.equal(rc.MAX_MOTIVO_LEN, precheck.MAX_MOTIVO_SCAN_LEN,
    'dos ventanas distintas ⇒ un token entre ambas lo ve un módulo y el otro no (evasión)');
  assert.equal(precheck.MAX_MOTIVO_SCAN_LEN, 8192);
});

// =============================================================================
// Ramas defensivas del decisor único (cobertura de las ramas nuevas)
// =============================================================================

test('SEC-B — el allowlist se puede derivar de `config` cuando no viene explícito', () => {
    const config = {
        pipelines: {
            desarrollo: {
                skills_por_fase: { dev: ['pipeline-dev'], verificacion: ['tester', 'security', 'qa'] },
            },
        },
    };
    // Skill dentro del allowlist derivado ⇒ el piso no lo frena.
    const ok = rc.classifyRebote({
        motivo: 'ETIMEDOUT al contactar la API',
        classifyErrorDetail: precheck.classifyErrorDetailed('ETIMEDOUT al contactar la API'),
        skill: 'tester',
        config,
    });
    assert.equal(ok.category, 'infra');

    // Skill fuera del allowlist derivado ⇒ fail-closed.
    const no = rc.classifyRebote({
        motivo: 'ETIMEDOUT al contactar la API',
        classifyErrorDetail: precheck.classifyErrorDetailed('ETIMEDOUT al contactar la API'),
        skill: 'tester-fake',
        config,
    });
    assert.notEqual(no.category, 'infra');
    assert.equal(no.infra_downgraded_by, 'security_floor');

    // Y un allowlist como Array (no Set) también se soporta.
    const arr = rc.classifyRebote({
        motivo: 'ETIMEDOUT al contactar la API',
        classifyErrorDetail: precheck.classifyErrorDetailed('ETIMEDOUT al contactar la API'),
        skill: 'tester',
        skillAllowlist: ['tester', 'qa'],
    });
    assert.equal(arr.category, 'infra');
});

test('CA-2 — un caller LEGACY que declara infra sobre un motivo de código NO obtiene infra', () => {
    // Contrato viejo: sólo `classifyErrorResult`, sin evidencia tipada. Si el
    // motivo trae señal fuerte de rechazo de código y NINGUNA evidencia de tier
    // máquina, el decisor lo degrada igual — `infra` exige evidencia positiva.
    const motivo = 'El cambio no esta commiteado: git status muestra archivos sin agregar.';
    const v = rc.classifyRebote({ motivo, classifyErrorResult: 'infra' });
    assert.notEqual(v.category, 'infra');
    assert.equal(v.category, 'code');
    assert.equal(v.infra_downgraded_by, 'code_signal');
    assert.equal(v.counts_against_circuit_breaker, true);
});

test('CA-4 — un `classifyErrorDetail` corrupto no puede colar un infra', () => {
    // Fail-closed ante shape inesperado: sin `clasificacion: 'infra'` no hay infra.
    for (const detail of [{}, { clasificacion: 'INFRA' }, { clasificacion: null }, { evidencia: 'errno' }]) {
        const v = rc.classifyRebote({
            motivo: 'algo pasó',
            classifyErrorDetail: detail,
            skill: 'qa',
            skillAllowlist: ALLOWLIST,
        });
        assert.notEqual(v.category, 'infra', `detail=${JSON.stringify(detail)}`);
    }
});
