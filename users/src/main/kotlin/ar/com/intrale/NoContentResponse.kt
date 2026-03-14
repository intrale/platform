package ar.com.intrale

import io.ktor.http.HttpStatusCode

class NoContentResponse : Response(statusCode = HttpStatusCode.NoContent)
