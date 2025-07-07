package asdo

import ext.CommSignUpService

class DoSignUp(private val service: CommSignUpService) : ToDoSignUp {
    override suspend fun execute(email: String) {
        service.execute("signup", email)
    }
}
