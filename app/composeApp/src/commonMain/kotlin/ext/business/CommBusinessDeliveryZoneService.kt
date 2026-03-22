package ext.business

import ar.com.intrale.shared.business.BusinessDeliveryZoneDTO
import ar.com.intrale.shared.business.UpdateBusinessDeliveryZoneRequest

interface CommBusinessDeliveryZoneService {
    suspend fun getDeliveryZone(businessId: String): Result<BusinessDeliveryZoneDTO>
    suspend fun updateDeliveryZone(businessId: String, request: UpdateBusinessDeliveryZoneRequest): Result<BusinessDeliveryZoneDTO>
}
