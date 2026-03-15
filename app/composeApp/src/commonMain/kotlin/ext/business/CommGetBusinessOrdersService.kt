package ext.business

interface CommGetBusinessOrdersService {
    suspend fun listOrders(businessId: String): Result<List<BusinessOrderDTO>>
}
