package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.getUser
import com.google.gson.Gson
import io.konform.validation.Validation
import io.konform.validation.ValidationResult
import io.konform.validation.jsonschema.minLength
import io.konform.validation.jsonschema.pattern
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.awssdk.enhanced.dynamodb.Key

class ReviewBusinessRegistration(
    override val config: UsersConfig,
    override val logger: Logger,
    private val twoFactorVerify: Function,
    private val signUp: Function,
    private val cognito: CognitoIdentityProviderClient,
    private val tableBusiness: DynamoDbTable<Business>,
    private val tableUsers: DynamoDbTable<User>,
    private val tableProfiles: DynamoDbTable<UserBusinessProfile>
) : SecuredFunction(config = config, logger = logger) {

    fun requestValidation(body: ReviewBusinessRegistrationRequest): Response? {
        val validation = Validation<ReviewBusinessRegistrationRequest> {
            ReviewBusinessRegistrationRequest::name required {
                minLength(7)
            }
            ReviewBusinessRegistrationRequest::decision required {
                pattern(Regex("^(approved|rejected)$", RegexOption.IGNORE_CASE)) hint "Debe ser APPROVED o REJECTED"
            }
            ReviewBusinessRegistrationRequest::twoFactorCode required {
                minLength(6)
            }
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
        logger.debug("starting review business registration $function")

        // Validacion del request
        if (textBody.isEmpty()) return RequestValidationException("Request body not found")
        val body = Gson().fromJson(textBody, ReviewBusinessRegistrationRequest::class.java)
        val response = requestValidation(body)
        if (response != null) return response

        // Validar si el usuario que genera el request es un Platform Admin
        logger.debug("checking Platform Admin Profile")
        val responseCognito = cognito.getUser {
            this.accessToken = headers["Authorization"]!!
        }

        logger.debug("trying to get user $responseCognito")
        val email = responseCognito.userAttributes?.firstOrNull { it.name == EMAIL_ATT_NAME }?.value
        if (email == null) {
            return UnauthorizedException()
        }
        val adminProfile = tableProfiles.scan().items().firstOrNull {
            it.email == email && it.business == business && it.profile == PROFILE_PLATFORM_ADMIN && it.state == BusinessState.APPROVED
        } ?: return UnauthorizedException()

        // Validar el segundo factor para ese usuario
        logger.debug("checking Two Factor")
        val twoFactorResponse = twoFactorVerify.execute(business, function, headers, Gson().toJson(TwoFactorVerifyRequest(body.twoFactorCode)))
        if (twoFactorResponse.statusCode?.value != 200) {
            return twoFactorResponse
        }

        // Validar que el negocio se encuentre en estado pending
        val businessData = tableBusiness.getItem(
            Business(
                name = body.name,
            )
        )

        if (businessData == null) {
            return ExceptionResponse("Business not found")
        }

        if (businessData.state != BusinessState.PENDING) {
            return ExceptionResponse("Business is in wrong state")
        }

        // Cambiar el estado del negocio segun la bandera de aceptado o rechazado
        if (body.decision.uppercase() == "APPROVED") {
            val existing = tableBusiness.scan().items().firstOrNull {
                it.name.equals(body.name, ignoreCase = true) && it.state == BusinessState.APPROVED
            }
            if (existing != null) {
                return ExceptionResponse("El nombre del negocio ya existe")
            }

            businessData.state = BusinessState.APPROVED
            // Si el negocio es aceptado, Validar si el usuario Business Admin ya se encuentra registrado en intrale en caso de que No, enviar mail para signup del usuario
            logger.debug("checking User Business Admin")

            //val businessAdminUser = tableUsers.getItem { User(email = businessData.emailAdmin) }
            val businessAdminUser = tableUsers.getItem { b ->
                b.key(Key.builder().partitionValue(businessData.emailAdmin).build())
            }

            if (businessAdminUser == null) {
                logger.debug("SignUp User Business Admin")
                val signUpResponse = signUp.execute(
                    business,
                    function,
                    headers,
                    Gson().toJson(SignUpRequest(businessData.emailAdmin!!))
                )
                if (signUpResponse.statusCode?.value != 200) {
                    return signUpResponse
                }
            }

            // Si el negocio es aceptado, Registrar al usuario con el perfil de Business Admin para el negocio para el cual se registra
            logger.debug("Profile Assigned Business Admin")
            val userBusinessProfile = UserBusinessProfile()
            userBusinessProfile.email = businessData.emailAdmin!!
            userBusinessProfile.business = business
            userBusinessProfile.profile = "BUSINESS_ADMIN"
            tableProfiles.putItem(userBusinessProfile)

            // Se actualiza el config con el nuevo negocio
            config.businesses += setOf(businessData.name!!)

            // Informar al usuario que ya se encuentra disponible su negocio
            //TODO: Informar al usuario que ya se encuentra disponible su negocio

        } else {
            businessData.state = BusinessState.REJECTED
            // Informar al usuario que el registro fue rechazado
        }
        tableBusiness.updateItem(businessData)

        return Response()
    }
}

