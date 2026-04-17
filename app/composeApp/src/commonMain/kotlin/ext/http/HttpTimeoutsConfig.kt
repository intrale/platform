package ext.http

/**
 * Configuracion centralizada de timeouts HTTP para el cliente Ktor.
 *
 * Issue #2285 — CA-1: valores expresados como constantes con nombre,
 * no magic numbers inline. Los limites superiores (30s / 15s / 30s)
 * evitan saturacion del pool de conexiones del engine por requests colgadas
 * (OWASP A05 — Security Misconfiguration / DoS client-side).
 */
object HttpTimeoutsConfig {

    /** Tiempo maximo total para completar una request, en milisegundos. */
    const val HTTP_REQUEST_TIMEOUT_MS: Long = 30_000L

    /** Tiempo maximo para establecer la conexion TCP, en milisegundos. */
    const val HTTP_CONNECT_TIMEOUT_MS: Long = 15_000L

    /** Tiempo maximo de inactividad entre paquetes, en milisegundos. */
    const val HTTP_SOCKET_TIMEOUT_MS: Long = 30_000L
}
