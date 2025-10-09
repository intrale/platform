package ar.com.intrale

import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals

class BrandingPushTest {
    @Test
    fun `returns placeholder push response`() = runBlocking {
        val function = BrandingPush()

        val response = function.execute(
            business = "demo",
            function = "brandingPush",
            headers = mapOf("X-Device-Id" to "device-1"),
            textBody = "{}"
        ) as BrandingPushResponse

        assertEquals(HttpStatusCode.Accepted, response.statusCode)
        assertEquals("demo", response.businessId)
        assertEquals("device-1", response.deviceId)
    }
}
