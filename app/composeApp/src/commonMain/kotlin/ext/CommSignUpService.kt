package ext

import ext.SignUpResponse

interface CommSignUpService {
    suspend fun execute(email:String): Result<SignUpResponse>
}
