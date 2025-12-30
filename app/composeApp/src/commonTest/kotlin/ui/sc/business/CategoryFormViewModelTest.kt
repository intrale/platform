package ui.sc.business

import asdo.business.ToDoCreateCategory
import asdo.business.ToDoDeleteCategory
import asdo.business.ToDoUpdateCategory
import ext.business.CategoryDTO
import ext.business.CategoryRequest
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private class FakeCategoryCrud(
    private val createResult: Result<CategoryDTO> = Result.success(CategoryDTO(id = "new-id", name = "Nueva")),
    private val updateResult: Result<CategoryDTO> = Result.success(CategoryDTO(id = "updated-id", name = "Actualizada")),
    private val deleteResult: Result<Unit> = Result.success(Unit)
) : ToDoCreateCategory, ToDoUpdateCategory, ToDoDeleteCategory {
    override suspend fun execute(businessId: String, request: CategoryRequest): Result<CategoryDTO> =
        createResult

    override suspend fun execute(
        businessId: String,
        categoryId: String,
        request: CategoryRequest
    ): Result<CategoryDTO> = updateResult

    override suspend fun execute(
        businessId: String,
        categoryId: String,
        reassignToCategoryId: String?
    ): Result<Unit> = deleteResult
}

class CategoryFormViewModelTest {

    @Test
    fun `nombre requerido`() = runTest {
        val fake = FakeCategoryCrud()
        val viewModel = CategoryFormViewModel(fake, fake, fake)
        val result = viewModel.save("biz-1")
        assertTrue(result.isFailure)
    }

    @Test
    fun `creacion exitosa pasa a modo edicion`() = runTest {
        val fake = FakeCategoryCrud()
        val viewModel = CategoryFormViewModel(fake, fake, fake)
        viewModel.uiState = viewModel.uiState.copy(name = "Bebidas")
        val result = viewModel.save("biz-1")
        assertTrue(result.isSuccess)
        assertEquals(CategoryFormMode.Edit, viewModel.mode)
        assertEquals("new-id", viewModel.uiState.id)
    }

    @Test
    fun `eliminar sin id falla`() = runTest {
        val fake = FakeCategoryCrud()
        val viewModel = CategoryFormViewModel(fake, fake, fake)
        val result = viewModel.delete("biz-1")
        assertTrue(result.isFailure)
        assertFalse(viewModel.loading)
    }
}
