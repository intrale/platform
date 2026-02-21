package asdo.signup

import ext.auth.ExceptionResponse
import ext.dto.StatusCodeDTO
import ext.signup.CommConfirmSignUpService
import ext.signup.ConfirmSignUpResponse
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class DoConfirmSignUpTest {

    private fun fakeService(result: Result<ConfirmSignUpResponse>) = object : CommConfirmSignUpService {
        override suspend fun execute(email: String, code: String) = result
    }

    @Test
    fun `confirmacion exitosa retorna resultado`() = runTest {
        val sut = DoConfirmSignUp(fakeService(Result.success(ConfirmSignUpResponse(StatusCodeDTO(200, "OK")))))

        val result = sut.execute("test@test.com", "123456")

        assertTrue(result.isSuccess)
        assertEquals(200, result.getOrThrow().statusCode.value)
    }

    @Test
    fun `confirmacion fallida con ExceptionResponse retorna DoConfirmSignUpException`() = runTest {
        val exception = ExceptionResponse(StatusCodeDTO(400, "Bad Request"), "Codigo invalido")
        val sut = DoConfirmSignUp(fakeService(Result.failure(exception)))

        val result = sut.execute("test@test.com", "wrong")

        assertTrue(result.isFailure)
        val ex = result.exceptionOrNull() as DoConfirmSignUpException
        assertEquals(400, ex.statusCode.value)
    }

    @Test
    fun `confirmacion fallida con excepcion generica retorna DoConfirmSignUpException con status 500`() = runTest {
        val sut = DoConfirmSignUp(fakeService(Result.failure(RuntimeException("Network error"))))

        val result = sut.execute("test@test.com", "123456")

        assertTrue(result.isFailure)
        val ex = result.exceptionOrNull() as DoConfirmSignUpException
        assertEquals(500, ex.statusCode.value)
    }
}
