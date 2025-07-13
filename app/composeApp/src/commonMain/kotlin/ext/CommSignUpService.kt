package ext

interface CommSignUpService {
    suspend fun execute(email:String)
}
