package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.*
import com.google.gson.Gson
import io.konform.validation.Validation
import io.konform.validation.ValidationResult
import io.konform.validation.jsonschema.pattern
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

const val PROFILE_ATT_NAME = "profile"
const val BUSINESS_ATT_NAME = "locale"
const val EMAIL_ATT_NAME = "email"
const val DEFAULT_PROFILE = "DEFAULT"

open class SignUp (
    open val config: UsersConfig,
    open val logger: Logger,
    open val cognito: CognitoIdentityProviderClient,
    private val tableProfiles: DynamoDbTable<UserBusinessProfile>
) : Function {

    open fun getProfile() : String {
        return DEFAULT_PROFILE
    }

    override suspend fun execute(business: String, function: String, headers: Map<String, String>, textBody:String): Response {
        logger.debug("Executing function $function with parameters $textBody")
        if (textBody.isEmpty()) return RequestValidationException("Request body not found")

        var body = Gson().fromJson(textBody, ar.com.intrale.SignUpRequest::class.java)

        var validation = Validation<ar.com.intrale.SignUpRequest> {
            ar.com.intrale.SignUpRequest::email  required {
                pattern(".+@.+\\..+") hint "El campo email debe tener formato de email. Valor actual: '{value}'"
            }
        }

        var validationResult: ValidationResult<Any>
        try {
            validationResult = validation(body)
        } catch (e:Exception){
            return RequestValidationException("Request is empty")
        }

        if (validationResult.isValid){
            logger.debug("Validation is valid")
            val email: String = body.email

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
                            })
            } catch (e:UsernameExistsException) {
                logger.info("Usuario ya existe, se omitirá creación en Cognito")
            } catch (e:Exception) {
                logger.error("Error creating user", e)
                return ExceptionResponse(e.message ?: "Internal Server Error")
            }

            val state = UserBusinessProfileUtils.computeRelationState(tableProfiles, email)
            UserBusinessProfileUtils.upsertUserBusinessProfile(
                tableProfiles,
                email,
                business,
                getProfile(),
                state
            )

            return Response()
        }

        var errorsMessage: String = ""
        validationResult.errors.forEach {
            errorsMessage += it.dataPath.substring(1) + ' ' + it.message
        }

        return RequestValidationException(errorsMessage)
    }

}