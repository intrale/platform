package ar.com.intrale.delivery

import com.google.gson.Gson
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.Application
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.call
import io.ktor.server.request.receiveText
import io.ktor.server.response.respond
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.put
import io.ktor.server.routing.route
import io.ktor.server.routing.routing
import kotlinx.serialization.Serializable
import java.util.concurrent.ConcurrentHashMap

private val availabilityStore = ConcurrentHashMap<String, DeliveryAvailabilityPayload>()
private val gson = Gson()
private val allowedDays = setOf(
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"
)
private val allowedBlocks = setOf("MORNING", "AFTERNOON", "NIGHT")

@Serializable
data class DeliveryAvailabilitySlotPayload(
    val dayOfWeek: String,
    val mode: String,
    val block: String? = null,
    val start: String? = null,
    val end: String? = null
)

@Serializable
data class DeliveryAvailabilityPayload(
    val timezone: String = "UTC",
    val slots: List<DeliveryAvailabilitySlotPayload> = emptyList()
)

fun Application.deliveryAvailabilityRoutes() {
    routing {
        route("/delivery/profile/availability") {
            get {
                val userKey = call.authorizationKey() ?: return@get
                val payload = availabilityStore[userKey] ?: DeliveryAvailabilityPayload()
                call.respondText(
                    text = gson.toJson(payload),
                    contentType = ContentType.Application.Json
                )
            }
            put {
                val userKey = call.authorizationKey() ?: return@put
                val rawBody = call.receiveText()
                val payload = runCatching {
                    gson.fromJson(rawBody, DeliveryAvailabilityPayload::class.java)
                }.getOrNull()
                if (payload == null) {
                    call.respond(HttpStatusCode.BadRequest, "Payload inválido")
                    return@put
                }
                val validationErrors = payload.validate()
                if (validationErrors.isNotEmpty()) {
                    call.respond(HttpStatusCode.BadRequest, validationErrors.joinToString("; "))
                    return@put
                }
                val normalized = payload.normalized()
                availabilityStore[userKey] = normalized
                call.respondText(
                    text = gson.toJson(normalized),
                    contentType = ContentType.Application.Json
                )
            }
        }
    }
}

private fun DeliveryAvailabilityPayload.validate(): List<String> {
    val errors = mutableListOf<String>()
    if (timezone.isBlank()) {
        errors.add("timezone requerido")
    }
    if (slots.isEmpty()) {
        errors.add("al menos un día debe estar activo")
    }
    slots.forEach { slot ->
        val dayName = slot.dayOfWeek.lowercase()
        if (!allowedDays.contains(dayName)) {
            errors.add("día inválido: ${slot.dayOfWeek}")
        }
        val mode = slot.mode.uppercase()
        if (mode != "BLOCK" && mode != "CUSTOM") {
            errors.add("modo inválido para ${slot.dayOfWeek}")
        }
        if (mode == "BLOCK" && slot.block?.uppercase() !in allowedBlocks) {
            errors.add("bloque inválido para ${slot.dayOfWeek}")
        }
        if (mode == "CUSTOM") {
            if (slot.start.isNullOrBlank() || slot.end.isNullOrBlank()) {
                errors.add("rangos incompletos para ${slot.dayOfWeek}")
            }
        }
        val startMinutes = slot.resolveStartMinutes()
        val endMinutes = slot.resolveEndMinutes()
        if (startMinutes != null && endMinutes != null && endMinutes <= startMinutes) {
            errors.add("fin debe ser mayor al inicio para ${slot.dayOfWeek}")
        }
    }
    return errors
}

private fun DeliveryAvailabilitySlotPayload.resolveStartMinutes(): Int? = when {
    mode.uppercase() == "BLOCK" -> block.toDefaultRange()?.first
    else -> start.toMinutes()
}

private fun DeliveryAvailabilitySlotPayload.resolveEndMinutes(): Int? = when {
    mode.uppercase() == "BLOCK" -> block.toDefaultRange()?.second
    else -> end.toMinutes()
}

private fun DeliveryAvailabilityPayload.normalized(): DeliveryAvailabilityPayload = copy(
    timezone = timezone.trim(),
    slots = slots.map { slot ->
        slot.copy(
            dayOfWeek = slot.dayOfWeek.lowercase(),
            mode = slot.mode.uppercase(),
            block = slot.block?.uppercase(),
            start = slot.start,
            end = slot.end
        )
    }
)

private fun String?.toMinutes(): Int? {
    val value = this ?: return null
    val parts = value.split(":")
    if (parts.size != 2) return null
    val hours = parts[0].toIntOrNull() ?: return null
    val minutes = parts[1].toIntOrNull() ?: return null
    return hours * 60 + minutes
}

private fun String?.toDefaultRange(): Pair<Int, Int>? = when (this?.uppercase()) {
    "MORNING" -> 6 * 60 to 12 * 60
    "AFTERNOON" -> 12 * 60 to 18 * 60
    "NIGHT" -> 18 * 60 to 23 * 60
    else -> null
}

suspend fun ApplicationCall.authorizationKey(): String? {
    val token = request.headers[HttpHeaders.Authorization]?.removePrefix("Bearer ")?.trim()
    if (token.isNullOrBlank()) {
        respond(HttpStatusCode.Unauthorized, "Token Bearer requerido")
        return null
    }
    return token
}
