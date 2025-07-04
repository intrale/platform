package ar.com.intrale

import com.amazonaws.services.lambda.runtime.Context
import com.amazonaws.services.lambda.runtime.events.APIGatewayProxyRequestEvent
import com.amazonaws.services.lambda.runtime.events.APIGatewayProxyResponseEvent
import kotlin.io.encoding.ExperimentalEncodingApi

class UsersRequestHandler : LambdaRequestHandler() {

    // The request limit most be assigned on Api Gateway
    // Exposes POST /{business}/requestJoinBusiness for AWS Lambda
    @OptIn(ExperimentalEncodingApi::class)
    override fun handleRequest(requestEvent: APIGatewayProxyRequestEvent?, context: Context?): APIGatewayProxyResponseEvent {
        return handle(appModule, requestEvent, context)
    }
}