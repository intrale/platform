package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AdminCreateUserRequest
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AttributeType
import aws.sdk.kotlin.services.cognitoidentityprovider.model.UsernameExistsException
import io.konform.validation.Validation
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

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.debug("starting register saler $function")

        val body = parseBody<RegisterSalerRequest>(textBody)
            ?: return RequestValidationException("Request body not found")
        val validationError = validateRequest(body, Validation {
            RegisterSalerRequest::email required {
                pattern(EMAIL_REGEX) hint EMAIL_VALIDATION_HINT
            }
        })
        if (validationError != null) return validationError

        val (_, _) = requireApprovedProfile(
            cognito, headers, tableProfiles, business, PROFILE_BUSINESS_ADMIN
        ) ?: return UnauthorizedException()

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
