package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.getUser
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

class RequestJoinBusiness(
    override val config: UsersConfig,
    override val logger: Logger,
    private val cognito: CognitoIdentityProviderClient,
    private val tableProfiles: DynamoDbTable<UserBusinessProfile>,
    private val tableBusiness: DynamoDbTable<Business>
) : SecuredFunction(config = config, logger = logger) {

    fun requestValidation(body: RequestJoinBusinessRequest): Response? {
        return null
    }

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.debug("starting request join business $function")

        var state = BusinessState.PENDING
        cognito.use { client ->
            val user = client.getUser {
                this.accessToken = headers["Authorization"]
            }
            val email = user.userAttributes?.firstOrNull { it.name == EMAIL_ATT_NAME }?.value
                ?: return ExceptionResponse("Email not found")

            val businessData = tableBusiness.getItem(Business().apply { name = business })
                ?: return ExceptionResponse("Business not found")
            if (businessData.autoAcceptDeliveries) {
                state = BusinessState.APPROVED
            }

            val profile = UserBusinessProfile().apply {
                this.email = email
                this.business = business
                this.profile = PROFILE_DELIVERY
                this.state = state
            }
            logger.debug("persisting request $profile")
            tableProfiles.putItem(profile)
        }

        logger.debug("return request join business $function")
        return RequestJoinBusinessResponse(state)
    }
}
