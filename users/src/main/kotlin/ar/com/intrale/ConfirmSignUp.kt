package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.NotAuthorizedException
import com.google.gson.Gson
import io.konform.validation.Validation
import io.konform.validation.ValidationResult
import org.slf4j.Logger

class ConfirmSignUp(val config: UsersConfig, val logger: Logger, val cognito: CognitoIdentityProviderClient) : Function {

    fun requestValidation(body: ConfirmSignUpRequest): Response? {
        val validation = Validation<ConfirmSignUpRequest> {
            ConfirmSignUpRequest::email required {}
            ConfirmSignUpRequest::code required {}
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
        if (textBody.isEmpty()) return RequestValidationException("Request body not found")
        val body = Gson().fromJson(textBody, ConfirmSignUpRequest::class.java)
        val response = requestValidation(body)
        if (response != null) return response

        try {
            logger.info("Confirmando registro de usuario: ${body.email}")

            val confirmRequest = aws.sdk.kotlin.services.cognitoidentityprovider.model.ConfirmSignUpRequest {
                clientId = config.awsCognitoClientId
                username = body.email
                confirmationCode = body.code
            }

            cognito.confirmSignUp(confirmRequest)

            logger.info("Registro confirmado exitosamente para: ${body.email}")
            return Response()
        } catch (e: NotAuthorizedException) {
            logger.error("Error al confirmar registro: ${e.message}", e)
            return UnauthorizedException()
        } catch (e: Exception) {
            logger.error("Error al confirmar registro: ${e.message}", e)
            return ExceptionResponse(e.message ?: "Internal Server Error")
        }
    }
}
