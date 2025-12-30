package ui.sc.business

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import ar.com.intrale.strings.model.MessageKey
import ar.com.intrale.strings.resolveMessage
import asdo.business.ToDoCreateCategory
import asdo.business.ToDoDeleteCategory
import asdo.business.ToDoUpdateCategory
import ext.business.CategoryDTO
import ext.business.CategoryRequest
import io.konform.validation.Validation
import io.konform.validation.jsonschema.minLength
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

enum class CategoryFormMode { Create, Edit }

data class CategoryFormUiState(
    val id: String? = null,
    val name: String = "",
    val description: String = ""
)

class CategoryFormViewModel(
    private val createCategory: ToDoCreateCategory = DIManager.di.direct.instance(),
    private val updateCategory: ToDoUpdateCategory = DIManager.di.direct.instance(),
    private val deleteCategory: ToDoDeleteCategory = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {

    private val logger = loggerFactory.newLogger<CategoryFormViewModel>()

    var uiState by mutableStateOf(CategoryFormUiState())
    var loading by mutableStateOf(false)
    var mode by mutableStateOf(CategoryFormMode.Create)
        private set
    var errorMessage by mutableStateOf<String?>(null)
        private set

    override fun getState(): Any = uiState

    init {
        validation = Validation<CategoryFormUiState> {
            CategoryFormUiState::name required {
                minLength(1) hint resolveMessage(MessageKey.form_error_required)
            }
        } as Validation<Any>
        initInputState()
    }

    override fun initInputState() {
        inputsStates = mutableMapOf(
            entry(CategoryFormUiState::name.name),
            entry(CategoryFormUiState::description.name)
        )
    }

    fun applyDraft(draft: CategoryDraft?) {
        uiState = if (draft == null) {
            CategoryFormUiState()
        } else {
            CategoryFormUiState(
                id = draft.id,
                name = draft.name,
                description = draft.description
            )
        }
        mode = if (uiState.id == null) CategoryFormMode.Create else CategoryFormMode.Edit
        errorMessage = null
    }

    suspend fun save(businessId: String): Result<CategoryDTO> {
        if (!isValid()) {
            errorMessage = resolveMessage(MessageKey.form_error_required)
            return Result.failure(IllegalStateException(errorMessage))
        }
        val request = CategoryRequest(
            name = uiState.name.trim(),
            description = uiState.description.ifBlank { null }
        )
        return if (uiState.id == null) {
            createCategory.execute(businessId, request)
        } else {
            updateCategory.execute(businessId, uiState.id!!, request)
        }.onSuccess { category ->
            uiState = uiState.copy(
                id = category.id,
                name = category.name,
                description = category.description.orEmpty()
            )
            mode = CategoryFormMode.Edit
        }.onFailure { error ->
            logger.error(error) { "No se pudo guardar la categoría" }
            errorMessage = error.message
        }
    }

    suspend fun delete(businessId: String): Result<Unit> {
        val categoryId = uiState.id
            ?: return Result.failure(IllegalStateException("Categoría sin id"))
        return deleteCategory.execute(businessId, categoryId)
            .onFailure { error -> errorMessage = error.message }
    }
}
