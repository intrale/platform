package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.ChangePasswordRequest as AwsChangePasswordRequest
import aws.sdk.kotlin.services.cognitoidentityprovider.model.NotAuthorizedException
import com.google.gson.Gson
import io.konform.validation.Validation
import io.konform.validation.ValidationResult
import org.slf4j.Logger
import ar.com.intrale.UnauthorizedException

class ChangePassword(
    override val config: UsersConfig,
    override val logger: Logger,
    private val cognito: CognitoIdentityProviderClient
) : SecuredFunction(config = config, logger = logger) {

    fun requestValidation(body: ChangePasswordRequest): Response? {
        val validation = Validation<ChangePasswordRequest> {
            ChangePasswordRequest::oldPassword required {}
            ChangePasswordRequest::newPassword required {}
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
        if (textBody.isEmpty()) return RequestValidationException("Request body not found")
        val body = Gson().fromJson(textBody, ChangePasswordRequest::class.java)
        val response = requestValidation(body)
        if (response != null) return response

        val token = headers["Authorization"]
        if (token.isNullOrBlank()) {
            return UnauthorizedException()
        }

        try {
            cognito.changePassword(
                AwsChangePasswordRequest {
                    accessToken = token
                    previousPassword = body.oldPassword
                    proposedPassword = body.newPassword
                }
            )
            return Response()
        } catch (e: NotAuthorizedException) {
            logger.error("Error al cambiar contraseña: ${e.message}", e)
            return UnauthorizedException()
        } catch (e: Exception) {
            logger.error("Error al cambiar contraseña: ${e.message}", e)
            return ExceptionResponse(e.message ?: "Internal Server Error")
        }
    }
}
