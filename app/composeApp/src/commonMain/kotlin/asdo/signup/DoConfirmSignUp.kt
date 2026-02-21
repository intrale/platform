package asdo.signup

import ext.signup.CommConfirmSignUpService
import ext.auth.ExceptionResponse

class DoConfirmSignUp(private val service: CommConfirmSignUpService) : ToDoConfirmSignUp {
    override suspend fun execute(email: String, code: String): Result<DoConfirmSignUpResult> {
        return try {
            service.execute(email, code)
                .mapCatching { it.toDoConfirmSignUpResult() }
                .recoverCatching { e ->
                    throw (e as? ExceptionResponse)?.toDoConfirmSignUpException()
                        ?: e.toDoConfirmSignUpException()
                }
        } catch (e: Exception) {
            Result.failure(e.toDoConfirmSignUpException())
        }
    }
}
