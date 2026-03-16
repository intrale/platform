package ext.business

import ar.com.intrale.shared.business.RegisterBusinessResponse

interface CommRegisterBusinessService {
    suspend fun execute(name: String, emailAdmin: String, description: String): Result<RegisterBusinessResponse>
}
