// =============================================================================
// fallback-episode-state.test.js — #6179
//
// Cubre las ramas de decisión de `recordDispatch`: changed / notify / auth /
// desconocida / ausente / ilegible / shape_invalido / persistencia_fallida /
// heartbeat / deterministic / lock_no_adquirido / entra_respaldo (desde un
// episodio primario abierto, que es la transición dominante en producción).
//
// Cada nombre de esa lista tiene al menos un test que asserea su `reason`. Si se
// agrega una rama, va con test: un header que afirma cubrir algo que no cubre es
// peor que no tener header, porque apaga la revisión.
//
// Lo ÚNICO que queda sin ejecutar en `fallback-episode-state.js` son dos `catch`
// fail-safe de helpers que no deciden nada: el de `deriveTier` alrededor de
// `billingOf` (inalcanzable — `billingOf` ya atrapa adentro y nunca lanza) y el
// de `deriveCause` alrededor de `classifyPauseCause` (que tampoco lanza con la
// entrada hostil que se le prueba más abajo). Ninguno es una rama de decisión de
// `recordDispatch`; se dejan como red por si esas dependencias cambian.
//
// AISLAMIENTO: cada test usa un tmpdir propio como `stateDir`. El módulo trabaja
// sobre el filesystem REAL a propósito (`atomic-json` + `file-lock` +
// `provider-pause-cause` no aceptan un fs inyectado), así que la única forma
// honesta de aislarlo es un directorio de verdad, no un fake.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const episodeState = require('../fallback-episode-state');
const cmp = require('../commander/multi-provider');
const { assertCopyLimpio } = require('./helpers/forbidden-copy-patterns');

const T0 = 1_700_000_000_000;
const HORA = 60 * 60 * 1000;

const MODELS = {
    providers: {
        anthropic: { billing: 'paid', supports_tool_use: true },
        'openai-codex': { billing: 'paid', supports_tool_use: true },
        'gemini-google': { billing: 'free', supports_tool_use: true },
        cerebras: { billing: 'free', supports_tool_use: false },
        deterministic: { supports_tool_use: false },
    },
};

function mkStateDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'v3-fallback-episode-'));
}

function rm(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ya no está */ }
}

/**
 * Siembra el snapshot de salud del que se DERIVA la causa. `recordDispatch` no
 * acepta `cause` por parámetro (D1): ésa es justamente la garantía de que
 * ningún call site puede volver a hardcodearla como hacía `pulpo.js:13325`.
 */
function seedHealth(stateDir, { anthropicReason = 'quota_exhausted_real' } = {}) {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'multi-provider-health.json'), JSON.stringify({
        ts: new Date(T0).toISOString(),
        providers: [
            {
                provider: 'anthropic', label: 'Anthropic', state: 'red',
                reason_code: anthropicReason, quota: { pct: 100 },
            },
            {
                provider: 'openai', label: 'OpenAI / Codex', state: 'green',
                reason_code: 'cli_oauth_ok', quota: { pct: 5 },
            },
        ],
    }));
}

/** Despacho degradado estándar. `staleMs` alto para que el snapshot sembrado no sea stale. */
function dispatch(stateDir, over = {}) {
    return episodeState.recordDispatch({
        stateDir,
        provider: 'openai-codex',
        crossProvider: true,
        chain: ['anthropic', 'openai-codex'],
        models: MODELS,
        heartbeatMs: 6 * HORA,
        now: T0,
        ...over,
    });
}

function episodeFile(stateDir) {
    return path.join(stateDir, episodeState.EPISODE_FILENAME);
}

// -----------------------------------------------------------------------------
// CA-1 / CA-2 — el ruido que la historia viene a sacar
// -----------------------------------------------------------------------------

test('CA-2 — 15 despachos consecutivos en el mismo estado ⇒ exactamente 1 notificación', () => {
    const dir = mkStateDir();
    try {
        seedHealth(dir);
        let avisos = 0;
        for (let i = 0; i < 15; i++) {
            if (dispatch(dir, { now: T0 + i * 1000 }).notify) avisos++;
        }
        assert.equal(avisos, 1, '15 despachos, un aviso');
    } finally { rm(dir); }
});

test('CA-2 — la vuelta al motor principal emite un aviso, y uno solo', () => {
    const dir = mkStateDir();
    try {
        seedHealth(dir);
        assert.equal(dispatch(dir).notify, true, 'entra en respaldo');

        const vuelta = dispatch(dir, {
            provider: 'anthropic', crossProvider: false, now: T0 + 4 * HORA,
        });
        assert.equal(vuelta.notify, true);
        assert.equal(vuelta.changed, true);
        assert.equal(vuelta.reason, 'vuelve_principal');
        assert.equal(vuelta.episode.mode, 'primario');
        assert.equal(vuelta.episode.tier, null, 'en primario no hay escalón');

        // Los despachos sanos siguientes no vuelven a avisar.
        for (let i = 1; i <= 5; i++) {
            const r = dispatch(dir, {
                provider: 'anthropic', crossProvider: false, now: T0 + 4 * HORA + i * 1000,
            });
            assert.equal(r.notify, false, 'el motor principal estable es silencio');
        }

        // Y el copy dice cuánto duró la degradación.
        const texto = cmp.formatEpisodeNotice(vuelta.episode, { now: T0 + 4 * HORA });
        assert.match(texto, /volvió al motor principal/i);
        assert.match(texto, /Estuvo 4 h con motor de respaldo/);
        assertCopyLimpio(assert, texto, 'aviso de vuelta a la normalidad');
    } finally { rm(dir); }
});

test('CA-2 — con un episodio PRIMARIO abierto, caer a respaldo emite el aviso de entrada', () => {
    // El camino DOMINANTE en producción, y por eso tiene test propio: el happy
    // path de `dispatch-with-fallback.js:1538-1549` llama a `_recordEpisode` en
    // CADA despacho exitoso del primario, así que cuando el pipeline se degrada
    // `prev` casi nunca es null — es un episodio en `mode: 'primario'`. El primer
    // aviso que ve el operador sale por esta rama, no por la de `prev === null`.
    const dir = mkStateDir();
    try {
        seedHealth(dir);

        // Estado sembrado como lo siembra producción: despacho sano del primario.
        const sano = dispatch(dir, { provider: 'anthropic', crossProvider: false, now: T0 });
        assert.equal(sano.notify, false, 'el primario estable no avisa');
        const persistido = JSON.parse(fs.readFileSync(episodeFile(dir), 'utf8'));
        assert.equal(persistido.mode, 'primario', 'precondición: hay episodio primario abierto');

        // Y ahora sí, la degradación.
        const caida = dispatch(dir, { now: T0 + HORA });
        assert.equal(caida.notify, true, 'entrar en respaldo desde primario SIEMPRE avisa');
        assert.equal(caida.changed, true);
        assert.equal(caida.reason, 'entra_respaldo', 'la transición, no `sin_estado_previo`');
        assert.equal(caida.episode.mode, 'respaldo');
        assert.equal(caida.episode.tier, 'respaldo_pago');
        assert.equal(caida.episode.since, T0 + HORA, 'el episodio degradado arranca en la caída');

        // Y a partir de acá el dedup vuelve a mandar: un solo aviso.
        for (let i = 1; i <= 5; i++) {
            assert.equal(dispatch(dir, { now: T0 + HORA + i * 1000 }).notify, false);
        }
    } finally { rm(dir); }
});

test('CA-4 — bajar de escalón emite 1 aviso que explica la consecuencia práctica', () => {
    const dir = mkStateDir();
    try {
        seedHealth(dir);
        const primero = dispatch(dir);
        assert.equal(primero.episode.tier, 'respaldo_pago');

        // `openai-codex` (pago) se agota y se cae a `cerebras` (free, sin tools).
        const baja = dispatch(dir, {
            provider: 'cerebras',
            chain: ['anthropic', 'openai-codex', 'cerebras'],
            now: T0 + 2 * HORA,
        });
        assert.equal(baja.notify, true);
        assert.equal(baja.changed, true);
        assert.equal(baja.reason, 'baja_escalon');
        assert.equal(baja.episode.tier, 'gratuito_sin_herramientas');
        assert.equal(baja.episode.since, T0 + 2 * HORA, 'el escalón nuevo abre episodio nuevo');

        const texto = cmp.formatEpisodeNotice(baja.episode, { now: T0 + 2 * HORA });
        assert.match(texto, /no puede ejecutar comandos/i, 'dice qué NO puede hacer');
        assert.match(texto, /no editan archivos ni corren tests/i, 'la consecuencia va en tareas');
        // CA-5 / CA-9: describe el escalón, jamás el id del proveedor.
        assertCopyLimpio(assert, texto, 'aviso de bajada de escalón');

        // Y repetir en el escalón nuevo tampoco avisa.
        const repetido = dispatch(dir, {
            provider: 'cerebras',
            chain: ['anthropic', 'openai-codex', 'cerebras'],
            now: T0 + 2 * HORA + 1000,
        });
        assert.equal(repetido.notify, false);
    } finally { rm(dir); }
});

test('#6179 — subir de escalón también cierra el episodio anterior con un aviso', () => {
    const dir = mkStateDir();
    try {
        seedHealth(dir);
        dispatch(dir, { provider: 'cerebras', chain: ['anthropic', 'cerebras'] });

        const sube = dispatch(dir, { provider: 'openai-codex', now: T0 + HORA });
        assert.equal(sube.notify, true, 'recuperar herramientas es un cambio de situación');
        assert.equal(sube.reason, 'sube_escalon');
        // Callarlo dejaría al operador creyendo que el pipeline sigue sin poder
        // correr comandos — el mismo problema que CA-13 viene a resolver.
        const texto = cmp.formatEpisodeNotice(sube.episode, { now: T0 + HORA });
        assert.doesNotMatch(texto, /no puede ejecutar comandos/i);
    } finally { rm(dir); }
});

// -----------------------------------------------------------------------------
// CA-6 / CA-12 — la causa es la derivada, y auth/desconocida nunca se callan
// -----------------------------------------------------------------------------

test('CA-6 — la causa se DERIVA del snapshot: un gating de credenciales da cause auth', () => {
    const dir = mkStateDir();
    try {
        seedHealth(dir, { anthropicReason: 'invalid_credentials' });
        const r = dispatch(dir);
        assert.equal(r.episode.cause, 'auth',
            'la causa sale de provider-pause-cause, no de un literal del call site');

        const texto = cmp.formatEpisodeNotice(r.episode, { now: T0 });
        assert.match(texto, /credenciales/i);
        assert.doesNotMatch(texto, /cupo|cuota/i,
            'un 401 no puede reportarse como cuota agotada (SEC-9)');
    } finally { rm(dir); }
});

test('CA-12 — cause auth notifica SIEMPRE, aunque el estado no haya cambiado', () => {
    const dir = mkStateDir();
    try {
        seedHealth(dir, { anthropicReason: 'invalid_credentials' });
        let avisos = 0;
        for (let i = 0; i < 8; i++) {
            const r = dispatch(dir, { now: T0 + i * 1000 });
            if (r.notify) avisos++;
        }
        assert.equal(avisos, 8, 'fail-closed: una credencial revocada se avisa en cada despacho');

        // Y el copy explica su propia repetición, para que el operador no crea
        // que la historia no funcionó (UX, decisión 5).
        const texto = cmp.formatEpisodeNotice(dispatch(dir).episode, { now: T0 });
        assert.match(texto, /te aviso en cada despacho/i);
        assert.match(texto, /🚨/, 'destacado: hay algo que decidir');
        assert.match(texto, /revises el acceso/i, 'CA-7: acá SÍ hay acción');
    } finally { rm(dir); }
});

test('CA-12 — snapshot degradado (dominantCause null) ⇒ notifica destacado', () => {
    const dir = mkStateDir();
    try {
        // Sin snapshot: classifyPauseCause devuelve degraded:true ⇒ cause null.
        // Ese null ES el caso "motivo desconocido", no un error a tapar.
        const r = dispatch(dir);
        assert.equal(r.episode.cause, null);
        assert.equal(r.notify, true);

        let avisos = 0;
        for (let i = 1; i <= 5; i++) {
            if (dispatch(dir, { now: T0 + i * 1000 }).notify) avisos++;
        }
        assert.equal(avisos, 5, 'causa desconocida también es fail-closed');

        const texto = cmp.formatEpisodeNotice(r.episode, { now: T0 });
        assert.match(texto, /🚨/);
        assert.match(texto, /no se pudo determinar/i);
        assertCopyLimpio(assert, texto, 'aviso de causa desconocida');
    } finally { rm(dir); }
});

// -----------------------------------------------------------------------------
// CA-10 — el silencio no puede significar "se rompió el avisador"
// -----------------------------------------------------------------------------

test('CA-10 — estado AUSENTE ⇒ notify true, con el motivo distinguido', () => {
    const dir = mkStateDir();
    try {
        seedHealth(dir);
        assert.equal(fs.existsSync(episodeFile(dir)), false, 'precondición: no hay estado');
        const r = dispatch(dir);
        assert.equal(r.notify, true);
        assert.equal(r.reason, 'ausente');
    } finally { rm(dir); }
});

test('CA-10 — estado ILEGIBLE (JSON corrupto) ⇒ notify true, NUNCA "sin cambio"', () => {
    const dir = mkStateDir();
    try {
        seedHealth(dir);
        dispatch(dir); // deja un episodio válido
        fs.writeFileSync(episodeFile(dir), '{ esto no es json valido ');

        const r = dispatch(dir, { now: T0 + 1000 });
        assert.equal(r.notify, true, 'tratar el corrupto como conocido es supresión silenciosa');
        assert.equal(r.reason, 'ilegible');
    } finally { rm(dir); }
});

test('CA-10 — estado con SHAPE INVÁLIDO ⇒ notify true (validación de tipos y enums)', () => {
    const dir = mkStateDir();
    try {
        seedHealth(dir);
        // Parsea perfecto, pero el `tier` no está en el enum y `since` no es número.
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(episodeFile(dir), JSON.stringify({
            version: 1, mode: 'respaldo', tier: 'inventado', cause: 'cuota',
            evento: 'entra_respaldo', since: 'ayer', lastNotifiedAt: 0,
        }));

        const r = dispatch(dir, { now: T0 + 1000 });
        assert.equal(r.notify, true);
        assert.equal(r.reason, 'shape_invalido');
    } finally { rm(dir); }
});

test('CA-10 — los TRES casos son distinguibles entre sí, no un fallback colapsado', () => {
    const dir = mkStateDir();
    try {
        seedHealth(dir);
        const razones = new Set();

        razones.add(dispatch(dir).reason);                                  // ausente
        fs.writeFileSync(episodeFile(dir), 'xx');
        razones.add(dispatch(dir, { now: T0 + 1 }).reason);                  // ilegible
        fs.writeFileSync(episodeFile(dir), JSON.stringify({ version: 99 }));
        razones.add(dispatch(dir, { now: T0 + 2 }).reason);                  // shape_invalido

        assert.deepEqual([...razones].sort(), ['ausente', 'ilegible', 'shape_invalido']);
    } finally { rm(dir); }
});

test('CA-11 — si writeJsonAtomic devuelve false, se notifica igual', () => {
    const dir = mkStateDir();
    try {
        seedHealth(dir);
        dispatch(dir); // primer aviso, estado persistido

        // Segundo despacho idéntico: sin fallo de persistencia sería silencio.
        const sinFallo = dispatch(dir, { now: T0 + 1000 });
        assert.equal(sinFallo.notify, false, 'precondición: este despacho no avisaría');

        const r = dispatch(dir, {
            now: T0 + 2000,
            atomicJson: {
                readJsonSafe: require('../atomic-json').readJsonSafe,
                writeJsonAtomic: () => false, // fail-soft, no lanza
            },
        });
        assert.equal(r.notify, true, 'descartar el false es cómo un control se apaga en silencio');
        assert.equal(r.reason, 'persistencia_fallida');
    } finally { rm(dir); }
});

test('#6179 — sin `models` inyectado, el escalón se deriva de `agent-models.json` del pipelineDir', () => {
    // `pulpo.js` llama a `recordDispatch` SIN `models` (sólo `pipelineDir`), así
    // que este es el camino real del Commander: si la lectura se rompiera, todo
    // proveedor caería a `gratuito_sin_herramientas` y el operador vería el 🚨 de
    // calidad degradada en cada fallback a un respaldo PAGO. Falso destacado =
    // fatiga de alerta.
    const dir = mkStateDir();
    try {
        const pipelineDir = path.join(dir, 'pipeline');
        fs.mkdirSync(path.join(pipelineDir, 'state'), { recursive: true });
        seedHealth(path.join(pipelineDir, 'state'));
        fs.writeFileSync(path.join(pipelineDir, 'agent-models.json'), JSON.stringify(MODELS));

        const r = episodeState.recordDispatch({
            pipelineDir, provider: 'openai-codex', crossProvider: true,
            chain: ['anthropic', 'openai-codex'], now: T0, // <- sin `models`
        });
        assert.equal(r.episode.tier, 'respaldo_pago', 'leyó el billing del archivo');

        // Y si el archivo no está, degrada sin romper (fail-safe de `billingOf`).
        const dir2 = mkStateDir();
        try {
            const pd2 = path.join(dir2, 'pipeline');
            fs.mkdirSync(path.join(pd2, 'state'), { recursive: true });
            seedHealth(path.join(pd2, 'state'));
            const r2 = episodeState.recordDispatch({
                pipelineDir: pd2, provider: 'openai-codex', crossProvider: true,
                chain: ['anthropic', 'openai-codex'], now: T0,
            });
            assert.equal(r2.episode.tier, 'gratuito_sin_herramientas', 'sin archivo, el peor escalón');
            assert.equal(r2.notify, true, 'y sigue avisando: nunca silencio por no poder leer');
        } finally { rm(dir2); }
    } finally { rm(dir); }
});

test('#6179 — `models` hostil no rompe el aviso: degrada al peor escalón', () => {
    // D8 / entrada hostil: un `agent-models.json` que explota al leerse no puede
    // tumbar al avisador. Describir de menos una degradación es peor que
    // describirla de más, así que el fail-safe cae al escalón MÁS degradado.
    const dir = mkStateDir();
    try {
        seedHealth(dir);
        const modelsHostil = { get providers() { throw new Error('agent-models.json explotó'); } };
        const r = dispatch(dir, { models: modelsHostil });
        assert.equal(r.notify, true, 'el avisador sobrevive a la entrada hostil');
        assert.equal(r.episode.tier, 'gratuito_sin_herramientas');
    } finally { rm(dir); }
});

test('#6179 — `chain` hostil ⇒ causa desconocida, que NOTIFICA (CA-12), no crashea', () => {
    const dir = mkStateDir();
    try {
        seedHealth(dir);
        // Un elemento que explota al convertirse a string: `classifyPauseCause`
        // lo toca y lanza. El fail-safe es `cause: null` = "no se pudo
        // determinar", que por CA-12 notifica destacado en vez de callar.
        const chainHostil = [{ toString() { throw new Error('boom'); } }];
        const r = dispatch(dir, { chain: chainHostil, now: T0 + 1 });
        assert.equal(r.notify, true);
        assert.equal(r.episode.cause, null, 'causa desconocida, jamás una inventada');
        assertCopyLimpio(assert, cmp.formatEpisodeNotice(r.episode, { now: T0 + 1 }), 'chain hostil');
    } finally { rm(dir); }
});

// -----------------------------------------------------------------------------
// CA-14 / SEC-6 — no poder entrar a la sección crítica no puede ser silencio
//
// Es la red del issue: si esta rama regresiona, el operador recibe SILENCIO, que
// es indistinguible de "está todo bien" — el modo de falla exacto que la historia
// existe para eliminar. Sin test que la pinnee, el fail-closed no está entregado.
// -----------------------------------------------------------------------------

/**
 * Deja el lock del archivo de episodio TOMADO por un holder que `file-lock` no
 * puede robar, para forzar el timeout de forma determinística y sin esperas.
 *
 * El holder declara nuestro propio PID (así `isPidAlive` da true y el lock no se
 * declara stale) pero con `startTime` distinto del real, así que tampoco entra
 * por la puerta de reentrancia (`file-lock.js:369`). Con `lockTimeoutMs: 0` el
 * acquire falla en el primer intento: sin sleeps, sin reloj de 5 s.
 */
function trabarLock(stateDir) {
    fs.mkdirSync(stateDir, { recursive: true });
    const lockPath = episodeFile(stateDir) + '.lock';
    fs.writeFileSync(lockPath, JSON.stringify({
        pid: process.pid,                       // vivo => no es stale
        startTime: '1999-01-01T00:00:00.000Z',  // != el real => no es reentrante
        hostname: os.hostname(),
        version: 1,
        acquired_at: new Date(T0).toISOString(),
    }));
    return lockPath;
}

test('CA-14 — lock no adquirido EN RESPALDO ⇒ avisa igual, con episodio sintetizado', () => {
    const dir = mkStateDir();
    try {
        seedHealth(dir);
        dispatch(dir);                                   // abre el episodio
        assert.equal(dispatch(dir, { now: T0 + 1000 }).notify, false,
            'precondición: un despacho repetido en este estado NO avisaría');

        trabarLock(dir);
        const r = dispatch(dir, { now: T0 + 2000, lockTimeoutMs: 0 });

        assert.equal(r.notify, true, 'fail-closed hacia el aviso: un mensaje de más > un silencio');
        assert.equal(r.changed, false, 'no sabemos si cambió: no pudimos leer el estado');
        assert.match(r.reason, /^lock_no_adquirido:/, 'el motivo dice por qué, para diagnóstico');

        // El episodio va SINTETIZADO: sin él, `formatEpisodeNotice` no tendría qué
        // renderizar y el aviso que acabamos de decidir emitir se caería igual.
        assert.ok(r.episode, 'hay episodio que renderizar');
        assert.equal(r.episode.mode, 'respaldo');
        assert.equal(r.episode.tier, 'respaldo_pago');
        assert.equal(r.episode.evento, 'entra_respaldo');
        assert.equal(r.episode.since, T0 + 2000);
        const texto = cmp.formatEpisodeNotice(r.episode, { now: T0 + 2000 });
        assert.ok(texto.length > 0);
        assertCopyLimpio(assert, texto, 'aviso emitido sin poder tomar el lock');

        // Y no dejó basura: el estado en disco sigue siendo el que había.
        const enDisco = JSON.parse(fs.readFileSync(episodeFile(dir), 'utf8'));
        assert.equal(enDisco.updatedAt, T0 + 1000, 'sin lock no se escribe estado');
    } finally { rm(dir); }
});

test('CA-14 — lock no adquirido EN PRIMARIO ⇒ NO avisa (asimetría deliberada)', () => {
    const dir = mkStateDir();
    try {
        seedHealth(dir);
        trabarLock(dir);
        const r = episodeState.recordDispatch({
            stateDir: dir, provider: 'anthropic', crossProvider: false,
            chain: ['anthropic'], models: MODELS, now: T0, lockTimeoutMs: 0,
        });

        // En primario no hay degradación que ocultar: avisar sería anunciar una
        // "vuelta a la normalidad" que quizá nunca ocurrió — un destacado falso,
        // que es la fatiga de alerta que CA-15 manda evitar.
        assert.equal(r.notify, false);
        assert.equal(r.changed, false);
        assert.equal(r.episode, null, 'sin episodio no hay nada que renderizar');
        assert.equal(r.reason, 'lock_no_adquirido');
    } finally { rm(dir); }
});

test('CA-14 — las dos ramas del lock son DISTINGUIBLES por `reason`', () => {
    // Si colapsaran al mismo motivo, el log operativo no permitiría saber si el
    // pipeline calló estando degradado (bug grave) o estando sano (correcto).
    const dir = mkStateDir();
    try {
        seedHealth(dir);
        trabarLock(dir);
        const enPrimario = episodeState.recordDispatch({
            stateDir: dir, provider: 'anthropic', crossProvider: false,
            chain: ['anthropic'], models: MODELS, now: T0, lockTimeoutMs: 0,
        });
        const enRespaldo = dispatch(dir, { now: T0, lockTimeoutMs: 0 });
        assert.notEqual(enPrimario.reason, enRespaldo.reason);
        assert.notEqual(enPrimario.notify, enRespaldo.notify);
    } finally { rm(dir); }
});

test('#6179 — `lockTimeoutMs` es de tests: el default de producción es 5000 ms', () => {
    // El override existe SÓLO para poder ejercitar CA-14 en milisegundos. Si un
    // call site de producción lo pasara, un budget corto convertiría el
    // fail-closed en una fuente de ruido propia (G-4).
    const mod = fs.readFileSync(path.resolve(__dirname, '..', 'fallback-episode-state.js'), 'utf8');
    assert.match(mod, /const LOCK_TIMEOUT_MS = 5000;/, 'el default no cambió');

    for (const f of [
        path.resolve(__dirname, '..', 'agent-launcher', 'dispatch-with-fallback.js'),
        path.resolve(__dirname, '..', '..', 'pulpo.js'),
    ]) {
        assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /lockTimeoutMs/,
            `${path.basename(f)} no puede pasar lockTimeoutMs`);
    }
});

// -----------------------------------------------------------------------------
// CA-13 — heartbeat
// -----------------------------------------------------------------------------

test('CA-13 — degradación sostenida más de 6 h ⇒ re-aviso ÚNICO al próximo despacho', () => {
    const dir = mkStateDir();
    try {
        seedHealth(dir);
        assert.equal(dispatch(dir).notify, true);

        // A las 5:59 todavía no.
        assert.equal(dispatch(dir, { now: T0 + 6 * HORA - 60_000 }).notify, false);

        // A las 6:00 sí, y una sola vez.
        const hb = dispatch(dir, { now: T0 + 6 * HORA });
        assert.equal(hb.notify, true);
        assert.equal(hb.reason, 'heartbeat');
        assert.equal(hb.changed, false, 'no cambió nada: sigue pasando lo mismo');
        assert.equal(hb.episode.since, T0, 'el episodio NO se reinicia con el heartbeat');

        assert.equal(dispatch(dir, { now: T0 + 6 * HORA + 1000 }).notify, false,
            're-aviso único, no una ráfaga nueva');

        // El copy se lee distinto de un cambio de estado.
        const texto = cmp.formatEpisodeNotice(hb.episode, { now: T0 + 6 * HORA });
        assert.match(texto, /⏳/);
        assert.match(texto, /Seguimos con/i);
        assert.match(texto, /el silencio no se confunda con normalidad/i);
        assertCopyLimpio(assert, texto, 'aviso de heartbeat');
    } finally { rm(dir); }
});

test('CA-13 — la ventana del heartbeat es configurable', () => {
    const dir = mkStateDir();
    try {
        seedHealth(dir);
        dispatch(dir, { heartbeatMs: HORA });
        assert.equal(dispatch(dir, { now: T0 + 30 * 60 * 1000, heartbeatMs: HORA }).notify, false);
        assert.equal(dispatch(dir, { now: T0 + HORA, heartbeatMs: HORA }).notify, true);
    } finally { rm(dir); }
});

test('CA-13 — la ventana también sale de `config.yaml`, no sólo del parámetro', () => {
    // El parámetro `heartbeatMs` es de tests; en producción `recordDispatch` no
    // lo recibe y la ventana la resuelve `config.yaml: fallback_episode
    // .heartbeat_hours`. Sin este test, cambiar el default del YAML no rompería
    // nada visible y el operador dejaría de recibir el re-aviso sostenido.
    const dir = mkStateDir();
    try {
        seedHealth(dir);
        const cfgPath = path.join(dir, 'config.yaml');
        fs.writeFileSync(cfgPath, 'fallback_episode:\n  heartbeat_hours: 2\n');

        // Sin `heartbeatMs`: la ventana tiene que salir del YAML (2 h).
        const base = {
            stateDir: dir, configPath: cfgPath, provider: 'openai-codex',
            crossProvider: true, chain: ['anthropic', 'openai-codex'], models: MODELS,
        };
        const abre = episodeState.recordDispatch({ ...base, now: T0 });
        assert.equal(abre.episode.heartbeatMs, 2 * HORA, 'leyó heartbeat_hours del YAML');

        assert.equal(episodeState.recordDispatch({ ...base, now: T0 + HORA }).notify, false,
            'a la hora todavía no toca re-avisar');
        const re = episodeState.recordDispatch({ ...base, now: T0 + 3 * HORA });
        assert.equal(re.notify, true, 'pasadas las 2 h configuradas, re-avisa');
        assert.equal(re.reason, 'heartbeat');
    } finally { rm(dir); }
});

test('CA-13 (G-3) — el heartbeat es dirigido por DESPACHO, no por timer', () => {
    const dir = mkStateDir();
    try {
        seedHealth(dir);
        dispatch(dir);
        // Pasan 9 h sin despachar: nadie emite nada por sí solo. `readEpisode`
        // es puro y no dispara avisos — si el pipeline no despacha, no hay
        // impacto que avisar.
        const leido = episodeState.readEpisode({ stateDir: dir });
        assert.equal(leido.episode.lastNotifiedAt, T0);
        assert.equal(leido.reason, null);
        // El re-aviso llega recién con el primer despacho posterior.
        assert.equal(dispatch(dir, { now: T0 + 9 * HORA }).reason, 'heartbeat');
    } finally { rm(dir); }
});

// -----------------------------------------------------------------------------
// CA-15 — el modo determinista no es una degradación
// -----------------------------------------------------------------------------

test('CA-15 — provider deterministic ⇒ sin episodio, sin aviso, sin tocar el estado', () => {
    const dir = mkStateDir();
    try {
        seedHealth(dir);
        const r = episodeState.recordDispatch({
            stateDir: dir, provider: 'deterministic', crossProvider: true,
            chain: ['deterministic'], models: MODELS, now: T0,
        });
        assert.equal(r.notify, false);
        assert.equal(r.episode, null);
        assert.equal(r.reason, 'modo_determinista');
        // El corte va ANTES de derivar `tier`: `deterministic` no declara
        // `billing` y tiene `supports_tool_use:false`, así que sin el corte
        // caería en `gratuito_sin_herramientas` y dispararía el 🚨 de calidad
        // degradada. Un destacado falso es fatiga de alerta.
        assert.equal(fs.existsSync(episodeFile(dir)), false, 'no abre episodio');
    } finally { rm(dir); }
});

// -----------------------------------------------------------------------------
// D10 — un solo archivo de estado para los dos emisores
// -----------------------------------------------------------------------------

test('D10 — dispatcher y Commander resuelven al MISMO archivo de episodio', () => {
    // Los dos pasan `pipelineDir`; si no resolvieran igual habría dos episodios,
    // dos estados y volvería el doble aviso con la política nueva puesta.
    const desdeDispatcher = episodeState.episodeFilePath({ pipelineDir: '/repo/.pipeline' });
    const desdeCommander = episodeState.episodeFilePath({ pipelineDir: '/repo/.pipeline' });
    assert.equal(desdeDispatcher, desdeCommander);
    assert.equal(path.basename(desdeDispatcher), 'fallback-episode.json');
    assert.equal(path.basename(path.dirname(desdeDispatcher)), 'state');

    // Y el default (sin pipelineDir) cae en el mismo `.pipeline/state`.
    const porDefecto = episodeState.episodeFilePath({});
    assert.equal(path.basename(path.dirname(porDefecto)), 'state');
    assert.equal(
        path.resolve(porDefecto),
        path.resolve(__dirname, '..', '..', 'state', 'fallback-episode.json'),
    );
});

test('D10 — el estado escrito por un emisor lo lee el otro', () => {
    const dir = mkStateDir();
    try {
        seedHealth(dir);
        const pipelineDir = path.join(dir, 'pipeline');
        fs.mkdirSync(path.join(pipelineDir, 'state'), { recursive: true });
        seedHealth(path.join(pipelineDir, 'state'));

        const comun = {
            pipelineDir, provider: 'openai-codex', crossProvider: true,
            chain: ['anthropic', 'openai-codex'], models: MODELS,
        };
        assert.equal(episodeState.recordDispatch({ ...comun, now: T0 }).notify, true);
        // Segundo emisor, mismo pipelineDir, sin `stateDir` explícito.
        assert.equal(episodeState.recordDispatch({ ...comun, now: T0 + 1000 }).notify, false,
            'el segundo emisor ve el episodio abierto por el primero');
    } finally { rm(dir); }
});

// -----------------------------------------------------------------------------
// readEpisode — lectura pura (la consume la parte 2 del split)
// -----------------------------------------------------------------------------

test('readEpisode es PURO: no escribe, no decide, no abre episodios', () => {
    const dir = mkStateDir();
    try {
        const vacio = episodeState.readEpisode({ stateDir: dir });
        assert.equal(vacio.episode, null);
        assert.equal(vacio.reason, 'ausente');
        assert.equal(fs.existsSync(episodeFile(dir)), false, 'leer no crea estado');

        seedHealth(dir);
        dispatch(dir);
        const leido = episodeState.readEpisode({ stateDir: dir });
        assert.equal(leido.episode.mode, 'respaldo');
        assert.equal(leido.episode.tier, 'respaldo_pago');
        assert.equal(leido.reason, null);

        // Diez lecturas no consumen el episodio ni disparan heartbeat.
        for (let i = 0; i < 10; i++) episodeState.readEpisode({ stateDir: dir });
        assert.equal(dispatch(dir, { now: T0 + 1000 }).notify, false);
    } finally { rm(dir); }
});

// -----------------------------------------------------------------------------
// Copy hostil — CA-5 / CA-9 / D8
// -----------------------------------------------------------------------------

test('CA-5 / D8 — episodios hostiles no filtran nada al chat', () => {
    const hostiles = [
        { evento: 'constructor', tier: '__proto__', cause: 'toString', since: T0 },
        { evento: '__proto__', tier: 'valueOf', cause: '__proto__', since: T0 },
        { evento: 'entra_respaldo', tier: 'respaldo_pago', cause: 'sk-live-AKIA-eyJhbGciOi', since: T0 },
        { evento: 'entra_respaldo', tier: 'respaldo_pago', cause: 'quota_exhausted en claude-opus-4', since: T0 },
        {},
        null,
    ];
    for (const ep of hostiles) {
        const texto = cmp.formatEpisodeNotice(ep, { now: T0 + HORA });
        assert.equal(typeof texto, 'string');
        assertCopyLimpio(assert, texto, `episodio hostil ${JSON.stringify(ep)}`);
    }
});

test('CA-8 — el copy del episodio jamás contiene la jerga que reemplazó', () => {
    const dir = mkStateDir();
    try {
        seedHealth(dir);
        for (const provider of ['openai-codex', 'gemini-google', 'cerebras']) {
            const r = dispatch(dir, { provider, chain: ['anthropic', provider], now: T0 });
            if (!r.episode) continue;
            const texto = cmp.formatEpisodeNotice(r.episode, { now: T0 + HORA });
            assertCopyLimpio(assert, texto, `aviso para el escalón de ${provider}`);
            assert.ok(texto.length <= 600, 'el aviso entra en un vistazo');
            rm(episodeFile(dir));
        }
    } finally { rm(dir); }
});

test('CA-7 — sin acción pendiente, el aviso lo dice explícitamente', () => {
    const dir = mkStateDir();
    try {
        seedHealth(dir); // causa `cuota`: se resuelve solo
        const texto = cmp.formatEpisodeNotice(dispatch(dir).episode, { now: T0 });
        assert.match(texto, /No hace falta que hagas nada/i);
        assert.doesNotMatch(texto, /revises el acceso/i);
    } finally { rm(dir); }
});

test('#6179 — el copy de producción es el mismo que validó UX (sin divergencia)', () => {
    // Si se inlinearan los literales en vez de leer `copy.json`, el copy se
    // desincroniza en el primer retoque y vuelve el problema que la historia
    // viene a resolver. Este test es el que lo impide.
    const ref = require('../../assets/copy/fallback-episode/render.js');
    let comparadas = 0;
    for (const evento of ref.EVENTOS) {
        for (const tier of ref.TIERS) {
            for (const cause of [...ref.CAUSAS, null]) {
                // El cruce `sostenido` × `auth`/`desconocida` diverge A PROPÓSITO:
                // la directriz de UX en `validacion` pide conservar el marcador
                // destacado y el pedido de acción. `recordDispatch` además nunca
                // lo emite (esas causas notifican por despacho y no llegan al
                // heartbeat), así que la celda es inalcanzable en producción.
                if (evento === 'sostenido' && (cause === 'auth' || cause === 'desconocida' || cause === null)) continue;
                const ep = { evento, tier, cause, since: T0, heartbeatMs: 6 * HORA };
                assert.equal(
                    cmp.formatEpisodeNotice(ep, { now: T0 + 3 * HORA }),
                    ref.formatEpisodeNotice(ep, { now: T0 + 3 * HORA }),
                    `divergencia en ${evento}/${tier}/${cause}`,
                );
                comparadas++;
            }
        }
    }
    assert.ok(comparadas >= 60, `se compararon ${comparadas} variantes`);
});

test('#6179 — auth/desconocida NUNCA degradan a la lectura de heartbeat (directriz UX)', () => {
    for (const cause of ['auth', 'desconocida']) {
        const texto = cmp.formatEpisodeNotice(
            { evento: 'sostenido', tier: 'gratuito_sin_herramientas', cause, since: T0, heartbeatMs: 6 * HORA },
            { now: T0 + 7 * HORA },
        );
        assert.match(texto, /🚨/, 'el marcador destacado no puede caer a ⏳');
        assert.doesNotMatch(texto, /Te vuelvo a avisar cada/i,
            'el cierre de heartbeat no puede pisar el pedido de acción');
    }
});
