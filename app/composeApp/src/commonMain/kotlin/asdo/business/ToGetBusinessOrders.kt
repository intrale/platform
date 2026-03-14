package asdo.business

interface ToGetBusinessOrders {
    suspend fun execute(businessId: String): Result<List<BusinessOrder>>
}
