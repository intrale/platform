package ar.com.intrale

import com.auth0.jwt.JWT
import com.google.gson.Gson
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger

class DeliveryProfileFunction(
    override val config: UsersConfig,
    override val logger: Logger,
    private val profileRepository: DeliveryProfileRepository,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config, logger, jwtValidator) {

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        val email = resolveEmail(headers) ?: return UnauthorizedException()
        val method = headers["X-Http-Method"]?.uppercase() ?: HttpMethod.Get.value.uppercase()
        val functionPath = headers["X-Function-Path"] ?: function
        val isAvailability = functionPath.contains("availability")

        return if (isAvailability) {
            handleAvailability(business, email, method, textBody)
        } else {
            handleProfile(business, email, method, textBody)
        }
    }

    private fun handleProfile(
        business: String,
        email: String,
        method: String,
        textBody: String
    ): Response {
        return when (method) {
            HttpMethod.Get.value.uppercase() -> {
                logger.info("Consultando perfil del repartidor $email en negocio $business")
                val record = profileRepository.getProfile(business, email)
                DeliveryProfileResponse(
                    profile = record.profile.copy(email = email),
                    zones = record.zones,
                    status = HttpStatusCode.OK
                )
            }

            HttpMethod.Put.value.uppercase() -> {
                logger.info("Actualizando perfil del repartidor $email en negocio $business")
                val updateRequest = runCatching {
                    Gson().fromJson(textBody, DeliveryProfileUpdateRequest::class.java)
                }.getOrNull()

                val incomingProfile = updateRequest?.profile ?: DeliveryProfilePayload(email = email)
                val record = profileRepository.updateProfile(business, email, incomingProfile)

                DeliveryProfileResponse(
                    profile = record.profile.copy(email = email),
                    zones = record.zones,
                    status = HttpStatusCode.OK
                )
            }

            else -> RequestValidationException("Unsupported method for delivery profile: $method")
        }
    }

    private fun handleAvailability(
        business: String,
        email: String,
        method: String,
        textBody: String
    ): Response {
        return when (method) {
            HttpMethod.Get.value.uppercase() -> {
                logger.info("Consultando disponibilidad del repartidor $email en negocio $business")
                val payload = profileRepository.getAvailability(business, email)
                DeliveryAvailabilityResponse(
                    timezone = payload.timezone,
                    slots = payload.slots,
                    status = HttpStatusCode.OK
                )
            }

            HttpMethod.Put.value.uppercase() -> {
                logger.info("Actualizando disponibilidad del repartidor $email en negocio $business")
                val payload = runCatching {
                    Gson().fromJson(textBody, DeliveryAvailabilityPayload::class.java)
                }.getOrNull() ?: return RequestValidationException("Payload de disponibilidad inválido")

                val updated = profileRepository.updateAvailability(business, email, payload)
                DeliveryAvailabilityResponse(
                    timezone = updated.timezone,
                    slots = updated.slots,
                    status = HttpStatusCode.OK
                )
            }

            else -> RequestValidationException("Unsupported method for delivery availability: $method")
        }
    }

    private fun resolveEmail(headers: Map<String, String>): String? {
        val token = headers["Authorization"] ?: headers["authorization"]
        val decoded = token
            ?.removePrefix("Bearer ")
            ?.takeIf { it.isNotBlank() }
            ?.let { runCatching { JWT.decode(it) }.getOrNull() }

        return decoded?.getClaim("email")?.asString()
            ?: decoded?.subject
            ?: headers["X-Debug-User"]
    }
}
