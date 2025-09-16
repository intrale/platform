package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.getUser
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AdminCreateUserRequest
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AttributeType
import aws.sdk.kotlin.services.cognitoidentityprovider.model.UsernameExistsException
import com.google.gson.Gson
import io.konform.validation.Validation
import io.konform.validation.ValidationResult
import io.konform.validation.jsonschema.pattern
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

class RegisterSaler(
    override val config: UsersConfig,
    override val logger: Logger,
    private val cognito: CognitoIdentityProviderClient,
    private val tableProfiles: DynamoDbTable<UserBusinessProfile>,
) : SecuredFunction(config = config, logger = logger) {

    fun requestValidation(body: RegisterSalerRequest): Response? {
        val validation = Validation<RegisterSalerRequest> {
            RegisterSalerRequest::email required {
                pattern(".+@.+\\..+") hint "El campo email debe tener formato de email. Valor actual: '{value}'"
            }
        }

        val validationResult: ValidationResult<Any> = try {
            validation(body)
        } catch (e: Exception) {
            return RequestValidationException("Request is empty")
        }

        if (!validationResult.isValid) {
            val errorsMessage = validationResult.errors.joinToString(" ") {
                it.dataPath.substring(1) + ' ' + it.message
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
        logger.debug("starting register saler $function")

        if (textBody.isEmpty()) {
            return RequestValidationException("Request body not found")
        }
        val body = Gson().fromJson(textBody, RegisterSalerRequest::class.java)
        val validationResponse = requestValidation(body)
        if (validationResponse != null) {
            return validationResponse
        }

        val token = headers["Authorization"] ?: return UnauthorizedException()

        val adminEmail = try {
            cognito.getUser { this.accessToken = token }
                .userAttributes?.firstOrNull { it.name == EMAIL_ATT_NAME }?.value
        } catch (e: Exception) {
            logger.error("Error obtaining admin email", e)
            null
        } ?: return UnauthorizedException()

        val isApprovedAdmin = tableProfiles.scan().items().any {
            it.email == adminEmail &&
                it.business == business &&
                it.profile == PROFILE_BUSINESS_ADMIN &&
                it.state == BusinessState.APPROVED
        }
        if (!isApprovedAdmin) {
            return UnauthorizedException()
        }

        val existing = tableProfiles.getItem(
            UserBusinessProfile().apply {
                email = body.email
                this.business = business
                profile = PROFILE_SALER
            }
        )
        if (existing?.state == BusinessState.APPROVED) {
            return ExceptionResponse("Saler ya registrado para el negocio", HttpStatusCode.Conflict)
        }

        val attrs = mutableListOf<AttributeType>().apply {
            add(
                AttributeType {
                    name = EMAIL_ATT_NAME
                    value = body.email
                }
            )
        }

        try {
            logger.info("Call to Cognito to create user with email ${body.email}")
            cognito.adminCreateUser(
                AdminCreateUserRequest {
                    userPoolId = config.awsCognitoUserPoolId
                    username = body.email
                    userAttributes = attrs
                }
            )
        } catch (e: UsernameExistsException) {
            logger.info("Usuario ya existe, se omitirá creación en Cognito")
        } catch (e: Exception) {
            logger.error("Error creating user", e)
            return ExceptionResponse(e.message ?: "Internal Server Error")
        }

        UserBusinessProfileUtils.upsertUserBusinessProfile(
            tableProfiles,
            body.email,
            business,
            PROFILE_SALER,
            BusinessState.APPROVED
        )

        logger.debug("register saler finished $function")
        return Response()
    }
}
