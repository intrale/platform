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
import kotlin.time.Duration.Companion.seconds
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

        routing {
            post("/{business}/{function}") {
                val di = closestDI()
                val logger: Logger by di.instance()

                val headers = call.request.headers.entries().associate { it.key to it.value.joinToString(",") }
                val body = try {
                    call.receiveText()
                } catch (e: Exception) {
                    ""
                }

                val functionResponse = call.executeFunction(
                    di = di,
                    logger = logger,
                    businessName = call.parameters["business"],
                    functionName = call.parameters["function"],
                    headers = headers,
                    requestBody = body
                )

                call.respondText(
                    text = Gson().toJson(functionResponse),
                    contentType = ContentType.Application.Json,
                    status = functionResponse.statusCode
                )
            }
            options {
                call.response.headers.append("Access-Control-Allow-Origin", "*")
                call.response.headers.append("Access-Control-Allow-Methods", "OPTIONS, HEAD, POST")
                call.response.headers.append(
                    "Access-Control-Allow-Headers",
                    "Content-Type,Accept,Referer,User-Agent,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,Access-Control-Allow-Origin,Access-Control-Allow-Headers,function,idToken,businessName,filename"
                )
                call.respond(HttpStatusCode.OK)
            }
        }


    }.start(wait = true)
}

private suspend fun ApplicationCall.executeFunction(
    di: DI,
    logger: Logger,
    businessName: String?,
    functionName: String?,
    headers: Map<String, String>,
    requestBody: String
): Response {
    val resolvedBusiness = businessName ?: return RequestValidationException("No business defined")
    val config = di.direct.instance<Config>()
    val businesses = config.businesses()
    logger.info("config.businesses: ${businesses}")
    if (!businesses.contains(resolvedBusiness)) {
        return ExceptionResponse("Business not avaiable with name $resolvedBusiness")
    }

    val resolvedFunction = functionName ?: return RequestValidationException("No function defined on path")

    return try {
        val allFunctions = di.direct.allInstances<Function>()
        logger.info(">>> Registered functions count: ${allFunctions.size}")
        logger.info("Injecting Function $resolvedFunction.")
        val function = di.direct.instance<Function>(tag = resolvedFunction)
        function.execute(resolvedBusiness, resolvedFunction, headers, requestBody)
    } catch (e: DI.NotFoundException) {
        ExceptionResponse("No function with name $resolvedFunction found")
    }
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



