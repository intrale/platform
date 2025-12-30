package asdo.business

import ext.business.CategoryDTO
import ext.business.CategoryRequest

interface ToDoListCategories {
    suspend fun execute(businessId: String): Result<List<CategoryDTO>>
}

interface ToDoCreateCategory {
    suspend fun execute(businessId: String, request: CategoryRequest): Result<CategoryDTO>
}

interface ToDoUpdateCategory {
    suspend fun execute(
        businessId: String,
        categoryId: String,
        request: CategoryRequest
    ): Result<CategoryDTO>
}

interface ToDoDeleteCategory {
    suspend fun execute(
        businessId: String,
        categoryId: String,
        reassignToCategoryId: String? = null
    ): Result<Unit>
}
