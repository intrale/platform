package ui.sc.client

import androidx.compose.foundation.background
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Error
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Divider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import asdo.client.ToDoGetClientProfile
import asdo.client.ToDoGetPaymentMethods
import kotlinx.coroutines.launch
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import DIManager
import ui.cp.buttons.IntralePrimaryButton
import ui.sc.shared.Screen
import ui.util.formatPrice
import ui.th.elevations
import ui.th.spacing

const val CLIENT_CHECKOUT_PATH = "/client/checkout"

class ClientCheckoutScreen : Screen(CLIENT_CHECKOUT_PATH) {

    override val messageTitle: MessageKey = MessageKey.client_checkout_title

    @Composable
    override fun screen() {
        val viewModel = remember { ClientCheckoutViewModel() }
        val cartItems by ClientCartStore.items.collectAsState()
        val coroutineScope = rememberCoroutineScope()
        val logger = remember { LoggerFactory.default.newLogger<ClientCheckoutScreen>() }

        val getClientProfile: ToDoGetClientProfile = remember { DIManager.di.direct.instance() }
        val getPaymentMethods: ToDoGetPaymentMethods = remember { DIManager.di.direct.instance() }

        // Strings
        val titleText = Txt(MessageKey.client_checkout_title)
        val subtitleText = Txt(MessageKey.client_checkout_subtitle)
        val sectionItems = Txt(MessageKey.client_checkout_section_items)
        val sectionAddress = Txt(MessageKey.client_checkout_section_address)
        val sectionPayment = Txt(MessageKey.client_checkout_section_payment)
        val sectionSummary = Txt(MessageKey.client_checkout_section_summary)
        val notesLabel = Txt(MessageKey.client_checkout_notes_label)
        val notesPlaceholder = Txt(MessageKey.client_checkout_notes_placeholder)
        val confirmButton = Txt(MessageKey.client_checkout_confirm_button)
        val confirmingText = Txt(MessageKey.client_checkout_confirming)
        val successTitle = Txt(MessageKey.client_checkout_success_title)
        val successSubtitle = Txt(MessageKey.client_checkout_success_subtitle)
        val shortcodeLabel = Txt(MessageKey.client_checkout_success_shortcode_label)
        val viewOrdersLabel = Txt(MessageKey.client_checkout_success_view_orders)
        val backHomeLabel = Txt(MessageKey.client_checkout_success_back_home)
        val errorGeneric = Txt(MessageKey.client_checkout_error_generic)
        val retryLabel = Txt(MessageKey.client_checkout_error_retry)
        val subtotalLabel = Txt(MessageKey.client_cart_subtotal_label)
        val shippingLabel = Txt(MessageKey.client_cart_shipping_label)
        val totalLabel = Txt(MessageKey.client_cart_total_label)

        LaunchedEffect(Unit) {
            val itemsList = cartItems.values.toList()
            if (itemsList.isEmpty()) {
                logger.warning { "Checkout abierto sin items en el carrito" }
                goBack()
                return@LaunchedEffect
            }

            var address: asdo.client.ClientAddress? = null
            var paymentMethod: asdo.client.PaymentMethod? = null

            getClientProfile.execute()
                .onSuccess { data ->
                    val selectedId = ClientCartStore.selectedAddressId.value
                    address = data.addresses.firstOrNull { it.id == selectedId }
                        ?: data.addresses.firstOrNull { it.isDefault }
                        ?: data.addresses.firstOrNull()
                }
                .onFailure { logger.error(it) { "Error cargando perfil para checkout" } }

            getPaymentMethods.execute()
                .onSuccess { methods ->
                    val selectedId = ClientCartStore.selectedPaymentMethodId.value
                    val enabled = methods.filter { it.enabled }
                    paymentMethod = enabled.firstOrNull { it.id == selectedId }
                        ?: enabled.firstOrNull()
                }
                .onFailure { logger.error(it) { "Error cargando medios de pago para checkout" } }

            viewModel.loadFromCart(itemsList, address, paymentMethod)
        }

        Scaffold { padding ->
            when (viewModel.state.status) {
                CheckoutStatus.Success -> {
                    CheckoutSuccessContent(
                        shortCode = viewModel.state.shortCode.orEmpty(),
                        successTitle = successTitle,
                        successSubtitle = successSubtitle,
                        shortcodeLabel = shortcodeLabel,
                        viewOrdersLabel = viewOrdersLabel,
                        backHomeLabel = backHomeLabel,
                        onViewOrders = { navigate(CLIENT_ORDERS_PATH) },
                        onBackHome = { navigateClearingBackStack(CLIENT_HOME_PATH) }
                    )
                }

                else -> {
                    LazyColumn(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(padding),
                        contentPadding = PaddingValues(
                            horizontal = MaterialTheme.spacing.x4,
                            vertical = MaterialTheme.spacing.x2
                        ),
                        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
                    ) {
                        item {
                            Column(verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1_5)) {
                                Text(
                                    text = titleText,
                                    style = MaterialTheme.typography.headlineMedium,
                                    fontWeight = FontWeight.Bold
                                )
                                Text(
                                    text = subtitleText,
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }

                        // Items section
                        item {
                            CheckoutSectionTitle(sectionItems)
                        }
                        items(viewModel.state.items, key = { it.product.id }) { item ->
                            CheckoutItemRow(item)
                        }

                        // Address section
                        item {
                            CheckoutSectionTitle(sectionAddress)
                            viewModel.state.selectedAddress?.let { address ->
                                CheckoutAddressCard(address)
                            }
                        }

                        // Payment section
                        item {
                            CheckoutSectionTitle(sectionPayment)
                            viewModel.state.selectedPaymentMethod?.let { method ->
                                CheckoutPaymentCard(method)
                            }
                        }

                        // Notes
                        item {
                            OutlinedTextField(
                                value = viewModel.state.notes,
                                onValueChange = { viewModel.updateNotes(it) },
                                label = { Text(notesLabel) },
                                placeholder = { Text(notesPlaceholder) },
                                modifier = Modifier.fillMaxWidth(),
                                maxLines = 3,
                                enabled = viewModel.state.status == CheckoutStatus.Review
                            )
                        }

                        // Summary
                        item {
                            CheckoutSummaryCard(
                                sectionSummary = sectionSummary,
                                subtotalLabel = subtotalLabel,
                                shippingLabel = shippingLabel,
                                totalLabel = totalLabel,
                                subtotal = viewModel.state.subtotal,
                                shipping = viewModel.state.shipping,
                                total = viewModel.state.total
                            )
                        }

                        // Error message
                        if (viewModel.state.status == CheckoutStatus.Error) {
                            item {
                                CheckoutErrorCard(
                                    message = viewModel.state.errorMessage ?: errorGeneric,
                                    retryLabel = retryLabel,
                                    onRetry = { viewModel.retryConfirm() }
                                )
                            }
                        }

                        // Confirm button
                        item {
                            if (viewModel.state.status == CheckoutStatus.Loading) {
                                Box(
                                    modifier = Modifier.fillMaxWidth(),
                                    contentAlignment = Alignment.Center
                                ) {
                                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                        CircularProgressIndicator()
                                        Spacer(modifier = Modifier.height(MaterialTheme.spacing.x2))
                                        Text(
                                            text = confirmingText,
                                            style = MaterialTheme.typography.bodyMedium,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant
                                        )
                                    }
                                }
                            } else {
                                IntralePrimaryButton(
                                    text = confirmButton,
                                    onClick = {
                                        coroutineScope.launch { viewModel.confirmOrder() }
                                    },
                                    modifier = Modifier.fillMaxWidth(),
                                    enabled = viewModel.state.canConfirm
                                )
                            }
                            Spacer(modifier = Modifier.height(MaterialTheme.spacing.x2))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CheckoutSectionTitle(title: String) {
    Text(
        text = title,
        style = MaterialTheme.typography.titleMedium,
        fontWeight = FontWeight.Bold
    )
}

@Composable
private fun CheckoutItemRow(item: ClientCartItem) {
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
            Box(
                modifier = Modifier
                    .size(48.dp)
                    .clip(RoundedCornerShape(MaterialTheme.spacing.x2))
                    .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.08f)),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = item.product.emoji,
                    style = MaterialTheme.typography.titleLarge,
                    textAlign = TextAlign.Center
                )
            }
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = item.product.name,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.SemiBold
                )
                Text(
                    text = "${item.quantity} x ${formatPrice(item.product.unitPrice)}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Text(
                text = formatPrice(item.product.unitPrice * item.quantity),
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.SemiBold
            )
        }
    }
}

@Composable
private fun CheckoutAddressCard(address: asdo.client.ClientAddress) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x3),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
        ) {
            Text(
                text = address.label,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.SemiBold
            )
            val addressLine = listOf(address.street, address.number)
                .filter { it.isNotBlank() }
                .joinToString(" ")
            if (addressLine.isNotBlank()) {
                Text(
                    text = addressLine,
                    style = MaterialTheme.typography.bodyMedium
                )
            }
            val location = listOfNotNull(address.city, address.state, address.postalCode)
                .filter { it.isNotBlank() }
                .joinToString(" - ")
            if (location.isNotBlank()) {
                Text(
                    text = location,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

@Composable
private fun CheckoutPaymentCard(method: asdo.client.PaymentMethod) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x3),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
        ) {
            Text(
                text = method.name,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.SemiBold
            )
            method.description?.let {
                Text(
                    text = it,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

@Composable
private fun CheckoutSummaryCard(
    sectionSummary: String,
    subtotalLabel: String,
    shippingLabel: String,
    totalLabel: String,
    subtotal: Double,
    shipping: Double,
    total: Double
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = MaterialTheme.elevations.level1)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x3),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
        ) {
            Text(
                text = sectionSummary,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold
            )
            CheckoutSummaryRow(label = subtotalLabel, value = formatPrice(subtotal))
            CheckoutSummaryRow(label = shippingLabel, value = formatPrice(shipping))
            Divider()
            CheckoutSummaryRow(label = totalLabel, value = formatPrice(total), emphasize = true)
        }
    }
}

@Composable
private fun CheckoutSummaryRow(label: String, value: String, emphasize: Boolean = false) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = label,
            style = if (emphasize) MaterialTheme.typography.titleMedium else MaterialTheme.typography.bodyMedium,
            fontWeight = if (emphasize) FontWeight.Bold else FontWeight.Normal
        )
        Text(
            text = value,
            style = if (emphasize) MaterialTheme.typography.titleMedium else MaterialTheme.typography.bodyMedium,
            fontWeight = if (emphasize) FontWeight.Bold else FontWeight.Normal
        )
    }
}

@Composable
private fun CheckoutErrorCard(
    message: String,
    retryLabel: String,
    onRetry: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x3),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
        ) {
            Icon(
                imageVector = Icons.Default.Error,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.error
            )
            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(1f),
                color = MaterialTheme.colorScheme.onErrorContainer
            )
            TextButton(onClick = onRetry) {
                Text(retryLabel)
            }
        }
    }
}

@Composable
private fun CheckoutSuccessContent(
    shortCode: String,
    successTitle: String,
    successSubtitle: String,
    shortcodeLabel: String,
    viewOrdersLabel: String,
    backHomeLabel: String,
    onViewOrders: () -> Unit,
    onBackHome: () -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 24.dp, vertical = 48.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Box(
            modifier = Modifier
                .size(96.dp)
                .clip(CircleShape)
                .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.1f)),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                imageVector = Icons.Default.CheckCircle,
                contentDescription = successTitle,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(56.dp)
            )
        }
        Spacer(modifier = Modifier.height(24.dp))
        Text(
            text = successTitle,
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center
        )
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            text = successSubtitle,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center
        )
        Spacer(modifier = Modifier.height(32.dp))
        Text(
            text = shortcodeLabel,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center
        )
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            text = shortCode,
            style = MaterialTheme.typography.headlineLarge,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.primary,
            textAlign = TextAlign.Center
        )
        Spacer(modifier = Modifier.height(48.dp))
        IntralePrimaryButton(
            text = viewOrdersLabel,
            onClick = onViewOrders,
            modifier = Modifier.fillMaxWidth()
        )
        Spacer(modifier = Modifier.height(12.dp))
        TextButton(onClick = onBackHome) {
            Text(
                text = backHomeLabel,
                fontWeight = FontWeight.SemiBold
            )
        }
    }
}
