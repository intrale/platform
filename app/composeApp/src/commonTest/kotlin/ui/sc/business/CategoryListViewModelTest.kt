package ui.sc.business

import asdo.business.ToDoDeleteCategory
import asdo.business.ToDoListCategories
import ext.business.CategoryDTO
import kotlinx.coroutines.test.runTest
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private class FakeCategories(
    private val listResult: Result<List<CategoryDTO>>,
    private val deleteResult: Result<Unit> = Result.success(Unit)
) : ToDoListCategories, ToDoDeleteCategory {
    override suspend fun execute(businessId: String): Result<List<CategoryDTO>> = listResult

    override suspend fun execute(
        businessId: String,
        categoryId: String,
        reassignToCategoryId: String?
    ): Result<Unit> = deleteResult
}

private val testLogger = LoggerFactory(listOf(simplePrintFrontend))

class CategoryListViewModelTest {

    @Test
    fun `estado missing sin negocio seleccionado`() = runTest {
        val fake = FakeCategories(Result.success(emptyList()))
        val viewModel = CategoryListViewModel(fake, fake, loggerFactory = testLogger)
        viewModel.loadCategories(null)
        assertEquals(CategoryListStatus.MissingBusiness, viewModel.state.status)
    }

    @Test
    fun `carga categorias exitosamente`() = runTest {
        val fake = FakeCategories(Result.success(listOf(CategoryDTO(id = "1", name = "Bebidas"))))
        val viewModel = CategoryListViewModel(fake, fake, loggerFactory = testLogger)
        viewModel.loadCategories("biz-1")
        assertEquals(CategoryListStatus.Loaded, viewModel.state.status)
        assertEquals(1, viewModel.state.items.size)
    }

    @Test
    fun `fallo al eliminar informa error`() = runTest {
        val listResult = Result.success(listOf(CategoryDTO(id = "1", name = "Bebidas")))
        val deleteResult = Result.failure<Unit>(Exception("blocked"))
        val fake = FakeCategories(listResult, deleteResult)
        val viewModel = CategoryListViewModel(fake, fake, loggerFactory = testLogger)
        viewModel.loadCategories("biz-1")
        val result = viewModel.deleteCategory("1")
        assertTrue(result.isFailure)
        assertTrue(viewModel.state.errorMessage?.isNotBlank() == true)
    }
}
