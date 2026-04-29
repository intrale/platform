package ui.sc.business.delivery

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import asdo.business.delivery.Coordinate
import asdo.business.delivery.MAX_ZONE_RADIUS_METERS
import androidx.compose.foundation.Canvas
import kotlin.math.max

/**
 * Implementación STUB del adaptador de mapa para Android (#2447).
 *
 * No usa Google Maps todavía — espera a que aterrice #2420.
 * Renderiza un canvas plano que mapea coordenadas a un viewport simple
 * (latitud → eje Y invertido, longitud → eje X) para que el usuario pueda
 * tapear, arrastrar y ver el círculo.
 *
 * Ventana inicial: centrada en Buenos Aires.
 */
private val DEFAULT_CENTER = Coordinate(-34.6037, -58.3816)
private const val VIEW_DELTA_DEG = 0.2

@Composable
actual fun ZoneEditorMap(
    center: Coordinate?,
    radiusMeters: Int,
    onMapTap: (Coordinate) -> Unit,
    onCenterDrag: (Coordinate) -> Unit,
    onCenterDragStart: () -> Unit,
) {
    var canvasSize by remember { mutableStateOf(IntSize.Zero) }
    val viewport = remember(center) {
        val anchor = center ?: DEFAULT_CENTER
        Viewport(
            minLat = anchor.latitude - VIEW_DELTA_DEG,
            maxLat = anchor.latitude + VIEW_DELTA_DEG,
            minLng = anchor.longitude - VIEW_DELTA_DEG,
            maxLng = anchor.longitude + VIEW_DELTA_DEG,
        )
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .onGloballyPositioned { canvasSize = it.size }
            .pointerInput(center, radiusMeters) {
                detectTapGestures { offset ->
                    val coord = viewport.fromOffset(offset, canvasSize)
                    onMapTap(coord)
                }
            }
            .pointerInput(center, radiusMeters) {
                if (center != null) {
                    detectDragGestures(
                        onDragStart = { onCenterDragStart() },
                        onDrag = { change, _ ->
                            val coord = viewport.fromOffset(change.position, canvasSize)
                            onCenterDrag(coord)
                        }
                    )
                }
            }
    ) {
        Canvas(modifier = Modifier.fillMaxSize()) {
            // Cuadrícula sutil para indicar que el mapa es interactivo.
            val gridStep = 32f
            val gridColor = Color.Gray.copy(alpha = 0.15f)
            var x = 0f
            while (x < size.width) {
                drawLine(gridColor, Offset(x, 0f), Offset(x, size.height), strokeWidth = 1f)
                x += gridStep
            }
            var y = 0f
            while (y < size.height) {
                drawLine(gridColor, Offset(0f, y), Offset(size.width, y), strokeWidth = 1f)
                y += gridStep
            }

            if (center != null && canvasSize != IntSize.Zero) {
                val centerOffset = viewport.toOffset(center, canvasSize)
                val pixelsPerMeter = max(
                    canvasSize.width.toFloat() / metersPerView(viewport),
                    1f / MAX_ZONE_RADIUS_METERS.toFloat()
                )
                val radiusPx = radiusMeters * pixelsPerMeter
                drawCircle(
                    color = Color(0xFF1976D2).copy(alpha = 0.20f),
                    radius = radiusPx,
                    center = centerOffset,
                )
                drawCircle(
                    color = Color(0xFF0D47A1),
                    radius = radiusPx,
                    center = centerOffset,
                    style = Stroke(width = 4f),
                )
                drawCircle(
                    color = Color(0xFFD32F2F),
                    radius = 10f,
                    center = centerOffset,
                )
            }
        }

        if (center == null) {
            Text(
                text = "Tapea el mapa para colocar el centro",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier
                    .align(Alignment.Center)
                    .padding(16.dp)
            )
        }
    }

    LaunchedEffect(center) {
        // hook reservado para integraciones futuras (ej. animar cámara con #2420).
    }
}

private data class Viewport(
    val minLat: Double,
    val maxLat: Double,
    val minLng: Double,
    val maxLng: Double,
) {
    fun toOffset(coord: Coordinate, size: IntSize): Offset {
        val xRatio = ((coord.longitude - minLng) / (maxLng - minLng)).toFloat().coerceIn(0f, 1f)
        // Invertimos eje Y: latitudes mayores arriba.
        val yRatio = (1.0 - (coord.latitude - minLat) / (maxLat - minLat)).toFloat().coerceIn(0f, 1f)
        return Offset(xRatio * size.width, yRatio * size.height)
    }

    fun fromOffset(offset: Offset, size: IntSize): Coordinate {
        if (size == IntSize.Zero) return Coordinate(minLat, minLng)
        val xRatio = (offset.x / size.width).coerceIn(0f, 1f).toDouble()
        val yRatio = (offset.y / size.height).coerceIn(0f, 1f).toDouble()
        val lng = minLng + xRatio * (maxLng - minLng)
        val lat = maxLat - yRatio * (maxLat - minLat)
        return Coordinate(lat, lng)
    }
}

/**
 * Estimación grosera: cuántos metros caben en el ancho del viewport.
 * 1 grado de longitud ≈ 111_000 m * cos(lat). En Buenos Aires (-34.6) ≈ 91_400 m.
 */
private fun metersPerView(viewport: Viewport): Float {
    val avgLat = (viewport.minLat + viewport.maxLat) / 2
    val metersPerDegLng = 111_000.0 * kotlin.math.cos(avgLat * kotlin.math.PI / 180.0)
    return ((viewport.maxLng - viewport.minLng) * metersPerDegLng).toFloat().coerceAtLeast(1f)
}
