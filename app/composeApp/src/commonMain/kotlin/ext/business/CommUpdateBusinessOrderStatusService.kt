package ext.business

import ar.com.intrale.shared.business.BusinessOrderStatusUpdateResponseDTO

interface CommUpdateBusinessOrderStatusService {
    suspend fun updateOrderStatus(
        businessId: String,
        orderId: String,
        newStatus: String,
        reason: String?
    ): Result<BusinessOrderStatusUpdateResponseDTO>
}
