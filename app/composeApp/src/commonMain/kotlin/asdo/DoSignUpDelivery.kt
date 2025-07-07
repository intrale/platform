package asdo

import ext.CommSignUpService

class DoSignUpDelivery(private val service: CommSignUpService) : ToDoSignUpDelivery {
    override suspend fun execute(email: String) {
        service.execute("signupDelivery", email)
    }
}
