package ext.location

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Geocoder
import android.location.Location
import android.os.Build
import androidx.core.content.ContextCompat
import com.google.android.gms.location.CurrentLocationRequest
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import kotlin.coroutines.resume

/**
 * Implementación Android de [CommLocationProvider]. Usa el cliente Fused
 * (Play Services Location) para obtener una posición coarse one-shot, y
 * `android.location.Geocoder` del SDK como fallback de entrada manual.
 *
 * Privacidad (CA-5 / CA-7):
 * - **No persiste** ninguna ubicación. Cada llamada solicita al sistema una
 *   posición fresca y la entrega al ViewModel; cuando el ViewModel se
 *   descarta, la coordenada desaparece del proceso.
 * - **No loggea** `latitude`, `longitude`, `Address` ni el objeto `Location`
 *   completo. Solo metadatos: `granted`, `available`, `hasResult`.
 * - El permiso `ACCESS_COARSE_LOCATION` se verifica con [hasCoarseLocationPermission]
 *   antes de cualquier llamada; nunca se asume concedido.
 *
 * Compatibilidad:
 * - `getFromLocationName` síncrono < API 33: bloquea el thread, así que se
 *   ejecuta dentro de `withContext(Dispatchers.IO)` para no romper el main.
 * - API 33+: existe versión async con callback, pero la sincrónica sigue
 *   funcionando y es más simple de testear; el costo I/O ya está aislado.
 */
class AndroidLocationProvider(
    private val context: Context,
) : CommLocationProvider {

    private val logger = LoggerFactory.default.newLogger<AndroidLocationProvider>()
    private val fusedClient by lazy {
        LocationServices.getFusedLocationProviderClient(context)
    }

    override fun isAvailable(): Boolean = true

    override suspend fun requestCoarseLocation(): LocationOutcome {
        if (!hasCoarseLocationPermission()) {
            logger.info { "Permiso de ubicación no concedido granted=false" }
            return LocationOutcome.PermissionDenied
        }
        return try {
            val location = withContext(Dispatchers.IO) {
                awaitCurrentLocation()
            }
            if (location == null) {
                logger.info { "Servicio de ubicación retornó vacío hasResult=false" }
                LocationOutcome.Unavailable
            } else {
                logger.info { "Ubicación obtenida hasResult=true" }
                LocationOutcome.Coordinates(
                    latitude = location.latitude,
                    longitude = location.longitude,
                )
            }
        } catch (security: SecurityException) {
            logger.warning(security) { "SecurityException leyendo ubicación granted=false" }
            LocationOutcome.PermissionDenied
        } catch (throwable: Throwable) {
            logger.error(throwable) { "Error leyendo ubicación" }
            LocationOutcome.Error(throwable.message ?: "Error de ubicación")
        }
    }

    override suspend fun geocodeAddress(query: String): LocationOutcome {
        if (query.isBlank()) {
            return LocationOutcome.NotFound
        }
        return try {
            val results = withContext(Dispatchers.IO) {
                @Suppress("DEPRECATION")
                Geocoder(context)
                    .getFromLocationName(query, GEOCODER_MAX_RESULTS)
                    .orEmpty()
            }
            val first = results.firstOrNull { it.hasLatitude() && it.hasLongitude() }
            if (first == null) {
                logger.info { "Geocoder sin resultados hasResult=false" }
                LocationOutcome.NotFound
            } else {
                logger.info { "Dirección geocodificada hasResult=true" }
                LocationOutcome.Coordinates(
                    latitude = first.latitude,
                    longitude = first.longitude,
                )
            }
        } catch (throwable: Throwable) {
            logger.error(throwable) { "Error geocodificando dirección" }
            LocationOutcome.Error(throwable.message ?: "Error geocodificando")
        }
    }

    private fun hasCoarseLocationPermission(): Boolean =
        ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.ACCESS_COARSE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED

    private suspend fun awaitCurrentLocation(): Location? =
        suspendCancellableCoroutine { cont: CancellableContinuation<Location?> ->
            try {
                val request = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    CurrentLocationRequest.Builder()
                        .setPriority(Priority.PRIORITY_LOW_POWER)
                        .build()
                } else {
                    CurrentLocationRequest.Builder().build()
                }
                fusedClient.getCurrentLocation(request, null)
                    .addOnSuccessListener { loc -> if (cont.isActive) cont.resume(loc) }
                    .addOnFailureListener { error ->
                        if (cont.isActive) {
                            logger.warning(error) { "FusedClient retornó error" }
                            cont.resume(null)
                        }
                    }
            } catch (security: SecurityException) {
                if (cont.isActive) cont.resume(null)
                throw security
            }
        }

    companion object {
        private const val GEOCODER_MAX_RESULTS: Int = 3
    }
}
