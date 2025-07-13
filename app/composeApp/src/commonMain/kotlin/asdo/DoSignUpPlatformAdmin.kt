package asdo

import ext.CommSignUpService

class DoSignUpPlatformAdmin(private val service: CommSignUpService) : ToDoSignUpPlatformAdmin {
    override suspend fun execute(email: String) {
        service.execute(/*"signupPlatformAdmin",*/ email)
    }
}
