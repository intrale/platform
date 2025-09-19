package ar.com.intrale

import asdo.business.DoRegisterBusiness
import asdo.business.DoReviewBusinessRegistration
import asdo.business.ToDoRegisterBusiness
import asdo.business.ToDoReviewBusinessRegistration
import ext.business.CommRegisterBusinessService
import ext.business.CommReviewBusinessRegistrationService
import ext.business.RegisterBusinessResponse
import ext.business.ReviewBusinessRegistrationResponse
import ext.dto.StatusCodeDTO
import kotlin.test.Test
import kotlin.test.assertTrue

class RegisterBusinessIntegrationTest {
    private class FakeRegisterService : CommRegisterBusinessService {
        override suspend fun execute(name: String, emailAdmin: String, description: String): Result<RegisterBusinessResponse> {
            return Result.success(RegisterBusinessResponse(StatusCodeDTO(200, "OK")))
        }
    }

    private class FakeReviewService : CommReviewBusinessRegistrationService {
        override suspend fun execute(
            name: String,
            decision: String,
            twoFactorCode: String,
            token: String
        ): Result<ReviewBusinessRegistrationResponse> {
            return Result.success(ReviewBusinessRegistrationResponse(StatusCodeDTO(200, "OK")))
        }
    }

    /*@Test
    fun registerAndApprove() = runBlocking {
        val register: ToDoRegisterBusiness = DoRegisterBusiness(FakeRegisterService())
        val review: ToDoReviewBusinessRegistration = DoReviewBusinessRegistration(FakeReviewService())
        val regResult = register.execute("Biz", "admin@biz.com", "desc")
        assertTrue(regResult.isSuccess)
        val revResult = review.execute("Biz", "approved", "123456")
        assertTrue(revResult.isSuccess)
    }*/
}
