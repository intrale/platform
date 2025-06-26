package ar.com.intrale

import io.ktor.http.HttpStatusCode

class RequestValidationException(val message: String) : Response(statusCode = HttpStatusCode.BadRequest) {
}