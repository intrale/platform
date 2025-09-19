package ext.business

interface CommRegisterBusinessService {
    suspend fun execute(name: String, emailAdmin: String, description: String): Result<RegisterBusinessResponse>
}
