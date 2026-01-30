package ar.com.intrale

import ar.com.intrale.util.decodeBase64OrNull
import com.amazonaws.services.lambda.runtime.Context
import com.amazonaws.services.lambda.runtime.RequestHandler
import com.amazonaws.services.lambda.runtime.events.APIGatewayProxyRequestEvent
import com.amazonaws.services.lambda.runtime.events.APIGatewayProxyResponseEvent
import com.google.gson.Gson
import io.ktor.http.HttpMethod
import kotlinx.coroutines.runBlocking
import org.kodein.di.DI
import org.kodein.di.instance
import org.slf4j.Logger
import org.slf4j.LoggerFactory
import kotlin.getValue

abstract class LambdaRequestHandler  : RequestHandler<APIGatewayProxyRequestEvent, APIGatewayProxyResponseEvent> {

    private var diContainer: DI? = null

    private fun getDi(appModule: DI.Module): DI =
        diContainer ?: DI { import(appModule) }.also { diContainer = it }

    // The request limit most be assigned on Api Gateway
    /*@OptIn(ExperimentalEncodingApi::class)
    override fun handleRequest(requestEvent: APIGatewayProxyRequestEvent?, context: Context?): APIGatewayProxyResponseEvent  = APIGatewayProxyResponseEvent().apply {
        handle(appModule, requestEvent, context)
    }*/


    // The request limit most be assigned on Api Gateway
    fun handle(appModule: DI.Module, requestEvent: APIGatewayProxyRequestEvent?, context: Context?): APIGatewayProxyResponseEvent  /*= APIGatewayProxyResponseEvent().apply */{
        try {

            val di = getDi(appModule)
            val logger: Logger by di.instance()

            //TODO: Validar si esto sigue siendo necesario
            for ((key, binding) in di.container.tree.bindings) {
                val tipo = key.type.jvmType.typeName               // Nombre completo del tipo vinculado
                val tag = key.tag?.toString() ?: "sin tag"
                val tipoBinding = binding::class.qualifiedName     // Tipo de binding (singleton, provider, etc.)

                logger.info("Tipo registrado: $tipo con tag: $tag -> binding: $tipoBinding")
            }

            if (requestEvent != null) {
                val httpMethod = requestEvent.httpMethod ?: "POST"

                if (httpMethod.equals("OPTIONS", ignoreCase = true)) {
                    val map = mutableMapOf<String, String>()
                    map["Access-Control-Allow-Origin"] = "*"
                    map["Access-Control-Allow-Methods"] = "GET, OPTIONS, HEAD, PUT, POST, DELETE"
                    map["Access-Control-Allow-Headers"] =
                        "Content-Type,Accept,Referer,User-Agent,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,Access-Control-Allow-Origin,Access-Control-Allow-Headers,function,idToken,businessName,filename"
                    return APIGatewayProxyResponseEvent().apply {
                        headers = map
                        statusCode = 200
                    }
                }

                logger.info("Path ${requestEvent.path}")
                logger.info("resource = ${requestEvent.resource}")

                val pathParts = requestEvent.path?.split("/")?.filter { it.isNotBlank() } ?: emptyList()
                val businessName = requestEvent.pathParameters?.get("business")
                    ?: pathParts.takeIf { it.size >= 2 }?.getOrNull(0)
                val functionPath = requestEvent.pathParameters?.get("function")
                    ?: pathParts.drop(1).joinToString("/")
                val functionSegments = functionPath.split("/").filter { it.isNotBlank() }
                val functionKey = when {
                    functionSegments.size >= 2 -> functionSegments.take(2).joinToString("/")
                    functionSegments.isNotEmpty() -> functionSegments.first()
                    else -> null
                }

                logger.info("Function name is $functionPath (key: $functionKey)")
                logger.info("Business name is $businessName")

                val functionResponse: Response = if (businessName == null) {
                    logger.info("Business name is null")
                    RequestValidationException("No business defined on path")
                } else {
                    val config by di.instance<Config>()
                    val businesses = config.businesses()
                    logger.info("Available businesses are $businesses")
                    if (!businesses.contains(businessName)){
                        logger.info("Business not avaiable with name $businessName")
                        ExceptionResponse("Business not avaiable with name $businessName")
                    } else if (functionKey.isNullOrBlank()) {
                        logger.info("No function defined on path")
                        RequestValidationException("No function defined on path")
                    } else {
                        try {
                            logger.info("Injecting Function $functionKey")
                            val function by di.instance<Function>(tag = functionKey)
                            runBlocking {
                                var requestBody = ""
                                try {
                                    val encoded = requestEvent.body
                                    if (encoded != null) {
                                        val decoded = decodeBase64OrNull(encoded)
                                        if (decoded != null) {
                                            requestBody = decoded
                                            logger.info("Request body is $requestBody")
                                        } else {
                                            logger.warn("Request body no es Base64 válido, se usará el valor original")
                                            requestBody = encoded
                                        }
                                    } else {
                                        logger.info("Request body not found")
                                    }
                                    val headers = (requestEvent.headers ?: emptyMap()) + mapOf(
                                        "X-Http-Method" to httpMethod,
                                        "X-Function-Path" to functionPath
                                    )
                                    function.execute(
                                        businessName,
                                        functionPath,
                                        headers,
                                        requestBody
                                    )
                                } catch (e: Exception) {
                                    logger.info(e.message)
                                    ExceptionResponse(e.message.toString())
                                }
                            }
                        } catch (e: DI.NotFoundException) {
                            logger.info("No function with name $functionKey found")
                            ExceptionResponse("No function with name $functionKey found")
                        }
                    }
                }

                return APIGatewayProxyResponseEvent().apply {
                    body = Gson().toJson(functionResponse)
                    logger.info("Returning body is $body")
                    statusCode = functionResponse.statusCode?.value
                }

            }
        } catch (e: Exception) {
            LoggerFactory.getLogger(javaClass).error("Unhandled exception", e)
            return APIGatewayProxyResponseEvent().apply {
                statusCode = 500
                body = "Internal Server Error"
            }
        }
        return APIGatewayProxyResponseEvent().apply {
            statusCode = 500
            body = "Unexpected Error"
        }

    }
}
