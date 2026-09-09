'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const oauth = require('./oauth-session-expiry');

const originalRead = fs.readFileSync;

function fixture(t, value) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-expiry-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const statePath = path.join(dir, 'state.json');
    fs.readFileSync = function fakeRead(file, encoding) {
        if (path.resolve(String(file)) === path.resolve(oauth.CREDENTIALS_PATH)) {
            if (value instanceof Error) throw value;
            return typeof value === 'string' ? value : JSON.stringify(value);
        }
        return originalRead.call(fs, file, encoding);
    };
    t.after(() => { fs.readFileSync = originalRead; });
    return statePath;
}

function credentials(expiresAt, refreshTokenExpiresAt = expiresAt + oauth.NEXT_CYCLE_MS * 2) {
    return { claudeAiOauth: { expiresAt, refreshTokenExpiresAt } };
}

/**
 * Doble de `provider-disabled` (#6238). `source` es lo único que gobierna CE-2.
 * `sin señal` = `getDisabledEntry` devuelve null, que es lo que hace el módulo
 * real cuando el provider no está apagado o cuando el TTL ya venció.
 */
function fakeDisabledModule(source) {
    return { getDisabledEntry: () => (source === null ? null : { name: 'anthropic', source }) };
}

const sinSenal = fakeDisabledModule(null);
const conCredentialDeath = fakeDisabledModule('credential-death');

test('calcula una sesión vigente leyendo sólo vencimientos derivados', (t) => {
    const now = Date.UTC(2026, 7, 20, 12);
    fixture(t, credentials(now + 65 * 60000));
    assert.deepEqual(oauth.getOAuthSessionExpiry(now), {
        expiresAt: new Date(now + 65 * 60000), minutesLeft: 65, available: true,
    });
});

test('degrada sin excepción ante archivo ausente o JSON corrupto', async (t) => {
    fixture(t, new Error('missing'));
    assert.deepEqual(oauth.getOAuthSessionExpiry(), { expiresAt: null, minutesLeft: null, available: false });
    fs.readFileSync = (file, encoding) => path.resolve(String(file)) === path.resolve(oauth.CREDENTIALS_PATH)
        ? '{dato sintetico invalido'
        : originalRead.call(fs, file, encoding);
    assert.equal(oauth.getOAuthSessionExpiry().available, false);
});

test('la primera lectura persiste y no emite', (t) => {
    const now = 1_800_000_000_000;
    const statePath = fixture(t, credentials(now + 25 * 60000, now + 20 * 60000));
    const d = oauth.evaluate({ now, statePath, disabledModule: sinSenal });
    assert.equal(d.reason, 'first_reading');
    assert.equal(d.shouldEmit, false);
    assert.equal(JSON.parse(originalRead(statePath, 'utf8')).expires_at_epoch, now + 25 * 60000);
});

test('emite T-30 una sola vez cuando el refresh no alcanza', (t) => {
    const now = 1_800_000_000_000;
    const value = credentials(now + 25 * 60000, now + 20 * 60000);
    const statePath = fixture(t, value);
    oauth.evaluate({ now: now - 60000, statePath, disabledModule: sinSenal });
    const first = oauth.evaluate({ now, statePath, disabledModule: sinSenal });
    assert.equal(first.threshold, 't30');
    assert.equal(first.reason, 'refresh_insufficient');
    assert.equal(oauth.recordEmitted({ statePath, alert: first.alert, threshold: first.threshold }), true);
    assert.equal(oauth.evaluate({ now: now + 60000, statePath, disabledModule: sinSenal }).shouldEmit, false);
});

test('un salto directo a T-10 marca también T-30', (t) => {
    const now = 1_800_000_000_000;
    const statePath = fixture(t, credentials(now + 8 * 60000, now));
    oauth.evaluate({ now: now - 60000, statePath, disabledModule: sinSenal });
    const d = oauth.evaluate({ now, statePath, disabledModule: sinSenal });
    assert.equal(d.threshold, 't10');
    oauth.recordEmitted({ statePath, alert: d.alert, threshold: d.threshold });
    const state = JSON.parse(originalRead(statePath, 'utf8'));
    assert.equal(state.t30_sent, true);
    assert.equal(state.t10_sent, true);
});

test('una sesión vencida no emite avisos anticipados', (t) => {
    const now = 1_800_000_000_000;
    const statePath = fixture(t, credentials(now - 60000, now - 60000));
    oauth.evaluate({ now: now - 120000, statePath, disabledModule: sinSenal });
    assert.equal(oauth.evaluate({ now, statePath, disabledModule: sinSenal }).reason, 'already_expired');
});

test('la renovación resetea umbrales y cierra un aviso abierto', (t) => {
    const now = 1_800_000_000_000;
    let epoch = now + 5 * 60000;
    const statePath = fixture(t, credentials(epoch, now));
    oauth.evaluate({ now: now - 60000, statePath, disabledModule: sinSenal });
    const warning = oauth.evaluate({ now, statePath, disabledModule: sinSenal });
    oauth.recordEmitted({ statePath, alert: warning.alert, threshold: warning.threshold });
    epoch = now + 8 * 60 * 60000;
    fs.readFileSync = (file, encoding) => path.resolve(String(file)) === path.resolve(oauth.CREDENTIALS_PATH)
        ? JSON.stringify(credentials(epoch)) : originalRead.call(fs, file, encoding);
    const renewed = oauth.evaluate({ now: now + 60000, statePath, disabledModule: sinSenal });
    assert.equal(renewed.alert, 'renewed');
    const state = JSON.parse(originalRead(statePath, 'utf8'));
    assert.equal(state.t10_sent, false);
    assert.equal(state.renewal_unhealthy, false);
});

// ---------------------------------------------------------------------------
// CE-2 — revisión 2: la única fuente es la señal tipada de #6238.
// ---------------------------------------------------------------------------

test('CE-2 enciende sólo con la señal de #6238 y nunca con otro origen de disable', (t) => {
    const now = 1_800_000_000_000;
    const epoch = now + 25 * 60000;
    // El refresh alcanza de sobra: CE-1 apagada, así que lo único que puede
    // emitir acá es CE-2.
    const statePath = fixture(t, credentials(epoch, epoch + oauth.NEXT_CYCLE_MS * 3));

    oauth.evaluate({ now: now - 60000, statePath, disabledModule: conCredentialDeath });
    const conSenal = oauth.evaluate({ now, statePath, disabledModule: conCredentialDeath });
    assert.equal(conSenal.shouldEmit, true);
    assert.equal(conSenal.threshold, 't30');
    assert.equal(conSenal.reason, 'credential_death');
    assert.equal(JSON.parse(originalRead(statePath, 'utf8')).renewal_unhealthy, true);

    // Otro origen de disable (pacing) no es evidencia de credencial rechazada.
    const otroPath = fixture(t, credentials(epoch, epoch + oauth.NEXT_CYCLE_MS * 3));
    const pacing = fakeDisabledModule('pacing');
    oauth.evaluate({ now: now - 60000, statePath: otroPath, disabledModule: pacing });
    const conPacing = oauth.evaluate({ now, statePath: otroPath, disabledModule: pacing });
    assert.equal(conPacing.shouldEmit, false);
    assert.equal(conPacing.reason, 'automatic_renewal_expected');
    assert.equal(JSON.parse(originalRead(otroPath, 'utf8')).renewal_unhealthy, false);
});

test('un error al leer provider-disabled no rompe el tick y deja CE-2 apagada', (t) => {
    const now = 1_800_000_000_000;
    const epoch = now + 25 * 60000;
    const statePath = fixture(t, credentials(epoch, epoch + oauth.NEXT_CYCLE_MS * 3));
    const roto = { getDisabledEntry: () => { throw new Error('flag file ilegible'); } };
    oauth.evaluate({ now: now - 60000, statePath, disabledModule: roto });
    const d = oauth.evaluate({ now, statePath, disabledModule: roto });
    assert.equal(d.shouldEmit, false);
    assert.equal(d.reason, 'automatic_renewal_expected');
    assert.equal(JSON.parse(originalRead(statePath, 'utf8')).renewal_unhealthy, false);
});

test('CA-14 · régimen sano prolongado con escritura perezosa no emite nada', (t) => {
    // Reproduce el defecto de los dos rebotes anteriores: el CLI reescribe el
    // archivo T-0 + 2 min (después del vencimiento, no antes), sin ninguna
    // evidencia de credencial rechazada. Debe ser silencio absoluto.
    const TICK_MS = 5 * 60000;
    const CICLO_MS = 8 * 60 * 60000;
    const ESCRITURA_TARDIA_MS = 2 * 60000;
    const inicio = 1_800_000_000_000;

    let epoch = inicio + CICLO_MS;
    const statePath = fixture(t, credentials(epoch));
    fs.readFileSync = (file, encoding) => path.resolve(String(file)) === path.resolve(oauth.CREDENTIALS_PATH)
        ? JSON.stringify(credentials(epoch, epoch + oauth.NEXT_CYCLE_MS * 3))
        : originalRead.call(fs, file, encoding);

    let emisiones = 0;
    const EVALUACIONES = 300;
    for (let i = 0; i < EVALUACIONES; i += 1) {
        const now = inicio + i * TICK_MS;
        // El CLI recién reescribe el archivo 2 minutos DESPUÉS del vencimiento.
        if (now >= epoch + ESCRITURA_TARDIA_MS) epoch += CICLO_MS;
        const d = oauth.evaluate({ now, statePath, disabledModule: sinSenal });
        if (d.shouldEmit) {
            emisiones += 1;
            oauth.recordEmitted({ statePath, alert: d.alert, threshold: d.threshold });
        }
    }

    assert.ok(EVALUACIONES >= 250, 'la simulación debe cubrir al menos 250 evaluaciones');
    assert.equal(emisiones, 0, 'régimen sano = silencio absoluto');
    const state = JSON.parse(originalRead(statePath, 'utf8'));
    assert.equal(state.renewal_unhealthy, false, 'el marcador de CE-2 termina apagado');
    assert.equal(state.expiry_alert_open, false);
});

test('CA-15 · el aviso de CE-2 se apaga solo cuando la renovación vuelve a funcionar', (t) => {
    const TICK_MS = 5 * 60000;
    const inicio = 1_800_000_000_000;
    let epoch = inicio + 25 * 60000;
    let senal = 'credential-death';
    const disabledModule = { getDisabledEntry: () => (senal === null ? null : { name: 'anthropic', source: senal }) };

    const statePath = fixture(t, credentials(epoch));
    fs.readFileSync = (file, encoding) => path.resolve(String(file)) === path.resolve(oauth.CREDENTIALS_PATH)
        ? JSON.stringify(credentials(epoch, epoch + oauth.NEXT_CYCLE_MS * 3))
        : originalRead.call(fs, file, encoding);

    // Lectura previa persistida (CA-6) + episodio abierto por CE-2.
    oauth.evaluate({ now: inicio - TICK_MS, statePath, disabledModule });
    const aviso = oauth.evaluate({ now: inicio, statePath, disabledModule });
    assert.equal(aviso.reason, 'credential_death');
    oauth.recordEmitted({ statePath, alert: aviso.alert, threshold: aviso.threshold });

    // Ticks siguientes dentro del mismo umbral: no se repite el aviso (CA-3).
    for (let i = 1; i <= 2; i += 1) {
        assert.equal(oauth.evaluate({ now: inicio + i * TICK_MS, statePath, disabledModule }).shouldEmit, false);
    }

    // El disable vence (TTL 60 min) y la vigencia salta hacia adelante.
    senal = null;
    epoch += 8 * 60 * 60000;
    const cierre = oauth.evaluate({ now: inicio + 3 * TICK_MS, statePath, disabledModule });
    assert.equal(cierre.alert, 'renewed', 'CA-9: el episodio abierto cierra');
    oauth.recordEmitted({ statePath, alert: cierre.alert });

    const state = JSON.parse(originalRead(statePath, 'utf8'));
    assert.equal(state.renewal_unhealthy, false, 'CE-2 queda apagada sin intervención humana');
    assert.equal(state.expiry_alert_open, false);
    assert.equal(state.t30_sent, false, 'los umbrales quedan disponibles para el próximo ciclo');
    assert.equal(state.t10_sent, false);

    // Y no se emite un segundo cierre en el tick siguiente.
    assert.equal(oauth.evaluate({ now: inicio + 4 * TICK_MS, statePath, disabledModule }).shouldEmit, false);
});

test('CA-15 · la reautenticación DENTRO del TTL de la señal apaga CE-2 al drenarse', (t) => {
    // Orden realista (el que produjo el rebote): la reautenticación es la
    // RESPUESTA al aviso, así que el salto de vigencia ocurre con la entrada
    // `credential-death` todavía vigente — su TTL es de 60 min. El fail-closed
    // gana ese tick; el apagado tiene que ocurrir igual cuando la señal drena,
    // en un tick posterior donde `renewed` ya es false.
    const TICK_MS = 5 * 60000;
    const inicio = 1_800_000_000_000;
    let epoch = inicio + 25 * 60000;
    let senal = 'credential-death';
    const disabledModule = { getDisabledEntry: () => (senal === null ? null : { name: 'anthropic', source: senal }) };

    // Refresh lejano: CE-1 apagada, lo único que puede emitir acá es CE-2.
    const statePath = fixture(t, credentials(epoch));
    fs.readFileSync = (file, encoding) => path.resolve(String(file)) === path.resolve(oauth.CREDENTIALS_PATH)
        ? JSON.stringify(credentials(epoch, epoch + oauth.NEXT_CYCLE_MS * 5))
        : originalRead.call(fs, file, encoding);

    oauth.evaluate({ now: inicio - TICK_MS, statePath, disabledModule });
    const aviso = oauth.evaluate({ now: inicio, statePath, disabledModule });
    assert.equal(aviso.reason, 'credential_death');
    oauth.recordEmitted({ statePath, alert: aviso.alert, threshold: aviso.threshold });

    // El operador reautentica CON la señal todavía vigente: fail-closed gana.
    epoch += 8 * 60 * 60000;
    const conSenalViva = oauth.evaluate({ now: inicio + TICK_MS, statePath, disabledModule });
    assert.equal(conSenalViva.shouldEmit, false, 'el tick del salto no cierra: la señal sigue viva');
    assert.equal(JSON.parse(originalRead(statePath, 'utf8')).renewal_unhealthy, true, 'fail-closed intacto');

    // Recién ahora drena el TTL de 60 min. `renewed` ya es false en este tick.
    senal = null;
    const cierre = oauth.evaluate({ now: inicio + 2 * TICK_MS, statePath, disabledModule });
    assert.equal(cierre.alert, 'renewed', 'CA-9: el cierre sale en el tick posterior al salto');
    oauth.recordEmitted({ statePath, alert: cierre.alert });

    const state = JSON.parse(originalRead(statePath, 'utf8'));
    assert.equal(state.renewal_unhealthy, false, 'CA-15: CE-2 queda apagada sin intervención humana');
    assert.equal(state.expiry_alert_open, false);

    // CA-5 / CA-14: cero emisiones en el ciclo siguiente, ya sin ninguna señal.
    let emisiones = 0;
    for (let i = 3; i < 130; i += 1) {
        const now = inicio + i * TICK_MS;
        if (now >= epoch + 2 * 60000) epoch += 8 * 60 * 60000;
        const d = oauth.evaluate({ now, statePath, disabledModule });
        if (d.shouldEmit) { emisiones += 1; oauth.recordEmitted({ statePath, alert: d.alert, threshold: d.threshold }); }
    }
    assert.equal(emisiones, 0, 'sin señal vigente el ciclo siguiente es silencio absoluto');
    assert.equal(JSON.parse(originalRead(statePath, 'utf8')).renewal_unhealthy, false);
});

test('CE-2 no se apaga sin renovación posterior al encendido, y una señal nueva la reenciende', (t) => {
    const TICK_MS = 5 * 60000;
    const inicio = 1_800_000_000_000;
    let epoch = inicio + 25 * 60000;
    let senal = 'credential-death';
    const disabledModule = { getDisabledEntry: () => (senal === null ? null : { name: 'anthropic', source: senal }) };

    const statePath = fixture(t, credentials(epoch));
    fs.readFileSync = (file, encoding) => path.resolve(String(file)) === path.resolve(oauth.CREDENTIALS_PATH)
        ? JSON.stringify(credentials(epoch, epoch + oauth.NEXT_CYCLE_MS * 5))
        : originalRead.call(fs, file, encoding);

    oauth.evaluate({ now: inicio - TICK_MS, statePath, disabledModule });
    const aviso = oauth.evaluate({ now: inicio, statePath, disabledModule });
    assert.equal(aviso.reason, 'credential_death');
    oauth.recordEmitted({ statePath, alert: aviso.alert, threshold: aviso.threshold });

    // La señal drena SIN que la vigencia haya saltado: no hay evidencia de que
    // la renovación volviera a andar, así que CE-2 sigue encendida.
    senal = null;
    oauth.evaluate({ now: inicio + TICK_MS, statePath, disabledModule });
    assert.equal(JSON.parse(originalRead(statePath, 'utf8')).renewal_unhealthy, true,
        'sin renovación observada el marcador no se apaga solo');

    // Ahora sí renueva: apaga y cierra el episodio.
    epoch += 8 * 60 * 60000;
    const cierre = oauth.evaluate({ now: inicio + 2 * TICK_MS, statePath, disabledModule });
    assert.equal(cierre.alert, 'renewed');
    oauth.recordEmitted({ statePath, alert: cierre.alert });
    assert.equal(JSON.parse(originalRead(statePath, 'utf8')).unhealthy_expires_at_epoch, null);

    // Un episodio NUEVO se ancla a la vigencia vigente ahora, no a la vieja:
    // la renovación pasada no puede apagarlo retroactivamente.
    senal = 'credential-death';
    oauth.evaluate({ now: inicio + 3 * TICK_MS, statePath, disabledModule });
    const reencendido = JSON.parse(originalRead(statePath, 'utf8'));
    assert.equal(reencendido.renewal_unhealthy, true);
    assert.equal(reencendido.unhealthy_expires_at_epoch, epoch, 'el ancla es la vigencia del nuevo encendido');
    senal = null;
    oauth.evaluate({ now: inicio + 4 * TICK_MS, statePath, disabledModule });
    assert.equal(JSON.parse(originalRead(statePath, 'utf8')).renewal_unhealthy, true,
        'la renovación anterior al reencendido no lo apaga');
});

test('tres lecturas fallidas abren un único episodio de salud y la recuperación lo cierra', (t) => {
    const now = 1_800_000_000_000;
    const statePath = fixture(t, new Error('missing'));
    assert.equal(oauth.evaluate({ now, statePath, disabledModule: sinSenal }).shouldEmit, false);
    assert.equal(oauth.evaluate({ now: now + 5 * 60000, statePath, disabledModule: sinSenal }).shouldEmit, false);
    const alert = oauth.evaluate({ now: now + 10 * 60000, statePath, disabledModule: sinSenal });
    assert.equal(alert.alert, 'health_unavailable');
    oauth.recordEmitted({ statePath, alert: alert.alert });
    assert.equal(oauth.evaluate({ now: now + 15 * 60000, statePath, disabledModule: sinSenal }).shouldEmit, false);
    fs.readFileSync = (file, encoding) => path.resolve(String(file)) === path.resolve(oauth.CREDENTIALS_PATH)
        ? JSON.stringify(credentials(now + 9 * 60 * 60000)) : originalRead.call(fs, file, encoding);
    const recovered = oauth.evaluate({ now: now + 20 * 60000, statePath, disabledModule: sinSenal });
    assert.equal(recovered.alert, 'health_recovered');
});

test('en régimen sano cruza umbrales en silencio', (t) => {
    const now = 1_800_000_000_000;
    const epoch = now + 25 * 60000;
    const statePath = fixture(t, credentials(epoch, epoch + oauth.NEXT_CYCLE_MS));
    oauth.evaluate({ now: now - 60000, statePath, disabledModule: sinSenal });
    assert.equal(oauth.evaluate({ now, statePath, disabledModule: sinSenal }).reason, 'automatic_renewal_expected');
});

test('el módulo nunca escribe sobre provider-disabled', () => {
    const fuente = originalRead(path.join(__dirname, 'oauth-session-expiry.js'), 'utf8');
    for (const escritor of ['setProviderDisabled', 'clearProviderDisabled', 'clearAll']) {
        assert.equal(fuente.includes(escritor), false, `no debe usar ${escritor}`);
    }
    // CA-14: la comparación de expiresAt no puede volver a encender CE-2.
    assert.equal(fuente.includes('crossedWithoutRenewal'), false);
    assert.equal(fuente.includes('renewedBeforeExpiry'), false);
});

// ---------------------------------------------------------------------------
// Contención del marker (rebote de `security`, OWASP A05 / CWE-538).
//
// El marker persiste el calendario de vencimiento de la credencial del
// operador. El repo es PÚBLICO, así que el estado canónico vive fuera del árbol
// y, como red, el nombre legacy está ignorado y dado de alta en el inventario
// de paths sensibles (#5463).
// ---------------------------------------------------------------------------

test('el marker canónico vive fuera del árbol del repo', () => {
    const canonico = oauth.defaultStateFilePath();
    assert.equal(path.isAbsolute(canonico), true);
    assert.equal(canonico, path.join(os.homedir(), '.claude', 'pipeline-state', oauth.STATE_FILENAME));
    // El repo nunca puede ser prefijo del path del marker.
    const repoRoot = path.resolve(__dirname, '..', '..');
    assert.equal(path.relative(repoRoot, canonico).startsWith('..'), true,
        `el marker no puede quedar dentro de ${repoRoot}`);
    // La forma lógica que se muestra al operador no filtra el home del host.
    assert.equal(oauth.EXTERNAL_STATE_FILE_LOGICO.includes(os.homedir()), false);
});

test('el barrido borra el marker legacy dentro del árbol y es idempotente', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-expiry-legacy-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const legacy = oauth.legacyStateFilePath(dir);
    fs.writeFileSync(legacy, JSON.stringify({ expires_at_epoch: 1_800_000_000_000 }));

    assert.equal(oauth.purgeLegacyStateFile(dir), true);
    assert.equal(fs.existsSync(legacy), false);
    // Segunda pasada: no hay legacy, no lanza y no reporta borrado.
    assert.equal(oauth.purgeLegacyStateFile(dir), false);
    // Directorio inexistente tampoco rompe el tick.
    assert.equal(oauth.purgeLegacyStateFile(path.join(dir, 'no-existe')), false);
});

test('el marker legacy está cubierto por el inventario de paths sensibles', () => {
    const { clasificarPath } = require('./sensitive-paths');
    const entrada = clasificarPath(`.pipeline/${oauth.STATE_FILENAME}`);
    assert.notEqual(entrada, null, 'el scanner de pre-commit debe reconocer el marker');
    assert.equal(entrada.clase, 'estado');
    assert.equal(entrada.requiereIgnore, true);
    assert.equal(entrada.escaneaContenido, true);
});

test('el Pulpo apunta el marker al path externo, no al árbol del repo', () => {
    const pulpo = originalRead(path.join(__dirname, '..', 'pulpo.js'), 'utf8');
    assert.equal(pulpo.includes("path.join(PIPELINE, 'oauth-session-expiry-state.json')"), false,
        'el marker no puede resolverse contra PIPELINE');
    assert.equal(pulpo.includes('oauthSessionExpiry.defaultStateFilePath()'), true);
});
