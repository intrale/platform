package asdo

import ext.CommSignUpService

class DoSignUpSaler(private val service: CommSignUpService) : ToDoSignUpSaler {
    override suspend fun execute(email: String) {
        service.execute("signupSaler", email)
    }
}
