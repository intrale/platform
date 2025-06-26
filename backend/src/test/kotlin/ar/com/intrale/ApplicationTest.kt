import ar.com.intrale.healthRoute
import io.ktor.server.testing.*
import io.ktor.server.application.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ApplicationTest {

    @Test
    fun healthEndpointReturnsUp() = withTestApplication({
        // Aquí configurás tu aplicación como lo harías normalmente
        healthRoute()
    }) {
        handleRequest(HttpMethod.Get, "/health").apply {
            assertEquals(HttpStatusCode.OK, response.status())
            assertEquals("{\"status\":\"UP\"}", response.content)
        }
    }
}
