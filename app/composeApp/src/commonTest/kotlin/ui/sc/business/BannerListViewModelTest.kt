package ui.sc.business

import asdo.business.ToDoListBanners
import asdo.business.ToDoToggleBanner
import ar.com.intrale.shared.business.BannerDTO
import kotlinx.coroutines.test.runTest
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend
import ui.session.SessionStore
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private val testLoggerFactory = LoggerFactory(listOf(simplePrintFrontend))

private val sampleBanners = listOf(
    BannerDTO(
        id = "b-1",
        businessId = "biz-1",
        title = "Envio gratis",
        text = "Por compras mayores a $5000",
        imageUrl = "https://cdn.example.com/envio.png",
        position = "home",
        active = true
    ),
    BannerDTO(
        id = "b-2",
        businessId = "biz-1",
        title = "2x1 en lacteos",
        text = "Solo esta semana",
        imageUrl = "https://cdn.example.com/promo.png",
        position = "destacados",
        active = false
    )
)

// ── Fakes ────────────────────────────────────────────────────────────────────

private class FakeListBanners(
    private val result: Result<List<BannerDTO>>
) : ToDoListBanners {
    var called = false
        private set

    override suspend fun execute(businessId: String): Result<List<BannerDTO>> {
        called = true
        return result
    }
}

private class FakeToggleBanner(
    private val result: Result<BannerDTO>
) : ToDoToggleBanner {
    var called = false
        private set
    var lastBannerId: String? = null
        private set
    var lastActive: Boolean? = null
        private set

    override suspend fun execute(
        businessId: String,
        bannerId: String,
        active: Boolean
    ): Result<BannerDTO> {
        called = true
        lastBannerId = bannerId
        lastActive = active
        return result
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

class BannerListViewModelTest {

    @BeforeTest
    fun setup() {
        SessionStore.clear()
    }

    @Test
    fun `loadBanners exitoso carga lista de banners`() = runTest {
        val vm = BannerListViewModel(
            listBanners = FakeListBanners(Result.success(sampleBanners)),
            toggleBanner = FakeToggleBanner(Result.success(sampleBanners[0])),
            loggerFactory = testLoggerFactory
        )

        vm.loadBanners("biz-1")

        assertEquals(BannerListStatus.Loaded, vm.state.status)
        assertEquals(2, vm.state.items.size)
        assertEquals("Envio gratis", vm.state.items[0].title)
        assertEquals("2x1 en lacteos", vm.state.items[1].title)
        assertTrue(vm.state.items[0].active)
        assertTrue(!vm.state.items[1].active)
    }

    @Test
    fun `loadBanners sin businessId muestra MissingBusiness`() = runTest {
        val vm = BannerListViewModel(
            listBanners = FakeListBanners(Result.success(sampleBanners)),
            toggleBanner = FakeToggleBanner(Result.success(sampleBanners[0])),
            loggerFactory = testLoggerFactory
        )

        vm.loadBanners(null)

        assertEquals(BannerListStatus.MissingBusiness, vm.state.status)
    }

    @Test
    fun `loadBanners con businessId vacio muestra MissingBusiness`() = runTest {
        val vm = BannerListViewModel(
            listBanners = FakeListBanners(Result.success(sampleBanners)),
            toggleBanner = FakeToggleBanner(Result.success(sampleBanners[0])),
            loggerFactory = testLoggerFactory
        )

        vm.loadBanners("")

        assertEquals(BannerListStatus.MissingBusiness, vm.state.status)
    }

    @Test
    fun `loadBanners con error muestra estado Error`() = runTest {
        val vm = BannerListViewModel(
            listBanners = FakeListBanners(Result.failure(RuntimeException("network error"))),
            toggleBanner = FakeToggleBanner(Result.success(sampleBanners[0])),
            loggerFactory = testLoggerFactory
        )

        vm.loadBanners("biz-1")

        assertEquals(BannerListStatus.Error, vm.state.status)
        assertTrue(vm.state.errorMessage?.contains("network error") == true)
    }

    @Test
    fun `loadBanners con lista vacia muestra Empty`() = runTest {
        val vm = BannerListViewModel(
            listBanners = FakeListBanners(Result.success(emptyList())),
            toggleBanner = FakeToggleBanner(Result.success(sampleBanners[0])),
            loggerFactory = testLoggerFactory
        )

        vm.loadBanners("biz-1")

        assertEquals(BannerListStatus.Empty, vm.state.status)
    }

    @Test
    fun `toggleBannerActive actualiza estado del banner`() = runTest {
        val updatedBanner = sampleBanners[0].copy(active = false)
        val fakeToggle = FakeToggleBanner(Result.success(updatedBanner))
        val vm = BannerListViewModel(
            listBanners = FakeListBanners(Result.success(sampleBanners)),
            toggleBanner = fakeToggle,
            loggerFactory = testLoggerFactory
        )

        vm.loadBanners("biz-1")
        val result = vm.toggleBannerActive("b-1", false)

        assertTrue(result.isSuccess)
        assertTrue(fakeToggle.called)
        assertEquals("b-1", fakeToggle.lastBannerId)
        assertEquals(false, fakeToggle.lastActive)
        assertTrue(!vm.state.items.first { it.id == "b-1" }.active)
    }

    @Test
    fun `toggleBannerActive sin negocio falla`() = runTest {
        val vm = BannerListViewModel(
            listBanners = FakeListBanners(Result.success(sampleBanners)),
            toggleBanner = FakeToggleBanner(Result.success(sampleBanners[0])),
            loggerFactory = testLoggerFactory
        )

        val result = vm.toggleBannerActive("b-1", false)

        assertTrue(result.isFailure)
    }

    @Test
    fun `toDraft convierte item a draft correctamente`() = runTest {
        val vm = BannerListViewModel(
            listBanners = FakeListBanners(Result.success(sampleBanners)),
            toggleBanner = FakeToggleBanner(Result.success(sampleBanners[0])),
            loggerFactory = testLoggerFactory
        )

        vm.loadBanners("biz-1")
        val draft = vm.toDraft(vm.state.items[0])

        assertEquals("b-1", draft.id)
        assertEquals("Envio gratis", draft.title)
        assertEquals("Por compras mayores a \$5000", draft.text)
        assertEquals("home", draft.position)
        assertTrue(draft.active)
    }

    @Test
    fun `clearError limpia el mensaje de error`() = runTest {
        val vm = BannerListViewModel(
            listBanners = FakeListBanners(Result.failure(RuntimeException("error"))),
            toggleBanner = FakeToggleBanner(Result.success(sampleBanners[0])),
            loggerFactory = testLoggerFactory
        )

        vm.loadBanners("biz-1")
        assertTrue(vm.state.errorMessage != null)

        vm.clearError()
        assertEquals(null, vm.state.errorMessage)
    }

    @Test
    fun `estado inicial tiene campos vacios`() = runTest {
        val vm = BannerListViewModel(
            listBanners = FakeListBanners(Result.success(sampleBanners)),
            toggleBanner = FakeToggleBanner(Result.success(sampleBanners[0])),
            loggerFactory = testLoggerFactory
        )

        assertEquals(BannerListStatus.Idle, vm.state.status)
        assertTrue(vm.state.items.isEmpty())
        assertEquals(null, vm.state.errorMessage)
    }

    @Test
    fun `refresh recarga banners del negocio actual`() = runTest {
        val fakeList = FakeListBanners(Result.success(sampleBanners))
        val vm = BannerListViewModel(
            listBanners = fakeList,
            toggleBanner = FakeToggleBanner(Result.success(sampleBanners[0])),
            loggerFactory = testLoggerFactory
        )

        vm.loadBanners("biz-1")
        assertTrue(fakeList.called)
        vm.refresh()
        assertEquals(BannerListStatus.Loaded, vm.state.status)
    }
}
