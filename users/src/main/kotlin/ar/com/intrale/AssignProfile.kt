package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.getUser
import com.google.gson.Gson
import io.konform.validation.jsonschema.pattern
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import ar.com.intrale.UnauthorizedException

class AssignProfile(
    override val config: UsersConfig,
    override val logger: Logger,
    private val cognito: CognitoIdentityProviderClient,
    private val tableProfiles: DynamoDbTable<UserBusinessProfile>
) : SecuredFunction(config = config, logger = logger) {

    fun requestValidation(body: AssignProfileRequest): Response? {
        val validation = io.konform.validation.Validation<AssignProfileRequest> {
            AssignProfileRequest::email required {
                pattern(".+@.+\\..+") hint "El campo email debe tener formato de email. Valor actual: '{value}'"
            }
            AssignProfileRequest::profile required {}
        }
        val validationResult: io.konform.validation.ValidationResult<Any> = try {
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
        logger.debug("starting assign profile $function")

        if (textBody.isEmpty()) return RequestValidationException("Request body not found")
        val body = Gson().fromJson(textBody, AssignProfileRequest::class.java)
        val validationResponse = requestValidation(body)
        if (validationResponse != null) return validationResponse

        val emailCaller = cognito.getUser { this.accessToken = headers["Authorization"] }
            .userAttributes?.firstOrNull { it.name == EMAIL_ATT_NAME }?.value
            ?: return UnauthorizedException()
        val adminProfile = tableProfiles.getItem(
            UserBusinessProfile().apply {
                email = emailCaller
                this.business = business
                profile = PROFILE_PLATFORM_ADMIN
            }
        )
        if (adminProfile == null || adminProfile.state != BusinessState.APPROVED) {
            return UnauthorizedException()
        }

        UserBusinessProfileUtils.upsertUserBusinessProfile(
            tableProfiles,
            body.email,
            business,
            body.profile,
            BusinessState.APPROVED
        )
        logger.debug("persisting profile for ${body.email}")
        logger.debug("return assign profile $function")
        return Response()
    }
}
