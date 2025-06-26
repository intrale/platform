    package ar.com.intrale

import io.ktor.http.HttpStatusCode

class UnauthorizedException() : Response(statusCode = HttpStatusCode.Unauthorized) {
}
