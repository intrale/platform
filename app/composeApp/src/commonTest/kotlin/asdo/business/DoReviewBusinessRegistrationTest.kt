package asdo.business

import ext.business.CommReviewBusinessRegistrationService
import ext.business.ReviewBusinessRegistrationResponse
import ext.dto.StatusCodeDTO
import ext.storage.CommKeyValueStorage
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private class FakeStorage(initialToken: String?) : CommKeyValueStorage {
    override var token: String? = initialToken
}

private class CapturingReviewService : CommReviewBusinessRegistrationService {
    var receivedToken: String? = null
    override suspend fun execute(
        publicId: String,
        decision: String,
        twoFactorCode: String,
        token: String
    ): Result<ReviewBusinessRegistrationResponse> {
        receivedToken = token
        return Result.success(ReviewBusinessRegistrationResponse(StatusCodeDTO(200, "OK")))
    }
}

class DoReviewBusinessRegistrationTest {
    @Test
    fun `retorna error cuando no existe token`() = runTest {
        val service = object : CommReviewBusinessRegistrationService {
            override suspend fun execute(
                publicId: String,
                decision: String,
                twoFactorCode: String,
                token: String
            ): Result<ReviewBusinessRegistrationResponse> {
                error("El servicio no debería ejecutarse sin token")
            }
        }
        val storage = FakeStorage(null)
        val useCase = DoReviewBusinessRegistration(service, storage)

        val result = useCase.execute("pub-1", "approved", "123456")

        assertTrue(result.isFailure)
        assertEquals("Token no encontrado", result.exceptionOrNull()?.message)
    }

    @Test
    fun `envia el token al servicio cuando existe`() = runTest {
        val service = CapturingReviewService()
        val storage = FakeStorage("Bearer token-123")
        val useCase = DoReviewBusinessRegistration(service, storage)

        val result = useCase.execute("pub-2", "rejected", "654321")

        assertTrue(result.isSuccess)
        assertEquals("Bearer token-123", service.receivedToken)
    }
}
