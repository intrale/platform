package ar.com.intrale

import io.ktor.http.HttpStatusCode

class BusinessConfigResponse(
    val config: Map<String, String> = emptyMap(),
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)
