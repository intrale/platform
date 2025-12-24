package asdo.business

interface ToDoDeleteProduct {
    suspend fun execute(businessId: String, productId: String): Result<Unit>
}
