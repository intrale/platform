package ar.com.intrale

import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals

class BrandingStatusTest {
    @Test
    fun `returns placeholder status`() = runBlocking {
        val function = BrandingStatus()

        val response = function.execute(
            business = "demo",
            function = "brandingStatus",
            headers = emptyMap(),
            textBody = "{}"
        ) as BrandingStatusResponse

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertEquals("v0", response.version)
    }
}
