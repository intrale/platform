package ext

import kotlinx.serialization.json.Json

/**
 * Instancia compartida de [Json] para deserializar respuestas del backend en los
 * `Client*Service`.
 *
 * El backend serializa `Response` con campos extra (por ejemplo `responseHeaders`)
 * que no estan declarados en los DTO del cliente. Si los servicios usan el `Json`
 * por defecto (`Json.decodeFromString`) sin `ignoreUnknownKeys = true`, fallan con
 * `Unexpected JSON token at offset N: Encountered an unknown key 'responseHeaders'`
 * y el flujo del usuario se rompe (issue #2158).
 *
 * Reglas:
 * - `ignoreUnknownKeys = true`: tolerar campos nuevos del backend sin romper el cliente.
 * - `isLenient = true`: tolerar JSON con leves desviaciones (comillas simples, claves sin
 *    comillas, etc.) por compatibilidad con respuestas no estrictas.
 *
 * Todo `Client*Service` que haga `bodyAsText() + decodeFromString` manual DEBE usar
 * esta instancia en lugar de `Json` directamente.
 */
val IntraleClientJson: Json = Json {
    ignoreUnknownKeys = true
    isLenient = true
}
