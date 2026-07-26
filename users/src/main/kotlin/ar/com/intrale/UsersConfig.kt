package ar.com.intrale

import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import java.util.Base64

class UsersConfig(
    override val region: String,
    val accessKeyId: String,
    val secretAccessKey: String,
    override val awsCognitoUserPoolId: String,
    override val awsCognitoClientId: String,
    val hmacKey: String,
    private val tableBusiness: DynamoDbTable<Business>
) : Config(
    region = region,
    awsCognitoUserPoolId = awsCognitoUserPoolId,
    awsCognitoClientId = awsCognitoClientId
) {
    val hmacKeyBytes: ByteArray = validateHmacKey(hmacKey)

    override fun businesses(): Set<String> =
        tableBusiness.scan().items()
            .filter { it.state == BusinessState.APPROVED }
            .mapNotNull { it.publicId }
            .toSet() + setOf("intrale")

    private fun validateHmacKey(value: String): ByteArray {
        if (value.isBlank()) {
            throw IllegalStateException(
                "INVITATION_HMAC_KEY no configurada. Generar con: openssl rand -base64 32"
            )
        }
        val decoded = try {
            Base64.getDecoder().decode(value)
        } catch (exception: IllegalArgumentException) {
            throw IllegalArgumentException("INVITATION_HMAC_KEY debe estar codificada en Base64", exception)
        }
        require(decoded.size >= MINIMUM_HMAC_KEY_BYTES) {
            "INVITATION_HMAC_KEY debe tener al menos 32 bytes (256 bits) decodificada. Actual: ${decoded.size}"
        }
        return decoded
    }

    private companion object {
        const val MINIMUM_HMAC_KEY_BYTES = 32
    }
}
