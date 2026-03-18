package ui.sc.business

import asdo.business.ToDoCreateBanner
import asdo.business.ToDoUpdateBanner
import ar.com.intrale.shared.business.BannerDTO
import ar.com.intrale.shared.business.BannerRequest
import kotlinx.coroutines.test.runTest
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend
import ui.session.SessionStore
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private val testLoggerFactory = LoggerFactory(listOf(simplePrintFrontend))

private val sampleBanner = BannerDTO(
    id = "b-1",
    businessId = "biz-1",
    title = "Envio gratis",
    text = "Por compras mayores a $5000",
    imageUrl = "https://cdn.example.com/envio.png",
    position = "home",
    active = true
)

// ── Fakes ────────────────────────────────────────────────────────────────────

private class FakeCreateBanner(
    private val result: Result<BannerDTO>
) : ToDoCreateBanner {
    var called = false
        private set
    var lastRequest: BannerRequest? = null
        private set

    override suspend fun execute(
        businessId: String,
        request: BannerRequest
    ): Result<BannerDTO> {
        called = true
        lastRequest = request
        return result
    }
}

private class FakeUpdateBanner(
    private val result: Result<BannerDTO>
) : ToDoUpdateBanner {
    var called = false
        private set
    var lastBannerId: String? = null
        private set
    var lastRequest: BannerRequest? = null
        private set

    override suspend fun execute(
        businessId: String,
        bannerId: String,
        request: BannerRequest
    ): Result<BannerDTO> {
        called = true
        lastBannerId = bannerId
        lastRequest = request
        return result
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

class BannerFormViewModelTest {

    @BeforeTest
    fun setup() {
        SessionStore.clear()
    }

    @Test
    fun `saveBanner crea banner nuevo exitosamente`() = runTest {
        val fakeCreate = FakeCreateBanner(Result.success(sampleBanner))
        val vm = BannerFormViewModel(
            toDoCreateBanner = fakeCreate,
            toDoUpdateBanner = FakeUpdateBanner(Result.success(sampleBanner)),
            loggerFactory = testLoggerFactory
        )

        vm.updateTitle("Envio gratis")
        vm.updateText("Por compras mayores a \$5000")
        vm.updateImageUrl("https://cdn.example.com/envio.png")
        vm.updatePosition("home")
        val result = vm.saveBanner("biz-1")

        assertTrue(result.isSuccess)
        assertTrue(fakeCreate.called)
        assertEquals(BannerFormStatus.Saved, vm.state.status)
        assertEquals("Envio gratis", vm.state.title)
    }

    @Test
    fun `saveBanner actualiza banner existente`() = runTest {
        val updatedBanner = sampleBanner.copy(title = "Promo actualizada")
        val fakeUpdate = FakeUpdateBanner(Result.success(updatedBanner))
        val vm = BannerFormViewModel(
            toDoCreateBanner = FakeCreateBanner(Result.success(sampleBanner)),
            toDoUpdateBanner = fakeUpdate,
            loggerFactory = testLoggerFactory
        )

        vm.loadDraft(BannerDraft(
            id = "b-1",
            title = "Envio gratis",
            text = "Texto original",
            imageUrl = "https://cdn.example.com/envio.png",
            position = "home",
            active = true
        ))
        vm.updateTitle("Promo actualizada")
        val result = vm.saveBanner("biz-1")

        assertTrue(result.isSuccess)
        assertTrue(fakeUpdate.called)
        assertEquals("b-1", fakeUpdate.lastBannerId)
        assertEquals(BannerFormStatus.Saved, vm.state.status)
        assertEquals("Promo actualizada", vm.state.title)
    }

    @Test
    fun `saveBanner sin businessId falla con MissingBusiness`() = runTest {
        val vm = BannerFormViewModel(
            toDoCreateBanner = FakeCreateBanner(Result.success(sampleBanner)),
            toDoUpdateBanner = FakeUpdateBanner(Result.success(sampleBanner)),
            loggerFactory = testLoggerFactory
        )

        val result = vm.saveBanner(null)

        assertTrue(result.isFailure)
        assertEquals(BannerFormStatus.MissingBusiness, vm.state.status)
    }

    @Test
    fun `saveBanner con businessId vacio falla`() = runTest {
        val vm = BannerFormViewModel(
            toDoCreateBanner = FakeCreateBanner(Result.success(sampleBanner)),
            toDoUpdateBanner = FakeUpdateBanner(Result.success(sampleBanner)),
            loggerFactory = testLoggerFactory
        )

        val result = vm.saveBanner("")

        assertTrue(result.isFailure)
        assertEquals(BannerFormStatus.MissingBusiness, vm.state.status)
    }

    @Test
    fun `saveBanner con titulo vacio falla validacion`() = runTest {
        val fakeCreate = FakeCreateBanner(Result.success(sampleBanner))
        val vm = BannerFormViewModel(
            toDoCreateBanner = fakeCreate,
            toDoUpdateBanner = FakeUpdateBanner(Result.success(sampleBanner)),
            loggerFactory = testLoggerFactory
        )

        // titulo queda vacio por defecto
        val result = vm.saveBanner("biz-1")

        assertTrue(result.isFailure)
        assertTrue(!fakeCreate.called)
    }

    @Test
    fun `saveBanner con error del servicio muestra Error`() = runTest {
        val vm = BannerFormViewModel(
            toDoCreateBanner = FakeCreateBanner(Result.failure(RuntimeException("server error"))),
            toDoUpdateBanner = FakeUpdateBanner(Result.success(sampleBanner)),
            loggerFactory = testLoggerFactory
        )

        vm.updateTitle("Banner test")
        val result = vm.saveBanner("biz-1")

        assertTrue(result.isFailure)
        assertTrue(vm.state.status is BannerFormStatus.Error)
    }

    @Test
    fun `loadDraft carga datos del draft al estado`() = runTest {
        val vm = BannerFormViewModel(
            toDoCreateBanner = FakeCreateBanner(Result.success(sampleBanner)),
            toDoUpdateBanner = FakeUpdateBanner(Result.success(sampleBanner)),
            loggerFactory = testLoggerFactory
        )

        vm.loadDraft(BannerDraft(
            id = "b-1",
            title = "Titulo draft",
            text = "Texto draft",
            imageUrl = "https://cdn.example.com/draft.png",
            position = "destacados",
            active = false
        ))

        assertEquals("b-1", vm.state.bannerId)
        assertEquals("Titulo draft", vm.state.title)
        assertEquals("Texto draft", vm.state.text)
        assertEquals("https://cdn.example.com/draft.png", vm.state.imageUrl)
        assertEquals("destacados", vm.state.position)
        assertEquals(false, vm.state.active)
        assertTrue(vm.state.isEditing)
    }

    @Test
    fun `loadDraft con null no cambia el estado`() = runTest {
        val vm = BannerFormViewModel(
            toDoCreateBanner = FakeCreateBanner(Result.success(sampleBanner)),
            toDoUpdateBanner = FakeUpdateBanner(Result.success(sampleBanner)),
            loggerFactory = testLoggerFactory
        )

        vm.loadDraft(null)

        assertEquals("", vm.state.title)
        assertEquals(false, vm.state.isEditing)
    }

    @Test
    fun `estado inicial tiene campos vacios`() = runTest {
        val vm = BannerFormViewModel(
            toDoCreateBanner = FakeCreateBanner(Result.success(sampleBanner)),
            toDoUpdateBanner = FakeUpdateBanner(Result.success(sampleBanner)),
            loggerFactory = testLoggerFactory
        )

        assertEquals("", vm.state.title)
        assertEquals("", vm.state.text)
        assertEquals("", vm.state.imageUrl)
        assertEquals("home", vm.state.position)
        assertTrue(vm.state.active)
        assertEquals(false, vm.state.isEditing)
        assertEquals(BannerFormStatus.Idle, vm.state.status)
    }

    @Test
    fun `updateTitle actualiza el campo title del estado`() = runTest {
        val vm = BannerFormViewModel(
            toDoCreateBanner = FakeCreateBanner(Result.success(sampleBanner)),
            toDoUpdateBanner = FakeUpdateBanner(Result.success(sampleBanner)),
            loggerFactory = testLoggerFactory
        )

        vm.updateTitle("Nuevo titulo")
        assertEquals("Nuevo titulo", vm.state.title)
    }

    @Test
    fun `updateText actualiza el campo text del estado`() = runTest {
        val vm = BannerFormViewModel(
            toDoCreateBanner = FakeCreateBanner(Result.success(sampleBanner)),
            toDoUpdateBanner = FakeUpdateBanner(Result.success(sampleBanner)),
            loggerFactory = testLoggerFactory
        )

        vm.updateText("Nuevo texto")
        assertEquals("Nuevo texto", vm.state.text)
    }

    @Test
    fun `updateImageUrl actualiza el campo imageUrl del estado`() = runTest {
        val vm = BannerFormViewModel(
            toDoCreateBanner = FakeCreateBanner(Result.success(sampleBanner)),
            toDoUpdateBanner = FakeUpdateBanner(Result.success(sampleBanner)),
            loggerFactory = testLoggerFactory
        )

        vm.updateImageUrl("https://new.url/img.png")
        assertEquals("https://new.url/img.png", vm.state.imageUrl)
    }

    @Test
    fun `updatePosition actualiza el campo position del estado`() = runTest {
        val vm = BannerFormViewModel(
            toDoCreateBanner = FakeCreateBanner(Result.success(sampleBanner)),
            toDoUpdateBanner = FakeUpdateBanner(Result.success(sampleBanner)),
            loggerFactory = testLoggerFactory
        )

        vm.updatePosition("destacados")
        assertEquals("destacados", vm.state.position)
    }

    @Test
    fun `updateActive actualiza el campo active del estado`() = runTest {
        val vm = BannerFormViewModel(
            toDoCreateBanner = FakeCreateBanner(Result.success(sampleBanner)),
            toDoUpdateBanner = FakeUpdateBanner(Result.success(sampleBanner)),
            loggerFactory = testLoggerFactory
        )

        vm.updateActive(false)
        assertEquals(false, vm.state.active)
    }
}
