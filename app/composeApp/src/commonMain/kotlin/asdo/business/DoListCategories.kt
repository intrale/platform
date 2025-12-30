package asdo.business

import ext.business.CategoryDTO
import ext.business.CategoryRequest
import ext.business.CommCategoryService

class DoListCategories(
    private val service: CommCategoryService
) : ToDoListCategories {
    override suspend fun execute(businessId: String): Result<List<CategoryDTO>> =
        service.listCategories(businessId)
}

class DoCreateCategory(
    private val service: CommCategoryService
) : ToDoCreateCategory {
    override suspend fun execute(
        businessId: String,
        request: CategoryRequest
    ): Result<CategoryDTO> = service.createCategory(businessId, request)
}

class DoUpdateCategory(
    private val service: CommCategoryService
) : ToDoUpdateCategory {
    override suspend fun execute(
        businessId: String,
        categoryId: String,
        request: CategoryRequest
    ): Result<CategoryDTO> = service.updateCategory(businessId, categoryId, request)
}

class DoDeleteCategory(
    private val service: CommCategoryService
) : ToDoDeleteCategory {
    override suspend fun execute(
        businessId: String,
        categoryId: String,
        reassignToCategoryId: String?
    ): Result<Unit> = service.deleteCategory(businessId, categoryId, reassignToCategoryId)
}
