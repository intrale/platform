package asdo

interface ToDoSignUpDelivery { suspend fun execute(business: String, email:String): Result<DoSignUpResult> }
