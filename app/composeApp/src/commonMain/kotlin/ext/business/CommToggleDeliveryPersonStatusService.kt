package ext.business

import ar.com.intrale.shared.business.ToggleDeliveryPersonStatusResponseDTO

interface CommToggleDeliveryPersonStatusService {
    suspend fun toggleStatus(businessId: String, email: String, newStatus: String): Result<ToggleDeliveryPersonStatusResponseDTO>
}
