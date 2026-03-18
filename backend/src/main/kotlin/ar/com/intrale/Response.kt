package ar.com.intrale

import io.ktor.http.HttpStatusCode

open class Response(
    val statusCode: HttpStatusCode? = HttpStatusCode.OK,
    val responseHeaders: Map<String, String> = emptyMap()
)