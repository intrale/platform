package ar.com.intrale.shared.business

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Pasos del onboarding guiado por voz.
 */
@Serializable
enum class OnboardingStepDTO {
    BUSINESS_TYPE,
    PRODUCTS,
    SCHEDULES,
    CONFIRM
}

/**
 * Categoria extraida por el asistente del texto transcrito.
 */
@Serializable
data class ExtractedCategoryDTO(
    val name: String = "",
    val description: String? = null
)

/**
 * Producto extraido por el asistente del texto transcrito.
 */
@Serializable
data class ExtractedProductDTO(
    val name: String = "",
    @SerialName("short_description")
    val shortDescription: String? = null,
    @SerialName("base_price")
    val basePrice: Double = 0.0,
    val unit: String = "unidad",
    val category: String? = null
)

/**
 * Horario extraido por el asistente del texto transcrito.
 */
@Serializable
data class ExtractedScheduleDTO(
    val day: String = "",
    @SerialName("is_open")
    val isOpen: Boolean = true,
    @SerialName("open_time")
    val openTime: String = "09:00",
    @SerialName("close_time")
    val closeTime: String = "18:00"
)

/**
 * Contexto acumulado del onboarding paso a paso.
 */
@Serializable
data class AccumulatedOnboardingContextDTO(
    @SerialName("business_name")
    val businessName: String? = null,
    @SerialName("business_description")
    val businessDescription: String? = null,
    @SerialName("business_category")
    val businessCategory: String? = null,
    val address: String? = null,
    val phone: String? = null,
    val categories: List<ExtractedCategoryDTO> = emptyList(),
    val products: List<ExtractedProductDTO> = emptyList(),
    val schedules: List<ExtractedScheduleDTO> = emptyList()
)

/**
 * Request para un paso del onboarding por voz.
 */
@Serializable
data class VoiceOnboardingRequestDTO(
    val transcript: String = "",
    val step: OnboardingStepDTO = OnboardingStepDTO.BUSINESS_TYPE,
    @SerialName("accumulated_context")
    val accumulatedContext: AccumulatedOnboardingContextDTO? = null
)

/**
 * Respuesta de un paso del onboarding por voz.
 */
@Serializable
data class VoiceOnboardingResponseDTO(
    val statusCode: StatusCodeDTO? = null,
    val step: String = "",
    val message: String = "",
    val nextStep: String? = null,
    val accumulatedContext: AccumulatedOnboardingContextDTO = AccumulatedOnboardingContextDTO(),
    val confidence: Double = 0.0,
    val needsClarification: Boolean = false
)

/**
 * Respuesta de la confirmacion final del onboarding.
 */
@Serializable
data class VoiceOnboardingConfirmResponseDTO(
    val statusCode: StatusCodeDTO? = null,
    val message: String = "",
    val categoriesCreated: Int = 0,
    val productsCreated: Int = 0,
    val schedulesSaved: Boolean = false,
    val businessUpdated: Boolean = false
)
