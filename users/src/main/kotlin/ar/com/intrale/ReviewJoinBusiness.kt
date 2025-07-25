package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.getUser
import com.google.gson.Gson
import io.konform.validation.Validation
import io.konform.validation.ValidationResult
import io.konform.validation.jsonschema.pattern
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

class ReviewJoinBusiness(
    override val config: UsersConfig,
    override val logger: Logger,
    private val cognito: CognitoIdentityProviderClient,
    private val tableProfiles: DynamoDbTable<UserBusinessProfile>,
) : SecuredFunction(config = config, logger = logger) {

    fun requestValidation(body: ReviewJoinBusinessRequest): Response? {
        val validation = Validation<ReviewJoinBusinessRequest> {
            ReviewJoinBusinessRequest::email required {
                pattern(".+@.+\\..+") hint "El campo email debe tener formato de email. Valor actual: '{value}'"
            }
            ReviewJoinBusinessRequest::decision required {
                pattern(Regex("^(APPROVED|REJECTED)$", RegexOption.IGNORE_CASE)) hint "Debe ser APPROVED o REJECTED"
            }
        }
        val validationResult: ValidationResult<Any> = try {
            validation(body)
        } catch (e: Exception) {
            e.printStackTrace()
            return RequestValidationException(e.message ?: "Unknown error")
        }
        if (!validationResult.isValid) {
            val errorsMessage = validationResult.errors.joinToString(" ") {
                "${it.dataPath.substring(1)} ${it.message}"
            }
            return RequestValidationException(errorsMessage)
        }
        return null
    }

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.debug("starting review join business $function")

        if (textBody.isEmpty()) return RequestValidationException("Request body not found")
        val body = Gson().fromJson(textBody, ReviewJoinBusinessRequest::class.java)
        val validationResponse = requestValidation(body)
        if (validationResponse != null) return validationResponse

        val user = cognito.getUser { this.accessToken = headers["Authorization"] }
        val userProfile = user.userAttributes?.firstOrNull { it.name == PROFILE_ATT_NAME }?.value
        if (PROFILE_BUSINESS_ADMIN != userProfile) {
            return UnauthorizedException()
        }

        val key = UserBusinessProfile().apply {
            email = body.email
            this.business = business
            profile = PROFILE_DELIVERY
        }
        val existing = tableProfiles.getItem(key) ?: return ExceptionResponse("Request not found")
        existing.state = if (body.decision.uppercase() == "APPROVED") BusinessState.APPROVED else BusinessState.REJECTED
        tableProfiles.updateItem(existing)

        logger.debug("return review join business $function")
        return Response()
    }
}
