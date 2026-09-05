'use strict';

// =============================================================================
// #5207 — Listado del trail: desborde de buffer, paginación y acotado por día
//
// CONTEXTO DEL DEFECTO
// --------------------
// El CA-2 del paraguas exige que outputs redactados PRUEBEN el rastro CloudTrail.
// Sobre el HEAD anterior eso era imposible: `kernel-cloudtrail-provision --verify`
// abortaba con el texto `aws s3api list-objects-v2 falló:` y nada después.
//
// La causa no era AWS. El bucket del trail acumula desde 2026-08-05 y su listado
// completo ya supera 1 MiB — el `maxBuffer` por defecto de `spawnSync`. Al
// desbordar, Node devuelve `status: null` y NO llena `stderr`, así que el
// mensaje salía mudo y apuntaba a un problema de permisos que no existía.
//
// Estos tests fijan las tres garantías del arreglo. Las dos últimas importan más
// que la primera: subir `maxBuffer` sólo mueve la pared de sitio, mientras que
// acotar el prefijo y paginar sacan el problema de raíz.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert');

const ct = require('../kernel-cloudtrail-provision.js');

const PLAN = Object.freeze({
    accountId: '000000000000',
    region: 'us-east-2',
    bucket: 'intrale-kernel-cloudtrail-000000000000-us-east-2',
});

// -----------------------------------------------------------------------------
// 1. Diagnóstico del fallo de spawn (la regresión que dejaba el error mudo)
// -----------------------------------------------------------------------------

test('#5207 · un desborde de buffer NO se reporta como fallo vacío de AWS', () => {
    // `spawnSync` ante ENOBUFS: status null, stderr vacío, detalle en `error`.
    // Es exactamente la forma que tenía el fallo real en producción.
    assert.ok(ct.AWS_MAX_BUFFER >= 64 * 1024 * 1024,
        'el maxBuffer explícito debe estar muy por encima del default de 1 MiB');
});

test('#5207 · el maxBuffer configurado supera con margen el listado real observado', () => {
    // El listado que rompió medía ~1,1 MB el 2026-09-04. El margen tiene que
    // dar aire para el crecimiento del bucket, no quedar al borde.
    const observadoBytes = 1108628;
    assert.ok(ct.AWS_MAX_BUFFER > observadoBytes * 50,
        'un margen chico volvería a romper apenas crezca el bucket');
});

// -----------------------------------------------------------------------------
// 2. Acotado por prefijo de día — el filtro se mueve al servidor
// -----------------------------------------------------------------------------

test('#5207 · con ventana declarada se listan prefijos de día, no el bucket entero', () => {
    const hasta = Date.UTC(2026, 8, 4, 12, 0, 0); // 2026-09-04T12:00Z
    const desde = Date.UTC(2026, 8, 3, 12, 0, 0); // 2026-09-03T12:00Z
    const prefijos = ct.trailDayPrefixes(PLAN, desde, hasta);

    assert.deepStrictEqual(prefijos, [
        'AWSLogs/000000000000/CloudTrail/us-east-2/2026/09/03/',
        'AWSLogs/000000000000/CloudTrail/us-east-2/2026/09/04/',
    ]);
});

test('#5207 · el prefijo se arma en UTC (CloudTrail particiona en UTC, no en local)', () => {
    // 2026-09-04T02:00Z cae el día 3 en Buenos Aires (UTC-3). Si el prefijo se
    // armara en hora local se pediría un día que no contiene el objeto.
    const t = Date.UTC(2026, 8, 4, 2, 0, 0);
    const prefijos = ct.trailDayPrefixes(PLAN, t, t);
    assert.deepStrictEqual(prefijos, ['AWSLogs/000000000000/CloudTrail/us-east-2/2026/09/04/']);
});

test('#5207 · una ventana absurda no genera miles de llamadas a S3', () => {
    // Un `sinceMs` corrupto (epoch 0) no puede traducirse en un barrido infinito.
    const prefijos = ct.trailDayPrefixes(PLAN, 0, Date.now());
    assert.ok(prefijos.length <= ct.MAX_DIAS_VENTANA,
        `tope defensivo excedido: ${prefijos.length} prefijos`);
});

// -----------------------------------------------------------------------------
// 2.b Rebote rev-1 — el tope recortaba el PRESENTE, no el pasado
//
// El review ejecutó `trailDayPrefixes(PLAN, hace60dias, hoy)` y obtuvo los 32
// días MÁS VIEJOS: el último prefijo era de un mes atrás y el día de HOY quedaba
// afuera. Con `--since` de más de 32 días (flag público del CLI), el listado no
// cubría el presente, `verifyKmsEventsFromTrail` no encontraba el evento recién
// emitido y `--verify` salía con exit 2 ("falta evidencia, reintentar") — cuando
// reintentar no podía servir nunca.
//
// Es el modo de falla que este archivo declara como el más peligroso ("no
// encontré el evento" indistinguible de "el control nunca se ejerció"), vuelto a
// meter por la puerta del tope. El test anterior sólo afirmaba `length <= 32`,
// que un rango sin el presente satisface igual.
// -----------------------------------------------------------------------------

const diaPrefijo = (ms) => {
    const d = new Date(ms);
    return `AWSLogs/000000000000/CloudTrail/us-east-2/${d.getUTCFullYear()}/`
        + `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/`;
};

test('#5207 rev-1 · una ventana que excede el tope conserva el día de HOY', () => {
    const hoy = Date.UTC(2026, 8, 5, 12, 0, 0);
    const hace60Dias = hoy - 60 * 24 * 60 * 60 * 1000;
    const prefijos = ct.trailDayPrefixes(PLAN, hace60Dias, hoy);

    assert.strictEqual(prefijos.length, ct.MAX_DIAS_VENTANA, 'el tope defensivo sigue vigente');
    assert.strictEqual(prefijos[prefijos.length - 1], diaPrefijo(hoy),
        'sin el día de hoy el evento recién emitido es inencontrable y --verify sale 2 para siempre');
    assert.ok(prefijos.includes(diaPrefijo(hoy)));
});

test('#5207 rev-1 · el recorte se hace desde el extremo VIEJO, anclado al presente', () => {
    const hoy = Date.UTC(2026, 8, 5, 12, 0, 0);
    const prefijos = ct.trailDayPrefixes(PLAN, hoy - 60 * 24 * 60 * 60 * 1000, hoy);
    const primerDiaEsperado = hoy - (ct.MAX_DIAS_VENTANA - 1) * 24 * 60 * 60 * 1000;
    assert.strictEqual(prefijos[0], diaPrefijo(primerDiaEsperado));
});

test('#5207 rev-1 · el truncamiento se REPORTA, nunca es silencioso', () => {
    const hoy = Date.UTC(2026, 8, 5, 12, 0, 0);
    const ventana = ct.trailDayWindow(PLAN, hoy - 60 * 24 * 60 * 60 * 1000, hoy);
    assert.strictEqual(ventana.truncado, true);
    assert.strictEqual(ventana.diasPedidos, 61);
    // `desdeEfectivoMs` es una medianoche UTC: la ventana se cuenta en días de
    // partición de CloudTrail, no en instantes.
    const medianocheHoy = Date.UTC(2026, 8, 5);
    assert.strictEqual(ventana.desdeEfectivoMs,
        medianocheHoy - (ct.MAX_DIAS_VENTANA - 1) * 24 * 60 * 60 * 1000);

    // Y el aviso llega a quien lista: "no encontré eventos" en una ventana
    // recortada NO es lo mismo que "el control no se ejerció".
    const avisos = [];
    ct.listTrailObjects(
        PLAN,
        { sinceMs: hoy - 60 * 24 * 60 * 60 * 1000, ahoraMs: hoy, avisar: (m) => avisos.push(m) },
        () => ({ Contents: [] }),
    );
    assert.strictEqual(avisos.length, 1, 'recortar la ventana pedida no puede pasar inadvertido');
    assert.match(avisos[0], /recortada a los 32 más recientes/);
});

test('#5207 rev-1 · una ventana dentro del tope no se recorta ni avisa', () => {
    const hoy = Date.UTC(2026, 8, 5, 12, 0, 0);
    const ventana = ct.trailDayWindow(PLAN, hoy - 3 * 24 * 60 * 60 * 1000, hoy);
    assert.strictEqual(ventana.truncado, false);
    assert.strictEqual(ventana.prefijos.length, 4);

    const avisos = [];
    ct.listTrailObjects(
        PLAN,
        { sinceMs: hoy - 3 * 24 * 60 * 60 * 1000, ahoraMs: hoy, avisar: (m) => avisos.push(m) },
        () => ({ Contents: [] }),
    );
    assert.deepStrictEqual(avisos, []);
});

test('#5207 rev-1 · un `desde` posterior al `hasta` no genera una ventana vacía', () => {
    // Reloj corrido o argumentos invertidos: el peor resultado sería cero
    // prefijos, o sea "no hay eventos" sin haber mirado nada.
    const hoy = Date.UTC(2026, 8, 5, 12, 0, 0);
    const prefijos = ct.trailDayPrefixes(PLAN, hoy + 10 * 24 * 60 * 60 * 1000, hoy);
    assert.deepStrictEqual(prefijos, [diaPrefijo(hoy)]);
});

test('#5207 · sin ventana el listado NO se acota por día (no se puede inventar un rango)', () => {
    const pedidos = [];
    const fakeAws = (args) => {
        pedidos.push(args[args.indexOf('--prefix') + 1]);
        return { Contents: [] };
    };
    ct.listTrailObjects(PLAN, { sinceMs: 0 }, fakeAws);
    assert.deepStrictEqual(pedidos, ['AWSLogs/000000000000/CloudTrail/us-east-2/']);
});

// -----------------------------------------------------------------------------
// 3. Paginación — un listado truncado es peor que un error
// -----------------------------------------------------------------------------

test('#5207 · el listado sigue NextToken hasta agotar el prefijo', () => {
    // `list-objects-v2` corta en 1000 claves. Ignorar `NextToken` devolvía un
    // listado incompleto EN SILENCIO: "no encontré el evento" se vuelve
    // indistinguible de "el control nunca se ejerció".
    const paginas = [
        { Contents: [{ Key: 'a/1.json.gz', LastModified: '2026-09-04T10:00:00Z' }], NextToken: 'tok-1' },
        { Contents: [{ Key: 'a/2.json.gz', LastModified: '2026-09-04T11:00:00Z' }], NextToken: 'tok-2' },
        { Contents: [{ Key: 'a/3.json.gz', LastModified: '2026-09-04T12:00:00Z' }] },
    ];
    let i = 0;
    const tokensEnviados = [];
    const fakeAws = (args) => {
        const idx = args.indexOf('--starting-token');
        if (idx !== -1) tokensEnviados.push(args[idx + 1]);
        return paginas[i++];
    };

    const claves = ct.listTrailObjects(PLAN, { sinceMs: 0 }, fakeAws);

    assert.deepStrictEqual(claves, ['a/1.json.gz', 'a/2.json.gz', 'a/3.json.gz']);
    assert.deepStrictEqual(tokensEnviados, ['tok-1', 'tok-2'],
        'cada vuelta debe reenviar el token de la anterior');
});

test('#5207 · la paginación tiene tope: un NextToken que nunca se agota no cuelga el proceso', () => {
    let vueltas = 0;
    const fakeAws = () => {
        vueltas += 1;
        return { Contents: [], NextToken: 'siempre-hay-mas' };
    };
    ct.listTrailObjects(PLAN, { sinceMs: 0 }, fakeAws);
    assert.ok(vueltas <= 100, `bucle sin tope: ${vueltas} vueltas`);
});

// -----------------------------------------------------------------------------
// 4. El comportamiento previo que NO debe cambiar
// -----------------------------------------------------------------------------

test('#5207 · se conservan sólo los .json.gz, ordenados por fecha de entrega', () => {
    const fakeAws = () => ({
        Contents: [
            { Key: 'p/b.json.gz', LastModified: '2026-09-04T12:00:00Z' },
            { Key: 'p/CloudTrail-Digest/', LastModified: '2026-09-04T09:00:00Z' },
            { Key: 'p/a.json.gz', LastModified: '2026-09-04T10:00:00Z' },
        ],
    });
    assert.deepStrictEqual(
        ct.listTrailObjects(PLAN, { sinceMs: 0 }, fakeAws),
        ['p/a.json.gz', 'p/b.json.gz'],
    );
});

test('#5207 · una clave listada por dos prefijos se procesa UNA sola vez', () => {
    // Una ventana que cruza medianoche UTC genera dos prefijos de día. Si la
    // misma clave apareciera en ambos, `verifyKmsEventsFromTrail` —que ACUMULA
    // los eventos de cada objeto que lee— contaría el uso de la CMK dos veces.
    // Evidencia de auditoría duplicada es peor que faltante: parece más sólida.
    const fakeAws = () => ({
        Contents: [{ Key: 'p/repetida.json.gz', LastModified: '2026-09-04T23:59:00Z' }],
    });
    const claves = ct.listTrailObjects(PLAN, { sinceMs: Date.parse('2026-09-04T23:50:00Z') }, fakeAws);
    assert.deepStrictEqual(claves, ['p/repetida.json.gz']);
});

test('#5207 · el colchón de entrega no descarta el objeto que trae la evidencia', () => {
    // CloudTrail entrega en lotes: un objeto puede llegar después del evento.
    // El colchón de 15 min existe para no perder justamente ese objeto.
    const evento = Date.UTC(2026, 8, 4, 12, 0, 0);
    const fakeAws = () => ({
        Contents: [
            // Entregado 10 min ANTES del corte: dentro del colchón, se conserva.
            { Key: 'p/justo.json.gz', LastModified: new Date(evento - 10 * 60 * 1000).toISOString() },
            // Entregado 2 h antes: fuera del colchón, se descarta.
            { Key: 'p/viejo.json.gz', LastModified: new Date(evento - 2 * 60 * 60 * 1000).toISOString() },
        ],
    });
    assert.deepStrictEqual(
        ct.listTrailObjects(PLAN, { sinceMs: evento }, fakeAws),
        ['p/justo.json.gz'],
    );
});
