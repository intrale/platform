package ext.client

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
}

// region ClientProfileService

class ClientProfileServiceTest {

    @Test
    fun `fetchProfile exitoso retorna ClientProfileResponse`() = runTest {
        val body = """{"profile":{"fullName":"Test","email":"test@test.com"},"preferences":{"language":"es"}}"""
        val service = ClientProfileService(mockClient(HttpStatusCode.OK, body), FakeStorage())

        val result = service.fetchProfile()

        assertTrue(result.isSuccess)
        assertEquals("Test", result.getOrThrow().profile?.fullName)
    }

    @Test
    fun `fetchProfile con body vacio retorna perfil default`() = runTest {
        val service = ClientProfileService(mockClient(HttpStatusCode.OK, ""), FakeStorage())

        val result = service.fetchProfile()

        assertTrue(result.isSuccess)
    }

    @Test
    fun `fetchProfile sin token retorna error`() = runTest {
        val service = ClientProfileService(mockClient(HttpStatusCode.OK, "{}"), FakeStorage(token = null))

        val result = service.fetchProfile()

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is ClientExceptionResponse)
    }

    @Test
    fun `updateProfile sin token retorna error`() = runTest {
        val service = ClientProfileService(mockClient(HttpStatusCode.OK, "{}"), FakeStorage(token = null))

        val result = service.updateProfile(ClientProfileDTO(fullName = "Updated"), ClientPreferencesDTO())

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is ClientExceptionResponse)
    }
}

// endregion

// region ClientAddressesService

class ClientAddressesServiceTest {

    @Test
    fun `listAddresses exitoso retorna lista`() = runTest {
        val body = """{"addresses":[{"id":"addr-1","label":"Casa","street":"Calle 1","number":"100","city":"CABA"}]}"""
        val service = ClientAddressesService(mockClient(HttpStatusCode.OK, body), FakeStorage())

        val result = service.listAddresses()

        assertTrue(result.isSuccess)
        assertEquals(1, result.getOrThrow().size)
    }

    @Test
    fun `createAddress exitoso retorna DTO`() = runTest {
        val body = """{"id":"new-1","label":"Casa","street":"Calle 1","number":"100","city":"CABA"}"""
        val service = ClientAddressesService(mockClient(HttpStatusCode.OK, body), FakeStorage())

        val result = service.createAddress(ClientAddressDTO(label = "Casa", street = "Calle 1", number = "100", city = "CABA"))

        assertTrue(result.isSuccess)
        assertEquals("new-1", result.getOrThrow().id)
    }

    @Test
    fun `deleteAddress exitoso retorna Unit`() = runTest {
        val service = ClientAddressesService(mockClient(HttpStatusCode.OK, ""), FakeStorage())

        val result = service.deleteAddress("addr-1")

        assertTrue(result.isSuccess)
    }

    @Test
    fun `markDefault exitoso retorna DTO`() = runTest {
        val body = """{"id":"addr-1","isDefault":true}"""
        val service = ClientAddressesService(mockClient(HttpStatusCode.OK, body), FakeStorage())

        val result = service.markDefault("addr-1")

        assertTrue(result.isSuccess)
        assertTrue(result.getOrThrow().isDefault)
    }
}

// endregion
