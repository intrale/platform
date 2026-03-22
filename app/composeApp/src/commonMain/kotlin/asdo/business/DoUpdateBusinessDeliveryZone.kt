package asdo.business

import ar.com.intrale.shared.business.BusinessDeliveryZoneDTO
import ar.com.intrale.shared.business.UpdateBusinessDeliveryZoneRequest
import ext.business.CommBusinessDeliveryZoneService

class DoUpdateBusinessDeliveryZone(
    private val service: CommBusinessDeliveryZoneService
) : ToDoUpdateBusinessDeliveryZone {
    override suspend fun execute(
        businessId: String,
        request: UpdateBusinessDeliveryZoneRequest
    ): Result<BusinessDeliveryZoneDTO> =
        service.updateDeliveryZone(businessId, request)
}
