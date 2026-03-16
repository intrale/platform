package asdo.business

import ar.com.intrale.shared.business.ProductDTO

interface ToDoListProducts {
    suspend fun execute(businessId: String): Result<List<ProductDTO>>
}
