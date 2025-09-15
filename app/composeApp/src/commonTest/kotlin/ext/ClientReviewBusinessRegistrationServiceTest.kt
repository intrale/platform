package ext

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.DefaultRequest
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.header
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.http.content.TextContent
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ClientReviewBusinessRegistrationServiceTest {
    @Test
    fun `adjunta el token en Authorization y conserva el cuerpo`() = runTest {
        var capturedAuthorization: String? = null
        var capturedBody: String? = null

        val engine = MockEngine { request ->
            capturedAuthorization = request.headers[HttpHeaders.Authorization]
            capturedBody = (request.body as TextContent).text
            respond(
                content = """{"statusCode":{"value":200,"description":"OK"}}""",
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            )
        }

        val client = HttpClient(engine) {
            install(ContentNegotiation) {
                json(Json { ignoreUnknownKeys = true })
            }
            install(DefaultRequest) {
                header(HttpHeaders.ContentType, ContentType.Application.Json)
            }
        }

        val service = ClientReviewBusinessRegistrationService(client)
        val result = service.execute("pub-123", "approved", "654321", "Bearer token-xyz")

        assertTrue(result.isSuccess)
        assertEquals("Bearer token-xyz", capturedAuthorization)

        val json = Json { ignoreUnknownKeys = true }
        val body = requireNotNull(capturedBody) { "El cuerpo de la petición no fue capturado" }
        val requestPayload = json.decodeFromString(ReviewBusinessRegistrationRequest.serializer(), body)
        assertEquals(
            ReviewBusinessRegistrationRequest("pub-123", "approved", "654321"),
            requestPayload
        )
    }
}
