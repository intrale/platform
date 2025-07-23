package ar.com.intrale

import com.amazonaws.services.lambda.runtime.Context
import com.amazonaws.services.lambda.runtime.RequestHandler
import com.amazonaws.services.lambda.runtime.events.APIGatewayProxyRequestEvent
import com.amazonaws.services.lambda.runtime.events.APIGatewayProxyResponseEvent
import com.google.gson.Gson

import kotlinx.coroutines.runBlocking
import org.kodein.di.DI
import org.kodein.di.instance
import org.kodein.di.ktor.closestDI
import org.kodein.type.jvmType
import org.slf4j.Logger
import java.lang.NullPointerException
import org.slf4j.LoggerFactory
import kotlin.collections.component1
import kotlin.collections.component2
import kotlin.collections.iterator
import kotlin.getValue
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

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
    @OptIn(ExperimentalEncodingApi::class)
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
                var httpMehtod = requestEvent.httpMethod

                if (httpMehtod == "OPTIONS") {
                    val map = mutableMapOf<String, String>()
                    map["Access-Control-Allow-Origin"] = "*"
                    map["Access-Control-Allow-Methods"] = "GET, OPTIONS, HEAD, PUT, POST"
                    map["Access-Control-Allow-Headers"] =
                        "Content-Type,Accept,Referer,User-Agent,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,Access-Control-Allow-Origin,Access-Control-Allow-Headers,function,idToken,businessName,filename"
                    return APIGatewayProxyResponseEvent().apply {
                        headers = map
                        statusCode = 200
                    }
                }

                if (httpMehtod == "POST") {
                    logger.info("Path ${requestEvent.path}")
                    logger.info("resource = ${requestEvent.resource}")
                    var functionName = requestEvent.pathParameters["function"]
                    val businessName = requestEvent.pathParameters["business"]
                    /*val pathParts = requestEvent.path?.split("/")?.filter { it.isNotBlank() } ?: listOf()
                    val businessName = pathParts.getOrNull(0)
                    val functionName = pathParts.getOrNull(1)*/

                    logger.info("Function name is $functionName")
                    logger.info("Business name is $businessName")

                    var functionResponse : Response

                    if (businessName == null) {
                        logger.info("Business name is null")
                        functionResponse = RequestValidationException("No business defined on path")
                    } else {
                        val config by di.instance<Config>()
                        if (!config.businesses.contains(businessName)){
                            logger.info("Business not avaiable with name $businessName")
                            functionResponse = ExceptionResponse("Business not avaiable with name $businessName")
                        } else {
                            if (functionName == null) {56
                                logger.info("No function defined on headers")
                                functionResponse = RequestValidationException("No function defined on path")
                            } else {
                                try {
                                    logger.info("Injecting Function $functionName")
                                    val function by di.instance<Function>(tag = functionName)
                                    return runBlocking {
                                        var requestBody:String = ""
                                        try {
                                            requestBody = String(Base64.Default.decode(requestEvent.body));
                                            logger.info("Request body is $requestBody")
                                            functionResponse = function.execute(businessName, functionName, requestEvent.headers, requestBody)
                                        } catch (e: NullPointerException){
                                            logger.info("NullPointerException is thrown")
                                            if (e.message.toString().contains("\"textBody\" is null")){
                                                logger.info("Request body not found")
                                                functionResponse = RequestValidationException("Request body not found")
                                            } else {
                                                logger.info(e.message)
                                                functionResponse = ExceptionResponse(e.message.toString())
                                            }
                                        }
                                        logger.info("Returning function response $functionResponse")
                                        return@runBlocking APIGatewayProxyResponseEvent().apply {
                                            body = Gson().toJson(functionResponse)
                                            logger.info("Returning body is $body")
                                            statusCode = functionResponse.statusCode?.value
                                        }
                                    }
                                } catch (e: DI.NotFoundException) {
                                    logger.info("No function with name $functionName found")
                                    functionResponse = ExceptionResponse("No function with name $functionName found")
                                    return APIGatewayProxyResponseEvent().apply {
                                        body = Gson().toJson(functionResponse)
                                        logger.info("Returning body is $body")
                                        statusCode = functionResponse.statusCode?.value
                                    }
                                }
                            }
                        }
                    }

                    return APIGatewayProxyResponseEvent().apply {
                        body = Gson().toJson(functionResponse)
                        logger.info("Finally returning body is $body")
                        statusCode = functionResponse.statusCode?.value
                    }

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
