package ar.com.intrale

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.response.*
import io.ktor.server.routing.*

fun Application.swaggerRoute() {
    routing {
        get("/openapi.yaml") {
            val resource = this::class.java.classLoader.getResource("openapi.yaml")
            if (resource != null) {
                call.respondText(resource.readText(), ContentType.parse("text/yaml"))
            } else {
                call.respond(HttpStatusCode.NotFound)
            }
        }
    }
}
