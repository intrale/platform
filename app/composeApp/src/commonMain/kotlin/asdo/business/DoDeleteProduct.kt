package asdo.business

import ext.business.CommProductService

class DoDeleteProduct(
    private val service: CommProductService
) : ToDoDeleteProduct {
    override suspend fun execute(businessId: String, productId: String): Result<Unit> =
        service.deleteProduct(businessId, productId)
}
