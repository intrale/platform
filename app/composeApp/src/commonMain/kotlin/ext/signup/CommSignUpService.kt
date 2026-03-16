package ext.signup

import ar.com.intrale.shared.auth.SignUpResponse

interface CommSignUpService {
    suspend fun execute(email:String): Result<SignUpResponse>
}
