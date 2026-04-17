package ext.business

import ar.com.intrale.BuildKonfig
import ar.com.intrale.shared.ExceptionResponse
import ar.com.intrale.shared.StatusCodeDTO
import ar.com.intrale.shared.toExceptionResponse
import ar.com.intrale.shared.business.BusinessConfigDTO
import ar.com.intrale.shared.business.GetBusinessConfigResponse
import ar.com.intrale.shared.business.UpdateBusinessConfigRequest
import ar.com.intrale.shared.business.UpdateBusinessConfigResponse
import ext.storage.CommKeyValueStorage
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.isSuccess
import ext.IntraleClientJson
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class ClientBusinessConfigService(
    private val httpClient: HttpClient,
    private val keyValueStorage: CommKeyValueStorage
) : CommBusinessConfigService {

    private val logger = LoggerFactory.default.newLogger<ClientBusinessConfigService>()

    override suspend fun getConfig(businessId: String): Result<BusinessConfigDTO> {
        return try {
            val response = httpClient.get("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/business/$businessId/config") {
                authorize()
            }
            val bodyText = response.bodyAsText()
            if (response.status.isSuccess()) {
                val result = IntraleClientJson.decodeFromString(GetBusinessConfigResponse.serializer(), bodyText)
                Result.success(result.config)
            } else {
                val exception = IntraleClientJson.decodeFromString(ExceptionResponse.serializer(), bodyText)
                Result.failure(exception)
            }
        } catch (e: Exception) {
            logger.error { "Error al obtener configuracion del negocio: ${e.message}" }
            Result.failure(e.toExceptionResponse())
        }
    }

    override suspend fun updateConfig(
        businessId: String,
        request: UpdateBusinessConfigRequest
    ): Result<BusinessConfigDTO> {
        return try {
            val response = httpClient.put("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/business/$businessId/config") {
                authorize()
                setBody(request)
            }
            val bodyText = response.bodyAsText()
            if (response.status.isSuccess()) {
                val result = IntraleClientJson.decodeFromString(UpdateBusinessConfigResponse.serializer(), bodyText)
                Result.success(result.config)
            } else {
                val exception = IntraleClientJson.decodeFromString(ExceptionResponse.serializer(), bodyText)
                Result.failure(exception)
            }
        } catch (e: Exception) {
            logger.error { "Error al actualizar configuracion del negocio: ${e.message}" }
            Result.failure(e.toExceptionResponse())
        }
    }

    private fun io.ktor.client.request.HttpRequestBuilder.authorize() {
        val token = keyValueStorage.token
            ?: throw ExceptionResponse(
                statusCode = StatusCodeDTO(401, "Unauthorized"),
                message = "Token no disponible"
            )
        header(HttpHeaders.Authorization, "Bearer $token")
    }
}
