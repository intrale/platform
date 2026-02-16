package ar.com.intrale

import com.google.gson.Gson
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.engine.*
import io.ktor.server.netty.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import org.kodein.di.DI
import org.kodein.di.allInstances
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.di.ktor.closestDI
import org.kodein.di.ktor.di
import org.kodein.type.jvmType
import ar.com.intrale.HealthResponse
import ar.com.intrale.delivery.deliveryAvailabilityRoutes
import org.slf4j.Logger

/**
 * Config and initialize
 * for Microservice
 * with KTOR
 */
fun start(appModule: DI.Module) {
    embeddedServer(Netty/*, host = "0.0.0.0", module = Application::module*/) {

        di {
            import(appModule)
        }

        healthRoute()
        deliveryAvailabilityRoutes()
        configureDynamicRouting()

    }.start(wait = true)
}

fun Application.healthRoute() {
    routing {
        get("/health") {
            call.respondText(
                text = Gson().toJson(HealthResponse()),
                contentType = ContentType.Application.Json,
                status = HttpStatusCode.OK
            )
        }
    }
}

fun Application.configureDynamicRouting() {
    routing {
        route("/{business}/{function...}") {
            registerDynamicHandler(HttpMethod.Post)
            registerDynamicHandler(HttpMethod.Get)
            registerDynamicHandler(HttpMethod.Put)
            registerDynamicHandler(HttpMethod.Delete)
        }
        options {
            call.response.headers.append("Access-Control-Allow-Origin", "*")
            call.response.headers.append("Access-Control-Allow-Methods", "GET, OPTIONS, HEAD, PUT, POST, DELETE")
            call.response.headers.append(
                "Access-Control-Allow-Headers",
                "Content-Type,Accept,Referer,User-Agent,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,Access-Control-Allow-Origin,Access-Control-Allow-Headers,function,idToken,businessName,filename"
            )
            call.respond(HttpStatusCode.OK)
        }
    }
}

private fun Route.registerDynamicHandler(httpMethod: HttpMethod) {
    method(httpMethod) {
        handle {
            val di = closestDI()
            val logger: Logger by di.instance()

            val businessName = call.parameters["business"]
            val functionSegments = call.parameters.getAll("function")?.filter { it.isNotBlank() } ?: emptyList()
            val functionPath = functionSegments.joinToString("/")
            val functionKey = when {
                functionSegments.size >= 2 -> functionSegments.take(2).joinToString("/")
                functionSegments.isNotEmpty() -> functionSegments.first()
                else -> null
            }

            val headers: Map<String, String> = call.request.headers.entries().associate {
                it.key to it.value.joinToString(",")
            } + mapOf(
                "X-Http-Method" to httpMethod.value,
                "X-Function-Path" to functionPath
            )

            val functionResponse: Response = when {
                businessName == null -> RequestValidationException("No business defined on path")
                functionKey.isNullOrBlank() -> RequestValidationException("No function defined on path")
                else -> {
                    val config = di.direct.instance<Config>()
                    val businesses = config.businesses()
                    logger.info("config.businesses: $businesses")
                    if (!businesses.contains(businessName)) {
                        ExceptionResponse("Business not avaiable with name $businessName")
                    } else {
                        try {
                            val allFunctions = di.direct.allInstances<Function>()
                            logger.info(">>> Registered functions count: ${allFunctions.size}")
                            logger.info("Injecting Function $functionKey for path $functionPath and method ${httpMethod.value}.")
                            val function = di.direct.instance<Function>(tag = functionKey)
                            val requestBody = try {
                                call.receiveText()
                            } catch (e: Exception) {
                                ""
                            }
                            function.execute(businessName, functionPath, headers, requestBody)
                        } catch (e: DI.NotFoundException) {
                            ExceptionResponse("No function with name $functionKey found")
                        }
                    }
                }
            }

            call.respondText(
                text = Gson().toJson(functionResponse),
                contentType = ContentType.Application.Json,
                status = functionResponse.statusCode
            )
        }
    }
}
