package asdo.signup

import ext.auth.ExceptionResponse
import ext.dto.StatusCodeDTO
import ext.signup.*
import ext.storage.CommKeyValueStorage
import ext.storage.model.ClientProfileCache
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private class FakeStorage(initialToken: String? = null) : CommKeyValueStorage {
    override var token: String? = initialToken
    override var profileCache: ClientProfileCache? = null
    override var preferredLanguage: String? = null
    override var onboardingCompleted: Boolean = false
}

// region DoSignUp

class DoSignUpTest {

    private fun fakeService(result: Result<SignUpResponse>) = object : CommSignUpService {
        override suspend fun execute(email: String) = result
    }

    @Test
    fun `registro exitoso retorna resultado`() = runTest {
        val response = SignUpResponse(StatusCodeDTO(200, "OK"))
        val sut = DoSignUp(fakeService(Result.success(response)))

        val result = sut.execute("user@test.com")

        assertTrue(result.isSuccess)
        assertEquals(200, result.getOrThrow().statusCode.value)
    }

    @Test
    fun `registro fallido con ExceptionResponse retorna DoSignUpException`() = runTest {
        val exception = ExceptionResponse(StatusCodeDTO(409, "Conflict"), "Email ya registrado")
        val sut = DoSignUp(fakeService(Result.failure(exception)))

        val result = sut.execute("user@test.com")

        assertTrue(result.isFailure)
        val ex = result.exceptionOrNull() as DoSignUpException
        assertEquals(409, ex.statusCode.value)
    }

    @Test
    fun `registro fallido con excepcion generica retorna DoSignUpException con status 500`() = runTest {
        val sut = DoSignUp(fakeService(Result.failure(RuntimeException("Timeout"))))

        val result = sut.execute("user@test.com")

        assertTrue(result.isFailure)
        val ex = result.exceptionOrNull() as DoSignUpException
        assertEquals(500, ex.statusCode.value)
    }
}

// endregion

// region DoSignUpDelivery

class DoSignUpDeliveryTest {

    private fun fakeService(result: Result<SignUpResponse>) = object : CommSignUpDeliveryService {
        override suspend fun execute(business: String, email: String) = result
    }

    @Test
    fun `registro delivery exitoso retorna resultado`() = runTest {
        val response = SignUpResponse(StatusCodeDTO(200, "OK"))
        val sut = DoSignUpDelivery(fakeService(Result.success(response)))

        val result = sut.execute("negocio-1", "driver@test.com")

        assertTrue(result.isSuccess)
        assertEquals(200, result.getOrThrow().statusCode.value)
    }

    @Test
    fun `registro delivery fallido retorna DoSignUpException`() = runTest {
        val exception = ExceptionResponse(StatusCodeDTO(400, "Bad Request"), "Error")
        val sut = DoSignUpDelivery(fakeService(Result.failure(exception)))

        val result = sut.execute("negocio-1", "driver@test.com")

        assertTrue(result.isFailure)
        val ex = result.exceptionOrNull() as DoSignUpException
        assertEquals(400, ex.statusCode.value)
    }
}

// endregion

// region DoSignUpPlatformAdmin

class DoSignUpPlatformAdminTest {

    private fun fakeService(result: Result<SignUpResponse>) = object : CommSignUpPlatformAdminService {
        override suspend fun execute(email: String) = result
    }

    @Test
    fun `registro admin exitoso retorna resultado`() = runTest {
        val response = SignUpResponse(StatusCodeDTO(200, "OK"))
        val sut = DoSignUpPlatformAdmin(fakeService(Result.success(response)))

        val result = sut.execute("admin@test.com")

        assertTrue(result.isSuccess)
        assertEquals(200, result.getOrThrow().statusCode.value)
    }

    @Test
    fun `registro admin fallido retorna DoSignUpException`() = runTest {
        val exception = ExceptionResponse(StatusCodeDTO(403, "Forbidden"), "Sin permisos")
        val sut = DoSignUpPlatformAdmin(fakeService(Result.failure(exception)))

        val result = sut.execute("admin@test.com")

        assertTrue(result.isFailure)
        val ex = result.exceptionOrNull() as DoSignUpException
        assertEquals(403, ex.statusCode.value)
    }
}

// endregion

// region DoRegisterSaler

class DoRegisterSalerTest {

    private fun fakeService(result: Result<RegisterSalerResponse>) = object : CommRegisterSalerService {
        override suspend fun execute(email: String, token: String) = result
    }

    @Test
    fun `retorna error cuando no existe token`() = runTest {
        val storage = FakeStorage(null)
        val sut = DoRegisterSaler(fakeService(Result.success(RegisterSalerResponse(StatusCodeDTO(200, "OK")))), storage)

        val result = sut.execute("saler@test.com")

        assertTrue(result.isFailure)
        assertEquals("Token no encontrado", result.exceptionOrNull()?.message)
    }

    @Test
    fun `registro exitoso retorna resultado`() = runTest {
        val storage = FakeStorage("tok")
        val sut = DoRegisterSaler(fakeService(Result.success(RegisterSalerResponse(StatusCodeDTO(200, "OK")))), storage)

        val result = sut.execute("saler@test.com")

        assertTrue(result.isSuccess)
        assertEquals(200, result.getOrThrow().statusCode.value)
    }

    @Test
    fun `registro fallido retorna DoRegisterSalerException`() = runTest {
        val storage = FakeStorage("tok")
        val exception = ExceptionResponse(StatusCodeDTO(400, "Bad Request"), "Error")
        val sut = DoRegisterSaler(fakeService(Result.failure(exception)), storage)

        val result = sut.execute("saler@test.com")

        assertTrue(result.isFailure)
        val ex = result.exceptionOrNull() as DoRegisterSalerException
        assertEquals(400, ex.statusCode.value)
    }
}

// endregion
