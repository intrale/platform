package asdo

interface ToDoSignUp { suspend fun execute(email:String): Result<DoSignUpResult> }
