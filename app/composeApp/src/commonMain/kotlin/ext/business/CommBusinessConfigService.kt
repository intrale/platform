package ext.business

import ar.com.intrale.shared.business.BusinessConfigDTO
import ar.com.intrale.shared.business.UpdateBusinessConfigRequest

interface CommBusinessConfigService {
    suspend fun getConfig(businessId: String): Result<BusinessConfigDTO>
    suspend fun updateConfig(businessId: String, request: UpdateBusinessConfigRequest): Result<BusinessConfigDTO>
}
