package ar.com.intrale

import aws.smithy.kotlin.runtime.util.type
import com.google.gson.Gson
import io.github.flaxoos.ktor.server.plugins.ratelimiter.RateLimiting
import io.github.flaxoos.ktor.server.plugins.ratelimiter.implementations.TokenBucket
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

        install(RateLimiting) {

            rateLimiter {
                type = TokenBucket::class
                capacity = 100
                rate = 10.seconds
            }
        }

        di {
            import(appModule)
        }

        healthRoute()

        routing {
            post("/{business}/{function}") {

                val di = closestDI()
                val logger: Logger by di.instance()

                val businessName = call.parameters["business"]
                val functionName = call.parameters["function"]

                var functionResponse : Response

                if (businessName == null) {
                    functionResponse = RequestValidationException("No business defined on path")
                } else {
                    val config = di.direct.instance<Config>()
                    logger.info("config.businesses: ${config.businesses}")
                    if (!config.businesses.contains(businessName)){
                        functionResponse = ExceptionResponse("Business not avaiable with name $businessName")
                    } else {
                        if (functionName == null) {
                            functionResponse = RequestValidationException("No function defined on path")
                        } else {
                            try {
                                val allFunctions = di.direct.allInstances<Function>()
                                logger.info(">>> Registered functions count: ${allFunctions.size}")
                                logger.info("Injecting Function $functionName.")
                                val function = di.direct.instance<Function>(tag = functionName)
                                val headers: Map<String, String> = call.request.headers.entries().associate {
                                    it.key to it.value.joinToString(",")
                                }
                                functionResponse = function.execute(businessName, functionName, headers, call.receiveText())
                            } catch (e: DI.NotFoundException) {
                                functionResponse = ExceptionResponse("No function with name $functionName found")
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
            options {
                call.response.headers.append("Access-Control-Allow-Origin", "*")
                call.response.headers.append("Access-Control-Allow-Methods", "GET, OPTIONS, HEAD, PUT, POST")
                call.response.headers.append(
                    "Access-Control-Allow-Headers",
                    "Content-Type,Accept,Referer,User-Agent,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,Access-Control-Allow-Origin,Access-Control-Allow-Headers,function,idToken,businessName,filename"
                )
                call.respond(HttpStatusCode.OK)
            }
        }


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



