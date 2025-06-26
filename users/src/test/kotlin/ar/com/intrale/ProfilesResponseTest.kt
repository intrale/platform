package ar.com.intrale

import io.ktor.http.HttpStatusCode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ProfilesResponseTest {
    @Test
    fun `constructor asigna perfiles y status por defecto`() {
        val profiles = arrayOf(Profile("Admin"), Profile("User"))
        val resp = ProfilesResponse(profiles)
        assertTrue(resp.profiles.contentEquals(profiles))
        assertEquals(HttpStatusCode.OK, resp.statusCode)
    }
    @Test
    fun `mantiene el orden de los perfiles`() {
        val profiles = arrayOf(Profile("Uno"), Profile("Dos"), Profile("Tres"))
        val resp = ProfilesResponse(profiles)
        resp.profiles.forEachIndexed { index, profile ->
            assertEquals(profiles[index], profile)
        }
    }
}
