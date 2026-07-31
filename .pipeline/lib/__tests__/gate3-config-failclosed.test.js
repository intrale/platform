// =============================================================================
// gate3-config-failclosed.test.js — GATE 3 no se bypassea con config ilegible.
//                                   (#5172, rechazo de `review`)
// =============================================================================
//
// ## Qué defiende
//
// La migración al resolver único (#5172) cambió el contrato de error de
// `kernel-action-policy.loadGate3Config`: antes se comía sus fallos de config
// puertas adentro (`catch { return {} }` → `DEFAULT_POLICY`), ahora PROPAGA el
// error tipado. `pulpo.realignAllowlistToActiveWave` envolvía la llamada al gate
// en un `catch {}` MUDO, así que ese error se perdía y el flujo seguía derecho
// hasta `realignActiveWaveDispatch`: con `config.yaml` corrupto la allowlist se
// realineaba SIN GATE 3 y sin una línea de traza.
//
// La inversión era estricta y en una acción de impacto `alto`:
//
//   | config ilegible → `realign-allowlist`                                    |
//   |--------------------------------------------------------------------------|
//   | ANTES de #5172 | `{}` → `DEFAULT_POLICY='wait-confirmation'` → proceed:false → NO muta |
//   | CON el bug     | `resolve()` lanza → `catch {}` lo traga → **muta igual**  |
//   | ESPERADO       | fail-closed explícito: NO muta, veredicto negativo, traza |
//
// El test afirma sobre el ESTADO EN DISCO (`.partial-pause.json`), no sobre el
// valor de retorno: un retorno negativo con la allowlist ya mutada seguiría
// siendo el bug, y sólo el archivo lo delata.
//
// ## No-vacuidad
//
// `camino feliz` ejercita el MISMO llamado con config sano y confirmer
// autorizado y exige que SÍ mute. Sin ese caso, un `realign` roto de cualquier
// otra forma (fixture mal armado, ola vacía) haría pasar el caso corrupto por
// el motivo equivocado.
//
// ## Aislamiento
//
// Convención del repo (ver `pulpo-config-recovery.test.js`): `PIPELINE_DIR_OVERRIDE`
// a un tmpdir ANTES de requerir `pulpo.js` con `PULPO_NO_AUTOSTART=1`. Cada
// archivo de `node --test` corre en su propio proceso ⇒ el env queda contenido.
//
// node --test
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// --- Aislamiento: tmpdir + override ANTES de requerir pulpo.js ----------------
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gate3-failclosed-'));
fs.mkdirSync(path.join(TMP_DIR, 'logs'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, 'servicios', 'telegram', 'pendiente'), { recursive: true });

const CONFIG_FILE = path.join(TMP_DIR, 'config.yaml');
const ALLOWLIST_FILE = path.join(TMP_DIR, '.partial-pause.json');
const WAVES_FILE = path.join(TMP_DIR, 'waves.json');

// Fixture "config sano": el `config.yaml` real, que por definición pasa
// `validateConfig` (es el mismo schema con el que corre el pipeline).
const GOOD_YAML = fs.readFileSync(path.join(__dirname, '..', '..', 'config.yaml'), 'utf8');

// El secreto va en la línea ADYACENTE al error de sintaxis: si el redactor
// filtrara contexto del archivo, saldría en el mensaje (SEC-1 / CA-14).
const SECRETO = 'SUPER-SECRETO-ABC123';
const BAD_YAML = `gates:\n  gate3:\n   policy: [[[\n  token: ${SECRETO}\n`;

process.env.PIPELINE_DIR_OVERRIDE = TMP_DIR;
process.env.PULPO_NO_AUTOSTART = '1';

fs.writeFileSync(CONFIG_FILE, GOOD_YAML);
const pulpo = require('../../pulpo.js');
const configResolver = require('../config-resolver');

// La ola activa tiene issues ABIERTOS distintos de la allowlist previa ⇒ hay
// algo real que mutar. Sin esto, `realignActiveWaveDispatch` cortaría antes por
// `no_active_wave` / `empty_expansion` y el test pasaría por el motivo
// equivocado.
const ISSUES_OLA = [111, 222];
const ALLOWLIST_PREVIA = JSON.stringify(
    { allowed_issues: [999], created_at: '2026-07-31T00:00:00Z', source: 'fixture' },
    null, 2,
);

function sembrarEstado() {
    fs.writeFileSync(WAVES_FILE, JSON.stringify({
        schema_version: '1.0',
        active_wave: {
            number: 1,
            name: 'ola-fixture-5172',
            status: 'active',
            issues: ISSUES_OLA.map((number) => ({ number })),
        },
        planned_waves: [],
    }, null, 2));
    fs.writeFileSync(ALLOWLIST_FILE, ALLOWLIST_PREVIA);
}

function allowlistEnDisco() {
    return fs.readFileSync(ALLOWLIST_FILE, 'utf8');
}

function conConfig(texto) {
    fs.writeFileSync(CONFIG_FILE, texto);
    // El resolver cachea por ruta: sin limpiar, seguiría sirviendo el documento
    // sano que se leyó al requerir pulpo.js y el test no probaría nada.
    configResolver.clearCache();
}

const DESYNC = { classification: 'resoluble_reductivo', added: [], removed: [] };

// -----------------------------------------------------------------------------

test('config.yaml corrupto NO bypassea GATE 3: la allowlist queda sin mutar', () => {
    sembrarEstado();
    conConfig(BAD_YAML);

    const r = pulpo.realignAllowlistToActiveWave(DESYNC, {});

    // 1. El invariante que importa: el ESTADO EN DISCO no se tocó.
    assert.equal(
        allowlistEnDisco(), ALLOWLIST_PREVIA,
        'con config ilegible la allowlist NO se puede realinear: GATE 3 no rindió veredicto',
    );

    // 2. Y el veredicto es fail-closed explícito, no un `ok:true` silencioso.
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'gate3_config_unreadable');

    // 3. Fail-closed ≠ crash (D-3): devolvió veredicto en vez de tirar el proceso.
    assert.ok(r.config_error, 'el veredicto lleva el copy redactado del fallo');
    assert.equal(r.config_error.causa, 'yaml-invalido');
    assert.equal(r.config_error.ok, false);
});

test('el veredicto de fail-closed no filtra el contenido del config (SEC-1)', () => {
    sembrarEstado();
    conConfig(BAD_YAML);

    const r = pulpo.realignAllowlistToActiveWave(DESYNC, {});

    // Assert NEGATIVO sobre el literal del secreto, serializando TODO el
    // veredicto: si cualquier campo arrastrara el `err.message` de js-yaml (que
    // trae el snippet crudo del archivo), esto lo detecta.
    assert.equal(
        JSON.stringify(r).includes(SECRETO), false,
        'ningún campo del veredicto puede arrastrar contenido del archivo',
    );
    // El detalle útil sí está: archivo + causa + línea, nada más.
    assert.equal(typeof r.config_error.detalle, 'string');
    assert.ok(r.config_error.detalle.includes('YAML inválido'));
    assert.equal(typeof r.config_error.linea, 'number');
});

test('config sano SIN confirmer: GATE 3 sigue exigiendo confirmación (no se aflojó)', () => {
    sembrarEstado();
    conConfig(GOOD_YAML);

    // `realign-allowlist` es `wait-confirmation` en DEFAULT_POLICY. Sin
    // confirmer válido el gate frena la mutación — comportamiento previo a
    // #5172, que el fail-closed no debe haber alterado.
    const r = pulpo.realignAllowlistToActiveWave(DESYNC, {});

    assert.equal(r.ok, false);
    assert.equal(r.reason, 'gate3_confirmation_required');
    assert.equal(allowlistEnDisco(), ALLOWLIST_PREVIA, 'sin confirmación no se muta');
});

test('camino feliz: config sano + confirmer autorizado SÍ realinea (el test no es vacuo)', () => {
    sembrarEstado();
    conConfig(GOOD_YAML);

    const r = pulpo.realignAllowlistToActiveWave(DESYNC, {
        confirmerChatId: '424242',
        operatorAllowlist: ['424242'],
    });

    assert.equal(r.ok, true, `esperaba realign OK, salió: ${JSON.stringify(r)}`);
    assert.deepEqual(r.allowlist, ISSUES_OLA);

    // La mutación llegó al disco: es exactamente lo que los dos primeros tests
    // exigen que NO pase con config ilegible.
    const despues = JSON.parse(allowlistEnDisco());
    assert.deepEqual(despues.allowed_issues, ISSUES_OLA);
    assert.notEqual(allowlistEnDisco(), ALLOWLIST_PREVIA);
});

test('el predicado de violación de config es el del resolver y cubre los dos errores tipados', () => {
    const { isConfigViolation, ConfigParseViolation, ConfigSchemaViolation } = configResolver;

    assert.equal(isConfigViolation(new ConfigParseViolation('x', { causa: 'yaml-invalido' })), true);
    assert.equal(isConfigViolation(new ConfigSchemaViolation('x', [])), true);
    assert.equal(isConfigViolation(new Error('cualquier otra cosa')), false);
    assert.equal(isConfigViolation(null), false);
    assert.equal(isConfigViolation(undefined), false);

    // D-G: los dos names son contrato compartido con `error-classifier`. Si uno
    // se renombra sin tocar el otro lugar, la corrupción de config deja de
    // clasificarse como `corruption` en silencio.
    const { classify } = require('../error-classifier');
    for (const name of ['ConfigParseViolation', 'ConfigSchemaViolation']) {
        const e = new Error('x');
        e.name = name;
        assert.equal(classify(e), 'corruption', `${name} debe clasificar como corruption`);
    }
});

// -----------------------------------------------------------------------------
// Guard estructural: ningún `catch` alrededor del gate puede volver a ser MUDO.
// -----------------------------------------------------------------------------
//
// Los cuatro tests de arriba defienden UN call-site (`realign-allowlist`, el que
// bypasseaba). Pero el defecto no era de ese call-site: era del patrón
// `enforceActionPolicy(...)` envuelto en `catch {}`, repetido en todo el
// codebase. Sin este guard, arreglar el que mutaba deja los otros seis listos
// para volverse el próximo bypass en cuanto alguno pase a `wait-confirmation`.
//
// El guard escanea el ÁRBOL, no una lista escrita a mano: un call-site nuevo con
// catch mudo rompe el test aunque nadie se acuerde de este archivo.

const PROD_ROOT = path.join(__dirname, '..', '..');
const EXCLUIDOS = /(^|[\\/])(node_modules|_tmp|__tests__|tests)[\\/]|\.test\.js$/;

function archivosDeProduccion(dir, acc = []) {
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entrada.name);
        if (EXCLUIDOS.test(p.slice(PROD_ROOT.length))) continue;
        if (entrada.isDirectory()) archivosDeProduccion(p, acc);
        else if (entrada.name.endsWith('.js')) acc.push(p);
    }
    return acc;
}

// Devuelve el cuerpo del `catch` que envuelve al call-site, o null si el call no
// está dentro de un try. Matchea llaves en vez de usar una regex: el cuerpo
// tiene llaves anidadas (objeto de opts, if internos) y una regex lo cortaría al
// primer `}`.
function cuerpoDelCatchQueEnvuelve(src, idxLlamada) {
    const idxCatch = src.indexOf('} catch', idxLlamada);
    // Cota: el catch tiene que ser el de ESTE try, no uno de 40 líneas más abajo.
    if (idxCatch === -1 || idxCatch - idxLlamada > 1500) return null;
    const apertura = src.indexOf('{', src.indexOf('catch', idxCatch));
    if (apertura === -1) return null;
    let profundidad = 0;
    for (let i = apertura; i < src.length; i += 1) {
        if (src[i] === '{') profundidad += 1;
        else if (src[i] === '}') {
            profundidad -= 1;
            if (profundidad === 0) return src.slice(apertura + 1, i);
        }
    }
    return null;
}

test('GUARD · ningún call-site de enforceActionPolicy conserva un catch mudo', () => {
    // Un catch "no mudo" tiene que hacer ALGO con el error: fallar cerrado
    // (el predicado del resolver) o al menos dejar traza (el helper único).
    const MANEJA_EL_ERROR = /logPolicyEnforcementFailure|esViolacionDeConfig|isConfigViolation/;

    const revisados = [];
    const mudos = [];

    for (const archivo of archivosDeProduccion(PROD_ROOT)) {
        const src = fs.readFileSync(archivo, 'utf8');
        let desde = 0;
        for (;;) {
            const idx = src.indexOf('enforceActionPolicy(', desde);
            if (idx === -1) break;
            desde = idx + 1;
            // La DEFINICIÓN de la función no es un call-site.
            if (/function\s+$/.test(src.slice(Math.max(0, idx - 10), idx))) continue;

            const rel = path.relative(PROD_ROOT, archivo).replace(/\\/g, '/');
            const linea = src.slice(0, idx).split('\n').length;
            revisados.push(`${rel}:${linea}`);

            const cuerpo = cuerpoDelCatchQueEnvuelve(src, idx);
            assert.notEqual(
                cuerpo, null,
                `${rel}:${linea} — llamada a enforceActionPolicy sin try/catch que la envuelva: `
                + 'si el resolver lanza, el error sube sin control por un camino que muta estado',
            );
            // Un cuerpo con SÓLO comentarios (`/* best-effort */`) es tan mudo
            // como uno vacío: se le sacan los comentarios antes de juzgarlo.
            const codigo = cuerpo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').trim();
            if (codigo === '' || !MANEJA_EL_ERROR.test(codigo)) {
                mudos.push(`${rel}:${linea}`);
            }
        }
    }

    // No-vacuidad: si el escaneo dejara de encontrar call-sites (regex rota,
    // filtro de exclusión de más), el test pasaría vacío y no defendería nada.
    assert.ok(
        revisados.length >= 7,
        `esperaba >=7 call-sites de enforceActionPolicy en producción, encontré ${revisados.length}: ${revisados.join(', ')}`,
    );
    assert.deepEqual(
        mudos, [],
        'estos call-sites se tragan el error del gate sin fallar cerrado ni dejar traza:\n  '
        + mudos.join('\n  '),
    );
});

test('el helper de traza describe la violación de config y NUNCA lanza ni filtra', () => {
    const { logPolicyEnforcementFailure } = require('../kernel-action-policy');
    const { ConfigParseViolation } = configResolver;

    const capturado = [];
    const warnOriginal = console.warn;
    console.warn = (...args) => capturado.push(args.join(' '));
    try {
        // 1. Violación de config: traza con la tríada redactada.
        const err = new ConfigParseViolation('YAML inválido', {
            causa: 'yaml-invalido', linea: 4, columna: 1, archivo: '/tmp/config.yaml',
        });
        err.raw = SECRETO; // si el helper serializara el error entero, se filtraría
        logPolicyEnforcementFailure('modulo-x', 'quota-flag-set', err);

        // 2. Error ajeno al config: traza igual, sin pretender que es corrupción.
        logPolicyEnforcementFailure('modulo-y', 'worktree-reset', new TypeError('boom'));

        // 3. Entradas degeneradas: es traza, y una traza que rompe es peor que
        //    la ausencia de traza (se llama desde dentro de catch blocks).
        assert.doesNotThrow(() => logPolicyEnforcementFailure('m', 'a', null));
        assert.doesNotThrow(() => logPolicyEnforcementFailure(undefined, undefined, undefined));
    } finally {
        console.warn = warnOriginal;
    }

    const todo = capturado.join('\n');
    assert.match(todo, /quota-flag-set/, 'la traza nombra la acción que no rindió veredicto');
    assert.match(todo, /modulo-x/, 'la traza nombra quién llamaba');
    assert.match(todo, /yaml|YAML|inválid/i, 'la traza dice la causa');
    assert.match(todo, /worktree-reset/, 'el error ajeno al config también deja traza');
    assert.equal(todo.includes(SECRETO), false, 'la traza no puede arrastrar contenido del archivo');
});
