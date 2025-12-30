package ui.sc.business

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.business.ToDoDeleteCategory
import asdo.business.ToDoListCategories
import ext.business.CategoryDTO
import io.konform.validation.Validation
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

enum class CategoryListStatus { Idle, Loading, Loaded, Empty, Error, MissingBusiness }

data class CategoryListItem(
    val id: String,
    val name: String,
    val description: String,
    val productCount: Int?
)

data class CategoryListUiState(
    val status: CategoryListStatus = CategoryListStatus.Idle,
    val items: List<CategoryListItem> = emptyList(),
    val errorMessage: String? = null,
    val deletingCategoryId: String? = null
)

class CategoryListViewModel(
    private val listCategories: ToDoListCategories = DIManager.di.direct.instance(),
    private val deleteCategory: ToDoDeleteCategory = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {

    private val logger = loggerFactory.newLogger<CategoryListViewModel>()
    private var currentBusinessId: String? = null

    var state by mutableStateOf(CategoryListUiState())
        private set

    override fun getState(): Any = state

    init {
        validation = Validation<CategoryListUiState> { } as Validation<Any>
        initInputState()
    }

    override fun initInputState() {
        inputsStates = mutableMapOf()
    }

    suspend fun loadCategories(businessId: String?) {
        if (businessId.isNullOrBlank()) {
            logger.warning { "No hay negocio seleccionado para cargar categorías" }
            state = state.copy(
                status = CategoryListStatus.MissingBusiness,
                items = emptyList(),
                errorMessage = null
            )
            return
        }
        currentBusinessId = businessId
        state = state.copy(
            status = CategoryListStatus.Loading,
            errorMessage = null
        )
        listCategories.execute(businessId)
            .onSuccess { categories ->
                val mapped = categories.mapNotNull { it.toItem() }
                state = state.copy(
                    status = if (mapped.isEmpty()) CategoryListStatus.Empty else CategoryListStatus.Loaded,
                    items = mapped,
                    errorMessage = null
                )
            }
            .onFailure { error ->
                logger.error(error) { "Error al cargar categorías" }
                state = state.copy(
                    status = CategoryListStatus.Error,
                    errorMessage = error.message ?: ""
                )
            }
    }

    suspend fun refresh() {
        loadCategories(currentBusinessId)
    }

    suspend fun deleteCategory(categoryId: String): Result<Unit> {
        val businessId = currentBusinessId
            ?: return Result.failure(IllegalStateException("No hay negocio seleccionado"))
        state = state.copy(deletingCategoryId = categoryId)
        val result = deleteCategory.execute(businessId, categoryId)
        state = state.copy(deletingCategoryId = null)
        result.onSuccess {
            state = state.copy(items = state.items.filterNot { it.id == categoryId })
            if (state.items.isEmpty()) {
                state = state.copy(status = CategoryListStatus.Empty)
            }
        }.onFailure { error ->
            logger.error(error) { "No se pudo eliminar la categoría $categoryId" }
            state = state.copy(errorMessage = error.message)
        }
        return result
    }

    fun clearError() {
        if (state.errorMessage != null) {
            state = state.copy(errorMessage = null)
        }
    }

    fun toDraft(item: CategoryListItem): CategoryDraft =
        CategoryDraft(
            id = item.id,
            name = item.name,
            description = item.description,
            productCount = item.productCount
        )

    private fun CategoryDTO.toItem(): CategoryListItem? {
        val id = id ?: return null
        return CategoryListItem(
            id = id,
            name = name,
            description = description.orEmpty(),
            productCount = productCount
        )
    }
}
