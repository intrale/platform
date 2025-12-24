package asdo.business

import ext.business.ProductDTO

interface ToDoListProducts {
    suspend fun execute(businessId: String): Result<List<ProductDTO>>
}
