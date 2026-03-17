package ui.sc.business

import asdo.business.ToDoGetBusinessConfig
import asdo.business.ToDoUpdateBusinessConfig
import ar.com.intrale.shared.business.BusinessConfigDTO
import ar.com.intrale.shared.business.UpdateBusinessConfigRequest
import kotlinx.coroutines.test.runTest
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend
import ui.session.SessionStore
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private val testLoggerFactory = LoggerFactory(listOf(simplePrintFrontend))

private val sampleConfig = BusinessConfigDTO(
    businessId = "biz-1",
    name = "Mi Negocio",
    address = "Av. Siempre Viva 742",
    phone = "+54 11 1234-5678",
    email = "contacto@minegocio.com",
    logoUrl = "https://example.com/logo.png"
)

// ── Fakes ────────────────────────────────────────────────────────────────────

private class FakeGetBusinessConfig(
    private val result: Result<BusinessConfigDTO>
) : ToDoGetBusinessConfig {
    var called = false
        private set

    override suspend fun execute(businessId: String): Result<BusinessConfigDTO> {
        called = true
        return result
    }
}

private class FakeUpdateBusinessConfig(
    private val result: Result<BusinessConfigDTO>
) : ToDoUpdateBusinessConfig {
    var called = false
        private set
    var lastRequest: UpdateBusinessConfigRequest? = null
        private set

    override suspend fun execute(
        businessId: String,
        request: UpdateBusinessConfigRequest
    ): Result<BusinessConfigDTO> {
        called = true
        lastRequest = request
        return result
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

class BusinessConfigViewModelTest {

    @BeforeTest
    fun setup() {
        SessionStore.clear()
    }

    @Test
    fun `loadConfig exitoso carga datos del negocio`() = runTest {
        val vm = BusinessConfigViewModel(
            toDoGetBusinessConfig = FakeGetBusinessConfig(Result.success(sampleConfig)),
            toDoUpdateBusinessConfig = FakeUpdateBusinessConfig(Result.success(sampleConfig)),
            loggerFactory = testLoggerFactory
        )

        vm.loadConfig("biz-1")

        assertEquals("Mi Negocio", vm.state.name)
        assertEquals("Av. Siempre Viva 742", vm.state.address)
        assertEquals("+54 11 1234-5678", vm.state.phone)
        assertEquals("contacto@minegocio.com", vm.state.email)
        assertEquals("https://example.com/logo.png", vm.state.logoUrl)
        assertEquals(BusinessConfigStatus.Loaded, vm.state.status)
    }

    @Test
    fun `loadConfig sin businessId muestra MissingBusiness`() = runTest {
        val vm = BusinessConfigViewModel(
            toDoGetBusinessConfig = FakeGetBusinessConfig(Result.success(sampleConfig)),
            toDoUpdateBusinessConfig = FakeUpdateBusinessConfig(Result.success(sampleConfig)),
            loggerFactory = testLoggerFactory
        )

        vm.loadConfig(null)

        assertEquals(BusinessConfigStatus.MissingBusiness, vm.state.status)
    }

    @Test
    fun `loadConfig con businessId vacio muestra MissingBusiness`() = runTest {
        val vm = BusinessConfigViewModel(
            toDoGetBusinessConfig = FakeGetBusinessConfig(Result.success(sampleConfig)),
            toDoUpdateBusinessConfig = FakeUpdateBusinessConfig(Result.success(sampleConfig)),
            loggerFactory = testLoggerFactory
        )

        vm.loadConfig("")

        assertEquals(BusinessConfigStatus.MissingBusiness, vm.state.status)
    }

    @Test
    fun `loadConfig con error muestra estado Error`() = runTest {
        val vm = BusinessConfigViewModel(
            toDoGetBusinessConfig = FakeGetBusinessConfig(Result.failure(RuntimeException("network error"))),
            toDoUpdateBusinessConfig = FakeUpdateBusinessConfig(Result.success(sampleConfig)),
            loggerFactory = testLoggerFactory
        )

        vm.loadConfig("biz-1")

        assertTrue(vm.state.status is BusinessConfigStatus.Error)
        assertTrue((vm.state.status as BusinessConfigStatus.Error).message.contains("network error"))
    }

    @Test
    fun `saveConfig exitoso actualiza estado a Saved`() = runTest {
        val updatedConfig = sampleConfig.copy(name = "Nuevo Nombre")
        val fakeUpdate = FakeUpdateBusinessConfig(Result.success(updatedConfig))
        val vm = BusinessConfigViewModel(
            toDoGetBusinessConfig = FakeGetBusinessConfig(Result.success(sampleConfig)),
            toDoUpdateBusinessConfig = fakeUpdate,
            loggerFactory = testLoggerFactory
        )

        vm.loadConfig("biz-1")
        vm.updateName("Nuevo Nombre")
        val result = vm.saveConfig("biz-1")

        assertTrue(result.isSuccess)
        assertTrue(fakeUpdate.called)
        assertEquals("Nuevo Nombre", vm.state.name)
        assertEquals(BusinessConfigStatus.Saved, vm.state.status)
    }

    @Test
    fun `saveConfig sin businessId falla`() = runTest {
        val vm = BusinessConfigViewModel(
            toDoGetBusinessConfig = FakeGetBusinessConfig(Result.success(sampleConfig)),
            toDoUpdateBusinessConfig = FakeUpdateBusinessConfig(Result.success(sampleConfig)),
            loggerFactory = testLoggerFactory
        )

        val result = vm.saveConfig(null)

        assertTrue(result.isFailure)
        assertEquals(BusinessConfigStatus.MissingBusiness, vm.state.status)
    }

    @Test
    fun `saveConfig con nombre vacio falla validacion`() = runTest {
        val fakeUpdate = FakeUpdateBusinessConfig(Result.success(sampleConfig))
        val vm = BusinessConfigViewModel(
            toDoGetBusinessConfig = FakeGetBusinessConfig(Result.success(sampleConfig)),
            toDoUpdateBusinessConfig = fakeUpdate,
            loggerFactory = testLoggerFactory
        )

        // name queda vacio por defecto
        val result = vm.saveConfig("biz-1")

        assertTrue(result.isFailure)
        assertTrue(!fakeUpdate.called)
    }

    @Test
    fun `saveConfig con error del servicio muestra Error`() = runTest {
        val vm = BusinessConfigViewModel(
            toDoGetBusinessConfig = FakeGetBusinessConfig(Result.success(sampleConfig)),
            toDoUpdateBusinessConfig = FakeUpdateBusinessConfig(
                Result.failure(RuntimeException("server error"))
            ),
            loggerFactory = testLoggerFactory
        )

        vm.loadConfig("biz-1")
        val result = vm.saveConfig("biz-1")

        assertTrue(result.isFailure)
        assertTrue(vm.state.status is BusinessConfigStatus.Error)
    }

    @Test
    fun `updateName actualiza el campo name del estado`() = runTest {
        val vm = BusinessConfigViewModel(
            toDoGetBusinessConfig = FakeGetBusinessConfig(Result.success(sampleConfig)),
            toDoUpdateBusinessConfig = FakeUpdateBusinessConfig(Result.success(sampleConfig)),
            loggerFactory = testLoggerFactory
        )

        vm.updateName("Nombre Nuevo")

        assertEquals("Nombre Nuevo", vm.state.name)
    }

    @Test
    fun `updateAddress actualiza el campo address del estado`() = runTest {
        val vm = BusinessConfigViewModel(
            toDoGetBusinessConfig = FakeGetBusinessConfig(Result.success(sampleConfig)),
            toDoUpdateBusinessConfig = FakeUpdateBusinessConfig(Result.success(sampleConfig)),
            loggerFactory = testLoggerFactory
        )

        vm.updateAddress("Calle Nueva 123")

        assertEquals("Calle Nueva 123", vm.state.address)
    }

    @Test
    fun `updatePhone actualiza el campo phone del estado`() = runTest {
        val vm = BusinessConfigViewModel(
            toDoGetBusinessConfig = FakeGetBusinessConfig(Result.success(sampleConfig)),
            toDoUpdateBusinessConfig = FakeUpdateBusinessConfig(Result.success(sampleConfig)),
            loggerFactory = testLoggerFactory
        )

        vm.updatePhone("+54 11 9999-0000")

        assertEquals("+54 11 9999-0000", vm.state.phone)
    }

    @Test
    fun `updateEmail actualiza el campo email del estado`() = runTest {
        val vm = BusinessConfigViewModel(
            toDoGetBusinessConfig = FakeGetBusinessConfig(Result.success(sampleConfig)),
            toDoUpdateBusinessConfig = FakeUpdateBusinessConfig(Result.success(sampleConfig)),
            loggerFactory = testLoggerFactory
        )

        vm.updateEmail("nuevo@email.com")

        assertEquals("nuevo@email.com", vm.state.email)
    }

    @Test
    fun `updateLogoUrl actualiza el campo logoUrl del estado`() = runTest {
        val vm = BusinessConfigViewModel(
            toDoGetBusinessConfig = FakeGetBusinessConfig(Result.success(sampleConfig)),
            toDoUpdateBusinessConfig = FakeUpdateBusinessConfig(Result.success(sampleConfig)),
            loggerFactory = testLoggerFactory
        )

        vm.updateLogoUrl("https://cdn.example.com/new-logo.png")

        assertEquals("https://cdn.example.com/new-logo.png", vm.state.logoUrl)
    }

    @Test
    fun `saveConfig envia request con datos actuales del estado`() = runTest {
        val fakeUpdate = FakeUpdateBusinessConfig(Result.success(sampleConfig))
        val vm = BusinessConfigViewModel(
            toDoGetBusinessConfig = FakeGetBusinessConfig(Result.success(sampleConfig)),
            toDoUpdateBusinessConfig = fakeUpdate,
            loggerFactory = testLoggerFactory
        )

        vm.loadConfig("biz-1")
        vm.updateName("Negocio Actualizado")
        vm.updateAddress("Calle 456")
        vm.updatePhone("+1 555 0000")
        vm.updateEmail("new@test.com")
        vm.updateLogoUrl("https://logo.new")
        vm.saveConfig("biz-1")

        assertTrue(fakeUpdate.called)
        val req = fakeUpdate.lastRequest!!
        assertEquals("Negocio Actualizado", req.name)
        assertEquals("Calle 456", req.address)
        assertEquals("+1 555 0000", req.phone)
        assertEquals("new@test.com", req.email)
        assertEquals("https://logo.new", req.logoUrl)
    }
}
