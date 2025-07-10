package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.*
import com.google.gson.Gson
import io.konform.validation.Validation
import io.konform.validation.ValidationResult
import io.konform.validation.jsonschema.pattern
import org.slf4j.Logger

const val PROFILE_ATT_NAME = "profile"
const val BUSINESS_ATT_NAME = "locale"
const val EMAIL_ATT_NAME = "email"
const val DEFAULT_PROFILE = "DEFAULT"

open class SignUp (open val config: UsersConfig, open val logger: Logger, open val cognito: CognitoIdentityProviderClient): Function {

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
            attrs.add(AttributeType {
                this.name = PROFILE_ATT_NAME
                this.value = getProfile()
            })
            attrs.add(AttributeType {
                this.name = BUSINESS_ATT_NAME
                this.value = business
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
                // Obtenemos la informacion del usuario
                logger.info("Obtenemos la informacion del usuario")
                val user = cognito.adminGetUser(AdminGetUserRequest {
                    userPoolId = config.awsCognitoUserPoolId
                    username = body.email
                })
                val businesses = user.userAttributes?.find { it.name == BUSINESS_ATT_NAME }?.value
                logger.info("businesses: $businesses")
                if (businesses?.contains(business) == true){
                    return ExceptionResponse(e.message ?: "Internal Server Error")
                }

                //TODO: Tendriamos que actualizar por un lado la informacion del negocio al cual esta habilitado el usuario
                // y por otro lado la informacion del perfil del usuario
                logger.debug("Actualizamos el usuario con el nuevo negocio")
                //Actualizamos la informacion de negocio para el usuario
                val updateUserAttributesResponse = cognito.adminUpdateUserAttributes (
                    AdminUpdateUserAttributesRequest {
                        userPoolId = config.awsCognitoUserPoolId
                        username = body.email
                        userAttributes = listOf(
                            AttributeType {
                                name = BUSINESS_ATT_NAME
                                value = businesses + "," + business
                            }
                        )
                    })
            } catch (e:Exception) {
                logger.error("Error creating user", e)
                return ExceptionResponse(e.message ?: "Internal Server Error")
            }

            return Response()
        }

        var errorsMessage: String = ""
        validationResult.errors.forEach {
            errorsMessage += it.dataPath.substring(1) + ' ' + it.message
        }

        return RequestValidationException(errorsMessage)
    }

}