package ext.delivery

import ext.dto.StatusCodeDTO
import ext.storage.CommKeyValueStorage
import ext.storage.model.ClientProfileCache
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
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.LocalDate
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private val jsonHeaders = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString())

private fun mockClient(status: HttpStatusCode, body: String): HttpClient {
    val engine = MockEngine { respond(body, status, jsonHeaders) }
    return HttpClient(engine) {
        install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) }
        install(DefaultRequest) { header(HttpHeaders.ContentType, ContentType.Application.Json) }
    }
}

private class FakeStorage(override var token: String? = "Bearer tok") : CommKeyValueStorage {
    override var profileCache: ClientProfileCache? = null
    override var preferredLanguage: String? = null
    override var onboardingCompleted: Boolean = false
}

// region DeliveryProfileService

class DeliveryProfileServiceTest {

    @Test
    fun `fetchProfile exitoso retorna DeliveryProfileResponse`() = runTest {
        val body = """{"profile":{"fullName":"Driver","email":"d@test.com"},"zones":[{"id":"z1","name":"Norte"}]}"""
        val service = DeliveryProfileService(mockClient(HttpStatusCode.OK, body), FakeStorage())

        val result = service.fetchProfile()

        assertTrue(result.isSuccess)
        assertEquals("Driver", result.getOrThrow().profile?.fullName)
    }

    @Test
    fun `fetchProfile con error retorna stub fallback`() = runTest {
        val service = DeliveryProfileService(mockClient(HttpStatusCode.OK, ""), FakeStorage(token = null))

        val result = service.fetchProfile()

        // recoverCatching devuelve stub con datos demo
        assertTrue(result.isSuccess)
        assertEquals("Repartidor Demo", result.getOrThrow().profile?.fullName)
    }

    @Test
    fun `updateProfile exitoso retorna DeliveryProfileResponse`() = runTest {
        val body = """{"profile":{"fullName":"Updated","email":"d@test.com"},"zones":[]}"""
        val service = DeliveryProfileService(mockClient(HttpStatusCode.OK, body), FakeStorage())

        val result = service.updateProfile(DeliveryProfileDTO(fullName = "Updated", email = "d@test.com"))

        assertTrue(result.isSuccess)
        assertEquals("Updated", result.getOrThrow().profile?.fullName)
    }
}

// endregion

// region DeliveryAvailabilityService

class DeliveryAvailabilityServiceTest {

    @Test
    fun `fetchAvailability exitoso retorna DTO`() = runTest {
        val body = """{"timezone":"America/Argentina/Buenos_Aires","slots":[]}"""
        val service = DeliveryAvailabilityService(mockClient(HttpStatusCode.OK, body), FakeStorage())

        val result = service.fetchAvailability()

        assertTrue(result.isSuccess)
        assertEquals("America/Argentina/Buenos_Aires", result.getOrThrow().timezone)
    }

    @Test
    fun `fetchAvailability con error retorna fallback vacio`() = runTest {
        val service = DeliveryAvailabilityService(mockClient(HttpStatusCode.OK, ""), FakeStorage(token = null))

        val result = service.fetchAvailability()

        // recoverCatching devuelve UTC vacío
        assertTrue(result.isSuccess)
        assertEquals("UTC", result.getOrThrow().timezone)
    }

    @Test
    fun `updateAvailability exitoso retorna DTO`() = runTest {
        val body = """{"timezone":"UTC","slots":[]}"""
        val service = DeliveryAvailabilityService(mockClient(HttpStatusCode.OK, body), FakeStorage())

        val result = service.updateAvailability(DeliveryAvailabilityDTO(timezone = "UTC"))

        assertTrue(result.isSuccess)
    }
}

// endregion

// region DeliveryOrdersService

class DeliveryOrdersServiceTest {

    @Test
    fun `fetchSummary exitoso retorna DTO`() = runTest {
        val body = """{"pending":3,"inProgress":1,"delivered":5}"""
        val service = DeliveryOrdersService(mockClient(HttpStatusCode.OK, body), FakeStorage())

        val result = service.fetchSummary(LocalDate(2026, 2, 17))

        assertTrue(result.isSuccess)
        assertEquals(3, result.getOrThrow().pending)
    }

    @Test
    fun `fetchSummary fallido retorna DeliveryExceptionResponse`() = runTest {
        val body = """{"statusCode":{"value":500,"description":"Error"},"message":"Error"}"""
        val service = DeliveryOrdersService(mockClient(HttpStatusCode.InternalServerError, body), FakeStorage())

        val result = service.fetchSummary(LocalDate(2026, 2, 17))

        assertTrue(result.isFailure)
    }

    @Test
    fun `fetchActiveOrders exitoso retorna lista`() = runTest {
        val body = """[{"id":"o1","businessName":"Tienda","neighborhood":"Centro","status":"IN_PROGRESS"}]"""
        val service = DeliveryOrdersService(mockClient(HttpStatusCode.OK, body), FakeStorage())

        val result = service.fetchActiveOrders()

        assertTrue(result.isSuccess)
        assertEquals(1, result.getOrThrow().size)
    }

    @Test
    fun `fetchAvailableOrders exitoso retorna lista`() = runTest {
        val body = """[]"""
        val service = DeliveryOrdersService(mockClient(HttpStatusCode.OK, body), FakeStorage())

        val result = service.fetchAvailableOrders()

        assertTrue(result.isSuccess)
        assertEquals(0, result.getOrThrow().size)
    }

    @Test
    fun `fetchActiveOrders sin token retorna error`() = runTest {
        val service = DeliveryOrdersService(mockClient(HttpStatusCode.OK, "[]"), FakeStorage(token = null))

        val result = service.fetchActiveOrders()

        assertTrue(result.isFailure)
    }
}

// endregion
