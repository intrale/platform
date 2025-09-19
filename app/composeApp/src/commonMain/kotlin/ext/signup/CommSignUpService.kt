package ext.signup

interface CommSignUpService {
    suspend fun execute(email:String): Result<SignUpResponse>
}
