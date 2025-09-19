package asdo.signup

interface ToDoSignUp { suspend fun execute(email:String): Result<DoSignUpResult> }
