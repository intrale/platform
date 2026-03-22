package asdo.business

import ar.com.intrale.shared.business.BusinessDeliveryZoneDTO
import ar.com.intrale.shared.business.UpdateBusinessDeliveryZoneRequest

interface ToDoUpdateBusinessDeliveryZone {
    suspend fun execute(businessId: String, request: UpdateBusinessDeliveryZoneRequest): Result<BusinessDeliveryZoneDTO>
}
