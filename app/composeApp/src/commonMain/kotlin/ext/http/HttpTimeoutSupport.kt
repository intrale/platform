package ext.http

/**
 * Helpers para detectar excepciones de timeout de Ktor de forma multiplataforma
 * sin depender de clases concretas (evita imports plataforma-especificos en commonMain).
 *
 * Issue #2285 — CA-2 / CA-4: al mapear timeouts, usamos un mensaje generico
 * y accionable en espanol, sin URLs, headers ni stack traces. El detalle
 * tecnico queda en el logger interno del HttpClient (nivel DEBUG).
 */

/**
 * Mensaje user-facing para timeouts.
 *
 * Requisitos:
 *  - En espanol informal (tono Intrale).
 *  - Accionable (sugiere al usuario volver a intentar).
 *  - Sin URLs, headers, JWT ni la palabra "timeout" en ingles.
 *  - ASCII-safe (sin tildes ni caracteres especiales) para compatibilidad
 *    con fallbacks KSP y logs de todas las plataformas.
 */
const val HTTP_TIMEOUT_USER_MESSAGE: String =
    "No pudimos conectarnos al servidor. Proba de nuevo en unos segundos."

/** Codigo HTTP que representa un timeout del cliente (RFC 7231 — Request Timeout). */
const val HTTP_TIMEOUT_STATUS_CODE: Int = 408
const val HTTP_TIMEOUT_STATUS_DESCRIPTION: String = "Request Timeout"

/**
 * Nombres simples de las excepciones de timeout conocidas de Ktor 2.x/3.x.
 * Se detecta por `simpleName` para no acoplar el modulo `shared` a
 * dependencias del cliente Ktor.
 */
private val TIMEOUT_EXCEPTION_SIMPLE_NAMES = setOf(
    "HttpRequestTimeoutException",
    "HttpConnectTimeoutException",
    "HttpSocketTimeoutException",
    "ConnectTimeoutException",
    "SocketTimeoutException",
)

/**
 * Retorna `true` si la excepcion (o alguna de sus causas) representa un timeout HTTP.
 */
fun Throwable.isHttpTimeout(): Boolean {
    var current: Throwable? = this
    val seen = HashSet<Throwable>()
    while (current != null && seen.add(current)) {
        val name = current::class.simpleName
        if (name != null && name in TIMEOUT_EXCEPTION_SIMPLE_NAMES) return true
        current = current.cause
    }
    return false
}
