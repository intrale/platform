package ar.com.intrale

import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class VoiceOnboardingServiceTest {

    // Service con API key vacia para testear sin llamadas reales
    private val service = ClaudeVoiceOnboardingService(apiKey = "")

    // --- Tests de buildSystemPrompt ---

    @Test
    fun `buildSystemPrompt incluye instrucciones del paso BUSINESS_TYPE`() {
        val prompt = service.buildSystemPrompt(OnboardingStep.BUSINESS_TYPE, null)
        assertTrue(prompt.contains("BUSINESS_TYPE"))
        assertTrue(prompt.contains("nombre del negocio"))
        assertTrue(prompt.contains("rubro"))
    }

    @Test
    fun `buildSystemPrompt incluye instrucciones del paso PRODUCTS`() {
        val prompt = service.buildSystemPrompt(OnboardingStep.PRODUCTS, null)
        assertTrue(prompt.contains("PRODUCTS"))
        assertTrue(prompt.contains("productos"))
        assertTrue(prompt.contains("precio"))
    }

    @Test
    fun `buildSystemPrompt incluye instrucciones del paso SCHEDULES`() {
        val prompt = service.buildSystemPrompt(OnboardingStep.SCHEDULES, null)
        assertTrue(prompt.contains("SCHEDULES"))
        assertTrue(prompt.contains("horarios"))
    }

    @Test
    fun `buildSystemPrompt incluye instrucciones del paso CONFIRM`() {
        val prompt = service.buildSystemPrompt(OnboardingStep.CONFIRM, null)
        assertTrue(prompt.contains("CONFIRM"))
        assertTrue(prompt.contains("confirme"))
    }

    @Test
    fun `buildSystemPrompt incluye contexto acumulado cuando existe`() {
        val ctx = AccumulatedOnboardingContext(
            businessName = "Mi Pizzeria",
            categories = listOf(ExtractedCategory(name = "Pizzas")),
            products = listOf(ExtractedProduct(name = "Muzzarella", basePrice = 500.0))
        )
        val prompt = service.buildSystemPrompt(OnboardingStep.PRODUCTS, ctx)
        assertTrue(prompt.contains("Mi Pizzeria"))
        assertTrue(prompt.contains("Pizzas"))
        assertTrue(prompt.contains("Muzzarella"))
    }

    @Test
    fun `buildSystemPrompt incluye horarios del contexto acumulado`() {
        val ctx = AccumulatedOnboardingContext(
            schedules = listOf(
                ExtractedSchedule(day = "Lunes", openTime = "09:00", closeTime = "18:00")
            )
        )
        val prompt = service.buildSystemPrompt(OnboardingStep.SCHEDULES, ctx)
        assertTrue(prompt.contains("Lunes"))
        assertTrue(prompt.contains("09:00"))
    }

    // --- Tests de parseOnboardingResponse ---

    @Test
    fun `parseOnboardingResponse parsea JSON valido con datos de negocio`() {
        val json = """{
            "message": "Entendi! Tenes una pizzeria.",
            "next_step": "PRODUCTS",
            "business_name": "La Pizzeria de Juan",
            "business_description": "Pizzeria artesanal",
            "business_category": "Gastronomia",
            "address": "Av. Corrientes 1234",
            "phone": "11-5555-1234",
            "confidence": 0.9,
            "needs_clarification": false
        }"""

        val result = service.parseOnboardingResponse(json, OnboardingStep.BUSINESS_TYPE, null)
        assertEquals("Entendi! Tenes una pizzeria.", result.message)
        assertEquals(OnboardingStep.PRODUCTS, result.nextStep)
        assertEquals("La Pizzeria de Juan", result.accumulatedContext.businessName)
        assertEquals("Pizzeria artesanal", result.accumulatedContext.businessDescription)
        assertEquals("Gastronomia", result.accumulatedContext.businessCategory)
        assertEquals("Av. Corrientes 1234", result.accumulatedContext.address)
        assertEquals("11-5555-1234", result.accumulatedContext.phone)
        assertEquals(0.9, result.confidence)
        assertFalse(result.needsClarification)
    }

    @Test
    fun `parseOnboardingResponse parsea JSON con productos y categorias`() {
        val json = """{
            "message": "Anote tus productos.",
            "next_step": "SCHEDULES",
            "categories": [
                {"name": "Pizzas", "description": "Pizzas artesanales"}
            ],
            "products": [
                {"name": "Muzzarella", "short_description": "Clasica", "base_price": 5000.0, "unit": "unidad", "category": "Pizzas"}
            ],
            "confidence": 0.85,
            "needs_clarification": false
        }"""

        val result = service.parseOnboardingResponse(json, OnboardingStep.PRODUCTS, null)
        assertEquals(1, result.accumulatedContext.categories.size)
        assertEquals("Pizzas", result.accumulatedContext.categories[0].name)
        assertEquals(1, result.accumulatedContext.products.size)
        assertEquals("Muzzarella", result.accumulatedContext.products[0].name)
        assertEquals(5000.0, result.accumulatedContext.products[0].basePrice)
    }

    @Test
    fun `parseOnboardingResponse acumula productos con contexto previo`() {
        val prevContext = AccumulatedOnboardingContext(
            businessName = "Mi Pizzeria",
            products = listOf(ExtractedProduct(name = "Muzzarella", basePrice = 5000.0))
        )

        val json = """{
            "message": "Agregue la fugazzeta.",
            "next_step": "SCHEDULES",
            "products": [
                {"name": "Fugazzeta", "base_price": 6000.0, "unit": "unidad"}
            ],
            "confidence": 0.9,
            "needs_clarification": false
        }"""

        val result = service.parseOnboardingResponse(json, OnboardingStep.PRODUCTS, prevContext)
        assertEquals(2, result.accumulatedContext.products.size)
        assertTrue(result.accumulatedContext.products.any { it.name == "Muzzarella" })
        assertTrue(result.accumulatedContext.products.any { it.name == "Fugazzeta" })
        assertEquals("Mi Pizzeria", result.accumulatedContext.businessName)
    }

    @Test
    fun `parseOnboardingResponse con horarios reemplaza los anteriores`() {
        val prevContext = AccumulatedOnboardingContext(
            schedules = listOf(ExtractedSchedule(day = "Lunes", isOpen = true))
        )

        val json = """{
            "message": "Actualice los horarios.",
            "schedules": [
                {"day": "Lunes", "is_open": true, "open_time": "09:00", "close_time": "18:00"},
                {"day": "Martes", "is_open": true, "open_time": "09:00", "close_time": "18:00"}
            ],
            "confidence": 0.85,
            "needs_clarification": false
        }"""

        val result = service.parseOnboardingResponse(json, OnboardingStep.SCHEDULES, prevContext)
        assertEquals(2, result.accumulatedContext.schedules.size)
    }

    @Test
    fun `parseOnboardingResponse con JSON envuelto en markdown`() {
        val text = """```json
        {"message": "Listo!", "confidence": 0.95, "needs_clarification": false}
        ```"""

        val result = service.parseOnboardingResponse(text, OnboardingStep.CONFIRM, null)
        assertEquals("Listo!", result.message)
        assertEquals(0.95, result.confidence)
    }

    @Test
    fun `parseOnboardingResponse con texto invalido retorna clarification`() {
        val result = service.parseOnboardingResponse(
            "esto no es json",
            OnboardingStep.BUSINESS_TYPE,
            null
        )
        assertTrue(result.needsClarification)
        assertEquals(0.0, result.confidence)
        assertEquals(OnboardingStep.BUSINESS_TYPE, result.nextStep)
    }

    @Test
    fun `parseOnboardingResponse con next_step invalido sugiere siguiente paso natural`() {
        val json = """{
            "message": "Datos registrados.",
            "next_step": "PASO_INVALIDO",
            "confidence": 0.8,
            "needs_clarification": false
        }"""

        val result = service.parseOnboardingResponse(json, OnboardingStep.BUSINESS_TYPE, null)
        assertEquals(OnboardingStep.PRODUCTS, result.nextStep)
    }

    @Test
    fun `parseOnboardingResponse desde SCHEDULES sugiere CONFIRM como siguiente`() {
        val json = """{
            "message": "Horarios registrados.",
            "next_step": "INVALIDO",
            "confidence": 0.8,
            "needs_clarification": false
        }"""

        val result = service.parseOnboardingResponse(json, OnboardingStep.SCHEDULES, null)
        assertEquals(OnboardingStep.CONFIRM, result.nextStep)
    }

    // --- Tests de processStep (sin API key) ---

    @Test
    fun `processStep sin API key retorna mensaje de servicio no disponible`() = runBlocking {
        val result = service.processStep("Tengo una pizzeria", OnboardingStep.BUSINESS_TYPE, null)
        assertTrue(result.needsClarification)
        assertTrue(result.message.contains("no esta disponible"))
    }
}
