package ext.client

import ar.com.intrale.BuildKonfig
import ar.com.intrale.shared.StatusCodeDTO
import ext.storage.CommKeyValueStorage
import io.ktor.client.HttpClient
import io.ktor.client.request.delete
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.isSuccess
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class PushTokenService(
    private val httpClient: HttpClient,
    private val keyValueStorage: CommKeyValueStorage
) : CommPushTokenService {

    private val logger = LoggerFactory.default.newLogger<PushTokenService>()

    override suspend fun registerToken(token: String, platform: String, appType: String): Result<Unit> {
        return try {
            logger.info { "Registrando token push: platform=$platform, appType=$appType" }
            val response = httpClient.post("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/client/push/register") {
                authorize()
                setBody(
                    mapOf(
                        "token" to token,
                        "platform" to platform,
                        "appType" to appType
                    )
                )
            }
            if (!response.status.isSuccess()) {
                val body = response.bodyAsText()
                logger.error { "Error registrando token push: $body" }
                throw body.toClientException()
            }
            Result.success(Unit)
        } catch (throwable: Throwable) {
            logger.error(throwable) { "Fallo al registrar token push" }
            Result.failure(throwable.toClientException())
        }
    }

    override suspend fun unregisterToken(token: String): Result<Unit> {
        return try {
            logger.info { "Desregistrando token push" }
            val response = httpClient.delete("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/client/push/unregister") {
                authorize()
                setBody(mapOf("token" to token))
            }
            if (!response.status.isSuccess()) {
                val body = response.bodyAsText()
                logger.error { "Error desregistrando token push: $body" }
                throw body.toClientException()
            }
            Result.success(Unit)
        } catch (throwable: Throwable) {
            logger.error(throwable) { "Fallo al desregistrar token push" }
            Result.failure(throwable.toClientException())
        }
    }

    private fun String.toClientException(): ClientExceptionResponse =
        runCatching { kotlinx.serialization.json.Json.decodeFromString(ClientExceptionResponse.serializer(), this) }
            .getOrElse { ClientExceptionResponse(message = this) }

    private fun io.ktor.client.request.HttpRequestBuilder.authorize() {
        val token = keyValueStorage.token
            ?: throw ClientExceptionResponse(
                message = "Token no disponible",
                statusCode = StatusCodeDTO(401, "Unauthorized")
            )
        header(HttpHeaders.Authorization, "Bearer $token")
    }
}
