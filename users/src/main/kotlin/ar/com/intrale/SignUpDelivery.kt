package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.*
import com.google.gson.Gson
import io.konform.validation.Validation
import io.konform.validation.ValidationResult
import io.konform.validation.jsonschema.pattern
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

class SignUpDelivery(
    override val config: UsersConfig,
    override val logger: Logger,
    override val cognito: CognitoIdentityProviderClient,
    private val tableProfiles: DynamoDbTable<UserBusinessProfile>
) : SignUp(config = config, logger = logger, cognito = cognito, tableProfiles = tableProfiles) {

    override fun getProfile(): String {
        return PROFILE_DELIVERY
    }

    override suspend fun execute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.debug("Executing delivery signup $function with $textBody")
        if (textBody.isEmpty()) return RequestValidationException("Request body not found")

        val body = Gson().fromJson(textBody, SignUpRequest::class.java)

        val validation = Validation<SignUpRequest> {
            SignUpRequest::email required {
                pattern(".+@.+\\..+") hint "El campo email debe tener formato de email. Valor actual: '{value}'"
            }
        }

        val validationResult: ValidationResult<Any> = try {
            validation(body)
        } catch (e: Exception) {
            return RequestValidationException("Request is empty")
        }

        if (!validationResult.isValid) {
            val errorsMessage = validationResult.errors.joinToString(" ") { it.dataPath.substring(1) + ' ' + it.message }
            return RequestValidationException(errorsMessage)
        }

        val email = body.email
        val key = UserBusinessProfile().apply {
            this.email = email
            this.business = business
            this.profile = getProfile()
        }
        val existing = tableProfiles.getItem(key)
        if (existing != null) {
            return ExceptionResponse("Delivery ya registrado para el negocio")
        }

        val attrs = mutableListOf<AttributeType>()
        attrs.add(AttributeType {
            this.name = EMAIL_ATT_NAME
            this.value = email
        })

        try {
            logger.info("Call to Cognito to create user with email $email")
            cognito.adminCreateUser(
                AdminCreateUserRequest {
                    userPoolId = config.awsCognitoUserPoolId
                    username = email
                    userAttributes = attrs
                }
            )
        } catch (e: UsernameExistsException) {
            logger.info("Usuario ya existe, se omitirá creación en Cognito")
        } catch (e: Exception) {
            logger.error("Error creating user", e)
            return ExceptionResponse(e.message ?: "Internal Server Error")
        }

        val userProfile = UserBusinessProfile().apply {
            this.email = email
            this.business = business
            this.profile = getProfile()
            this.state = BusinessState.PENDING
        }
        tableProfiles.putItem(userProfile)

        return Response()
    }
}
