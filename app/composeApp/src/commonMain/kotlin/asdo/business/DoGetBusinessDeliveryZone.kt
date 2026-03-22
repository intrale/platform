package asdo.business

import ar.com.intrale.shared.business.BusinessDeliveryZoneDTO
import ext.business.CommBusinessDeliveryZoneService

class DoGetBusinessDeliveryZone(
    private val service: CommBusinessDeliveryZoneService
) : ToDoGetBusinessDeliveryZone {
    override suspend fun execute(businessId: String): Result<BusinessDeliveryZoneDTO> =
        service.getDeliveryZone(businessId)
}
