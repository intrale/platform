package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

class ConfigAutoAcceptDeliveries(
    override val config: UsersConfig,
    override val logger: Logger,
    private val cognito: CognitoIdentityProviderClient,
    private val tableBusiness: DynamoDbTable<Business>,
    private val tableProfiles: DynamoDbTable<UserBusinessProfile>
) : SecuredFunction(config = config, logger = logger) {

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.debug("starting config auto accept deliveries $function")

        val body = parseBody<ConfigAutoAcceptDeliveriesRequest>(textBody)
            ?: return RequestValidationException("Request body not found")

        val (_, _) = requireApprovedProfile(
            cognito, headers, tableProfiles, business, PROFILE_BUSINESS_ADMIN
        ) ?: return UnauthorizedException()

        val key = Business().apply { name = business }
        val existing = tableBusiness.getItem(key) ?: return ExceptionResponse("Business not found")
        existing.autoAcceptDeliveries = body.autoAcceptDeliveries
        tableBusiness.updateItem(existing)

        logger.debug("return config auto accept deliveries $function")
        return Response()
    }
}
