package ui.sc.client

import DIManager
import ar.com.intrale.BuildKonfig
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
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
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Security
import androidx.compose.material.icons.filled.ShoppingBag
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.material.icons.filled.VerifiedUser
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Divider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.IntralePrimaryButton
import ui.sc.auth.CHANGE_PASSWORD_PATH
import ui.sc.auth.TWO_FACTOR_SETUP_PATH
import ui.sc.auth.TWO_FACTOR_VERIFY_PATH
import ui.sc.shared.HOME_PATH
import ui.sc.shared.Screen
import ui.sc.shared.ViewModel
import ui.th.elevations
import ui.th.spacing
import ui.session.SessionStore
import asdo.auth.ToDoResetLoginCache

const val CLIENT_HOME_PATH = "/client/home"

data class ClientProduct(
    val id: String,
    val name: String,
    val priceLabel: String,
    val emoji: String,
    val unitPrice: Double
)

sealed interface ClientProductsState {
    data object Loading : ClientProductsState
    data object Empty : ClientProductsState
    data class Error(val message: String) : ClientProductsState
    data class Loaded(val products: List<ClientProduct>) : ClientProductsState
}

data class ClientHomeUiState(
    val productsState: ClientProductsState = ClientProductsState.Loading,
    val lastAddedProduct: ClientProduct? = null
)

class ClientHomeScreen : Screen(CLIENT_HOME_PATH) {

    override val messageTitle: MessageKey = MessageKey.dashboard_title

    @Composable
    override fun screen() {
        val businessName = BuildKonfig.BUSINESS.replaceFirstChar { current ->
            if (current.isLowerCase()) current.titlecase() else current.toString()
        }
        val listState = rememberLazyListState()
        var profileMenuExpanded by remember { mutableStateOf(false) }
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
        val ordersPlaceholder = Txt(MessageKey.client_home_orders_placeholder)
        val addedToCartMessage = uiState.lastAddedProduct?.let { product ->
            Txt(MessageKey.client_home_added_to_cart, mapOf("product" to product.name))
        }
        val snackbarHostState = remember { SnackbarHostState() }

        LaunchedEffect(Unit) {
            viewModel.loadProducts()
        }

        LaunchedEffect(addedToCartMessage) {
            addedToCartMessage?.let { message ->
                snackbarHostState.showSnackbar(message)
                viewModel.clearLastAddedProduct()
            }
        }

        Scaffold(
            snackbarHost = { SnackbarHost(snackbarHostState) },
            bottomBar = {
                ClientHomeBottomBar(
                    onHomeClick = {
                        coroutineScope.launch { listState.animateScrollToItem(0) }
                    },
                    onOrdersClick = {
                        coroutineScope.launch { snackbarHostState.showSnackbar(ordersPlaceholder) }
                    },
                    onProfileClick = {
                        logger.info { "Abriendo menú de perfil" }
                        profileMenuExpanded = true
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
                    item { ClientHomeBanner(businessName) }

                    when (val productsState = uiState.productsState) {
                        ClientProductsState.Loading -> {
                            item { ClientHomeLoading() }
                        }

                        ClientProductsState.Empty -> {
                            item {
                                ClientHomeStateCard(
                                    message = emptyMessage,
                                    actionLabel = retryLabel,
                                    onAction = { coroutineScope.launch { viewModel.loadProducts() } }
                                )
                            }
                        }

                        is ClientProductsState.Error -> {
                            item {
                                ClientHomeStateCard(
                                    message = productsState.message.ifBlank { errorMessage },
                                    actionLabel = retryLabel,
                                    onAction = { coroutineScope.launch { viewModel.loadProducts() } }
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
                                    onAddClick = { viewModel.addToCart(product) }
                                )
                            }
                        }
                    }

                    item { Spacer(modifier = Modifier.height(MaterialTheme.spacing.x8)) }
                }

                ClientProfileMenu(
                    expanded = profileMenuExpanded,
                    onDismissRequest = { profileMenuExpanded = false },
                    onChangePassword = {
                        profileMenuExpanded = false
                        this@ClientHomeScreen.navigate(CHANGE_PASSWORD_PATH)
                    },
                    onSetupTwoFactor = {
                        profileMenuExpanded = false
                        this@ClientHomeScreen.navigate(TWO_FACTOR_SETUP_PATH)
                    },
                    onVerifyTwoFactor = {
                        profileMenuExpanded = false
                        this@ClientHomeScreen.navigate(TWO_FACTOR_VERIFY_PATH)
                    },
                    onLogout = {
                        profileMenuExpanded = false
                        coroutineScope.launch {
                            try {
                                viewModel.logout()
                                this@ClientHomeScreen.navigate(HOME_PATH)
                            } catch (error: Throwable) {
                                logger.error(error) { "Error al cerrar sesión" }
                            }
                        }
                    }
                )
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
private fun ClientHomeBanner(businessName: String) {
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
            IntralePrimaryButton(
                text = addLabel,
                onClick = onAddClick,
                leadingIcon = Icons.Default.ShoppingCart,
                iconContentDescription = addContentDescription,
                modifier = Modifier.fillMaxWidth(0.42f)
            )
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

@Composable
private fun ClientHomeBottomBar(
    onHomeClick: () -> Unit,
    onOrdersClick: () -> Unit,
    onProfileClick: () -> Unit
) {
    val homeLabel = Txt(MessageKey.client_home_tab_home)
    val ordersLabel = Txt(MessageKey.client_home_tab_orders)
    val profileLabel = Txt(MessageKey.client_home_tab_profile)

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primary)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = MaterialTheme.spacing.x2),
            horizontalArrangement = Arrangement.SpaceEvenly,
            verticalAlignment = Alignment.CenterVertically
        ) {
            ClientHomeBottomItem(icon = Icons.Default.Home, label = homeLabel, onClick = onHomeClick)
            ClientHomeBottomItem(icon = Icons.Default.ShoppingBag, label = ordersLabel, onClick = onOrdersClick)
            ClientHomeBottomItem(icon = Icons.Default.Person, label = profileLabel, onClick = onProfileClick)
        }
    }
}

@Composable
private fun ClientHomeBottomItem(
    icon: ImageVector,
    label: String,
    onClick: () -> Unit
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
        modifier = Modifier.clickable(onClick = onClick)
    ) {
        Icon(
            imageVector = icon,
            contentDescription = label,
            tint = Color.White
        )
        Text(
            text = label,
            color = Color.White,
            textAlign = TextAlign.Center,
            style = MaterialTheme.typography.bodyMedium
        )
    }
}

@Composable
private fun ClientProfileMenu(
    expanded: Boolean,
    onDismissRequest: () -> Unit,
    onChangePassword: () -> Unit,
    onSetupTwoFactor: () -> Unit,
    onVerifyTwoFactor: () -> Unit,
    onLogout: () -> Unit
) {
    val changePasswordLabel = Txt(MessageKey.dashboard_menu_change_password)
    val setupTwoFactorLabel = Txt(MessageKey.dashboard_menu_setup_two_factor)
    val verifyTwoFactorLabel = Txt(MessageKey.dashboard_menu_verify_two_factor)
    val logoutLabel = Txt(MessageKey.dashboard_menu_logout)
    val menuTitle = Txt(MessageKey.dashboard_menu_title)

    if (!expanded) return

    Box(modifier = Modifier.fillMaxSize()) {
        Box(
            modifier = Modifier
                .matchParentSize()
                .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f))
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                    onClick = onDismissRequest
                )
        )

        Card(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(horizontal = MaterialTheme.spacing.x4, vertical = MaterialTheme.spacing.x5)
                .fillMaxWidth(),
            shape = RoundedCornerShape(MaterialTheme.spacing.x2),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            elevation = CardDefaults.cardElevation(defaultElevation = MaterialTheme.elevations.level3)
        ) {
            Column(
                modifier = Modifier.padding(
                    horizontal = MaterialTheme.spacing.x3,
                    vertical = MaterialTheme.spacing.x3
                ),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
            ) {
                Text(
                    text = menuTitle,
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    fontWeight = FontWeight.SemiBold
                )

                ClientProfileAction(
                    icon = Icons.Default.Key,
                    label = changePasswordLabel,
                    onClick = onChangePassword
                )
                ClientProfileAction(
                    icon = Icons.Default.Security,
                    label = setupTwoFactorLabel,
                    onClick = onSetupTwoFactor
                )
                ClientProfileAction(
                    icon = Icons.Default.VerifiedUser,
                    label = verifyTwoFactorLabel,
                    onClick = onVerifyTwoFactor
                )

                Divider()

                ClientProfileAction(
                    icon = Icons.Default.Logout,
                    label = logoutLabel,
                    labelColor = MaterialTheme.colorScheme.error,
                    iconTint = MaterialTheme.colorScheme.error,
                    onClick = onLogout
                )
                Spacer(modifier = Modifier.height(MaterialTheme.spacing.x1))
            }
        }
    }
}

@Composable
private fun ClientProfileAction(
    icon: ImageVector,
    label: String,
    labelColor: Color = MaterialTheme.colorScheme.onSurface,
    iconTint: Color = MaterialTheme.colorScheme.primary,
    onClick: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.medium)
            .clickable(onClick = onClick)
            .padding(vertical = MaterialTheme.spacing.x1_5, horizontal = MaterialTheme.spacing.x2),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
    ) {
        Icon(
            imageVector = icon,
            contentDescription = label,
            tint = iconTint
        )
        Text(
            text = label,
            style = MaterialTheme.typography.bodyLarge,
            color = labelColor
        )
    }
}

class ClientHomeViewModel : ViewModel() {

    private val toDoResetLoginCache: ToDoResetLoginCache by DIManager.di.instance()

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
        delay(200)
        return listOf(
            ClientProduct(id = "bananas", name = "Bananas", priceLabel = "$400 / kg", emoji = "🍌", unitPrice = 400.0),
            ClientProduct(id = "red-apples", name = "Manzana roja", priceLabel = "$1200 / kg", emoji = "🍎", unitPrice = 1200.0),
            ClientProduct(id = "avocado", name = "Palta", priceLabel = "$2500 / kg", emoji = "🥑", unitPrice = 2500.0)
        )
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
}
