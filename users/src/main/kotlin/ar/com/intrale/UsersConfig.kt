package ar.com.intrale

import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

class UsersConfig(
    override val region: String,
    val accessKeyId: String,
    val secretAccessKey: String,
    override val awsCognitoUserPoolId: String,
    override val awsCognitoClientId: String,
    private val tableBusiness: DynamoDbTable<Business>
) : Config(
    region = region,
    awsCognitoUserPoolId = awsCognitoUserPoolId,
    awsCognitoClientId = awsCognitoClientId
) {
    override fun businesses(): Set<String> =
        tableBusiness.scan().items()
            .filter { it.state == BusinessState.APPROVED }
            .mapNotNull { it.publicId }
            .toSet() + setOf("intrale")
}
