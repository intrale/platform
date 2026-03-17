package asdo.business

import ar.com.intrale.shared.business.BusinessConfigDTO
import ext.business.CommBusinessConfigService

class DoGetBusinessConfig(
    private val service: CommBusinessConfigService
) : ToDoGetBusinessConfig {
    override suspend fun execute(businessId: String): Result<BusinessConfigDTO> =
        service.getConfig(businessId)
}
