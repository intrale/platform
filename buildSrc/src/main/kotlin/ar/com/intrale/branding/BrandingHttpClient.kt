package ar.com.intrale.branding

import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.isSuccess
import java.io.Closeable
import java.time.Duration
import kotlinx.coroutines.runBlocking

class BrandingHttpClient(
    private val client: HttpClient
) : Closeable {

    constructor(timeout: Duration = Duration.ofSeconds(10)) : this(
        HttpClient(CIO) {
            expectSuccess = false
            install(HttpTimeout) {
                val millis = timeout.toMillis()
                requestTimeoutMillis = millis
                connectTimeoutMillis = millis
                socketTimeoutMillis = millis
            }
        }
    )

    fun fetch(
        url: String,
        headers: Map<String, String> = emptyMap()
    ): BrandingHttpResponse = runBlocking {
        val response = client.get(url) {
            headers.forEach { (key, value) ->
                header(key, value)
            }
        }
        response.toBrandingHttpResponse()
    }

    override fun close() {
        client.close()
    }
}

private suspend fun HttpResponse.toBrandingHttpResponse(): BrandingHttpResponse {
    val bodyText = bodyAsText()
    return BrandingHttpResponse(
        code = status.value,
        body = bodyText,
        successful = status.isSuccess()
    )
}

data class BrandingHttpResponse(
    val code: Int,
    val body: String,
    val successful: Boolean
)
