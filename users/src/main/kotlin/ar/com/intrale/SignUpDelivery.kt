package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

class SignUpDelivery(
    override val config: UsersConfig,
    override val logger: Logger,
    override val cognito: CognitoIdentityProviderClient,
    tableProfiles: DynamoDbTable<UserBusinessProfile>
) : SignUp(config = config, logger = logger, cognito = cognito, tableProfiles = tableProfiles) {

    override fun getProfile(): String {
        return PROFILE_DELIVERY
    }
}
