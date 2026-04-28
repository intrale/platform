package ui.sc.client

import android.graphics.Color as AndroidColor
import android.os.Build
import android.preference.PreferenceManager
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import asdo.client.SanitizedBoundingBox
import asdo.client.SanitizedBusinessZone
import asdo.client.ZoneShape
import org.osmdroid.config.Configuration
import org.osmdroid.tileprovider.tilesource.TileSourceFactory
import org.osmdroid.util.BoundingBox
import org.osmdroid.util.GeoPoint
import org.osmdroid.views.MapView
import org.osmdroid.views.overlay.Polygon

/**
 * Android actual de [ZonesMapPlatformView] (issue #2423).
 *
 * - OSMDroid 6.1.20 (clientImplementation, scopeado al flavor `client`).
 * - HTTPS forzado vio `MAPNIK` (`https://tile.openstreetmap.org`).
 * - `userAgentValue` custom (Security A08 — politica de OSM exige
 *   identificador unico por app).
 * - Cache en `cacheDir/osmdroid` (Security A09 — sin external storage).
 * - Sin `MyLocationOverlay` ni overlays que muestren la posicion del
 *   usuario (Security A09).
 * - Sin pitch / rotacion (UX-7).
 * - `DisposableEffect` cierra el `MapView` para evitar leaks.
 */
@Composable
actual fun ZonesMapPlatformView(
    modifier: Modifier,
    zones: List<SanitizedBusinessZone>,
    boundingBox: SanitizedBoundingBox?,
    zoneColors: List<Long>,
) {
    val context = LocalContext.current

    // Inicializacion lazy de OSMDroid (idempotente). El holder verifica
    // que solo se ejecute una vez por proceso.
    LaunchedEffect(Unit) { OsmdroidInitializer.ensureInitialized(context) }

    val mapView = remember {
        MapView(context).apply {
            setTileSource(TileSourceFactory.MAPNIK)
            setMultiTouchControls(true)
            isHorizontalMapRepetitionEnabled = false
            isVerticalMapRepetitionEnabled = false
            minZoomLevel = 4.0
            maxZoomLevel = 18.0
        }
    }

    AndroidView(
        modifier = modifier.fillMaxSize(),
        factory = { mapView },
        update = { view ->
            view.overlays.clear()
            zones.forEachIndexed { index, zone ->
                val color = zoneColors.getOrNull(index)
                    ?: zoneColors.getOrNull(0)
                    ?: 0xFF1F77B4L
                val argb = color.toInt()
                val polygon = Polygon().apply {
                    fillPaint.color = AndroidColor.argb(
                        90, // alpha 0.35
                        AndroidColor.red(argb),
                        AndroidColor.green(argb),
                        AndroidColor.blue(argb),
                    )
                    outlinePaint.color = AndroidColor.argb(
                        230,
                        AndroidColor.red(argb),
                        AndroidColor.green(argb),
                        AndroidColor.blue(argb),
                    )
                    outlinePaint.strokeWidth = 4f
                    title = zone.name
                }
                val points: List<GeoPoint> = when (zone.type) {
                    ZoneShape.POLYGON -> zone.polygon.map { GeoPoint(it.lat, it.lng) }
                    ZoneShape.CIRCLE -> {
                        val center = zone.center
                        val radius = zone.radiusMeters
                        if (center != null && radius != null) {
                            Polygon.pointsAsCircle(GeoPoint(center.lat, center.lng), radius)
                        } else emptyList()
                    }
                    ZoneShape.UNKNOWN -> emptyList()
                }
                if (points.size >= 3) {
                    polygon.points = points
                    view.overlays.add(polygon)
                }
            }

            boundingBox?.let { bb ->
                val osmBb = BoundingBox(bb.maxLat, bb.maxLng, bb.minLat, bb.minLng)
                view.post { view.zoomToBoundingBox(osmBb, true, 64) }
            }
            view.invalidate()
        },
    )

    DisposableEffect(mapView) {
        mapView.onResume()
        onDispose {
            mapView.onPause()
            mapView.onDetach()
        }
    }
}

/** En Android renderizamos un mapa interactivo real. */
actual val isInteractiveMapAvailable: Boolean = true

/**
 * Inicializador idempotente de OSMDroid. Centraliza la config (cache,
 * userAgent, HTTPS) en lugar de obligar a tener un `Application` custom
 * (que rompe los tests instrumented si no se inyecta bien).
 */
private object OsmdroidInitializer {
    @Volatile private var initialized: Boolean = false

    fun ensureInitialized(context: android.content.Context) {
        if (initialized) return
        synchronized(this) {
            if (initialized) return
            val config = Configuration.getInstance()
            val prefs = PreferenceManager.getDefaultSharedPreferences(context.applicationContext)
            config.load(context.applicationContext, prefs)
            config.userAgentValue = "intrale-client/1.0"
            // Cache acotado en directorio interno (privado), 50 MB, expiracion 24h
            config.osmdroidBasePath = java.io.File(context.cacheDir, "osmdroid")
            config.osmdroidTileCache = java.io.File(context.cacheDir, "osmdroid/tiles")
            config.tileFileSystemCacheMaxBytes = 50L * 1024L * 1024L
            config.tileFileSystemCacheTrimBytes = 40L * 1024L * 1024L
            config.expirationOverrideDuration = 24L * 60L * 60L * 1000L // 24h en ms
            // Aseguramos que el SDK sea consciente para evitar warnings irrelevantes
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                config.cacheMapTileCount = 9
                config.cacheMapTileOvershoot = 0
            }
            initialized = true
        }
    }
}
