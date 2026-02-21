package ui.sc.business

import asdo.business.ToDoRegisterBusiness
import asdo.business.ToDoRequestJoinBusiness
import asdo.business.ToDoReviewBusinessRegistration
import asdo.business.ToDoReviewJoinBusiness
import asdo.business.ToGetBusinesses
import ext.business.RegisterBusinessResponse
import ext.business.RequestJoinBusinessResponse
import ext.business.ReviewBusinessRegistrationResponse
import ext.business.ReviewJoinBusinessResponse
import ext.dto.BusinessDTO
import ext.dto.SearchBusinessesResponse
import ext.dto.StatusCodeDTO
import kotlinx.coroutines.test.runTest
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private val testLoggerFactory = LoggerFactory(listOf(simplePrintFrontend))

// region Fakes

private class FakeRegisterBusiness(
    private val result: Result<RegisterBusinessResponse> = Result.success(RegisterBusinessResponse(StatusCodeDTO(200, "OK")))
) : ToDoRegisterBusiness {
    override suspend fun execute(name: String, emailAdmin: String, description: String): Result<RegisterBusinessResponse> = result
}

private class FakeRequestJoinBusiness(
    private val result: Result<RequestJoinBusinessResponse> = Result.success(RequestJoinBusinessResponse("PENDING"))
) : ToDoRequestJoinBusiness {
    override suspend fun execute(business: String): Result<RequestJoinBusinessResponse> = result
}

private class FakeReviewBusinessRegistration(
    private val result: Result<ReviewBusinessRegistrationResponse> = Result.success(
        ReviewBusinessRegistrationResponse(StatusCodeDTO(200, "OK"))
    )
) : ToDoReviewBusinessRegistration {
    override suspend fun execute(publicId: String, decision: String, twoFactorCode: String): Result<ReviewBusinessRegistrationResponse> = result
}

private class FakeReviewJoinBusiness(
    private val result: Result<ReviewJoinBusinessResponse> = Result.success(
        ReviewJoinBusinessResponse(StatusCodeDTO(200, "OK"))
    )
) : ToDoReviewJoinBusiness {
    override suspend fun execute(business: String, email: String, decision: String): Result<ReviewJoinBusinessResponse> = result
}

private class FakeGetBusinessesForReview(
    private val result: Result<SearchBusinessesResponse> = Result.success(
        SearchBusinessesResponse(StatusCodeDTO(200, "OK"), emptyList())
    )
) : ToGetBusinesses {
    override suspend fun execute(
        query: String, status: String?, limit: Int?, lastKey: String?
    ): Result<SearchBusinessesResponse> = result
}

// endregion

// region RegisterBusinessViewModel

class RegisterBusinessViewModelTest {

    @Test
    fun `register exitoso retorna resultado`() = runTest {
        val vm = RegisterBusinessViewModel(FakeRegisterBusiness(), testLoggerFactory)
        vm.state = RegisterBusinessViewModel.UIState(
            name = "Mi Negocio", email = "admin@test.com", description = "Descripcion"
        )

        val result = vm.register()

        assertTrue(result.isSuccess)
    }

    @Test
    fun `isValid con datos validos retorna true`() {
        val vm = RegisterBusinessViewModel(FakeRegisterBusiness(), testLoggerFactory)
        vm.state = RegisterBusinessViewModel.UIState(
            name = "Negocio", email = "admin@test.com", description = "Desc"
        )
        assertTrue(vm.isValid())
    }

    @Test
    fun `isValid con nombre vacio retorna false`() {
        val vm = RegisterBusinessViewModel(FakeRegisterBusiness(), testLoggerFactory)
        vm.state = RegisterBusinessViewModel.UIState(
            name = "", email = "admin@test.com", description = "Desc"
        )
        assertFalse(vm.isValid())
    }

    @Test
    fun `validacion rechaza email invalido`() {
        val vm = RegisterBusinessViewModel(FakeRegisterBusiness(), testLoggerFactory)
        vm.state = RegisterBusinessViewModel.UIState(
            name = "Mi Negocio", email = "correo-sin-arroba", description = "Descripcion"
        )
        assertFalse(vm.isValid())
    }

    @Test
    fun `registro con error propaga fallo`() = runTest {
        val vm = RegisterBusinessViewModel(
            FakeRegisterBusiness(Result.failure(RuntimeException("error de red"))),
            testLoggerFactory
        )
        vm.state = RegisterBusinessViewModel.UIState(
            name = "Mi Negocio", email = "admin@test.com", description = "Descripcion"
        )

        val result = vm.register()

        assertTrue(result.isFailure)
    }
}

// endregion

// region RequestJoinBusinessViewModel

class RequestJoinBusinessViewModelTest {

    @Test
    fun `request exitoso actualiza estado`() = runTest {
        val vm = RequestJoinBusinessViewModel(FakeRequestJoinBusiness(), testLoggerFactory)
        vm.state = RequestJoinBusinessViewModel.UIState(business = "negocio-1")

        vm.request()

        assertEquals("PENDING", vm.state.resultState)
    }

    @Test
    fun `isValid con negocio valido retorna true`() {
        val vm = RequestJoinBusinessViewModel(FakeRequestJoinBusiness(), testLoggerFactory)
        vm.state = RequestJoinBusinessViewModel.UIState(business = "negocio-1")
        assertTrue(vm.isValid())
    }

    @Test
    fun `request con error no modifica resultState`() = runTest {
        val vm = RequestJoinBusinessViewModel(
            FakeRequestJoinBusiness(Result.failure(RuntimeException("error de red"))),
            testLoggerFactory
        )
        vm.state = RequestJoinBusinessViewModel.UIState(business = "negocio-1")

        vm.request()

        assertEquals(null, vm.state.resultState)
    }
}

// endregion

// region ReviewBusinessViewModel

class ReviewBusinessViewModelTest {

    @Test
    fun `approve exitoso completa sin error`() = runTest {
        val vm = ReviewBusinessViewModel(FakeReviewBusinessRegistration(), FakeGetBusinessesForReview(), testLoggerFactory)
        vm.state = ReviewBusinessViewModel.UIState(twoFactorCode = "123456")

        val result = vm.approve("pub-1")

        assertTrue(result.isSuccess)
    }

    @Test
    fun `loadPending carga lista de pendientes`() = runTest {
        val businesses = listOf(
            BusinessDTO("id-1", "pub-1", "Negocio A", "Desc", "a@test.com", false, "PENDING"),
            BusinessDTO("id-2", "pub-2", "Negocio B", "Desc", "b@test.com", false, "PENDING")
        )
        val vm = ReviewBusinessViewModel(
            FakeReviewBusinessRegistration(),
            FakeGetBusinessesForReview(Result.success(SearchBusinessesResponse(StatusCodeDTO(200, "OK"), businesses))),
            testLoggerFactory
        )

        vm.loadPending()

        assertEquals(2, vm.pending.size)
        assertTrue(vm.selected.isEmpty())
    }

    @Test
    fun `toggleSelection agrega y remueve`() = runTest {
        val vm = ReviewBusinessViewModel(FakeReviewBusinessRegistration(), FakeGetBusinessesForReview(), testLoggerFactory)

        vm.toggleSelection("pub-1")
        assertTrue(vm.selected.contains("pub-1"))

        vm.toggleSelection("pub-1")
        assertFalse(vm.selected.contains("pub-1"))
    }

    @Test
    fun `selectAll selecciona todos`() = runTest {
        val businesses = listOf(
            BusinessDTO("id-1", "pub-1", "A", "D", "a@t.com", false, "PENDING"),
            BusinessDTO("id-2", "pub-2", "B", "D", "b@t.com", false, "PENDING")
        )
        val vm = ReviewBusinessViewModel(
            FakeReviewBusinessRegistration(),
            FakeGetBusinessesForReview(Result.success(SearchBusinessesResponse(StatusCodeDTO(200, "OK"), businesses))),
            testLoggerFactory
        )
        vm.loadPending()

        vm.selectAll()
        assertEquals(2, vm.selected.size)

        vm.clearSelection()
        assertTrue(vm.selected.isEmpty())
    }

    @Test
    fun `loadPending con error no modifica lista`() = runTest {
        val vm = ReviewBusinessViewModel(
            FakeReviewBusinessRegistration(),
            FakeGetBusinessesForReview(Result.failure(RuntimeException("error de red"))),
            testLoggerFactory
        )

        vm.loadPending()

        assertTrue(vm.pending.isEmpty())
    }

    @Test
    fun `reject exitoso invoca caso de uso con decision rejected`() = runTest {
        val vm = ReviewBusinessViewModel(
            FakeReviewBusinessRegistration(),
            FakeGetBusinessesForReview(),
            testLoggerFactory
        )
        vm.state = ReviewBusinessViewModel.UIState(twoFactorCode = "123456")

        val result = vm.reject("pub-1")

        assertTrue(result.isSuccess)
    }

    @Test
    fun `clearSelection vacia la seleccion`() = runTest {
        val businesses = listOf(
            BusinessDTO("id-1", "pub-1", "A", "D", "a@t.com", false, "PENDING"),
            BusinessDTO("id-2", "pub-2", "B", "D", "b@t.com", false, "PENDING")
        )
        val vm = ReviewBusinessViewModel(
            FakeReviewBusinessRegistration(),
            FakeGetBusinessesForReview(Result.success(SearchBusinessesResponse(StatusCodeDTO(200, "OK"), businesses))),
            testLoggerFactory
        )
        vm.loadPending()
        vm.selectAll()
        assertEquals(2, vm.selected.size)

        vm.clearSelection()

        assertTrue(vm.selected.isEmpty())
    }
}

// endregion

// region ReviewJoinBusinessViewModel

class ReviewJoinBusinessViewModelTest {

    @Test
    fun `approve exitoso llama servicio`() = runTest {
        val vm = ReviewJoinBusinessViewModel(FakeReviewJoinBusiness(), testLoggerFactory)
        vm.state = ReviewJoinBusinessViewModel.UIState(email = "user@test.com")

        val result = vm.approve()

        assertTrue(result.isSuccess)
    }

    @Test
    fun `isValid con email invalido retorna false`() {
        val vm = ReviewJoinBusinessViewModel(FakeReviewJoinBusiness(), testLoggerFactory)
        vm.state = ReviewJoinBusinessViewModel.UIState(email = "invalido")
        assertFalse(vm.isValid())
    }
}

// endregion
