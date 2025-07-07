package ext

interface CommSignUpService {
    suspend fun execute(function:String, email:String)
}
