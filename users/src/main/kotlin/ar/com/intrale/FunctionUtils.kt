package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.getUser
import com.google.gson.Gson
import io.konform.validation.Validation
import io.konform.validation.ValidationResult
import org.slf4j.Logger
import org.slf4j.LoggerFactory
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

private val logger: Logger = LoggerFactory.getLogger("ar.com.intrale")

const val EMAIL_REGEX = ".+@.+\\..+"
const val EMAIL_VALIDATION_HINT = "El campo email debe tener formato de email. Valor actual: '{value}'"

/**
 * Valida que el usuario autenticado tenga un perfil aprobado para el negocio dado.
 * Retorna el par (email, perfil) si es valido, o null si no esta autorizado.
 */
suspend fun requireApprovedProfile(
    cognito: CognitoIdentityProviderClient,
    headers: Map<String, String>,
    tableProfiles: DynamoDbTable<UserBusinessProfile>,
    business: String,
    requiredProfile: String
): Pair<String, UserBusinessProfile>? {
    val email = try {
        cognito.getUser { this.accessToken = headers["Authorization"] }
            .userAttributes?.firstOrNull { it.name == EMAIL_ATT_NAME }?.value
    } catch (e: Exception) {
        logger.error("Error obteniendo email del usuario autenticado", e)
        null
    } ?: return null

    val profile = tableProfiles.getItem(
        UserBusinessProfile().apply {
            this.email = email
            this.business = business
            this.profile = requiredProfile
        }
    )
    if (profile == null || profile.state != BusinessState.APPROVED) return null
    return Pair(email, profile)
}

/**
 * Valida un request body con Konform. Retorna null si es valido, o un Response de error.
 */
fun <T> validateRequest(body: T, validation: Validation<T>): Response? {
    val result: ValidationResult<T> = try {
        validation(body)
    } catch (e: Exception) {
        return RequestValidationException(e.message ?: "Unknown error")
    }
    if (!result.isValid) {
        val errorsMessage = result.errors.joinToString(" ") {
            "${it.dataPath.substring(1)} ${it.message}"
        }
        return RequestValidationException(errorsMessage)
    }
    return null
}

/**
 * Parsea el body del request. Retorna null si el body esta vacio.
 */
inline fun <reified T> parseBody(textBody: String): T? {
    if (textBody.isEmpty()) return null
    return Gson().fromJson(textBody, T::class.java)
}
