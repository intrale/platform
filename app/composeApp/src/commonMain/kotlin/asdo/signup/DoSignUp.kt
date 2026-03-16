package asdo.signup

import ext.signup.CommSignUpService
import ar.com.intrale.shared.ExceptionResponse
import ar.com.intrale.shared.auth.SignUpResponse

class DoSignUp(private val service: CommSignUpService) : ToDoSignUp {
    override suspend fun execute(email: String): Result<DoSignUpResult> {
        return try {
            service.execute(email)
                .mapCatching { it.toDoSignUpResult() }
                .recoverCatching { e ->
                    throw (e as? ExceptionResponse)?.toDoSignUpException()
                        ?: e.toDoSignUpException()
                }
        } catch (e: Exception) {
            Result.failure(e.toDoSignUpException())
        }
    }
}
