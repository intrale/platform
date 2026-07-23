package ar.com.intrale

import io.ktor.http.HttpStatusCode

/**
 * Respuesta 403 Forbidden.
 * Se usa cuando la identidad esta autenticada (JWT valido) pero NO esta
 * autorizada para operar sobre el recurso solicitado (ej. authz cross-product
 * del kernel multi-producto, SEC-1 / OWASP A01).
 *
 * Se distingue de [UnauthorizedException] (401 = sin sesion / token invalido)
 * para que la app pueda mapear copy accionable: 401 -> re-login, 403 -> "no tenes
 * permiso sobre este producto".
 */
class ForbiddenException(
    val code: String = "FORBIDDEN",
    val message: String = "No autorizado para operar sobre este recurso"
) : Response(statusCode = HttpStatusCode.Forbidden)
