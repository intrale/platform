package ar.com.intrale

import io.ktor.http.HttpStatusCode

/**
 * Standard response for health endpoint
 */
class HealthResponse(val status: String = "UP") : Response(HttpStatusCode.OK)
