package ext

interface CommRegisterSalerService {
    suspend fun execute(email: String, token: String): Result<RegisterSalerResponse>
}
