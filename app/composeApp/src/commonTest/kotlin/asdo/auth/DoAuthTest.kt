package asdo.auth

import ext.auth.*
import ext.dto.StatusCodeDTO
import ext.storage.CommKeyValueStorage
import ext.storage.model.ClientProfileCache
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private class FakeStorage(initialToken: String? = null) : CommKeyValueStorage {
    override var token: String? = initialToken
    override var profileCache: ClientProfileCache? = null
    override var preferredLanguage: String? = null
    override var onboardingCompleted: Boolean = false
}

// region DoLogin

class DoLoginTest {

    private val okResponse = LoginResponse(
        statusCode = StatusCodeDTO(200, "OK"),
        idToken = "id-tok",
        accessToken = "access-tok",
        refreshToken = "refresh-tok"
    )

    private fun fakeLoginService(
        result: Result<LoginResponse> = Result.success(okResponse)
    ) = object : CommLoginService {
        override suspend fun execute(
            user: String,
            password: String,
            newPassword: String?,
            name: String?,
            familyName: String?
        ) = result
    }

    @Test
    fun `login exitoso almacena token y retorna resultado`() = runTest {
        val storage = FakeStorage()
        val sut = DoLogin(fakeLoginService(), storage)

        val result = sut.execute("user@test.com", "pass123")

        assertTrue(result.isSuccess)
        assertEquals("access-tok", storage.token)
        assertEquals(200, result.getOrThrow().statusCode.value)
    }

    @Test
    fun `login con token existente retorna resultado desde storage`() = runTest {
        val storage = FakeStorage("existing-token")
        val sut = DoLogin(fakeLoginService(), storage)

        val result = sut.execute("user@test.com", "pass123")

        assertTrue(result.isSuccess)
        assertEquals(200, result.getOrThrow().statusCode.value)
        assertEquals("existing-token", result.getOrThrow().accessToken)
    }

    @Test
    fun `login fallido retorna DoLoginException`() = runTest {
        val storage = FakeStorage()
        val exception = ExceptionResponse(StatusCodeDTO(401, "Unauthorized"), "Credenciales invalidas")
        val sut = DoLogin(fakeLoginService(Result.failure(exception)), storage)

        val result = sut.execute("user@test.com", "wrong")

        assertTrue(result.isFailure)
        val ex = result.exceptionOrNull() as DoLoginException
        assertEquals(401, ex.statusCode.value)
    }

    @Test
    fun `login con excepcion generica retorna DoLoginException con status 500`() = runTest {
        val storage = FakeStorage()
        val sut = DoLogin(fakeLoginService(Result.failure(RuntimeException("Timeout"))), storage)

        val result = sut.execute("user@test.com", "pass")

        assertTrue(result.isFailure)
        val ex = result.exceptionOrNull() as DoLoginException
        assertEquals(500, ex.statusCode.value)
    }
}

// endregion

// region DoCheckPreviousLogin

class DoCheckPreviousLoginTest {

    @Test
    fun `retorna true cuando existe token`() = runTest {
        val storage = FakeStorage("some-token")
        val sut = DoCheckPreviousLogin(storage)
        assertTrue(sut.execute())
    }

    @Test
    fun `retorna false cuando no existe token`() = runTest {
        val storage = FakeStorage(null)
        val sut = DoCheckPreviousLogin(storage)
        assertFalse(sut.execute())
    }
}

// endregion

// region DoResetLoginCache

class DoResetLoginCacheTest {

    @Test
    fun `limpia token y profileCache y preferredLanguage`() = runTest {
        val storage = FakeStorage("tok").apply {
            profileCache = ClientProfileCache("", "", "", "", "en")
            preferredLanguage = "en"
        }
        val sut = DoResetLoginCache(storage)

        sut.execute()

        assertNull(storage.token)
        assertNull(storage.profileCache)
        assertNull(storage.preferredLanguage)
    }
}

// endregion

// region DoChangePassword

class DoChangePasswordTest {

    private fun fakeService(result: Result<ChangePasswordResponse>) = object : CommChangePasswordService {
        override suspend fun execute(oldPassword: String, newPassword: String, token: String) = result
    }

    @Test
    fun `retorna error cuando no existe token`() = runTest {
        val storage = FakeStorage(null)
        val sut = DoChangePassword(fakeService(Result.success(ChangePasswordResponse(StatusCodeDTO(200, "OK")))), storage)

        val result = sut.execute("old", "new")

        assertTrue(result.isFailure)
        assertEquals("Token no encontrado", result.exceptionOrNull()?.message)
    }

    @Test
    fun `cambio exitoso retorna resultado`() = runTest {
        val storage = FakeStorage("tok")
        val sut = DoChangePassword(fakeService(Result.success(ChangePasswordResponse(StatusCodeDTO(200, "OK")))), storage)

        val result = sut.execute("old", "new")

        assertTrue(result.isSuccess)
        assertEquals(200, result.getOrThrow().statusCode.value)
    }

    @Test
    fun `error del servicio retorna DoChangePasswordException`() = runTest {
        val storage = FakeStorage("tok")
        val exception = ExceptionResponse(StatusCodeDTO(400, "Bad Request"), "Error")
        val sut = DoChangePassword(fakeService(Result.failure(exception)), storage)

        val result = sut.execute("old", "new")

        assertTrue(result.isFailure)
        val ex = result.exceptionOrNull() as DoChangePasswordException
        assertEquals(400, ex.statusCode.value)
    }
}

// endregion

// region DoPasswordRecovery

class DoPasswordRecoveryTest {

    private fun fakeService(result: Result<PasswordRecoveryResponse>) = object : CommPasswordRecoveryService {
        override suspend fun recovery(email: String) = result
        override suspend fun confirm(email: String, code: String, password: String) = result
    }

    @Test
    fun `recuperacion exitosa retorna resultado`() = runTest {
        val sut = DoPasswordRecovery(fakeService(Result.success(PasswordRecoveryResponse(StatusCodeDTO(200, "OK")))))

        val result = sut.execute("test@test.com")

        assertTrue(result.isSuccess)
        assertEquals(200, result.getOrThrow().statusCode.value)
    }

    @Test
    fun `recuperacion fallida retorna DoPasswordRecoveryException`() = runTest {
        val exception = ExceptionResponse(StatusCodeDTO(404, "Not Found"), "Email no encontrado")
        val sut = DoPasswordRecovery(fakeService(Result.failure(exception)))

        val result = sut.execute("test@test.com")

        assertTrue(result.isFailure)
        val ex = result.exceptionOrNull() as DoPasswordRecoveryException
        assertEquals(404, ex.statusCode.value)
    }
}

// endregion

// region DoConfirmPasswordRecovery

class DoConfirmPasswordRecoveryTest {

    private fun fakeService(result: Result<PasswordRecoveryResponse>) = object : CommPasswordRecoveryService {
        override suspend fun recovery(email: String) = result
        override suspend fun confirm(email: String, code: String, password: String) = result
    }

    @Test
    fun `confirmacion exitosa retorna resultado`() = runTest {
        val sut = DoConfirmPasswordRecovery(fakeService(Result.success(PasswordRecoveryResponse(StatusCodeDTO(200, "OK")))))

        val result = sut.execute("test@test.com", "123456", "newpass")

        assertTrue(result.isSuccess)
        assertEquals(200, result.getOrThrow().statusCode.value)
    }

    @Test
    fun `confirmacion fallida retorna DoConfirmPasswordRecoveryException`() = runTest {
        val exception = ExceptionResponse(StatusCodeDTO(400, "Bad Request"), "Codigo invalido")
        val sut = DoConfirmPasswordRecovery(fakeService(Result.failure(exception)))

        val result = sut.execute("test@test.com", "wrong", "newpass")

        assertTrue(result.isFailure)
        val ex = result.exceptionOrNull() as DoConfirmPasswordRecoveryException
        assertEquals(400, ex.statusCode.value)
    }
}

// endregion

// region DoTwoFactorSetup

class DoTwoFactorSetupTest {

    private fun fakeService(result: Result<TwoFactorSetupResponse>) = object : CommTwoFactorSetupService {
        override suspend fun execute(token: String) = result
    }

    @Test
    fun `retorna error cuando no existe token`() = runTest {
        val storage = FakeStorage(null)
        val sut = DoTwoFactorSetup(fakeService(Result.success(TwoFactorSetupResponse(StatusCodeDTO(200, "OK"), "otpauth://totp/test"))), storage)

        val result = sut.execute()

        assertTrue(result.isFailure)
        assertEquals("Token no encontrado", result.exceptionOrNull()?.message)
    }

    @Test
    fun `setup exitoso retorna resultado con otpAuthUri`() = runTest {
        val storage = FakeStorage("tok")
        val response = TwoFactorSetupResponse(StatusCodeDTO(200, "OK"), "otpauth://totp/test")
        val sut = DoTwoFactorSetup(fakeService(Result.success(response)), storage)

        val result = sut.execute()

        assertTrue(result.isSuccess)
        assertEquals("otpauth://totp/test", result.getOrThrow().otpAuthUri)
    }

    @Test
    fun `setup fallido retorna DoTwoFactorSetupException`() = runTest {
        val storage = FakeStorage("tok")
        val exception = ExceptionResponse(StatusCodeDTO(500, "Error"), "Fallo interno")
        val sut = DoTwoFactorSetup(fakeService(Result.failure(exception)), storage)

        val result = sut.execute()

        assertTrue(result.isFailure)
        val ex = result.exceptionOrNull() as DoTwoFactorSetupException
        assertEquals(500, ex.statusCode.value)
    }
}

// endregion

// region DoTwoFactorVerify

class DoTwoFactorVerifyTest {

    private fun fakeService(result: Result<TwoFactorVerifyResponse>) = object : CommTwoFactorVerifyService {
        override suspend fun execute(code: String, token: String) = result
    }

    @Test
    fun `retorna error cuando no existe token`() = runTest {
        val storage = FakeStorage(null)
        val sut = DoTwoFactorVerify(fakeService(Result.success(TwoFactorVerifyResponse(StatusCodeDTO(200, "OK")))), storage)

        val result = sut.execute("123456")

        assertTrue(result.isFailure)
        assertEquals("Token no encontrado", result.exceptionOrNull()?.message)
    }

    @Test
    fun `verificacion exitosa retorna resultado`() = runTest {
        val storage = FakeStorage("tok")
        val sut = DoTwoFactorVerify(fakeService(Result.success(TwoFactorVerifyResponse(StatusCodeDTO(200, "OK")))), storage)

        val result = sut.execute("123456")

        assertTrue(result.isSuccess)
        assertEquals(200, result.getOrThrow().statusCode.value)
    }

    @Test
    fun `verificacion fallida retorna DoTwoFactorVerifyException`() = runTest {
        val storage = FakeStorage("tok")
        val exception = ExceptionResponse(StatusCodeDTO(400, "Bad Request"), "Codigo incorrecto")
        val sut = DoTwoFactorVerify(fakeService(Result.failure(exception)), storage)

        val result = sut.execute("wrong")

        assertTrue(result.isFailure)
        val ex = result.exceptionOrNull() as DoTwoFactorVerifyException
        assertEquals(400, ex.statusCode.value)
    }
}

// endregion
