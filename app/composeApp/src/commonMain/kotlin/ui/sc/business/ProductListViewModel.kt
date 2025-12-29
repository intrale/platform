package ui.sc.business

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.business.ToDoListProducts
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
    val status: ProductStatus
) {
    val priceLabel: String = formatPrice(basePrice, unit)
}

data class ProductListUiState(
    val status: ProductListStatus = ProductListStatus.Idle,
    val items: List<ProductListItem> = emptyList(),
    val errorMessage: String? = null
)

class ProductListViewModel(
    private val listProducts: ToDoListProducts = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {

    private val logger = loggerFactory.newLogger<ProductListViewModel>()
    private var currentBusinessId: String? = null

    var state by mutableStateOf(ProductListUiState())
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
        listProducts.execute(businessId)
            .onSuccess { products ->
                val mapped = products.mapNotNull { it.toItem() }
                state = state.copy(
                    status = if (mapped.isEmpty()) ProductListStatus.Empty else ProductListStatus.Loaded,
                    items = mapped,
                    errorMessage = null
                )
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
            status = item.status
        )

    private fun ProductDTO.toItem(): ProductListItem? {
        val id = id ?: return null
        return ProductListItem(
            id = id,
            name = name,
            shortDescription = shortDescription.orEmpty(),
            basePrice = basePrice,
            unit = unit,
            categoryId = categoryId,
            status = status
        )
    }
}
