package ext.business

import ar.com.intrale.BuildKonfig
import io.ktor.client.HttpClient
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.isSuccess
import io.ktor.utils.io.InternalAPI
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ext.auth.ExceptionResponse
import ext.auth.toExceptionResponse
import ext.dto.SearchBusinessesResponse

class ClientSearchBusinessesService(private val httpClient: HttpClient) : CommSearchBusinessesService {

    private val logger = LoggerFactory.default.newLogger<ClientSearchBusinessesService>()

    @OptIn(InternalAPI::class)
    override suspend fun execute(
        query: String,
        status: String?,
        limit: Int?,
        lastKey: String?
    ): Result<SearchBusinessesResponse> {
        return try {
            val response: HttpResponse = httpClient.post("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/searchBusinesses") {
                setBody(SearchBusinessesRequest(query, status, limit, lastKey))
            }
            if (response.status.isSuccess()) {
                val bodyText = response.bodyAsText()
                val result = Json.decodeFromString(SearchBusinessesResponse.serializer(), bodyText)
                logger.debug { "response body: $result" }
                Result.success(result)
            } else {
                val bodyText = response.bodyAsText()
                val exception = Json.decodeFromString(ExceptionResponse.serializer(), bodyText)
                logger.debug { "search business failed with status: $exception" }
                Result.failure(exception)
            }
        } catch (e: Exception) {
            logger.error { "search business error: ${e.message}" }
            Result.failure(e.toExceptionResponse())
        }
    }
}

@Serializable
data class SearchBusinessesRequest(
    val query: String = "",
    val status: String? = null,
    val limit: Int? = null,
    val lastKey: String? = null
)
