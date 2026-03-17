package asdo.business

import ar.com.intrale.shared.business.BusinessConfigDTO
import ar.com.intrale.shared.business.UpdateBusinessConfigRequest
import ext.business.CommBusinessConfigService

class DoUpdateBusinessConfig(
    private val service: CommBusinessConfigService
) : ToDoUpdateBusinessConfig {
    override suspend fun execute(
        businessId: String,
        request: UpdateBusinessConfigRequest
    ): Result<BusinessConfigDTO> =
        service.updateConfig(businessId, request)
}
