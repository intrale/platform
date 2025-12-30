package ext.client

import ar.com.intrale.BuildKonfig
import ext.dto.StatusCodeDTO
import ext.storage.CommKeyValueStorage
import io.ktor.client.HttpClient
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.isSuccess
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class ClientProfileService(
    private val httpClient: HttpClient,
    private val keyValueStorage: CommKeyValueStorage
) : CommClientProfileService {

    private val logger = LoggerFactory.default.newLogger<ClientProfileService>()

    override suspend fun fetchProfile(): Result<ClientProfileResponse> {
        return try {
            logger.info { "Solicitando perfil de cliente" }
            val response = httpClient.get("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/client/profile") {
                authorize()
            }
            Result.success(response.toProfileResponse())
        } catch (throwable: Throwable) {
            logger.error(throwable) { "Error al obtener perfil" }
            Result.failure(throwable.toClientException())
        }
    }

    override suspend fun updateProfile(
        profile: ClientProfileDTO,
        preferences: ClientPreferencesDTO
    ): Result<ClientProfileResponse> {
        return try {
            logger.info { "Actualizando perfil de cliente" }
            val response = httpClient.put("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/client/profile") {
                authorize()
                setBody(
                    mapOf(
                        "profile" to profile,
                        "preferences" to preferences
                    )
                )
            }
            Result.success(response.toProfileResponse())
        } catch (throwable: Throwable) {
            logger.error(throwable) { "Error al actualizar perfil" }
            Result.failure(throwable.toClientException())
        }
    }

    private suspend fun HttpResponse.toProfileResponse(): ClientProfileResponse {
        val bodyText = bodyAsText()
        if (status.isSuccess()) {
            return if (bodyText.isBlank()) {
                ClientProfileResponse(profile = ClientProfileDTO())
            } else {
                Json.decodeFromString(ClientProfileResponse.serializer(), bodyText)
            }
        }
        throw bodyText.toClientException()
    }

    private fun String.toClientException(): ClientExceptionResponse =
        runCatching { Json.decodeFromString(ClientExceptionResponse.serializer(), this) }
            .getOrElse { ClientExceptionResponse(message = this) }

    private fun io.ktor.client.request.HttpRequestBuilder.authorize() {
        val token = keyValueStorage.token
            ?: throw ClientExceptionResponse(message = "Token no disponible", statusCode = StatusCodeDTO(401, "Unauthorized"))
        header(HttpHeaders.Authorization, "Bearer $token")
    }
}

class ClientAddressesService(
    private val httpClient: HttpClient,
    private val keyValueStorage: CommKeyValueStorage
) : CommClientAddressesService {

    private val logger = LoggerFactory.default.newLogger<ClientAddressesService>()

    override suspend fun listAddresses(): Result<List<ClientAddressDTO>> {
        return try {
            logger.info { "Listando direcciones del cliente" }
            val response = httpClient.get("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/client/addresses") {
                authorize()
            }
            Result.success(response.toAddresses())
        } catch (throwable: Throwable) {
            logger.error(throwable) { "Error al listar direcciones" }
            Result.failure(throwable.toClientException())
        }
    }

    override suspend fun createAddress(address: ClientAddressDTO): Result<ClientAddressDTO> {
        return try {
            logger.info { "Creando dirección" }
            val response = httpClient.post("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/client/addresses") {
                authorize()
                setBody(address)
            }
            Result.success(response.toAddress())
        } catch (throwable: Throwable) {
            logger.error(throwable) { "Error al crear dirección" }
            Result.failure(throwable.toClientException())
        }
    }

    override suspend fun updateAddress(address: ClientAddressDTO): Result<ClientAddressDTO> {
        return try {
            val id = address.id ?: throw ClientExceptionResponse(message = "ID de dirección requerido")
            logger.info { "Actualizando dirección $id" }
            val response = httpClient.put("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/client/addresses/$id") {
                authorize()
                setBody(address)
            }
            Result.success(response.toAddress())
        } catch (throwable: Throwable) {
            logger.error(throwable) { "Error al actualizar dirección" }
            Result.failure(throwable.toClientException())
        }
    }

    override suspend fun deleteAddress(addressId: String): Result<Unit> {
        return try {
            logger.info { "Eliminando dirección $addressId" }
            val response = httpClient.delete("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/client/addresses/$addressId") {
                authorize()
            }
            if (!response.status.isSuccess()) {
                throw response.bodyAsText().toClientException()
            }
            Result.success(Unit)
        } catch (throwable: Throwable) {
            logger.error(throwable) { "Error al eliminar dirección" }
            Result.failure(throwable.toClientException())
        }
    }

    override suspend fun markDefault(addressId: String): Result<ClientAddressDTO> {
        return try {
            logger.info { "Marcando dirección predeterminada $addressId" }
            val response = httpClient.put("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/client/addresses/$addressId/default") {
                authorize()
            }
            Result.success(response.toAddress())
        } catch (throwable: Throwable) {
            logger.error(throwable) { "Error al marcar dirección predeterminada" }
            Result.failure(throwable.toClientException())
        }
    }

    private suspend fun HttpResponse.toAddresses(): List<ClientAddressDTO> {
        val bodyText = bodyAsText()
        if (status.isSuccess()) {
            if (bodyText.isBlank()) return emptyList()
            val parsedResponse = runCatching {
                Json.decodeFromString(ClientAddressResponse.serializer(), bodyText).addresses
            }.getOrNull()
            if (parsedResponse != null) {
                return parsedResponse
            }
            return Json.decodeFromString(ListSerializer(ClientAddressDTO.serializer()), bodyText)
        }
        throw bodyText.toClientException()
    }

    private suspend fun HttpResponse.toAddress(): ClientAddressDTO {
        val bodyText = bodyAsText()
        if (status.isSuccess()) {
            if (bodyText.isBlank()) return ClientAddressDTO()
            return Json.decodeFromString(ClientAddressDTO.serializer(), bodyText)
        }
        throw bodyText.toClientException()
    }

    private fun String.toClientException(): ClientExceptionResponse =
        runCatching { Json.decodeFromString(ClientExceptionResponse.serializer(), this) }
            .getOrElse { ClientExceptionResponse(message = this) }

    private fun io.ktor.client.request.HttpRequestBuilder.authorize() {
        val token = keyValueStorage.token
            ?: throw ClientExceptionResponse(message = "Token no disponible", statusCode = StatusCodeDTO(401, "Unauthorized"))
        header(HttpHeaders.Authorization, "Bearer $token")
    }
}
