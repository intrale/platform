package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.getUser
import org.apache.commons.codec.binary.Base32
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import java.security.SecureRandom

class TwoFactorSetup (override val config: UsersConfig, override val logger: Logger, val cognito: CognitoIdentityProviderClient, val tableUsers: DynamoDbTable<User>) :
    SecuredFunction(config=config, logger=logger ) {

        override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
            logger.debug("starting two factor setup $function")

            logger.debug("checking accessToken")
            val response = cognito.getUser {
                this.accessToken = headers["Authorization"]
            }

            logger.debug("trying to get user $response")
            val email = response.userAttributes?.firstOrNull { it.name == EMAIL_ATT_NAME }?.value
            val username = response.username
            val secret = generateSecret()

            if (email != null) {
                val user = User(
                    email = email,
                    secret = secret
                )
                logger.debug("persisting user $user")
                tableUsers.putItem(user)
            } else {
                logger.error("failed to get user")
                return ExceptionResponse("Email not found")
            }
            logger.debug ("return two factor setup $function")
            return TwoFactorSetupResponse(buildOtpAuthUri(secret, email))
        logger.error("failed to get two factor setup $function")
        return ExceptionResponse()
    }


    fun generateSecret(): String {
        val random = SecureRandom()
        val buffer = ByteArray(20)
        random.nextBytes(buffer)
        return Base32().encodeToString(buffer)
    }

    fun buildOtpAuthUri(secret: String, email: String?, issuer: String = "intrale"): String {
        return "otpauth://totp/${issuer}:${email}?secret=$secret&issuer=$issuer&algorithm=SHA1&digits=6&period=30"
    }

}