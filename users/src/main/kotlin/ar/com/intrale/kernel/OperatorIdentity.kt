package ar.com.intrale.kernel

import com.auth0.jwt.JWT

/**
 * Identidad del operador resuelta a partir del JWT ya validado criptograficamente
 * por [ar.com.intrale.SecuredFunction.execute]. NUNCA se construye a partir del
 * body/params controlados por el cliente.
 *
 * @property subject identificador estable del operador (claim `sub` o `email`).
 *                   Es la CLAVE de autorizacion (SEC-1): el scope operador->producto
 *                   se deriva de aca, jamas del request.
 * @property email   email del operador si viaja como claim (para audit/copy).
 * @property origin  origen autenticado del comando (SEC-3/SEC-7 audit trail).
 */
data class OperatorIdentity(
    val subject: String,
    val email: String?,
    val origin: String = ORIGIN_JWT_COGNITO
) {
    companion object {
        const val ORIGIN_JWT_COGNITO = "jwt:cognito"
    }
}

/**
 * Resuelve la [OperatorIdentity] releyendo el mismo header `Authorization` que la
 * clase base [ar.com.intrale.SecuredFunction] ya valido criptograficamente antes
 * de invocar `securedExecute`. Se re-decodifica (sin re-verificar) solo para leer
 * los claims — patron vigente del repo (ver `ClientOrders`, `ClientProfileFunctions`).
 *
 * Devuelve `null` si no hay identidad resoluble -> el handler debe responder 401.
 * NO usa headers de debug (`X-Debug-User`) para derivar identidad de autoridad:
 * seria un vector de suplantacion en endpoints de mutacion de autoridad.
 */
fun Map<String, String>.resolveOperatorIdentity(): OperatorIdentity? {
    val token = this["Authorization"] ?: this["authorization"]
    val decoded = token
        ?.removePrefix("Bearer ")
        ?.takeIf { it.isNotBlank() }
        ?.let { runCatching { JWT.decode(it) }.getOrNull() }
        ?: return null

    val email = decoded.getClaim("email").asString()
    val subject = decoded.subject ?: email ?: return null
    return OperatorIdentity(subject = subject, email = email)
}
