package ar.com.intrale

import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class DeliveryProfileFunctionTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("biz")
    private val repository = DeliveryProfileRepository()
    private val validator = LocalJwtValidator()

    @Test
    fun `GET delivery profile retorna perfil vacío cuando no existe`() = runBlocking {
        val function = DeliveryProfileFunction(config, logger, repository, validator)
        val email = "driver@test.com"

        val response = function.securedExecute(
            business = "biz",
            function = "delivery/profile",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "GET",
                "X-Function-Path" to "delivery/profile"
            ),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is DeliveryProfileResponse)
        assertEquals(email, (response as DeliveryProfileResponse).profile?.email)
    }

    @Test
    fun `PUT delivery profile actualiza el perfil del repartidor`() = runBlocking {
        val function = DeliveryProfileFunction(config, logger, repository, validator)
        val email = "driver@test.com"
        val body = """{"profile":{"fullName":"Juan Pérez","phone":"+5491100001111","vehicle":{"type":"Moto","model":"Honda Wave","plate":"ABC123"}}}"""

        val response = function.securedExecute(
            business = "biz",
            function = "delivery/profile",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "PUT",
                "X-Function-Path" to "delivery/profile"
            ),
            textBody = body
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is DeliveryProfileResponse)
        val profile = (response as DeliveryProfileResponse).profile!!
        assertEquals("Juan Pérez", profile.fullName)
        assertEquals(email, profile.email)
        assertEquals("Moto", profile.vehicle.type)
        assertEquals("Honda Wave", profile.vehicle.model)
        assertEquals("ABC123", profile.vehicle.plate)
    }

    @Test
    fun `GET delivery profile retorna datos actualizados después de PUT`() = runBlocking {
        val function = DeliveryProfileFunction(config, logger, repository, validator)
        val email = "driver@test.com"
        val body = """{"profile":{"fullName":"María López","phone":"+5491122223333","vehicle":{"type":"Bici","model":"Trek"}}}"""

        function.securedExecute(
            business = "biz",
            function = "delivery/profile",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "PUT",
                "X-Function-Path" to "delivery/profile"
            ),
            textBody = body
        )

        val response = function.securedExecute(
            business = "biz",
            function = "delivery/profile",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "GET",
                "X-Function-Path" to "delivery/profile"
            ),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        val profile = (response as DeliveryProfileResponse).profile!!
        assertEquals("María López", profile.fullName)
        assertEquals("Bici", profile.vehicle.type)
    }

    @Test
    fun `GET delivery availability retorna configuración vacía por defecto`() = runBlocking {
        val function = DeliveryProfileFunction(config, logger, repository, validator)
        val email = "driver@test.com"

        val response = function.securedExecute(
            business = "biz",
            function = "delivery/profile/availability",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "GET",
                "X-Function-Path" to "delivery/profile/availability"
            ),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is DeliveryAvailabilityResponse)
        assertEquals("UTC", (response as DeliveryAvailabilityResponse).timezone)
        assertTrue(response.slots.isEmpty())
    }

    @Test
    fun `PUT delivery availability persiste la configuración`() = runBlocking {
        val function = DeliveryProfileFunction(config, logger, repository, validator)
        val email = "driver@test.com"
        val body = """{"timezone":"America/Argentina/Buenos_Aires","slots":[{"dayOfWeek":"Monday","mode":"BLOCK","block":"morning"}]}"""

        val response = function.securedExecute(
            business = "biz",
            function = "delivery/profile/availability",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "PUT",
                "X-Function-Path" to "delivery/profile/availability"
            ),
            textBody = body
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is DeliveryAvailabilityResponse)
        val avail = response as DeliveryAvailabilityResponse
        assertEquals("America/Argentina/Buenos_Aires", avail.timezone)
        assertEquals(1, avail.slots.size)
        assertEquals("monday", avail.slots[0].dayOfWeek)
        assertEquals("BLOCK", avail.slots[0].mode)
        assertEquals("MORNING", avail.slots[0].block)
    }

    @Test
    fun `GET availability después de PUT retorna datos guardados`() = runBlocking {
        val function = DeliveryProfileFunction(config, logger, repository, validator)
        val email = "driver@test.com"
        val body = """{"timezone":"UTC","slots":[{"dayOfWeek":"friday","mode":"CUSTOM","start":"08:00","end":"16:00"}]}"""

        function.securedExecute(
            business = "biz",
            function = "delivery/profile/availability",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "PUT",
                "X-Function-Path" to "delivery/profile/availability"
            ),
            textBody = body
        )

        val response = function.securedExecute(
            business = "biz",
            function = "delivery/profile/availability",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "GET",
                "X-Function-Path" to "delivery/profile/availability"
            ),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        val avail = response as DeliveryAvailabilityResponse
        assertEquals(1, avail.slots.size)
        assertEquals("friday", avail.slots[0].dayOfWeek)
        assertEquals("CUSTOM", avail.slots[0].mode)
        assertEquals("08:00", avail.slots[0].start)
        assertEquals("16:00", avail.slots[0].end)
    }

    @Test
    fun `sin token retorna no autorizado`() = runBlocking {
        val function = DeliveryProfileFunction(config, logger, repository, validator)

        val response = function.securedExecute(
            business = "biz",
            function = "delivery/profile",
            headers = mapOf(
                "X-Http-Method" to "GET",
                "X-Function-Path" to "delivery/profile"
            ),
            textBody = ""
        )

        assertEquals(HttpStatusCode.Unauthorized, response.statusCode)
    }

    @Test
    fun `método no soportado retorna error de validación`() = runBlocking {
        val function = DeliveryProfileFunction(config, logger, repository, validator)
        val email = "driver@test.com"

        val response = function.securedExecute(
            business = "biz",
            function = "delivery/profile",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "DELETE",
                "X-Function-Path" to "delivery/profile"
            ),
            textBody = ""
        )

        assertEquals(HttpStatusCode.BadRequest, response.statusCode)
    }

    @Test
    fun `perfiles de distintos negocios no se mezclan`() = runBlocking {
        val configAB = testConfig("biz-a", "biz-b")
        val function = DeliveryProfileFunction(configAB, logger, repository, validator)
        val email = "driver@test.com"

        function.securedExecute(
            business = "biz-a",
            function = "delivery/profile",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "PUT",
                "X-Function-Path" to "delivery/profile"
            ),
            textBody = """{"profile":{"fullName":"Driver A"}}"""
        )

        function.securedExecute(
            business = "biz-b",
            function = "delivery/profile",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "PUT",
                "X-Function-Path" to "delivery/profile"
            ),
            textBody = """{"profile":{"fullName":"Driver B"}}"""
        )

        val responseA = function.securedExecute(
            business = "biz-a",
            function = "delivery/profile",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "GET",
                "X-Function-Path" to "delivery/profile"
            ),
            textBody = ""
        ) as DeliveryProfileResponse

        val responseB = function.securedExecute(
            business = "biz-b",
            function = "delivery/profile",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "GET",
                "X-Function-Path" to "delivery/profile"
            ),
            textBody = ""
        ) as DeliveryProfileResponse

        assertEquals("Driver A", responseA.profile?.fullName)
        assertEquals("Driver B", responseB.profile?.fullName)
    }
}
