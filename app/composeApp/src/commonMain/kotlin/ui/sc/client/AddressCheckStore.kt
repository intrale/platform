package ui.sc.client

import asdo.client.ZoneCheckResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Estado compartido del flujo de verificación de zona — issue #2422.
 *
 * Razón de existir:
 * - El catálogo (`ClientCatalogScreen`) necesita reaccionar al banner sticky
 *   y bloquear la incorporación al carrito hasta que la dirección esté
 *   verificada.
 * - El flujo de verificación (`AddressCheckScreen`) escribe acá tanto el
 *   éxito como el "fuera de zona" para que el catálogo reciba feedback.
 *
 * Privacidad (CA-5 / CA-7):
 * - Esta clase NO almacena `latitude`, `longitude`, `Address` ni objetos
 *   `Location`. Solo guarda `inZone`, `shippingCost`, `etaMinutes` (datos
 *   ya derivados, no PII) y un timestamp de verificación.
 * - Es un `object` Kotlin, NO un Singleton inyectado por DI: queremos que
 *   se comporte como caché de proceso, sin riesgo de "fuga" entre flavors.
 * - Cuando la app pasa más de [BACKGROUND_TIMEOUT_MS] en background, el
 *   estado se descarta llamando a [maybeClearOnResume]. El caller responsable
 *   es `MainActivity` (Android) o el wrapper equivalente.
 */
object AddressCheckStore {

    enum class Phase { Pending, Verified, OutOfZone }

    /**
     * Snapshot inmutable del estado de verificación. Solo expone metadatos
     * derivados — nunca lat/lng.
     */
    data class State(
        val phase: Phase = Phase.Pending,
        val shippingCost: Double = 0.0,
        val etaMinutes: Int? = null,
        val zoneId: String? = null,
        val verifiedAtEpochMillis: Long = 0L,
    ) {
        val isVerified: Boolean get() = phase == Phase.Verified
        val isPending: Boolean get() = phase == Phase.Pending
        val isOutOfZone: Boolean get() = phase == Phase.OutOfZone
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    /**
     * Marca la zona como verificada y dentro de cobertura, exponiendo el
     * costo de envío y la ETA al catálogo. NO recibe lat/lng (privacidad).
     */
    fun markVerified(result: ZoneCheckResult, nowMillis: Long) {
        _state.value = State(
            phase = if (result.inZone) Phase.Verified else Phase.OutOfZone,
            shippingCost = if (result.inZone) result.shippingCost else 0.0,
            etaMinutes = result.etaMinutes,
            zoneId = result.zoneId,
            verifiedAtEpochMillis = nowMillis,
        )
    }

    /**
     * Reinicia a "pendiente". Usado cuando el usuario toca
     * "Probar otra dirección", o cuando el watchdog de background
     * detecta más de 5 minutos sin actividad.
     */
    fun reset() {
        _state.value = State()
    }

    /**
     * Si pasó más de [BACKGROUND_TIMEOUT_MS] desde la última verificación,
     * el estado se descarta. Llamar al volver del background (CA-5).
     */
    fun maybeClearOnResume(nowMillis: Long) {
        val current = _state.value
        if (current.phase == Phase.Pending) return
        if (current.verifiedAtEpochMillis == 0L) return
        if (nowMillis - current.verifiedAtEpochMillis > BACKGROUND_TIMEOUT_MS) {
            _state.value = State()
        }
    }

    const val BACKGROUND_TIMEOUT_MS: Long = 5 * 60 * 1000L
}
