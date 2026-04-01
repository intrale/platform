package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import com.google.gson.Gson
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import org.slf4j.LoggerFactory
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

/**
 * Respuesta exitosa de un paso del onboarding por voz.
 */
class VoiceOnboardingResponse(
    val statusCode_value: Map<String, Any> = mapOf("value" to 200, "description" to "OK"),
    val step: String = "",
    val message: String = "",
    val nextStep: String? = null,
    val accumulatedContext: AccumulatedOnboardingContext = AccumulatedOnboardingContext(),
    val confidence: Double = 0.0,
    val needsClarification: Boolean = false,
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

/**
 * Respuesta de la confirmacion final del onboarding.
 */
class VoiceOnboardingConfirmResponse(
    val statusCode_value: Map<String, Any> = mapOf("value" to 201, "description" to "Created"),
    val message: String = "",
    val categoriesCreated: Int = 0,
    val productsCreated: Int = 0,
    val schedulesSaved: Boolean = false,
    val businessUpdated: Boolean = false,
    status: HttpStatusCode = HttpStatusCode.Created
) : Response(statusCode = status)

/**
 * Endpoint segurizado para el onboarding guiado por voz.
 * Solo BUSINESS_ADMIN puede usar este endpoint.
 *
 * Ruta: POST /{business}/business/voice-onboarding
 *
 * Flujo:
 * 1. App transcribe audio del usuario
 * 2. Envia transcript + step + accumulatedContext
 * 3. Backend interpreta con Claude y devuelve entidades estructuradas
 * 4. App muestra para confirmacion
 * 5. Cuando step=CONFIRM y el usuario confirma, se persisten las entidades
 */
class VoiceOnboardingFunction(
    override val config: UsersConfig,
    override val logger: Logger,
    private val cognito: CognitoIdentityProviderClient,
    private val tableProfiles: DynamoDbTable<UserBusinessProfile>,
    private val tableBusiness: DynamoDbTable<Business>,
    private val productRepository: ProductRepository,
    private val categoryRepository: CategoryRepository,
    private val voiceOnboardingService: VoiceOnboardingService,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config = config, logger = logger, jwtValidator = jwtValidator) {

    private val gson = Gson()

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.debug("Iniciando voice-onboarding para negocio=$business")

        // Solo BUSINESS_ADMIN puede hacer onboarding
        requireApprovedProfile(
            cognito, headers, tableProfiles, business, PROFILE_BUSINESS_ADMIN
        ) ?: return UnauthorizedException()

        // Parsear request
        val request = parseBody<VoiceOnboardingRequest>(textBody)
            ?: return RequestValidationException("Request body no encontrado")

        if (request.transcript.isBlank()) {
            return RequestValidationException("El texto transcrito no puede estar vacio")
        }

        if (request.transcript.length > 2000) {
            return RequestValidationException("El texto transcrito no puede superar los 2000 caracteres")
        }

        // Si es paso CONFIRM con texto afirmativo, persistir entidades
        if (request.step == OnboardingStep.CONFIRM && isConfirmation(request.transcript)) {
            return handleConfirmation(business, request.accumulatedContext)
        }

        // Procesar paso con IA
        return try {
            val result = voiceOnboardingService.processStep(
                transcript = request.transcript,
                step = request.step,
                accumulatedContext = request.accumulatedContext
            )

            logger.debug("Onboarding step=${request.step} procesado para negocio=$business (confidence=${result.confidence})")

            VoiceOnboardingResponse(
                step = request.step.name,
                message = result.message,
                nextStep = result.nextStep?.name,
                accumulatedContext = result.accumulatedContext,
                confidence = result.confidence,
                needsClarification = result.needsClarification
            )
        } catch (e: Exception) {
            logger.error("Error en voice-onboarding para negocio=$business", e)
            ExceptionResponse(
                "Error procesando la solicitud de onboarding",
                HttpStatusCode.InternalServerError
            )
        }
    }

    /**
     * Persiste todas las entidades acumuladas durante el onboarding.
     */
    internal fun handleConfirmation(
        business: String,
        context: AccumulatedOnboardingContext?
    ): Response {
        if (context == null) {
            return RequestValidationException("No hay contexto acumulado para confirmar")
        }

        logger.info("Confirmando onboarding para negocio=$business")

        var categoriesCreated = 0
        var productsCreated = 0
        var schedulesSaved = false
        var businessUpdated = false

        try {
            // 1. Actualizar datos del negocio (descripcion, direccion, telefono)
            val businessKey = Business().apply { name = business }
            val businessEntity = tableBusiness.getItem(businessKey)
            if (businessEntity != null) {
                var changed = false
                context.businessDescription?.let {
                    businessEntity.description = it
                    changed = true
                }
                context.address?.let {
                    businessEntity.address = it
                    changed = true
                }
                context.phone?.let {
                    businessEntity.phone = it
                    changed = true
                }

                // Guardar horarios como JSON
                if (context.schedules.isNotEmpty()) {
                    val scheduleRecords = context.schedules.map { s ->
                        DayScheduleRecord(
                            day = s.day,
                            isOpen = s.isOpen,
                            openTime = s.openTime,
                            closeTime = s.closeTime
                        )
                    }
                    businessEntity.schedulesJson = gson.toJson(scheduleRecords)
                    changed = true
                    schedulesSaved = true
                }

                if (changed) {
                    tableBusiness.updateItem(businessEntity)
                    businessUpdated = true
                }
            }

            // 2. Crear categorias y mapear IDs
            val categoryIdMap = mutableMapOf<String, String>() // nombre -> id
            for (cat in context.categories) {
                if (cat.name.isBlank()) continue
                val record = CategoryRecord(name = cat.name, description = cat.description)
                val saved = categoryRepository.saveCategory(business, record)
                categoryIdMap[cat.name.lowercase()] = saved.id
                categoriesCreated++
            }

            // 3. Crear productos vinculados a categorias
            for (prod in context.products) {
                if (prod.name.isBlank()) continue
                val categoryId = prod.category?.lowercase()?.let { categoryIdMap[it] } ?: ""
                val record = ProductRecord(
                    name = prod.name,
                    shortDescription = prod.shortDescription,
                    basePrice = prod.basePrice,
                    unit = prod.unit.ifBlank { "unidad" },
                    categoryId = categoryId,
                    status = "DRAFT",
                    isAvailable = true
                )
                productRepository.saveProduct(business, record)
                productsCreated++
            }

            logger.info(
                "Onboarding completado para negocio=$business: " +
                    "$categoriesCreated categorias, $productsCreated productos, " +
                    "horarios=${schedulesSaved}, negocio_actualizado=${businessUpdated}"
            )

            return VoiceOnboardingConfirmResponse(
                message = "Listo! Tu negocio fue configurado exitosamente. " +
                    "Se crearon $categoriesCreated categorias y $productsCreated productos.",
                categoriesCreated = categoriesCreated,
                productsCreated = productsCreated,
                schedulesSaved = schedulesSaved,
                businessUpdated = businessUpdated
            )
        } catch (e: Exception) {
            logger.error("Error persistiendo entidades de onboarding para negocio=$business", e)
            return ExceptionResponse(
                "Error guardando los datos del negocio: ${e.message}",
                HttpStatusCode.InternalServerError
            )
        }
    }

    /**
     * Detecta si el texto del usuario es una confirmacion afirmativa.
     */
    internal fun isConfirmation(text: String): Boolean {
        val affirmativePatterns = listOf(
            "si", "sí", "confirmo", "dale", "ok", "listo", "perfecto",
            "esta bien", "está bien", "de acuerdo", "confirmar", "todo bien",
            "yes", "correcto", "genial", "adelante"
        )
        val normalized = text.trim().lowercase()
        return affirmativePatterns.any { normalized.contains(it) }
    }
}
