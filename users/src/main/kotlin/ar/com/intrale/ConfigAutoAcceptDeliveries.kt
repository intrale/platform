package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.getUser
import com.google.gson.Gson
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import ar.com.intrale.UserBusinessProfile

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

        if (textBody.isEmpty()) return RequestValidationException("Request body not found")
        val body = Gson().fromJson(textBody, ConfigAutoAcceptDeliveriesRequest::class.java)

        val email = cognito.getUser { this.accessToken = headers["Authorization"] }
            .userAttributes?.firstOrNull { it.name == EMAIL_ATT_NAME }?.value
            ?: return UnauthorizedException()
        val adminProfile = tableProfiles.getItem(
            UserBusinessProfile().apply {
                this.email = email
                this.business = business
                profile = PROFILE_BUSINESS_ADMIN
            }
        )
        if (adminProfile == null || adminProfile.state != BusinessState.APPROVED) {
            return UnauthorizedException()
        }

        val key = Business().apply { name = business }
        val existing = tableBusiness.getItem(key) ?: return ExceptionResponse("Business not found")
        existing.autoAcceptDeliveries = body.autoAcceptDeliveries
        tableBusiness.updateItem(existing)

        logger.debug("return config auto accept deliveries $function")
        return Response()
    }
}
