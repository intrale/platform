package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.ListUsersRequest
import aws.sdk.kotlin.services.cognitoidentityprovider.model.UnauthorizedException
import org.slf4j.Logger
import kotlin.math.log

class SignUpPlatformAdmin(override val config: UsersConfig, override val logger: Logger, override val cognito: CognitoIdentityProviderClient) :
                SignUp(config = config, logger = logger, cognito = cognito) {

    override fun getProfile() : String {
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
        val response = identityProviderClient.listUsers(ListUsersRequest{
               userPoolId = config.awsCognitoUserPoolId
        })
        if (response.users?.isEmpty() == true){
               logger.info("User signup")
               return super.execute(business, function, headers, textBody)
        }
        logger.warn("UnauthorizeExeption")
        return UnauthorizedException()
    }


}