package asdo.business

import ext.business.CommProductService
import ext.business.ProductDTO

class DoListProducts(
    private val service: CommProductService
) : ToDoListProducts {
    override suspend fun execute(businessId: String): Result<List<ProductDTO>> =
        service.listProducts(businessId)
}
