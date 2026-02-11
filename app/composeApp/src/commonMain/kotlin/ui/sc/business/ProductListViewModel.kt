package ui.sc.business

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.business.ToDoListProducts
import asdo.business.ToDoListCategories
import ext.business.CategoryDTO
import ext.business.ProductDTO
import ext.business.ProductStatus
import io.konform.validation.Validation
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel
import ui.util.formatPrice

enum class ProductListStatus { Idle, Loading, Loaded, Empty, Error, MissingBusiness }

data class ProductListItem(
    val id: String,
    val name: String,
    val shortDescription: String,
    val basePrice: Double,
    val unit: String,
    val categoryId: String,
    val categoryName: String,
    val status: ProductStatus,
    val isAvailable: Boolean,
    val stockQuantity: Int?
) {
    val priceLabel: String = formatPrice(basePrice, unit)
    val categoryLabel: String = categoryName.ifBlank { categoryId }
}

data class ProductListUiState(
    val status: ProductListStatus = ProductListStatus.Idle,
    val items: List<ProductListItem> = emptyList(),
    val errorMessage: String? = null
)

class ProductListViewModel(
    private val listProducts: ToDoListProducts = DIManager.di.direct.instance(),
    private val listCategories: ToDoListCategories = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {

    private val logger = loggerFactory.newLogger<ProductListViewModel>()
    private var currentBusinessId: String? = null
    private var allItems: List<ProductListItem> = emptyList()

    var state by mutableStateOf(ProductListUiState())
        private set
    var categories by mutableStateOf<List<CategoryDTO>>(emptyList())
        private set
    var selectedCategoryId by mutableStateOf<String?>(null)
        private set
    var categoryError by mutableStateOf<String?>(null)
        private set

    override fun getState(): Any = state

    init {
        validation = Validation<ProductListUiState> { } as Validation<Any>
        initInputState()
    }

    override fun initInputState() {
        inputsStates = mutableMapOf()
    }

    suspend fun loadProducts(businessId: String?) {
        if (businessId.isNullOrBlank()) {
            logger.warning { "No hay negocio seleccionado para cargar productos" }
            state = state.copy(
                status = ProductListStatus.MissingBusiness,
                items = emptyList(),
                errorMessage = null
            )
            return
        }
        currentBusinessId = businessId
        state = state.copy(
            status = ProductListStatus.Loading,
            errorMessage = null
        )
        loadCategories(businessId)
        listProducts.execute(businessId)
            .onSuccess { products ->
                val mapped = products.mapNotNull { it.toItem(categories) }
                allItems = mapped
                applyCategoryFilter()
            }
            .onFailure { error ->
                logger.error(error) { "Error al cargar productos" }
                state = state.copy(
                    status = ProductListStatus.Error,
                    errorMessage = error.message ?: ""
                )
            }
    }

    suspend fun refresh() {
        loadProducts(currentBusinessId)
    }

    private suspend fun loadCategories(businessId: String) {
        categoryError = null
        listCategories.execute(businessId)
            .onSuccess { loaded -> categories = loaded.filter { !it.id.isNullOrBlank() } }
            .onFailure { error ->
                categoryError = error.message
                logger.error(error) { "No se pudieron cargar categorías" }
            }
    }

    fun selectCategory(categoryId: String?) {
        selectedCategoryId = categoryId
        applyCategoryFilter()
    }

    fun clearCategoryFilter() {
        selectCategory(null)
    }

    private fun applyCategoryFilter() {
        val filtered = selectedCategoryId?.let { id ->
            allItems.filter { it.categoryId == id }
        } ?: allItems
        val status = when {
            state.status == ProductListStatus.Error -> ProductListStatus.Error
            state.status == ProductListStatus.MissingBusiness -> ProductListStatus.MissingBusiness
            filtered.isEmpty() -> ProductListStatus.Empty
            else -> ProductListStatus.Loaded
        }
        state = state.copy(
            status = status,
            items = filtered,
            errorMessage = if (status == ProductListStatus.Error) state.errorMessage else null
        )
    }

    fun clearError() {
        if (state.errorMessage != null) {
            state = state.copy(errorMessage = null)
        }
    }

    fun toDraft(item: ProductListItem): ProductDraft =
        ProductDraft(
            id = item.id,
            name = item.name,
            shortDescription = item.shortDescription,
            basePrice = item.basePrice,
            unit = item.unit,
            categoryId = item.categoryId,
            status = item.status,
            isAvailable = item.isAvailable,
            stockQuantity = item.stockQuantity
        )

    private fun ProductDTO.toItem(categories: List<CategoryDTO>): ProductListItem? {
        val id = id ?: return null
        val categoryName = categories.firstOrNull { it.id == categoryId }?.name.orEmpty()
        return ProductListItem(
            id = id,
            name = name,
            shortDescription = shortDescription.orEmpty(),
            basePrice = basePrice,
            unit = unit,
            categoryId = categoryId,
            categoryName = categoryName,
            status = status,
            isAvailable = isAvailable,
            stockQuantity = stockQuantity
        )
    }
}
