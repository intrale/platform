package ext

interface CommLoginService {
    suspend fun execute(user:String, password:String): LoginResponse
}