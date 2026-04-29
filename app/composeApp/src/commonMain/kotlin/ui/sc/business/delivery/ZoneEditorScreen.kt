package ui.sc.business.delivery

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowForward
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import asdo.business.delivery.MAX_ZONE_NAME_LENGTH
import asdo.business.delivery.MAX_ZONE_RADIUS_METERS
import asdo.business.delivery.MIN_ZONE_RADIUS_METERS
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

/**
 * Pantalla del editor circular de zonas de entrega (#2447).
 *
 * Vive en commonMain pero sólo se referencia desde la nav del flavor `business`.
 * El platform-specific (mapa) se abstrae vía expect/actual en `ZoneEditorMap`.
 */
private val logger = LoggerFactory.default.newLogger("ui.sc.business.delivery", "ZoneEditorScreen")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ZoneEditorScreen(
    viewModel: DeliveryZonesViewModel,
    onClose: () -> Unit,
) {
    val state = viewModel.state
    val editor = state.editor ?: run {
        // No abrió el editor; render no-op.
        return
    }

    var dismissDialogVisible by remember { mutableStateOf(false) }

    fun requestClose() {
        val hasData = editor.hasCenter || editor.nameInput.isNotBlank() || editor.costCentsInput.isNotBlank()
        if (hasData && !editor.isSaving) {
            dismissDialogVisible = true
        } else {
            viewModel.closeEditor()
            onClose()
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
    ) {
        // Mapa (stub o real según platform).
        ZoneEditorMap(
            center = editor.center,
            radiusMeters = editor.radiusMeters,
            onMapTap = viewModel::onMapTap,
            onCenterDrag = viewModel::onCenterDrag,
            onCenterDragStart = viewModel::onCenterDragStart,
        )

        // Top-bar transparente con botón de cierre.
        Surface(
            color = Color.Black.copy(alpha = 0.45f),
            modifier = Modifier
                .fillMaxWidth()
                .align(Alignment.TopCenter)
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 8.dp, vertical = 4.dp)
            ) {
                IconButton(
                    onClick = ::requestClose,
                    modifier = Modifier
                        .sizeIn(minWidth = 48.dp, minHeight = 48.dp)
                        .semantics { contentDescription = "Cerrar editor" }
                ) {
                    Icon(Icons.Filled.Close, contentDescription = null, tint = Color.White)
                }
                Text(
                    text = Txt(MessageKey.zone_editor_title),
                    style = MaterialTheme.typography.titleMedium,
                    color = Color.White,
                    modifier = Modifier
                        .weight(1f)
                        .padding(start = 8.dp)
                )
            }
        }

        // Chip flotante con valor del radio (LiveRegion polite).
        if (editor.hasCenter) {
            Surface(
                color = if (editor.radiusBelowMinimum) MaterialTheme.colorScheme.errorContainer
                else MaterialTheme.colorScheme.surfaceContainerHigh,
                shape = RoundedCornerShape(50),
                shadowElevation = 6.dp,
                modifier = Modifier
                    .align(Alignment.Center)
                    .padding(bottom = 16.dp)
                    .semantics { liveRegion = LiveRegionMode.Polite }
            ) {
                Text(
                    text = if (editor.radiusBelowMinimum) Txt(MessageKey.zone_editor_radius_warning)
                    else formatRadius(editor.radiusMeters),
                    style = MaterialTheme.typography.labelLarge,
                    color = if (editor.radiusBelowMinimum) MaterialTheme.colorScheme.onErrorContainer
                    else MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                )
            }
        } else {
            // Hint de idle state.
            Surface(
                color = Color.Black.copy(alpha = 0.6f),
                shape = RoundedCornerShape(8.dp),
                modifier = Modifier
                    .align(Alignment.Center)
                    .padding(16.dp)
            ) {
                Text(
                    text = Txt(MessageKey.zone_editor_hint_idle),
                    style = MaterialTheme.typography.bodyMedium,
                    color = Color.White,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)
                )
            }
        }

        // Slider de radio + CTA Siguiente en bottom.
        Column(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (editor.hasCenter) {
                Card(
                    elevation = CardDefaults.cardElevation(defaultElevation = 4.dp),
                    shape = RoundedCornerShape(16.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(modifier = Modifier.padding(16.dp)) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text(
                                text = Txt(MessageKey.zone_editor_radius_label),
                                style = MaterialTheme.typography.labelLarge,
                            )
                            Spacer(modifier = Modifier.weight(1f))
                            Text(
                                text = formatRadius(editor.radiusMeters),
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                        Slider(
                            value = editor.radiusMeters.toFloat(),
                            onValueChange = { viewModel.onRadiusChange(it.toInt()) },
                            valueRange = MIN_ZONE_RADIUS_METERS.toFloat()..MAX_ZONE_RADIUS_METERS.toFloat(),
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(min = 48.dp)
                                .semantics { contentDescription = "Radio de la zona en metros" }
                        )
                    }
                }

                ExtendedFloatingActionButton(
                    onClick = { viewModel.openSheet() },
                    text = { Text(Txt(MessageKey.zone_editor_next_cta)) },
                    icon = { Icon(Icons.Filled.ArrowForward, contentDescription = null) },
                    expanded = editor.canOpenSheet,
                    modifier = Modifier
                        .align(Alignment.End)
                        .sizeIn(minHeight = 48.dp)
                        .semantics { contentDescription = "Continuar al formulario" }
                )
            }
        }

        // Bottom-sheet del formulario.
        if (editor.sheetVisible) {
            val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = false)
            ModalBottomSheet(
                onDismissRequest = { viewModel.dismissSheet() },
                sheetState = sheetState,
            ) {
                ZoneFormSheet(viewModel = viewModel, editor = editor)
            }
        }

        // Confirmación de descarte.
        if (dismissDialogVisible) {
            AlertDialog(
                onDismissRequest = { dismissDialogVisible = false },
                title = { Text(Txt(MessageKey.zone_form_dismiss_confirm_title)) },
                text = { Text(Txt(MessageKey.zone_form_dismiss_confirm_body)) },
                confirmButton = {
                    TextButton(onClick = {
                        dismissDialogVisible = false
                        viewModel.closeEditor()
                        onClose()
                    }) { Text(Txt(MessageKey.zone_form_dismiss_confirm_yes)) }
                },
                dismissButton = {
                    TextButton(onClick = { dismissDialogVisible = false }) {
                        Text(Txt(MessageKey.zone_form_dismiss_confirm_no))
                    }
                },
            )
        }
    }

    LaunchedEffect(Unit) {
        logger.info { "ZoneEditorScreen montado" }
    }
}

@Composable
private fun ZoneFormSheet(
    viewModel: DeliveryZonesViewModel,
    editor: ZoneEditorUIState,
) {
    val timeOptions = remember { listOf(15, 30, 45, 60, 90, 120) }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            text = Txt(MessageKey.zone_form_title),
            style = MaterialTheme.typography.headlineSmall,
        )
        Text(
            text = Txt(
                MessageKey.zone_form_radius_preview,
                params = mapOf("radius" to formatRadius(editor.radiusMeters))
            ),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        // Nombre
        OutlinedTextField(
            value = editor.nameInput,
            onValueChange = { viewModel.onNameChange(it) },
            label = { Text(Txt(MessageKey.zone_form_name_label)) },
            singleLine = true,
            isError = editor.nameError != null,
            supportingText = {
                if (editor.nameError != null) {
                    Text(Txt(MessageKey.zone_form_name_invalid))
                } else {
                    Text(
                        Txt(
                            MessageKey.zone_form_name_counter,
                            params = mapOf("count" to editor.nameInput.length.toString())
                        )
                    )
                }
            },
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 64.dp)
        )

        // Costo (en centavos)
        OutlinedTextField(
            value = editor.costCentsInput,
            onValueChange = { viewModel.onCostChange(it) },
            label = { Text(Txt(MessageKey.zone_form_cost_label)) },
            singleLine = true,
            isError = editor.costError != null,
            supportingText = {
                if (editor.costError != null) Text(Txt(MessageKey.zone_form_cost_invalid))
                else Text(Txt(MessageKey.zone_form_cost_helper))
            },
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 64.dp)
        )

        // Tiempo estimado: dropdown simulado con chips simples
        Text(
            text = Txt(MessageKey.zone_form_time_label),
            style = MaterialTheme.typography.labelLarge,
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            timeOptions.take(3).forEach { mins ->
                TextButton(
                    onClick = { viewModel.onEstimatedMinutesChange(mins) },
                    modifier = Modifier
                        .sizeIn(minHeight = 48.dp)
                        .semantics {
                            contentDescription = "Tiempo estimado $mins minutos"
                        }
                ) {
                    Text(if (editor.estimatedMinutes == mins) "[$mins min]" else "$mins min")
                }
            }
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            timeOptions.drop(3).forEach { mins ->
                TextButton(
                    onClick = { viewModel.onEstimatedMinutesChange(mins) },
                    modifier = Modifier
                        .sizeIn(minHeight = 48.dp)
                        .semantics {
                            contentDescription = "Tiempo estimado $mins minutos"
                        }
                ) {
                    Text(if (editor.estimatedMinutes == mins) "[$mins min]" else "$mins min")
                }
            }
        }

        Spacer(modifier = Modifier.size(8.dp))

        // CTA Guardar
        Button(
            onClick = { viewModel.saveZone() },
            enabled = editor.canSave,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .semantics { contentDescription = "Guardar zona" }
        ) {
            if (editor.isSaving) {
                CircularProgressIndicator(modifier = Modifier.size(18.dp), color = Color.White)
                Spacer(modifier = Modifier.size(8.dp))
                Text(Txt(MessageKey.zone_form_saving))
            } else {
                Text(Txt(MessageKey.zone_form_save_cta))
            }
        }

        editor.saveError?.let { error ->
            Text(
                text = error,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }
            )
        }
    }
}

/** Formatea el radio: < 1000 m → "{N} m"; >= 1000 m → "{X,Y} km". */
private fun formatRadius(meters: Int): String {
    if (meters < 1000) return "$meters m"
    val whole = meters / 1000
    val tenths = (meters % 1000) / 100
    return "$whole,$tenths km"
}
