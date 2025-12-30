package ext.business

interface CommCategoryService {
    suspend fun listCategories(businessId: String): Result<List<CategoryDTO>>
    suspend fun createCategory(
        businessId: String,
        request: CategoryRequest
    ): Result<CategoryDTO>

    suspend fun updateCategory(
        businessId: String,
        categoryId: String,
        request: CategoryRequest
    ): Result<CategoryDTO>

    suspend fun deleteCategory(
        businessId: String,
        categoryId: String,
        reassignToCategoryId: String? = null
    ): Result<Unit>
}
