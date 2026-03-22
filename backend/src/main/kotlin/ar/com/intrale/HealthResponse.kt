package ar.com.intrale

import io.ktor.http.HttpStatusCode
import java.lang.management.ManagementFactory
import java.time.Instant

/**
 * Respuesta verbose del endpoint de salud.
 *
 * Incluye estado, timestamp ISO-8601, uptime en milisegundos
 * y versión del runtime para facilitar el diagnóstico en producción.
 */
class HealthResponse(
    val status: String = "UP",
    val timestamp: String = Instant.now().toString(),
    val uptimeMs: Long = ManagementFactory.getRuntimeMXBean().uptime,
    val runtime: String = "java-${System.getProperty("java.version")}"
) : Response(HttpStatusCode.OK)
