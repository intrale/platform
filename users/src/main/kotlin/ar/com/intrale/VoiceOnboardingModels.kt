package ar.com.intrale

import com.google.gson.annotations.SerializedName

/**
 * Pasos del onboarding guiado por voz.
 * El flujo secuencial es: BUSINESS_TYPE → PRODUCTS → SCHEDULES → CONFIRM
 */
enum class OnboardingStep {
    /** Paso 1: tipo de negocio, nombre, descripcion, direccion, telefono */
    BUSINESS_TYPE,
    /** Paso 2: categorias y productos principales */
    PRODUCTS,
    /** Paso 3: horarios de atencion */
    SCHEDULES,
    /** Paso 4: confirmacion final — persiste todas las entidades */
    CONFIRM
}

/**
 * Request que envia la app con el texto transcrito de la voz del usuario.
 */
data class VoiceOnboardingRequest(
    /** Texto transcrito del audio del usuario */
    val transcript: String = "",
    /** Paso actual del onboarding */
    val step: OnboardingStep = OnboardingStep.BUSINESS_TYPE,
    /** Contexto acumulado de pasos anteriores (JSON serializado) */
    @SerializedName("accumulated_context")
    val accumulatedContext: AccumulatedOnboardingContext? = null
)

/**
 * Contexto acumulativo que se va construyendo paso a paso.
 * Cada respuesta exitosa del backend devuelve el contexto actualizado
 * y la app lo reenvía en el siguiente paso.
 */
data class AccumulatedOnboardingContext(
    @SerializedName("business_name")
    val businessName: String? = null,
    @SerializedName("business_description")
    val businessDescription: String? = null,
    @SerializedName("business_category")
    val businessCategory: String? = null,
    val address: String? = null,
    val phone: String? = null,
    val categories: List<ExtractedCategory> = emptyList(),
    val products: List<ExtractedProduct> = emptyList(),
    val schedules: List<ExtractedSchedule> = emptyList()
)

/**
 * Categoria extraida por Claude del texto transcrito.
 */
data class ExtractedCategory(
    val name: String = "",
    val description: String? = null
)

/**
 * Producto extraido por Claude del texto transcrito.
 */
data class ExtractedProduct(
    val name: String = "",
    @SerializedName("short_description")
    val shortDescription: String? = null,
    @SerializedName("base_price")
    val basePrice: Double = 0.0,
    val unit: String = "unidad",
    val category: String? = null
)

/**
 * Horario extraido por Claude del texto transcrito.
 */
data class ExtractedSchedule(
    val day: String = "",
    @SerializedName("is_open")
    val isOpen: Boolean = true,
    @SerializedName("open_time")
    val openTime: String = "09:00",
    @SerializedName("close_time")
    val closeTime: String = "18:00"
)

/**
 * Respuesta del agente IA para un paso del onboarding.
 * Contiene el mensaje conversacional + las entidades extraidas + el contexto actualizado.
 */
data class OnboardingStepResult(
    /** Mensaje conversacional del asistente para mostrar al usuario */
    val message: String = "",
    /** Siguiente paso sugerido */
    @SerializedName("next_step")
    val nextStep: OnboardingStep? = null,
    /** Contexto acumulado actualizado */
    @SerializedName("accumulated_context")
    val accumulatedContext: AccumulatedOnboardingContext = AccumulatedOnboardingContext(),
    /** Confianza de la interpretacion (0.0-1.0) */
    val confidence: Double = 0.0,
    /** Si necesita que el usuario repita o aclare */
    @SerializedName("needs_clarification")
    val needsClarification: Boolean = false
)

/**
 * Resultado de la confirmacion final: entidades creadas.
 */
data class OnboardingConfirmResult(
    @SerializedName("categories_created")
    val categoriesCreated: Int = 0,
    @SerializedName("products_created")
    val productsCreated: Int = 0,
    @SerializedName("schedules_saved")
    val schedulesSaved: Boolean = false,
    @SerializedName("business_updated")
    val businessUpdated: Boolean = false
)
