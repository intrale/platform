package ar.com.intrale

import asdo.DoRegisterBusiness
import asdo.DoReviewBusinessRegistration
import asdo.ToDoRegisterBusiness
import asdo.ToDoReviewBusinessRegistration
import ext.*
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertTrue

class RegisterBusinessIntegrationTest {
    private class FakeRegisterService : CommRegisterBusinessService {
        override suspend fun execute(name: String, emailAdmin: String, description: String): Result<RegisterBusinessResponse> {
            return Result.success(RegisterBusinessResponse(StatusCodeDTO(200, "OK")))
        }
    }

    private class FakeReviewService : CommReviewBusinessRegistrationService {
        override suspend fun execute(name: String, decision: String, twoFactorCode: String): Result<ReviewBusinessRegistrationResponse> {
            return Result.success(ReviewBusinessRegistrationResponse(StatusCodeDTO(200, "OK")))
        }
    }

    @Test
    fun registerAndApprove() = runBlocking {
        val register: ToDoRegisterBusiness = DoRegisterBusiness(FakeRegisterService())
        val review: ToDoReviewBusinessRegistration = DoReviewBusinessRegistration(FakeReviewService())
        val regResult = register.execute("Biz", "admin@biz.com", "desc")
        assertTrue(regResult.isSuccess)
        val revResult = review.execute("Biz", "approved", "123456")
        assertTrue(revResult.isSuccess)
    }
}
