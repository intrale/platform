package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import org.slf4j.Logger

class SignUpDelivery(
    override val config: UsersConfig,
    override val logger: Logger,
    override val cognito: CognitoIdentityProviderClient
) : SignUp(config = config, logger = logger, cognito = cognito) {

    override fun getProfile(): String {
        return PROFILE_DELIVERY
    }
}
