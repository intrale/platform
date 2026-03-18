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
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Divider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import asdo.client.ClientAddress
import kotlinx.coroutines.launch
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
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
        val snackbarHostState = remember { SnackbarHostState() }
        val coroutineScope = rememberCoroutineScope()
        val logger = remember { LoggerFactory.default.newLogger<ClientCheckoutScreen>() }

        val title = Txt(MessageKey.client_checkout_title)
        val subtitle = Txt(MessageKey.client_checkout_subtitle)
        val summaryTitle = Txt(MessageKey.client_checkout_summary_title)
        val subtotalLabel = Txt(MessageKey.client_checkout_subtotal_label)
        val shippingLabel = Txt(MessageKey.client_checkout_shipping_label)
        val totalLabel = Txt(MessageKey.client_checkout_total_label)
        val addressTitle = Txt(MessageKey.client_checkout_delivery_address_title)
        val addressEmpty = Txt(MessageKey.client_checkout_delivery_address_empty)
        val addressManage = Txt(MessageKey.client_checkout_delivery_address_manage)
        val addressLoading = Txt(MessageKey.client_checkout_delivery_address_loading)
        val paymentTitle = Txt(MessageKey.client_checkout_payment_title)
        val paymentCash = Txt(MessageKey.client_checkout_payment_cash)
        val paymentTransfer = Txt(MessageKey.client_checkout_payment_transfer)
        val notesLabel = Txt(MessageKey.client_checkout_notes_label)
        val notesPlaceholder = Txt(MessageKey.client_checkout_notes_placeholder)
        val additionalCosts = Txt(MessageKey.client_checkout_additional_costs)
        val confirmButton = Txt(MessageKey.client_checkout_confirm_button)
        val confirmLoading = Txt(MessageKey.client_checkout_confirm_loading)
        val backToCart = Txt(MessageKey.client_checkout_back_to_cart)
        val successTitle = Txt(MessageKey.client_checkout_success_title)
        val successMessage = Txt(MessageKey.client_checkout_success_message)
        val goToOrders = Txt(MessageKey.client_checkout_success_go_to_orders)
        val backHome = Txt(MessageKey.client_checkout_success_back_home)
        val errorGeneric = Txt(MessageKey.client_checkout_error)
        val errorMissingAddress = Txt(MessageKey.client_checkout_error_missing_address)
        val errorEmptyCart = Txt(MessageKey.client_checkout_error_empty_cart)

        LaunchedEffect(Unit) {
            viewModel.loadCartData()
            viewModel.loadAddresses()
        }

        val uiState = viewModel.state

        // Si el pedido fue confirmado exitosamente, mostrar pantalla de éxito
        if (uiState.orderResult != null) {
            CheckoutSuccessContent(
                title = successTitle,
                message = successMessage,
                orderCode = Txt(
                    MessageKey.client_checkout_success_order_id,
                    mapOf("code" to uiState.orderResult.shortCode)
                ),
                goToOrdersLabel = goToOrders,
                backHomeLabel = backHome,
                onGoToOrders = { navigate(CLIENT_ORDERS_PATH) },
                onBackHome = { navigateClearingBackStack(CLIENT_HOME_PATH) }
            )
            return
        }

        // Si el carrito está vacío (y no hay pedido confirmado), mostrar mensaje
        if (uiState.items.isEmpty() && !uiState.submitting) {
            Column(
                modifier = Modifier.fillMaxSize().padding(MaterialTheme.spacing.x4),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center
            ) {
                Text(
                    text = errorEmptyCart,
                    style = MaterialTheme.typography.bodyLarge,
                    textAlign = TextAlign.Center
                )
                Spacer(modifier = Modifier.height(MaterialTheme.spacing.x3))
                IntralePrimaryButton(
                    text = backToCart,
                    onClick = { goBack() },
                    modifier = Modifier.fillMaxWidth()
                )
            }
            return
        }

        Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { padding ->
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
                // Encabezado
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1_5)) {
                        Text(
                            text = title,
                            style = MaterialTheme.typography.headlineMedium,
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            text = subtitle,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }

                // Lista de productos (resumen)
                item {
                    CheckoutItemsSummaryCard(
                        items = uiState.items,
                        summaryTitle = summaryTitle
                    )
                }

                // Dirección de entrega
                item {
                    CheckoutAddressCard(
                        title = addressTitle,
                        loadingMessage = addressLoading,
                        emptyMessage = addressEmpty,
                        manageLabel = addressManage,
                        addresses = uiState.addresses,
                        selectedAddressId = uiState.selectedAddressId,
                        loading = uiState.addressLoading,
                        onSelect = { viewModel.selectAddress(it) },
                        onManage = { navigate(CLIENT_PROFILE_PATH) }
                    )
                }

                // Medio de pago
                item {
                    CheckoutPaymentCard(
                        title = paymentTitle,
                        cashLabel = paymentCash,
                        transferLabel = paymentTransfer,
                        selectedMethod = uiState.selectedPaymentMethod,
                        onSelect = { viewModel.selectPaymentMethod(it) }
                    )
                }

                // Notas del pedido
                item {
                    CheckoutNotesCard(
                        label = notesLabel,
                        placeholder = notesPlaceholder,
                        value = uiState.notes,
                        onValueChange = { viewModel.updateNotes(it) }
                    )
                }

                // Costos adicionales
                item {
                    Text(
                        text = additionalCosts,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.fillMaxWidth(),
                        textAlign = TextAlign.Center
                    )
                }

                // Resumen de costos
                item {
                    CheckoutTotalsCard(
                        subtotalLabel = subtotalLabel,
                        shippingLabel = shippingLabel,
                        totalLabel = totalLabel,
                        subtotal = uiState.subtotal,
                        shipping = uiState.shipping,
                        total = uiState.total
                    )
                }

                // Acciones
                item {
                    Column(
                        modifier = Modifier.fillMaxWidth(),
                        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
                    ) {
                        IntralePrimaryButton(
                            text = if (uiState.submitting) confirmLoading else confirmButton,
                            onClick = {
                                coroutineScope.launch {
                                    val success = viewModel.confirmOrder()
                                    if (!success) {
                                        val errorMsg = when (viewModel.state.error) {
                                            "empty_cart" -> errorEmptyCart
                                            else -> errorGeneric
                                        }
                                        snackbarHostState.showSnackbar(errorMsg)
                                    }
                                }
                            },
                            modifier = Modifier.fillMaxWidth(),
                            enabled = !uiState.submitting,
                            loading = uiState.submitting
                        )
                        TextButton(
                            onClick = { goBack() },
                            modifier = Modifier.align(Alignment.CenterHorizontally)
                        ) {
                            Text(
                                text = backToCart,
                                color = MaterialTheme.colorScheme.primary,
                                fontWeight = FontWeight.SemiBold
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CheckoutItemsSummaryCard(
    items: List<ClientCartItem>,
    summaryTitle: String
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
                text = summaryTitle,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold
            )
            items.forEach { item ->
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Row(
                        modifier = Modifier.weight(1f),
                        horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Box(
                            modifier = Modifier
                                .size(32.dp)
                                .clip(RoundedCornerShape(MaterialTheme.spacing.x1))
                                .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.08f)),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(
                                text = item.product.emoji,
                                style = MaterialTheme.typography.bodyMedium
                            )
                        }
                        Column {
                            Text(
                                text = item.product.name,
                                style = MaterialTheme.typography.bodyMedium,
                                fontWeight = FontWeight.SemiBold
                            )
                            Text(
                                text = "${item.quantity} x ${formatPrice(item.product.unitPrice)}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                    Text(
                        text = formatPrice(item.product.unitPrice * item.quantity),
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.SemiBold
                    )
                }
            }
        }
    }
}

@Composable
private fun CheckoutAddressCard(
    title: String,
    loadingMessage: String,
    emptyMessage: String,
    manageLabel: String,
    addresses: List<ClientAddress>,
    selectedAddressId: String?,
    loading: Boolean,
    onSelect: (String) -> Unit,
    onManage: () -> Unit
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
                text = title,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold
            )

            when {
                loading -> {
                    Text(text = loadingMessage, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }

                addresses.isEmpty() -> {
                    Text(text = emptyMessage, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }

                else -> {
                    val selected = addresses.firstOrNull { it.id == selectedAddressId }
                        ?: addresses.firstOrNull()
                    if (selected != null) {
                        CheckoutSelectedAddress(address = selected)
                    }
                    if (addresses.size > 1) {
                        addresses.filter { it.id != selected?.id }.forEach { address ->
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
                            ) {
                                RadioButton(
                                    selected = false,
                                    onClick = { address.id?.let(onSelect) },
                                    enabled = address.id != null
                                )
                                Text(
                                    text = address.label,
                                    style = MaterialTheme.typography.bodyMedium
                                )
                            }
                        }
                    }
                }
            }

            TextButton(onClick = onManage) {
                Text(text = manageLabel)
            }
        }
    }
}

@Composable
private fun CheckoutSelectedAddress(address: ClientAddress) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.3f))
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(MaterialTheme.spacing.x2),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
        ) {
            Text(
                text = address.label,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.SemiBold
            )
            val mainLine = listOf(address.street, address.number)
                .filter { it.isNotBlank() }
                .joinToString(" ")
            if (mainLine.isNotBlank()) {
                Text(text = mainLine, style = MaterialTheme.typography.bodyMedium)
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
private fun CheckoutPaymentCard(
    title: String,
    cashLabel: String,
    transferLabel: String,
    selectedMethod: String,
    onSelect: (String) -> Unit
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
                text = title,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
            ) {
                RadioButton(
                    selected = selectedMethod == "cash",
                    onClick = { onSelect("cash") }
                )
                Text(text = cashLabel, style = MaterialTheme.typography.bodyMedium)
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
            ) {
                RadioButton(
                    selected = selectedMethod == "transfer",
                    onClick = { onSelect("transfer") }
                )
                Text(text = transferLabel, style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

@Composable
private fun CheckoutNotesCard(
    label: String,
    placeholder: String,
    value: String,
    onValueChange: (String) -> Unit
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
                text = label,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold
            )
            OutlinedTextField(
                value = value,
                onValueChange = onValueChange,
                placeholder = { Text(text = placeholder) },
                modifier = Modifier.fillMaxWidth(),
                minLines = 2,
                maxLines = 4
            )
        }
    }
}

@Composable
private fun CheckoutTotalsCard(
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
            CheckoutSummaryRow(label = subtotalLabel, value = formatPrice(subtotal))
            CheckoutSummaryRow(label = shippingLabel, value = formatPrice(shipping))
            Divider()
            CheckoutSummaryRow(
                label = totalLabel,
                value = formatPrice(total),
                emphasize = true
            )
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
private fun CheckoutSuccessContent(
    title: String,
    message: String,
    orderCode: String,
    goToOrdersLabel: String,
    backHomeLabel: String,
    onGoToOrders: () -> Unit,
    onBackHome: () -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = MaterialTheme.spacing.x4, vertical = MaterialTheme.spacing.x5),
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
                contentDescription = title,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(48.dp)
            )
        }
        Spacer(modifier = Modifier.height(MaterialTheme.spacing.x3))
        Text(
            text = title,
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center
        )
        Spacer(modifier = Modifier.height(MaterialTheme.spacing.x1))
        Text(
            text = message,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center
        )
        Spacer(modifier = Modifier.height(MaterialTheme.spacing.x2))
        Text(
            text = orderCode,
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.primary,
            textAlign = TextAlign.Center
        )
        Spacer(modifier = Modifier.height(MaterialTheme.spacing.x4))
        IntralePrimaryButton(
            text = goToOrdersLabel,
            onClick = onGoToOrders,
            modifier = Modifier.fillMaxWidth()
        )
        Spacer(modifier = Modifier.height(MaterialTheme.spacing.x2))
        TextButton(onClick = onBackHome) {
            Text(
                text = backHomeLabel,
                color = MaterialTheme.colorScheme.primary,
                fontWeight = FontWeight.SemiBold
            )
        }
    }
}
