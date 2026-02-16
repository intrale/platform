package ar.com.intrale

import com.auth0.jwt.JWT
import com.google.gson.Gson
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import java.util.UUID
import org.slf4j.Logger

private fun Map<String, String>.resolveClientEmail(): String? {
    val token = this["Authorization"] ?: this["authorization"]
    val decoded = token
        ?.removePrefix("Bearer ")
        ?.takeIf { it.isNotBlank() }
        ?.let { runCatching { JWT.decode(it) }.getOrNull() }

    return decoded?.getClaim("email")?.asString()
        ?: decoded?.subject
        ?: this["X-Debug-User"]
}

class ClientProfileFunction(
    override val config: UsersConfig,
    override val logger: Logger,
    private val repository: ClientProfileRepository,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config, logger, jwtValidator) {

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        val email = headers.resolveClientEmail() ?: return UnauthorizedException()
        val method = headers["X-Http-Method"]?.uppercase() ?: HttpMethod.Get.value.uppercase()

        return when (method) {
            HttpMethod.Get.value.uppercase() -> {
                val record = repository.getSnapshot(business, email)
                ClientProfileResponse(
                    profile = record.profile.copy(email = email),
                    preferences = record.preferences,
                    status = HttpStatusCode.OK
                )
            }

            HttpMethod.Put.value.uppercase() -> {
                val updateRequest = runCatching {
                    Gson().fromJson(textBody, ClientProfileUpdateRequest::class.java)
                }.getOrNull()

                val incomingProfile = updateRequest?.profile ?: ClientProfilePayload(email = email)
                val incomingPreferences = updateRequest?.preferences ?: ClientPreferencesPayload()

                val record = repository.updateProfile(
                    business = business,
                    email = email,
                    profile = incomingProfile.copy(email = email),
                    preferences = incomingPreferences
                )

                ClientProfileResponse(
                    profile = record.profile.copy(email = email),
                    preferences = record.preferences,
                    status = HttpStatusCode.OK
                )
            }

            else -> RequestValidationException("Unsupported method for client profile: $method")
        }
    }
}

class ClientAddressesFunction(
    override val config: UsersConfig,
    override val logger: Logger,
    private val repository: ClientProfileRepository,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config, logger, jwtValidator) {

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        val email = headers.resolveClientEmail() ?: return UnauthorizedException()
        val method = headers["X-Http-Method"]?.uppercase() ?: HttpMethod.Get.value.uppercase()
        val segments = function.split("/").filter { it.isNotBlank() }
        val addressId = segments.getOrNull(2)
        val isDefaultPath = segments.getOrNull(3)?.equals("default", ignoreCase = true) == true

        return when (method) {
            HttpMethod.Get.value.uppercase() -> {
                val addresses = repository.listAddresses(business, email)
                ClientAddressListResponse(addresses = addresses, status = HttpStatusCode.OK)
            }

            HttpMethod.Post.value.uppercase() -> {
                val payload = runCatching {
                    Gson().fromJson(textBody, ClientAddressPayload::class.java)
                }.getOrNull() ?: return RequestValidationException("Invalid address payload")

                val effectivePayload = payload.copy(
                    id = payload.id ?: UUID.randomUUID().toString()
                )
                val record = repository.createAddress(business, email, effectivePayload)
                val created = record.addresses.firstOrNull { it.id == effectivePayload.id } ?: effectivePayload
                ClientAddressResponse(address = created, status = HttpStatusCode.Created)
            }

            HttpMethod.Put.value.uppercase() -> {
                if (addressId.isNullOrBlank()) {
                    return RequestValidationException("Address id is required")
                }
                if (isDefaultPath) {
                    val record = repository.markDefault(business, email, addressId)
                    val updated = record.addresses.firstOrNull { it.id == addressId }
                    return ClientAddressResponse(address = updated, status = HttpStatusCode.OK)
                }

                val payload = runCatching {
                    Gson().fromJson(textBody, ClientAddressPayload::class.java)
                }.getOrNull() ?: return RequestValidationException("Invalid address payload")

                val record = repository.updateAddress(business, email, addressId, payload.copy(id = addressId))
                val updated = record.addresses.firstOrNull { it.id == addressId } ?: payload.copy(id = addressId)
                ClientAddressResponse(address = updated, status = HttpStatusCode.OK)
            }

            HttpMethod.Delete.value.uppercase() -> {
                if (addressId.isNullOrBlank()) {
                    return RequestValidationException("Address id is required")
                }
                repository.deleteAddress(business, email, addressId)
                Response(statusCode = HttpStatusCode.NoContent)
            }

            else -> RequestValidationException("Unsupported method for client addresses: $method")
        }
    }
}

