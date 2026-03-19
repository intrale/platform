package asdo.business

interface ToUpdateBusinessOrderStatus {
    suspend fun execute(
        businessId: String,
        orderId: String,
        newStatus: BusinessOrderStatus,
        reason: String? = null
    ): Result<BusinessOrderStatusUpdateResult>
}
