package ui.sc.client

import DIManager
import ar.com.intrale.BuildKonfig
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import asdo.auth.ToDoResetLoginCache
import asdo.business.ToGetBusinessProducts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.ShoppingBag
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import ext.business.ProductStatus
import kotlinx.coroutines.launch
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.IntralePrimaryButton
import ui.sc.client.ClientBottomBar
import ui.sc.client.ClientTab
import ui.sc.client.CLIENT_ORDERS_PATH
import ui.sc.client.CLIENT_PROFILE_PATH
import ui.sc.shared.Screen
import ui.sc.shared.ViewModel
import ui.session.SessionStore
import ui.th.elevations
import ui.th.spacing
import ui.util.formatPrice

const val CLIENT_HOME_PATH = "/client/home"

data class ClientHomeUiState(
    val productsState: ClientProductsState = ClientProductsState.Loading,
    val lastAddedProduct: ClientProduct? = null
)

class ClientHomeScreen : Screen(CLIENT_HOME_PATH) {

    override val messageTitle: MessageKey = MessageKey.dashboard_title

    @Composable
    override fun screen() {
        val sessionState by SessionStore.sessionState.collectAsState()
        val businessName = remember(sessionState.selectedBusinessId) {
            (sessionState.selectedBusinessId ?: BuildKonfig.BUSINESS).replaceFirstChar { current ->
                if (current.isLowerCase()) current.titlecase() else current.toString()
            }
        }
        val listState = rememberLazyListState()
        val coroutineScope = rememberCoroutineScope()
        val logger = remember { LoggerFactory.default.newLogger<ClientHomeScreen>() }
        val viewModel: ClientHomeViewModel = viewModel { ClientHomeViewModel() }
        val uiState = viewModel.state
        val cartItems by ClientCartStore.items.collectAsState()
        val cartCount = cartItems.values.sumOf { it.quantity }

        val headerTitle = Txt(MessageKey.client_home_header_title)
        val headerSubtitle = Txt(
            MessageKey.client_home_header_subtitle,
            mapOf("business" to businessName)
        )
        val cartContentDescription = Txt(MessageKey.client_home_cart_icon_content_description)
        val productsTitle = Txt(MessageKey.client_home_products_title)
        val emptyMessage = Txt(MessageKey.client_home_products_empty)
        val errorMessage = Txt(MessageKey.client_home_products_error)
        val retryLabel = Txt(MessageKey.client_home_retry)
        val viewCatalogLabel = Txt(MessageKey.client_home_view_catalog)
        val deliveryCtaLabel = Txt(MessageKey.client_home_delivery_cta)
        val outOfStockLabel = Txt(MessageKey.client_product_out_of_stock)
        val addedToCartMessage = uiState.lastAddedProduct?.let { product ->
            Txt(MessageKey.client_home_added_to_cart, mapOf("product" to product.name))
        }
        val snackbarHostState = remember { SnackbarHostState() }
        var hasUserInitiatedRetry by rememberSaveable { mutableStateOf(false) }

        LaunchedEffect(Unit) {
            viewModel.loadProducts()
        }

        LaunchedEffect(addedToCartMessage) {
            addedToCartMessage?.let { message ->
                snackbarHostState.showSnackbar(message)
                viewModel.clearLastAddedProduct()
            }
        }

        LaunchedEffect(uiState.productsState) {
            if (uiState.productsState is ClientProductsState.Error && hasUserInitiatedRetry) {
                snackbarHostState.showSnackbar(errorMessage)
            }
        }

        Scaffold(
            snackbarHost = { SnackbarHost(snackbarHostState) },
            bottomBar = {
                ClientBottomBar(
                    activeTab = ClientTab.HOME,
                    onHomeClick = {
                        coroutineScope.launch { listState.animateScrollToItem(0) }
                    },
                    onOrdersClick = {
                        navigate(CLIENT_ORDERS_PATH)
                    },
                    onProfileClick = {
                        this@ClientHomeScreen.navigate(CLIENT_PROFILE_PATH)
                    }
                )
            }
        ) { padding ->
            Box(modifier = Modifier.fillMaxSize().padding(padding)) {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    state = listState,
                    contentPadding = PaddingValues(
                        horizontal = MaterialTheme.spacing.x4,
                        vertical = MaterialTheme.spacing.x2
                    ),
                    verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
                ) {
                    item {
                        ClientHomeHeader(
                            businessName = businessName,
                            headerTitle = headerTitle,
                            headerSubtitle = headerSubtitle,
                            cartCount = cartCount,
                            cartContentDescription = cartContentDescription,
                            onCartClick = { navigate(CLIENT_CART_PATH) }
                        )
                    }
                    item {
                        ClientHomeBanner(
                            businessName = businessName,
                            deliveryCtaLabel = deliveryCtaLabel,
                            onViewCatalog = {
                                navigate(CLIENT_CATALOG_PATH)
                            },
                            onDeliveryClick = { navigate(CLIENT_CART_PATH) },
                            viewCatalogLabel = viewCatalogLabel
                        )
                    }

                    when (val productsState = uiState.productsState) {
                        ClientProductsState.Loading -> {
                            item { ClientHomeLoading() }
                        }

                        ClientProductsState.Empty -> {
                            item {
                                ClientHomeStateCard(
                                    message = emptyMessage,
                                    actionLabel = retryLabel,
                                    onAction = {
                                        hasUserInitiatedRetry = true
                                        coroutineScope.launch { viewModel.loadProducts() }
                                    }
                                )
                            }
                        }

                        is ClientProductsState.Error -> {
                            item {
                                ClientHomeStateCard(
                                    message = productsState.message.ifBlank { errorMessage },
                                    actionLabel = retryLabel,
                                    onAction = {
                                        hasUserInitiatedRetry = true
                                        coroutineScope.launch { viewModel.loadProducts() }
                                    }
                                )
                            }
                        }

                        is ClientProductsState.Loaded -> {
                            item {
                                Text(
                                    text = productsTitle,
                                    style = MaterialTheme.typography.titleMedium,
                                    fontWeight = FontWeight.SemiBold
                                )
                            }
                            items(productsState.products, key = { it.id }) { product ->
                                ClientProductCard(
                                    product = product,
                                    addLabel = Txt(MessageKey.client_home_add_label),
                                    addContentDescription = Txt(MessageKey.client_home_add_content_description),
                                    outOfStockLabel = outOfStockLabel,
                                    onAddClick = { viewModel.addToCart(product) }
                                )
                            }
                        }
                    }

                    item { Spacer(modifier = Modifier.height(MaterialTheme.spacing.x8)) }
                }

            }
        }
    }
}

@Composable
private fun ClientHomeHeader(
    businessName: String,
    headerTitle: String,
    headerSubtitle: String,
    cartCount: Int,
    cartContentDescription: String,
    onCartClick: () -> Unit
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)) {
            Text(
                text = businessName.uppercase(),
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold
            )
            Text(
                text = headerTitle,
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold
            )
            Text(
                text = headerSubtitle,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        Box(
            contentAlignment = Alignment.TopEnd,
            modifier = Modifier.clickable(onClick = onCartClick)
        ) {
            Icon(
                imageVector = Icons.Default.ShoppingCart,
                contentDescription = cartContentDescription,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(28.dp)
            )
            if (cartCount > 0) {
                Box(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(end = 2.dp)
                        .size(18.dp)
                        .clip(CircleShape)
                        .background(MaterialTheme.colorScheme.primary),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = cartCount.toString(),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onPrimary,
                        fontWeight = FontWeight.Bold
                    )
                }
            }
        }
    }
}

@Composable
private fun ClientHomeBanner(
    businessName: String,
    deliveryCtaLabel: String,
    onViewCatalog: () -> Unit,
    onDeliveryClick: () -> Unit,
    viewCatalogLabel: String
) {
    val deliveryTitle = Txt(MessageKey.client_home_delivery_title)
    val deliveryDescription = Txt(
        MessageKey.client_home_delivery_description,
        mapOf("business" to businessName)
    )
    val bannerHelper = Txt(MessageKey.client_home_header_description, mapOf("business" to businessName))

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x4),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
            ) {
                Box(
                    modifier = Modifier
                        .size(56.dp)
                        .clip(CircleShape),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(
                        imageVector = Icons.Default.ShoppingBag,
                        contentDescription = deliveryTitle,
                        tint = MaterialTheme.colorScheme.primary
                    )
                }
                Column(verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)) {
                    Text(
                        text = deliveryTitle,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold
                    )
                    Text(
                        text = deliveryDescription,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            Text(
                text = bannerHelper,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
            ) {
                IntralePrimaryButton(
                    text = deliveryCtaLabel,
                    onClick = onDeliveryClick,
                    modifier = Modifier.weight(1f)
                )
                TextButton(
                    onClick = onViewCatalog,
                    modifier = Modifier.weight(1f)
                ) {
                    Text(text = viewCatalogLabel)
                }
            }
        }
    }
}

@Composable
private fun ClientHomeLoading() {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = MaterialTheme.spacing.x4),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically
    ) {
        CircularProgressIndicator()
    }
}

@Composable
private fun ClientHomeStateCard(
    message: String,
    actionLabel: String,
    onAction: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x4),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
        ) {
            Text(
                text = message,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            IntralePrimaryButton(
                text = actionLabel,
                onClick = onAction,
                leadingIcon = Icons.Default.Image,
                iconContentDescription = actionLabel,
                modifier = Modifier.fillMaxWidth()
            )
        }
    }
}

@Composable
private fun ClientProductCard(
    product: ClientProduct,
    addLabel: String,
    addContentDescription: String,
    outOfStockLabel: String,
    onAddClick: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = MaterialTheme.elevations.level1)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x3),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
        ) {
            ProductThumbnail(product.emoji, contentDescription = product.name)
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
            ) {
                Text(
                    text = product.name,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.SemiBold
                )
                Text(
                    text = product.priceLabel,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            if (product.isAvailable) {
                IntralePrimaryButton(
                    text = addLabel,
                    onClick = onAddClick,
                    leadingIcon = Icons.Default.ShoppingCart,
                    iconContentDescription = addContentDescription,
                    modifier = Modifier.fillMaxWidth(0.42f)
                )
            } else {
                Text(
                    text = outOfStockLabel,
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.error,
                    fontWeight = FontWeight.SemiBold
                )
            }
        }
    }
}

@Composable
private fun ProductThumbnail(emoji: String, contentDescription: String) {
    Box(
        modifier = Modifier
            .size(64.dp)
            .clip(RoundedCornerShape(MaterialTheme.spacing.x2))
            .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.08f)),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = emoji,
            style = MaterialTheme.typography.headlineMedium,
            color = MaterialTheme.colorScheme.primary,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(MaterialTheme.spacing.x1)
        )
    }
}

class ClientHomeViewModel : ViewModel() {

    private val toDoResetLoginCache: ToDoResetLoginCache by DIManager.di.instance()
    private val toGetBusinessProducts: ToGetBusinessProducts by DIManager.di.instance()

    private val logger = LoggerFactory.default.newLogger<ClientHomeViewModel>()

    var state by mutableStateOf(ClientHomeUiState())
        private set

    override fun getState(): Any = state

    override fun initInputState() { /* No-op */ }

    suspend fun loadProducts() {
        logger.info { "Cargando productos para cliente" }
        state = state.copy(productsState = ClientProductsState.Loading)
        state = runCatching { fetchProducts() }
            .fold(
                onSuccess = { products ->
                    val nextState = if (products.isEmpty()) {
                        ClientProductsState.Empty
                    } else {
                        ClientProductsState.Loaded(products)
                    }
                    state.copy(productsState = nextState)
                },
                onFailure = { error ->
                    logger.error(error) { "Error al cargar productos" }
                    state.copy(
                        productsState = ClientProductsState.Error(
                            error.message ?: ""
                        )
                    )
                }
            )
    }

    fun addToCart(product: ClientProduct) {
        ClientCartStore.add(product)
        state = state.copy(lastAddedProduct = product)
    }

    fun clearLastAddedProduct() {
        if (state.lastAddedProduct != null) {
            state = state.copy(lastAddedProduct = null)
        }
    }

    private suspend fun fetchProducts(): List<ClientProduct> {
        val businessId = resolveBusinessId()
        logger.info { "Cargando productos publicados para negocio $businessId" }
        return toGetBusinessProducts.execute(
            businessId = businessId,
            status = ProductStatus.Published.name.uppercase()
        ).getOrThrow()
            .products
            .filter { product -> ProductStatus.fromRaw(product.status) == ProductStatus.Published }
            .map { product ->
                ClientProduct(
                    id = product.id,
                    name = product.name,
                    priceLabel = formatPrice(product.basePrice),
                    emoji = product.emoji ?: "🛍️",
                    unitPrice = product.basePrice,
                    isAvailable = product.isAvailable
                )
            }
    }

    suspend fun logout() {
        logger.info { "Ejecutando logout desde cliente" }
        try {
            toDoResetLoginCache.execute()
            SessionStore.clear()
        } catch (e: Throwable) {
            logger.error(e) { "Error al ejecutar logout" }
            throw e
        }
    }

    private fun resolveBusinessId(): String {
        val sessionBusiness = SessionStore.sessionState.value.selectedBusinessId
        return (sessionBusiness ?: BuildKonfig.BUSINESS).takeIf { it.isNotBlank() }
            ?: throw IllegalStateException("Business no configurado")
    }
}
