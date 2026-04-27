package ui.sc.client

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import ext.location.rememberCoarseLocationPermissionLauncher
import kotlinx.coroutines.launch
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.IntralePrimaryButton
import ui.sc.shared.Screen
import ui.th.spacing
import ui.util.formatPrice

const val CLIENT_ADDRESS_CHECK_PATH = "/client/addressCheck"

/**
 * Pantalla del flujo de verificación de zona — issue #2422 (Hija A de #2417).
 *
 * State machine y CA cubiertos:
 * - CA-2: rationale ANTES del diálogo nativo de permisos.
 * - CA-3: card positiva (`tertiaryContainer`) con costo + ETA + CTA.
 * - CA-4: card negativa (`errorContainer`) tono conciliador con dos
 *         acciones (placeholder a Hija B + probar otra dirección).
 * - CA-11: indicador discreto > 1.5 s + toast > 5 s + botón reintentar
 *           ante error.
 * - CA-12: el botón "Ver zonas de cobertura" abre toast placeholder
 *           hasta que Hija B aporte el mapa.
 */
class AddressCheckScreen : Screen(CLIENT_ADDRESS_CHECK_PATH) {

    override val messageTitle: MessageKey = MessageKey.address_check_appbar_title

    @Composable
    override fun screen() {
        ScreenContent()
    }

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    private fun ScreenContent(
        viewModel: AddressCheckViewModel = viewModel { AddressCheckViewModel() }
    ) {
        val logger = remember { LoggerFactory.default.newLogger<AddressCheckScreen>() }
        val coroutineScope = rememberCoroutineScope()
        val state = viewModel.state
        val snackbarHostState = remember { SnackbarHostState() }

        // Etiquetas (todas via Txt → catálogo es/en).
        val title = Txt(MessageKey.address_check_appbar_title)
        val rationaleTitle = Txt(MessageKey.address_check_rationale_title)
        val rationaleDescription = Txt(MessageKey.address_check_rationale_description)
        val rationaleUseGps = Txt(MessageKey.address_check_rationale_use_gps)
        val rationaleManual = Txt(MessageKey.address_check_rationale_manual)
        val manualTitle = Txt(MessageKey.address_check_manual_title)
        val manualPlaceholder = Txt(MessageKey.address_check_manual_placeholder)
        val manualHelperNotFound = Txt(MessageKey.address_check_manual_helper_not_found)
        val manualSubmit = Txt(MessageKey.address_check_manual_submit)
        val loadingSlow = Txt(MessageKey.address_check_loading_slow)
        val positiveTitle = Txt(MessageKey.address_check_result_positive_title)
        val positiveCostFree = Txt(MessageKey.address_check_result_positive_cost_free)
        val positiveContinue = Txt(MessageKey.address_check_result_positive_continue)
        val positiveA11y = Txt(MessageKey.address_check_a11y_positive_card)
        val negativeTitle = Txt(MessageKey.address_check_result_negative_title)
        val negativeSubtitle = Txt(MessageKey.address_check_result_negative_subtitle)
        val negativeViewZones = Txt(MessageKey.address_check_result_negative_view_zones)
        val negativeViewZonesPlaceholder = Txt(
            MessageKey.address_check_result_negative_view_zones_placeholder
        )
        val negativeTryAgain = Txt(MessageKey.address_check_result_negative_try_again)
        val negativeA11y = Txt(MessageKey.address_check_a11y_negative_card)
        val resultError = Txt(MessageKey.address_check_result_error)
        val resultErrorRetry = Txt(MessageKey.address_check_result_error_retry)

        // Permission launcher: cuando el sistema responde, el VM continúa.
        val permissionLauncher = rememberCoarseLocationPermissionLauncher { granted ->
            logger.info { "Permiso runtime resuelto granted=$granted" }
            coroutineScope.launch { viewModel.onPermissionResult(granted) }
        }

        // Toast "Conexión lenta" cuando la verificación tarda > 5 s.
        LaunchedEffect(state.isSlowConnectionVisible) {
            if (state.isSlowConnectionVisible) {
                snackbarHostState.showSnackbar(loadingSlow)
            }
        }

        // Toast del placeholder "Ver zonas de cobertura" (Hija B).
        LaunchedEffect(state.placeholderToastVisible) {
            if (state.placeholderToastVisible) {
                snackbarHostState.showSnackbar(negativeViewZonesPlaceholder)
                viewModel.dismissZonesPlaceholder()
            }
        }

        // Si la pantalla se abrió desde el banner del catálogo (sin
        // verificación previa) y aún estamos en Idle, abrimos el rationale
        // automáticamente para minimizar fricción (CA-2).
        LaunchedEffect(Unit) {
            if (state.step == AddressCheckStep.Idle) {
                viewModel.openRationale()
            }
        }

        Scaffold(
            snackbarHost = { SnackbarHost(snackbarHostState) }
        ) { padding ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .padding(MaterialTheme.spacing.x4),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
            ) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.SemiBold,
                )

                when (state.step) {
                    AddressCheckStep.Idle, AddressCheckStep.Rationale -> {
                        // El rationale se renderiza como ModalBottomSheet abajo.
                        // El cuerpo principal queda con un mensaje y el CTA
                        // que reabre el sheet si el usuario lo cerró.
                        IdleHint(
                            onVerifyClick = { viewModel.openRationale() },
                            verifyLabel = Txt(MessageKey.address_check_banner_pending_action),
                            description = rationaleDescription,
                        )
                    }

                    AddressCheckStep.ManualInput -> {
                        ManualInputCard(
                            title = manualTitle,
                            placeholder = manualPlaceholder,
                            helperNotFound = manualHelperNotFound,
                            submitLabel = manualSubmit,
                            value = state.manualAddressInput,
                            error = state.manualAddressError,
                            onValueChange = { viewModel.onManualAddressChange(it) },
                            onSubmit = {
                                coroutineScope.launch { viewModel.submitManualAddress() }
                            },
                        )
                    }

                    AddressCheckStep.Locating, AddressCheckStep.Loading -> {
                        LoadingIndicator()
                    }

                    AddressCheckStep.ResultPositive -> {
                        val cost = state.lastResult?.shippingCost ?: 0.0
                        val eta = state.lastResult?.etaMinutes
                        val costLine = if (cost <= 0.0) {
                            positiveCostFree
                        } else {
                            Txt(
                                MessageKey.address_check_result_positive_cost,
                                mapOf("price" to formatPrice(cost)),
                            )
                        }
                        val etaLine = eta?.let {
                            Txt(
                                MessageKey.address_check_result_positive_eta,
                                mapOf("eta" to it.toString()),
                            )
                        }
                        PositiveResultCard(
                            title = positiveTitle,
                            costLine = costLine,
                            etaLine = etaLine,
                            continueLabel = positiveContinue,
                            a11yDescription = positiveA11y,
                            onContinue = {
                                viewModel.acceptPositiveResult()
                                navigate(CLIENT_CATALOG_PATH)
                            },
                        )
                    }

                    AddressCheckStep.ResultNegative -> {
                        NegativeResultCard(
                            title = negativeTitle,
                            subtitle = negativeSubtitle,
                            viewZonesLabel = negativeViewZones,
                            tryAgainLabel = negativeTryAgain,
                            a11yDescription = negativeA11y,
                            onViewZones = { viewModel.showZonesPlaceholder() },
                            onTryAgain = { viewModel.tryAnotherAddress() },
                        )
                    }

                    AddressCheckStep.ResultError -> {
                        ErrorResultCard(
                            message = resultError,
                            retryLabel = resultErrorRetry,
                            onRetry = {
                                coroutineScope.launch { viewModel.retry() }
                            },
                        )
                    }
                }
            }
        }

        // Bottom sheet de rationale (CA-2).
        if (state.rationaleVisible) {
            val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
            ModalBottomSheet(
                onDismissRequest = { viewModel.dismissRationale() },
                sheetState = sheetState,
            ) {
                RationaleSheetContent(
                    title = rationaleTitle,
                    description = rationaleDescription,
                    useGpsLabel = rationaleUseGps,
                    manualLabel = rationaleManual,
                    onUseGps = {
                        viewModel.onPermissionRequestRequested()
                        permissionLauncher.invoke()
                    },
                    onManual = { viewModel.chooseManualEntry() },
                )
            }
        }
    }
}

// region ── Composables internos

@Composable
private fun IdleHint(
    onVerifyClick: () -> Unit,
    verifyLabel: String,
    description: String,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainerHighest,
        ),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x4),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    imageVector = Icons.Default.LocationOn,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                )
                Spacer(modifier = Modifier.size(MaterialTheme.spacing.x2))
                Text(
                    text = description,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }
            IntralePrimaryButton(
                modifier = Modifier
                    .fillMaxWidth()
                    .defaultMinSize(minHeight = 48.dp),
                text = verifyLabel,
                onClick = onVerifyClick,
            )
        }
    }
}

@Composable
private fun RationaleSheetContent(
    title: String,
    description: String,
    useGpsLabel: String,
    manualLabel: String,
    onUseGps: () -> Unit,
    onManual: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(
                horizontal = MaterialTheme.spacing.x4,
                vertical = MaterialTheme.spacing.x4,
            ),
        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3),
    ) {
        Text(
            text = title,
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.SemiBold,
        )
        Text(
            text = description,
            style = MaterialTheme.typography.bodyMedium,
        )
        // CA-2: ambos botones con misma jerarquía visual: tonal + mismo
        // tamaño + mismo color de fondo. NO uno filled + uno outlined.
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2),
        ) {
            Button(
                onClick = onUseGps,
                modifier = Modifier
                    .weight(1f)
                    .defaultMinSize(minHeight = 56.dp),
                colors = ButtonDefaults.filledTonalButtonColors(),
            ) {
                Icon(
                    imageVector = Icons.Default.LocationOn,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp),
                )
                Spacer(modifier = Modifier.size(MaterialTheme.spacing.x1))
                Text(text = useGpsLabel)
            }
            Button(
                onClick = onManual,
                modifier = Modifier
                    .weight(1f)
                    .defaultMinSize(minHeight = 56.dp),
                colors = ButtonDefaults.filledTonalButtonColors(),
            ) {
                Icon(
                    imageVector = Icons.Default.Edit,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp),
                )
                Spacer(modifier = Modifier.size(MaterialTheme.spacing.x1))
                Text(text = manualLabel)
            }
        }
    }
}

@Composable
private fun ManualInputCard(
    title: String,
    placeholder: String,
    helperNotFound: String,
    submitLabel: String,
    value: String,
    error: String?,
    onValueChange: (String) -> Unit,
    onSubmit: () -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x4),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2),
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            OutlinedTextField(
                value = value,
                onValueChange = onValueChange,
                placeholder = { Text(placeholder) },
                singleLine = true,
                isError = error == AddressCheckViewModel.NOT_FOUND_ERROR,
                supportingText = {
                    when (error) {
                        AddressCheckViewModel.NOT_FOUND_ERROR -> Text(helperNotFound)
                        else -> Unit
                    }
                },
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Text,
                    imeAction = ImeAction.Go,
                ),
                modifier = Modifier.fillMaxWidth(),
            )
            IntralePrimaryButton(
                modifier = Modifier
                    .fillMaxWidth()
                    .defaultMinSize(minHeight = 48.dp),
                text = submitLabel,
                onClick = onSubmit,
            )
        }
    }
}

@Composable
private fun LoadingIndicator() {
    // CA-11: indicador discreto, no full-screen.
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = MaterialTheme.spacing.x4),
        contentAlignment = Alignment.Center,
    ) {
        CircularProgressIndicator()
    }
}

@Composable
private fun PositiveResultCard(
    title: String,
    costLine: String,
    etaLine: String?,
    continueLabel: String,
    a11yDescription: String,
    onContinue: () -> Unit,
) {
    AnimatedVisibility(
        visible = true,
        enter = fadeIn(),
        exit = fadeOut(),
    ) {
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .semantics { contentDescription = a11yDescription },
            colors = CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.tertiaryContainer,
            ),
        ) {
            Column(
                modifier = Modifier.padding(MaterialTheme.spacing.x4),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        imageVector = Icons.Default.CheckCircle,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onTertiaryContainer,
                    )
                    Spacer(modifier = Modifier.size(MaterialTheme.spacing.x2))
                    Text(
                        text = title,
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.onTertiaryContainer,
                    )
                }
                Text(
                    text = costLine,
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onTertiaryContainer,
                )
                etaLine?.let {
                    Text(
                        text = it,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onTertiaryContainer,
                    )
                }
                IntralePrimaryButton(
                    modifier = Modifier
                        .fillMaxWidth()
                        .defaultMinSize(minHeight = 48.dp),
                    text = continueLabel,
                    onClick = onContinue,
                )
            }
        }
    }
}

@Composable
private fun NegativeResultCard(
    title: String,
    subtitle: String,
    viewZonesLabel: String,
    tryAgainLabel: String,
    a11yDescription: String,
    onViewZones: () -> Unit,
    onTryAgain: () -> Unit,
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .semantics { contentDescription = a11yDescription },
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.errorContainer,
        ),
    ) {
        Column(
            modifier = Modifier.padding(MaterialTheme.spacing.x4),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    imageVector = Icons.Default.Info,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onErrorContainer,
                )
                Spacer(modifier = Modifier.size(MaterialTheme.spacing.x2))
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onErrorContainer,
                )
            }
            Text(
                text = subtitle,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onErrorContainer,
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2),
            ) {
                TextButton(
                    onClick = onViewZones,
                    modifier = Modifier
                        .weight(1f)
                        .defaultMinSize(minHeight = 48.dp),
                ) {
                    Text(viewZonesLabel)
                }
                IntralePrimaryButton(
                    modifier = Modifier
                        .weight(1f)
                        .defaultMinSize(minHeight = 48.dp),
                    text = tryAgainLabel,
                    onClick = onTryAgain,
                )
            }
        }
    }
}

@Composable
private fun ErrorResultCard(
    message: String,
    retryLabel: String,
    onRetry: () -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
        ),
    ) {
        Column(
            modifier = Modifier.padding(MaterialTheme.spacing.x4),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    imageVector = Icons.Default.Warning,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurface,
                )
                Spacer(modifier = Modifier.size(MaterialTheme.spacing.x2))
                Text(
                    text = message,
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }
            IntralePrimaryButton(
                modifier = Modifier
                    .fillMaxWidth()
                    .defaultMinSize(minHeight = 48.dp),
                text = retryLabel,
                onClick = onRetry,
            )
        }
    }
}

// endregion
