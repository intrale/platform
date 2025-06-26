package ar.com.intrale

import aws.sdk.kotlin.runtime.auth.credentials.StaticCredentialsProvider
import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AdminGetUserRequest
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AdminInitiateAuthRequest
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AdminRespondToAuthChallengeRequest
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AdminUpdateUserAttributesRequest
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AttributeType
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AuthFlowType.AdminNoSrpAuth
import aws.sdk.kotlin.services.cognitoidentityprovider.model.ChallengeNameType.NewPasswordRequired
import aws.sdk.kotlin.services.cognitoidentityprovider.model.ForgotPasswordRequest
import aws.sdk.kotlin.services.cognitoidentityprovider.model.NotAuthorizedException
import aws.sdk.kotlin.services.cognitoidentityprovider.model.UnauthorizedException
import aws.smithy.kotlin.runtime.auth.awscredentials.Credentials
import com.google.gson.Gson
import io.konform.validation.Validation
import io.konform.validation.ValidationResult
import net.datafaker.Faker
import org.slf4j.Logger

class PasswordRecovery(val config: UsersConfig, val logger: Logger, val cognito: CognitoIdentityProviderClient) : Function {


    fun requestValidation(body:PasswordRecoveryRequest): Response? {
        val validation = Validation<PasswordRecoveryRequest> {
            PasswordRecoveryRequest::email required {}
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

    override suspend fun execute(business: String, function: String, headers: Map<String, String>, textBody: String): Response {
        // Validacion del request
        if (textBody.isEmpty()) return RequestValidationException("Request body not found")
        val body = Gson().fromJson(textBody, PasswordRecoveryRequest::class.java)
        val response = requestValidation(body)
        if (response!=null) return response

        // Se intenta realizar el signin normalmente contra el proveedor de autenticacion
        try {
            logger.info("Se intenta realizar el signin normalmente contra el proveedor de autenticacion")
            cognito.use { identityProviderClient ->

                val forgotPasswordRequest = ForgotPasswordRequest {
                    clientId = config.awsCognitoClientId
                    username = body.email
                }

                val forgotPasswordResponse = identityProviderClient.forgotPassword(forgotPasswordRequest)

                logger.info("retornando ok")
                return Response()

            }
        } catch (e: NotAuthorizedException) {
            logger.error("Error al consultar Cognito: ${e.message}", e)
            return UnauthorizedException()
        } catch (e: Exception) {
            logger.error("Error al consultar Cognito: ${e.message}", e)
            return ExceptionResponse(e.message ?: "Internal Server Error")
        }
        //TODO: Returning nothing
        logger.info("PasswordRecovery:Returning nothing")
        return ExceptionResponse("Unknown error")
    }
}