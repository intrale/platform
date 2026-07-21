// =============================================================================
// pulpo-corruption.test.js — readYaml ENOENT-vs-corrupto + granularidad SEC-3
// (#3941, EP5-H4)
//
// Implementa los dos tests de la sección "Tests obligatorios" del issue que
// ejercen lógica residente en pulpo.js (no en lib/*):
//   - readYaml: archivo inexistente → {}; archivo existente corrupto → señaliza
//     corrupción (NO {} silencioso) lanzando WorkFileCorruptionError.
//   - granularidad SEC-3: la lectura de un work-file corrupto NO escribe el
//     `.paused` global (la pausa global se reserva a config.yaml).
//
// Se requiere pulpo.js con PULPO_NO_AUTOSTART=1 (convención del repo, ver
// sherlock-soft-timeout-mp01.test.js): el módulo exporta funciones sin arrancar
// el pipeline. `readYaml`/`readYamlSafe` sólo leen el path provisto — no tocan
// `.paused` ni Telegram — por lo que son seguros de ejercer en test.
// node --test
// =============================================================================
'use strict';

process.env.PULPO_NO_AUTOSTART = '1';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pulpo = require('../../pulpo.js');
const {
    readYaml, readYamlSafe, WorkFileCorruptionError, PAUSE_FILE,
    shouldAutoRecoverFromCorruptionHalt,
} = pulpo;

function tmpFile(name, content) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulpo-corrupt-'));
    const fp = path.join(dir, name);
    fs.writeFileSync(fp, content);
    return fp;
}

test('readYaml: archivo inexistente (ENOENT) → {}', () => {
    const missing = path.join(os.tmpdir(), 'no-existe-jamas-3941', 'nope.yaml');
    assert.deepStrictEqual(readYaml(missing), {});
});

test('readYaml: archivo válido → objeto parseado', () => {
    const fp = tmpFile('ok.yaml', 'issue: 3941\nfase: dev\n');
    assert.deepStrictEqual(readYaml(fp), { issue: 3941, fase: 'dev' });
});

test('readYaml: archivo vacío → {} (yaml.load → undefined → {})', () => {
    const fp = tmpFile('vacio.yaml', '');
    assert.deepStrictEqual(readYaml(fp), {});
});

test('readYaml: archivo existente CORRUPTO → señaliza corrupción (NO {} silencioso)', () => {
    const fp = tmpFile('corrupto.yaml', 'issue: 3941\n  : : mal indentado\n :bad');
    assert.throws(
        () => readYaml(fp),
        (e) => e instanceof WorkFileCorruptionError && e.name === 'WorkFileCorruptionError',
        'debe lanzar WorkFileCorruptionError, no devolver {}',
    );
});

test('readYamlSafe: archivo corrupto → {} best-effort SIN lanzar', () => {
    const fp = tmpFile('corrupto2.yaml', 'a: b: c: d\n  - : :');
    // No debe lanzar; degrada a {} (y loguea por dentro).
    assert.deepStrictEqual(readYamlSafe(fp, 'test'), {});
});

test('granularidad SEC-3: leer un work-file corrupto NO escribe el .paused global', () => {
    // Precondición: el .paused real no debe existir para que la aserción sea
    // significativa. Si existe (pipeline pausado por otra causa), no podemos
    // afirmar que lo creó esta lectura → skip defensivo.
    const pausedAntes = fs.existsSync(PAUSE_FILE);
    const fp = tmpFile('wf-corrupto.yaml', ': : : nope\n  bad: : :');

    // readYaml lanza, readYamlSafe degrada — ninguno debe tocar PAUSE_FILE.
    assert.throws(() => readYaml(fp), (e) => e.name === 'WorkFileCorruptionError');
    assert.deepStrictEqual(readYamlSafe(fp), {});

    const pausedDespues = fs.existsSync(PAUSE_FILE);
    assert.strictEqual(
        pausedDespues,
        pausedAntes,
        'la lectura de un work-file corrupto NO debe crear/borrar el .paused global (SEC-3)',
    );
});

// =============================================================================
// #4832 — Gate del auto-recovery del halt por corrupción de config.yaml.
//
// El branch de éxito de loadConfig() decide levantar la pausa total SÓLO cuando
// shouldAutoRecoverFromCorruptionHalt(existe, origen) es true. Se testea el gate
// PURO (sin tocar el .paused real ni Telegram) + el round-trip con el marker que
// escribe haltOnConfigCorruption vía readFullPauseOrigin (fail-closed).
// =============================================================================
test('#4832 CA-2: pausa presente con origen config-corruption-halt → auto-recovery procede', () => {
    assert.strictEqual(shouldAutoRecoverFromCorruptionHalt(true, 'config-corruption-halt'), true);
});

test('#4832 CA-3: pausa manual (origen manual) NO se auto-levanta aunque config esté sano', () => {
    assert.strictEqual(shouldAutoRecoverFromCorruptionHalt(true, 'manual'), false);
});

test('#4832 CA-3: origen unknown/ambiguo → NO se auto-levanta (fail-closed)', () => {
    assert.strictEqual(shouldAutoRecoverFromCorruptionHalt(true, 'unknown'), false);
    assert.strictEqual(shouldAutoRecoverFromCorruptionHalt(true, ''), false);
    assert.strictEqual(shouldAutoRecoverFromCorruptionHalt(true, 'config-corruption'), false);
});

test('#4832: sin marker .paused presente → nunca recupera (aunque el origen diga corrupción)', () => {
    assert.strictEqual(shouldAutoRecoverFromCorruptionHalt(false, 'config-corruption-halt'), false);
});

test('#4832 CA-1 round-trip: el shape JSON del marker de corrupción es clasificado recuperable', () => {
    // Réplica EXACTA del payload que escribe haltOnConfigCorruption (pulpo.js):
    // { source, ts, detail-redactado }. Se aísla en tmp dir vía PIPELINE_DIR_OVERRIDE
    // para NO tocar el .paused real; se recarga partial-pause con ese override.
    const os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulpo-4832-'));
    const prevOverride = process.env.PIPELINE_DIR_OVERRIDE;
    process.env.PIPELINE_DIR_OVERRIDE = tmp;
    delete require.cache[require.resolve('../partial-pause')];
    const pp = require('../partial-pause');
    try {
        const { PAUSE_FILE: TMP_PAUSE } = pp._paths();
        fs.writeFileSync(TMP_PAUSE, JSON.stringify({
            source: 'config-corruption-halt',
            ts: '2026-07-20T23:09:00.000Z',
            detail: 'YAML inválido (línea 12, col 1)',
        }));
        const origin = pp.readFullPauseOrigin();
        assert.strictEqual(origin.source, 'config-corruption-halt');
        // El gate del loop combina existencia + origen → recovery procede.
        assert.strictEqual(
            shouldAutoRecoverFromCorruptionHalt(fs.existsSync(TMP_PAUSE), origin.source),
            true,
        );
    } finally {
        if (prevOverride === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
        else process.env.PIPELINE_DIR_OVERRIDE = prevOverride;
        delete require.cache[require.resolve('../partial-pause')];
    }
});
