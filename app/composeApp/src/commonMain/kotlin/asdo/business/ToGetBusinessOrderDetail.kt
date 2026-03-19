package asdo.business

interface ToGetBusinessOrderDetail {
    suspend fun execute(businessId: String, orderId: String): Result<BusinessOrderDetail>
}
