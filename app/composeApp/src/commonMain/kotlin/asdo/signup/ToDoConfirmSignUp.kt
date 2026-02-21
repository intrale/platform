package asdo.signup

interface ToDoConfirmSignUp {
    suspend fun execute(email: String, code: String): Result<DoConfirmSignUpResult>
}
