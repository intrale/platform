package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.ListUsersRequest
import aws.sdk.kotlin.services.cognitoidentityprovider.model.UnauthorizedException
import com.google.gson.Gson
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

@Suppress("UNUSED_PARAMETER")
class SignUpPlatformAdmin(
    override val config: UsersConfig,
    override val logger: Logger,
    override val cognito: CognitoIdentityProviderClient,
    val tableProfiles: DynamoDbTable<UserBusinessProfile>
) : SignUp(config = config, logger = logger, cognito = cognito, tableProfiles = tableProfiles) {

    override fun getProfile(): String {
        return PROFILE_PLATFORM_ADMIN
    }

    override suspend fun execute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        // Validamos si ya existe algun usuario y lanzamos un error
        // Solo se permite utilizar en la creacion del primer usuario
        logger.info("Executing function $function")
        val identityProviderClient = cognito
        val response = identityProviderClient.listUsers(
            ListUsersRequest {
                userPoolId = config.awsCognitoUserPoolId
            }
        )
        if (response.users?.isEmpty() == true) {
            logger.info("User signup")
            val result = super.execute(business, function, headers, textBody)

            val body = Gson().fromJson(textBody, SignUpRequest::class.java)
            UserBusinessProfileUtils.upsertUserBusinessProfile(
                table = tableProfiles,
                email = body.email,
                business = business,
                profile = PROFILE_PLATFORM_ADMIN,
                state = BusinessState.APPROVED
            )

            return result
        }
        logger.warn("UnauthorizeExeption")
        return UnauthorizedException()
    }


}