package ar.com.intrale

import io.ktor.http.HttpStatusCode

class BusinessFontsResponse(
    val fonts: Map<String, String> = emptyMap(),
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)
