package asdo.business

import ar.com.intrale.shared.business.BusinessConfigDTO
import ar.com.intrale.shared.business.UpdateBusinessConfigRequest

interface ToDoUpdateBusinessConfig {
    suspend fun execute(businessId: String, request: UpdateBusinessConfigRequest): Result<BusinessConfigDTO>
}
