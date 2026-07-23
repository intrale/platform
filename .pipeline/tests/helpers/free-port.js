'use strict';

// =============================================================================
// free-port.js — asignación de puerto libre para tests que spawnean el dashboard
//
// Motivación (rebote #4568): varios tests levantan el dashboard REAL en un
// subproceso y elegían el puerto con `3xxx + (Date.now() % N)`. Bajo la
// concurrencia de `node --test` (cada .test.js corre en su propio proceso, en
// paralelo), dos archivos podían calcular EXACTAMENTE el mismo puerto en el
// mismo milisegundo — con rangos que además se solapaban entre sí. El segundo
// dashboard fallaba al bindear (EADDRINUSE), nunca respondía /api/health y todo
// el archivo caía con `ECONNREFUSED`/`ECONNRESET` (8 fallos sobre puerto 3577).
//
// Solución: pedirle al SO un puerto efímero libre (bind a 0). El SO garantiza
// que dos listeners simultáneos reciban puertos distintos, eliminando la
// colisión determinísticamente. Se cierra el server descartable y se entrega
// el número; la ventana TOCTOU hasta que el dashboard bindea es mínima y muy
// improbable de colisionar (los efímeros viven en el rango alto del SO, lejos
// de cualquier puerto fijo del resto de la suite).
// =============================================================================

const net = require('net');

/**
 * Reserva un puerto TCP libre pidiéndoselo al SO (listen 0) y lo devuelve tras
 * cerrar el server descartable.
 *
 * @param {string} [host='127.0.0.1'] host sobre el que reservar.
 * @returns {Promise<number>} puerto libre asignado por el SO.
 */
function getFreePort(host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, host, () => {
            const { port } = srv.address();
            srv.close((err) => (err ? reject(err) : resolve(port)));
        });
    });
}

module.exports = { getFreePort };
