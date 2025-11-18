package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.getUser
import com.google.gson.Gson
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import java.time.Instant

private val HEX_COLOR_REGEX = Regex("^#[0-9a-fA-F]{6}$")
private val REQUIRED_COLOR_KEYS = listOf(
    "backgroundPrimary",
    "screenBackground",
    "primaryButton",
    "secondaryButton",
    "labelText",
    "inputBackground",
    "headerBackground"
)

class PutBusinessLookAndFeelColors(
    override val config: UsersConfig,
    override val logger: Logger,
    private val cognito: CognitoIdentityProviderClient,
    private val tableProfiles: DynamoDbTable<UserBusinessProfile>,
    private val lookAndFeelTable: DynamoDbTable<BusinessLookAndFeel>
) : SecuredFunction(config = config, logger = logger) {

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.debug("starting put business look and feel colors $function for $business")

        if (business.isBlank()) {
            return RequestValidationException("Business not defined on path")
        }

        if (textBody.isBlank()) {
            return RequestValidationException("Request body not found")
        }

        val body = try {
            Gson().fromJson(textBody, BusinessLookAndFeelColorsRequest::class.java)
        } catch (e: Exception) {
            logger.error("Invalid request body", e)
            return RequestValidationException("Invalid request body")
        }

        val colors = body.colors ?: return RequestValidationException("colors field is required")

        val missingKeys = REQUIRED_COLOR_KEYS.filter { key -> colors[key].isNullOrBlank() }
        if (missingKeys.isNotEmpty()) {
            return RequestValidationException("Missing colors for keys: ${missingKeys.joinToString(", ")}")
        }

        val invalidKeys = colors.filter { (_, value) -> !HEX_COLOR_REGEX.matches(value) }
        if (invalidKeys.isNotEmpty()) {
            return RequestValidationException(
                "Invalid color format for keys: ${invalidKeys.keys.joinToString(", ")}"
            )
        }

        val token = headers["Authorization"] ?: return UnauthorizedException()
        val email = cognito.getUser { this.accessToken = token }
            .userAttributes?.firstOrNull { it.name == EMAIL_ATT_NAME }?.value
            ?: return UnauthorizedException()

        val hasAccess = tableProfiles.scan().items().any {
            it.email == email &&
                it.business == business &&
                it.state == BusinessState.APPROVED &&
                (it.profile == PROFILE_BUSINESS_ADMIN || it.profile == PROFILE_PLATFORM_ADMIN)
        }
        if (!hasAccess) {
            logger.warn("User $email tried to update colors for $business without permissions")
            return UnauthorizedException()
        }

        val key = BusinessLookAndFeel().apply { businessId = business }
        val entity = lookAndFeelTable.getItem(key) ?: BusinessLookAndFeel().apply { businessId = business }
        entity.colors = colors.mapValues { it.value.uppercase() }.toMutableMap()
        entity.lastUpdated = Instant.now().toString()
        entity.updatedBy = email

        lookAndFeelTable.putItem(entity)

        logger.debug("returning put business look and feel colors $function for $business")
        return BusinessLookAndFeelColorsResponse(
            colors = entity.colors ?: emptyMap(),
            lastUpdated = entity.lastUpdated,
            updatedBy = entity.updatedBy
        )
    }
}
