package ui.sc.client

import DIManager
import ar.com.intrale.BuildKonfig
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import asdo.business.ToGetProduct
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import ext.business.ProductDTO
import kotlinx.coroutines.launch
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.IntralePrimaryButton
import ui.sc.shared.Screen
import ui.sc.shared.ViewModel
import ui.session.SessionStore
import ui.th.spacing
import ui.util.formatPrice

const val CLIENT_PRODUCT_DETAIL_PATH = "/client/product/detail"

// ---------------------------------------------------------------------------
// UI Models
// ---------------------------------------------------------------------------

data class ClientProductDetail(
    val id: String,
    val name: String,
    val emoji: String,
    val description: String,
    val priceLabel: String,
    val unit: String,
    val unitPrice: Double,
    val categoryId: String? = null
)

sealed interface ProductDetailState {
    data object Loading : ProductDetailState
    data class Loaded(val detail: ClientProductDetail) : ProductDetailState
    data class Error(val message: String) : ProductDetailState
}

data class ClientProductDetailUiState(
    val productState: ProductDetailState = ProductDetailState.Loading,
    val quantity: Int = 1,
    val isInCart: Boolean = false,
    val cartQuantity: Int = 0,
    val snackbarMessage: String? = null
)

// ---------------------------------------------------------------------------
// ViewModel
// ---------------------------------------------------------------------------

class ClientProductDetailViewModel(
    private val toGetProduct: ToGetProduct = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {

    private val logger = loggerFactory.newLogger<ClientProductDetailViewModel>()

    var state by mutableStateOf(ClientProductDetailUiState())
        private set

    override fun getState(): Any = state

    override fun initInputState() { /* No-op */ }

    suspend fun loadProduct() {
        val productId = ClientProductSelectionStore.selectedProductId.value
        if (productId == null) {
            logger.warning { "No hay producto seleccionado" }
            state = state.copy(
                productState = ProductDetailState.Error("No se selecciono un producto")
            )
            return
        }

        logger.info { "Cargando detalle del producto $productId" }
        state = state.copy(productState = ProductDetailState.Loading)

        val businessId = resolveBusinessId()
        state = toGetProduct.execute(businessId, productId).fold(
            onSuccess = { dto ->
                val detail = dto.toClientProductDetail()
                val cartItem = ClientCartStore.items.value[dto.id]
                state.copy(
                    productState = ProductDetailState.Loaded(detail),
                    quantity = cartItem?.quantity ?: 1,
                    isInCart = cartItem != null,
                    cartQuantity = cartItem?.quantity ?: 0
                )
            },
            onFailure = { error ->
                logger.error(error) { "Error al cargar producto $productId" }
                state.copy(
                    productState = ProductDetailState.Error(error.message ?: "")
                )
            }
        )
    }

    fun incrementQuantity() {
        state = state.copy(quantity = state.quantity + 1)
    }

    fun decrementQuantity() {
        if (state.quantity > 1) {
            state = state.copy(quantity = state.quantity - 1)
        }
    }

    fun addOrUpdateCart() {
        val loaded = state.productState as? ProductDetailState.Loaded ?: return
        val detail = loaded.detail
        val clientProduct = ClientProduct(
            id = detail.id,
            name = detail.name,
            priceLabel = detail.priceLabel,
            emoji = detail.emoji,
            unitPrice = detail.unitPrice,
            categoryId = detail.categoryId
        )
        val wasInCart = state.isInCart
        ClientCartStore.setQuantity(clientProduct, state.quantity)
        state = state.copy(
            isInCart = true,
            cartQuantity = state.quantity,
            snackbarMessage = if (wasInCart) "updated" else "added"
        )
    }

    fun clearSnackbar() {
        state = state.copy(snackbarMessage = null)
    }

    private fun ProductDTO.toClientProductDetail() = ClientProductDetail(
        id = id ?: "",
        name = name,
        emoji = "\uD83D\uDECD\uFE0F",
        description = shortDescription ?: "",
        priceLabel = formatPrice(basePrice, unit),
        unit = unit,
        unitPrice = basePrice,
        categoryId = categoryId
    )

    private fun resolveBusinessId(): String {
        val sessionBusiness = SessionStore.sessionState.value.selectedBusinessId
        return (sessionBusiness ?: BuildKonfig.BUSINESS).takeIf { it.isNotBlank() }
            ?: throw IllegalStateException("Business no configurado")
    }
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

class ClientProductDetailScreen : Screen(CLIENT_PRODUCT_DETAIL_PATH) {

    override val messageTitle: MessageKey = MessageKey.client_product_detail_title

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    override fun screen() {
        val viewModel: ClientProductDetailViewModel =
            viewModel { ClientProductDetailViewModel() }
        val uiState = viewModel.state
        val coroutineScope = rememberCoroutineScope()
        val snackbarHostState = remember { SnackbarHostState() }

        val titleText = Txt(MessageKey.client_product_detail_title)
        val descriptionLabel = Txt(MessageKey.client_product_detail_description_label)
        val priceLabel = Txt(MessageKey.client_product_detail_price_label)
        val unitLabel = Txt(MessageKey.client_product_detail_unit_label)
        val stockLabel = Txt(MessageKey.client_product_detail_stock_label)
        val stockUnavailable = Txt(MessageKey.client_product_detail_stock_unavailable)
        val quantityLabel = Txt(MessageKey.client_product_detail_quantity_label)
        val addToCartLabel = Txt(MessageKey.client_product_detail_add_to_cart)
        val updateCartLabel = Txt(MessageKey.client_product_detail_update_cart)
        val alreadyInCartLabel = Txt(MessageKey.client_product_detail_already_in_cart)
        val errorMessage = Txt(MessageKey.client_product_detail_error)
        val retryLabel = Txt(MessageKey.client_product_detail_retry)
        val loadingLabel = Txt(MessageKey.client_product_detail_loading)
        val backLabel = Txt(MessageKey.client_product_detail_back)

        val snackbarText = uiState.snackbarMessage?.let { key ->
            val loaded = uiState.productState as? ProductDetailState.Loaded
            val productName = loaded?.detail?.name ?: ""
            when (key) {
                "added" -> Txt(
                    MessageKey.client_product_detail_added_snackbar,
                    mapOf("product" to productName)
                )
                "updated" -> Txt(
                    MessageKey.client_product_detail_updated_snackbar,
                    mapOf("product" to productName)
                )
                else -> null
            }
        }

        LaunchedEffect(Unit) {
            viewModel.loadProduct()
        }

        LaunchedEffect(snackbarText) {
            snackbarText?.let {
                snackbarHostState.showSnackbar(it)
                viewModel.clearSnackbar()
            }
        }

        Scaffold(
            snackbarHost = { SnackbarHost(snackbarHostState) },
            topBar = {
                TopAppBar(
                    title = { Text(titleText) },
                    navigationIcon = {
                        IconButton(onClick = { goBack() }) {
                            Icon(
                                imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                                contentDescription = backLabel
                            )
                        }
                    }
                )
            },
            bottomBar = {
                ClientBottomBar(
                    activeTab = ClientTab.HOME,
                    onHomeClick = { navigateClearingBackStack(CLIENT_HOME_PATH) },
                    onOrdersClick = { navigate(CLIENT_ORDERS_PATH) },
                    onProfileClick = { navigate(CLIENT_PROFILE_PATH) }
                )
            }
        ) { padding ->
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
            ) {
                when (val productState = uiState.productState) {
                    is ProductDetailState.Loading -> {
                        Column(
                            modifier = Modifier.fillMaxSize(),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.Center
                        ) {
                            CircularProgressIndicator()
                            Spacer(modifier = Modifier.height(MaterialTheme.spacing.x2))
                            Text(
                                text = loadingLabel,
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }

                    is ProductDetailState.Error -> {
                        Column(
                            modifier = Modifier
                                .fillMaxSize()
                                .padding(MaterialTheme.spacing.x4),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.Center
                        ) {
                            Text(
                                text = productState.message.ifBlank { errorMessage },
                                style = MaterialTheme.typography.bodyLarge,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                textAlign = TextAlign.Center
                            )
                            Spacer(modifier = Modifier.height(MaterialTheme.spacing.x3))
                            IntralePrimaryButton(
                                text = retryLabel,
                                onClick = {
                                    coroutineScope.launch { viewModel.loadProduct() }
                                },
                                modifier = Modifier.fillMaxWidth(0.6f)
                            )
                        }
                    }

                    is ProductDetailState.Loaded -> {
                        ProductDetailContent(
                            detail = productState.detail,
                            uiState = uiState,
                            descriptionLabel = descriptionLabel,
                            priceLabel = priceLabel,
                            unitLabel = unitLabel,
                            stockLabel = stockLabel,
                            stockUnavailable = stockUnavailable,
                            quantityLabel = quantityLabel,
                            addToCartLabel = addToCartLabel,
                            updateCartLabel = updateCartLabel,
                            alreadyInCartLabel = alreadyInCartLabel,
                            onIncrement = { viewModel.incrementQuantity() },
                            onDecrement = { viewModel.decrementQuantity() },
                            onAddOrUpdate = { viewModel.addOrUpdateCart() }
                        )
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Loaded Content
// ---------------------------------------------------------------------------

@Composable
private fun ProductDetailContent(
    detail: ClientProductDetail,
    uiState: ClientProductDetailUiState,
    descriptionLabel: String,
    priceLabel: String,
    unitLabel: String,
    stockLabel: String,
    stockUnavailable: String,
    quantityLabel: String,
    addToCartLabel: String,
    updateCartLabel: String,
    alreadyInCartLabel: String,
    onIncrement: () -> Unit,
    onDecrement: () -> Unit,
    onAddOrUpdate: () -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(MaterialTheme.spacing.x4),
        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
    ) {
        // Thumbnail grande
        Box(
            modifier = Modifier
                .size(120.dp)
                .clip(RoundedCornerShape(MaterialTheme.spacing.x3))
                .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.08f))
                .align(Alignment.CenterHorizontally),
            contentAlignment = Alignment.Center
        ) {
            Text(
                text = detail.emoji,
                style = MaterialTheme.typography.displayMedium,
                color = MaterialTheme.colorScheme.primary,
                textAlign = TextAlign.Center
            )
        }

        // Nombre
        Text(
            text = detail.name,
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.Bold
        )

        // Badge "Ya en tu carrito"
        if (uiState.isInCart) {
            AssistChip(
                onClick = {},
                label = { Text(alreadyInCartLabel) },
                leadingIcon = {
                    Icon(
                        imageVector = Icons.Default.ShoppingCart,
                        contentDescription = null,
                        modifier = Modifier.size(AssistChipDefaults.IconSize)
                    )
                }
            )
        }

        // Descripcion
        if (detail.description.isNotBlank()) {
            DetailInfoRow(label = descriptionLabel, value = detail.description)
        }

        // Precio
        DetailInfoRow(label = priceLabel, value = detail.priceLabel)

        // Unidad
        DetailInfoRow(label = unitLabel, value = detail.unit)

        // Stock (siempre fallback)
        DetailInfoRow(label = stockLabel, value = stockUnavailable)

        Spacer(modifier = Modifier.height(MaterialTheme.spacing.x2))

        // Selector de cantidad
        Text(
            text = quantityLabel,
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold
        )
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
        ) {
            IconButton(
                onClick = onDecrement,
                enabled = uiState.quantity > 1
            ) {
                Icon(Icons.Default.Remove, contentDescription = null)
            }
            Text(
                text = uiState.quantity.toString(),
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(horizontal = MaterialTheme.spacing.x2)
            )
            IconButton(onClick = onIncrement) {
                Icon(Icons.Default.Add, contentDescription = null)
            }
        }

        Spacer(modifier = Modifier.height(MaterialTheme.spacing.x2))

        // Boton agregar/actualizar
        IntralePrimaryButton(
            text = if (uiState.isInCart) updateCartLabel else addToCartLabel,
            onClick = onAddOrUpdate,
            leadingIcon = Icons.Default.ShoppingCart,
            iconContentDescription = if (uiState.isInCart) updateCartLabel else addToCartLabel,
            modifier = Modifier.fillMaxWidth()
        )

        Spacer(modifier = Modifier.height(MaterialTheme.spacing.x4))
    }
}

@Composable
private fun DetailInfoRow(label: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x0_5)) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            fontWeight = FontWeight.SemiBold
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodyLarge
        )
    }
}
