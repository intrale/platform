package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.*
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AuthFlowType.AdminNoSrpAuth
import aws.sdk.kotlin.services.cognitoidentityprovider.model.ChallengeNameType.NewPasswordRequired
import com.google.gson.Gson
import io.konform.validation.Validation
import io.konform.validation.ValidationResult
import org.slf4j.Logger

class SignIn(val config: UsersConfig, val logger: Logger, val cognito: CognitoIdentityProviderClient) : Function {


    fun requestValidation(body:SignInRequest): Response? {
        val validation = Validation<SignInRequest> {
            SignInRequest::email required {}
            SignInRequest::password required {}
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
        val body = Gson().fromJson(textBody, SignInRequest::class.java)
        val response = requestValidation(body)
        if (response!=null) return response

        // Se intenta realizar el signin normalmente contra el proveedor de autenticacion
        try {
            logger.info("Se intenta realizar el signin normalmente contra el proveedor de autenticacion")
            val identityProviderClient = cognito
                var authResponse = identityProviderClient.adminInitiateAuth(
                    AdminInitiateAuthRequest {
                        authFlow = AdminNoSrpAuth
                        clientId = config.awsCognitoClientId
                        userPoolId = config.awsCognitoUserPoolId
                        authParameters = mapOf("USERNAME" to body.email, "PASSWORD" to body.password)
                })

                // Validar respuesta luego del intento de login
                logger.info("Validar respuesta luego del intento de login: " + authResponse.challengeName?.value)
                if("NEW_PASSWORD_REQUIRED".equals(authResponse.challengeName?.value)) {
                    // Valido que el request contenga la nueva password
                    if (body.newPassword == null) {
                        return RequestValidationException("newPassword is required")
                    }
                    if (body.name == null) {
                        return RequestValidationException("name is required")
                    }
                    if (body.familyName == null) {
                        return RequestValidationException("familyName is required")
                    }

                    // Invocamos al cambio de contraseña
                    logger.info("Invocamos al cambio de contraseña")
                    val respondToAuthChallenge = identityProviderClient.adminRespondToAuthChallenge(
                        AdminRespondToAuthChallengeRequest {
                            challengeName = NewPasswordRequired
                            userPoolId = config.awsCognitoUserPoolId
                            clientId = config.awsCognitoClientId
                            challengeResponses = mapOf(
                                "USERNAME" to body.email,
                                "NEW_PASSWORD" to body.newPassword
                            )
                            session = authResponse.session
                        })

                    // Invocamos la actualizacion de atributos
                    val updateUserAttributesResponse = identityProviderClient.adminUpdateUserAttributes (
                        AdminUpdateUserAttributesRequest {
                            userPoolId = config.awsCognitoUserPoolId
                            username = body.email
                            userAttributes = listOf(
                                AttributeType {
                                    name = "name"
                                    value = body.name
                                },
                                AttributeType {
                                    name = "family_name"
                                    value = body.familyName
                                },
                                AttributeType {
                                    name = "email_verified"
                                    value = "true"
                                }
                            )
                        })

                    // Autenticamos con la nueva contraseña
                    authResponse = identityProviderClient.adminInitiateAuth(
                        AdminInitiateAuthRequest {
                            authFlow = AdminNoSrpAuth
                            clientId = config.awsCognitoClientId
                            userPoolId = config.awsCognitoUserPoolId
                            authParameters = mapOf("USERNAME" to body.email, "PASSWORD" to body.newPassword)
                        })

                }

                // Obtenemos la informacion del usuario
                logger.info("Obtenemos la informacion del usuario")
                val user = identityProviderClient.adminGetUser(AdminGetUserRequest {
                    userPoolId = config.awsCognitoUserPoolId
                    username = body.email
                })

                val businesses = user.userAttributes?.find { it.name == BUSINESS_ATT_NAME }?.value
                logger.info("businesses: $businesses")
                if (businesses?.contains(business) == false){
                    return UnauthorizedException()
                }

                logger.info("retornando tokens")
                return SignInResponse(
                    idToken = authResponse.authenticationResult?.idToken.toString(),
                    accessToken = authResponse.authenticationResult?.accessToken.toString(),
                    refreshToken = authResponse.authenticationResult?.refreshToken.toString()
                )
        } catch (e: NotAuthorizedException) {
            logger.error("Error al consultar Cognito: ${e.message}", e)
            return UnauthorizedException()
        } catch (e: Exception) {
            logger.error("Error al consultar Cognito: ${e.message}", e)
            return ExceptionResponse(e.message ?: "Internal Server Error")
        }
        //TODO: Returning nothing
        logger.info("SignIn:Returning nothing")
        return ExceptionResponse("Unknown error")
    }
}