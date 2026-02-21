package ui.sc.signup

import asdo.business.ToGetBusinesses
import asdo.signup.*
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

private class FakeSignUp(
    private val result: Result<DoSignUpResult> = Result.success(DoSignUpResult(SignUpStatusCode(200, "OK")))
) : ToDoSignUp {
    override suspend fun execute(email: String): Result<DoSignUpResult> = result
}

private class FakeSignUpDelivery(
    private val result: Result<DoSignUpResult> = Result.success(DoSignUpResult(SignUpStatusCode(200, "OK")))
) : ToDoSignUpDelivery {
    override suspend fun execute(business: String, email: String): Result<DoSignUpResult> = result
}

private class FakeSignUpPlatformAdmin(
    private val result: Result<DoSignUpResult> = Result.success(DoSignUpResult(SignUpStatusCode(200, "OK")))
) : ToDoSignUpPlatformAdmin {
    override suspend fun execute(email: String): Result<DoSignUpResult> = result
}

private class FakeRegisterSaler(
    private val result: Result<DoRegisterSalerResult> = Result.success(DoRegisterSalerResult(RegisterSalerStatusCode(200, "OK")))
) : ToDoRegisterSaler {
    override suspend fun execute(email: String): Result<DoRegisterSalerResult> = result
}

private class FakeConfirmSignUp(
    private val result: Result<DoConfirmSignUpResult> = Result.success(DoConfirmSignUpResult(ConfirmSignUpStatusCode(200, "OK")))
) : ToDoConfirmSignUp {
    override suspend fun execute(email: String, code: String): Result<DoConfirmSignUpResult> = result
}

private class FakeGetBusinesses(
    private val result: Result<SearchBusinessesResponse> = Result.success(
        SearchBusinessesResponse(StatusCodeDTO(200, "OK"), emptyList())
    )
) : ToGetBusinesses {
    override suspend fun execute(
        query: String, status: String?, limit: Int?, lastKey: String?
    ): Result<SearchBusinessesResponse> = result
}

// endregion

// region SignUpViewModel

class SignUpViewModelTest {

    @Test
    fun `signup exitoso retorna resultado`() = runTest {
        val vm = SignUpViewModel(FakeSignUp(), testLoggerFactory)
        vm.state = SignUpViewModel.SignUpUIState("test@test.com")

        val result = vm.signup()

        assertTrue(result.isSuccess)
        assertEquals(200, result.getOrThrow().statusCode.value)
    }

    @Test
    fun `isValid con email valido retorna true`() {
        val vm = SignUpViewModel(FakeSignUp(), testLoggerFactory)
        vm.state = SignUpViewModel.SignUpUIState("test@test.com")
        assertTrue(vm.isValid())
    }

    @Test
    fun `isValid con email invalido retorna false`() {
        val vm = SignUpViewModel(FakeSignUp(), testLoggerFactory)
        vm.state = SignUpViewModel.SignUpUIState("invalido")
        assertFalse(vm.isValid())
    }
}

// endregion

// region SignUpDeliveryViewModel

class SignUpDeliveryViewModelTest {

    @Test
    fun `signup exitoso retorna resultado`() = runTest {
        val vm = SignUpDeliveryViewModel(FakeSignUpDelivery(), FakeGetBusinesses(), testLoggerFactory)
        vm.state = SignUpDeliveryViewModel.SignUpUIState(
            email = "driver@test.com", businessPublicId = "biz-1", businessName = "Negocio"
        )

        val result = vm.signup()

        assertTrue(result.isSuccess)
    }

    @Test
    fun `searchBusinesses carga sugerencias`() = runTest {
        val businesses = listOf(
            BusinessDTO("id-1", "pub-1", "Negocio A", "Desc", "admin@a.com", false, "ACTIVE"),
            BusinessDTO("id-2", "pub-2", "Negocio B", "Desc", "admin@b.com", false, "ACTIVE")
        )
        val vm = SignUpDeliveryViewModel(
            FakeSignUpDelivery(),
            FakeGetBusinesses(Result.success(SearchBusinessesResponse(StatusCodeDTO(200, "OK"), businesses))),
            testLoggerFactory
        )

        vm.searchBusinesses("neg")

        assertEquals(2, vm.suggestions.size)
        assertEquals("pub-1", vm.suggestions[0].publicId)
    }

    @Test
    fun `isValid con datos validos retorna true`() {
        val vm = SignUpDeliveryViewModel(FakeSignUpDelivery(), FakeGetBusinesses(), testLoggerFactory)
        vm.state = SignUpDeliveryViewModel.SignUpUIState(
            email = "test@test.com", businessPublicId = "biz-1", businessName = "Negocio"
        )
        assertTrue(vm.isValid())
    }

    @Test
    fun `isValid sin email retorna false`() {
        val vm = SignUpDeliveryViewModel(FakeSignUpDelivery(), FakeGetBusinesses(), testLoggerFactory)
        vm.state = SignUpDeliveryViewModel.SignUpUIState(email = "invalido", businessPublicId = "biz-1")
        assertFalse(vm.isValid())
    }
}

// endregion

// region SignUpPlatformAdminViewModel

class SignUpPlatformAdminViewModelTest {

    @Test
    fun `signup exitoso retorna resultado`() = runTest {
        val vm = SignUpPlatformAdminViewModel(FakeSignUpPlatformAdmin(), testLoggerFactory)
        vm.state = SignUpPlatformAdminViewModel.SignUpUIState("admin@test.com")

        val result = vm.signup()

        assertTrue(result.isSuccess)
    }

    @Test
    fun `isValid con email invalido retorna false`() {
        val vm = SignUpPlatformAdminViewModel(FakeSignUpPlatformAdmin(), testLoggerFactory)
        vm.state = SignUpPlatformAdminViewModel.SignUpUIState("invalido")
        assertFalse(vm.isValid())
    }
}

// endregion

// region RegisterSalerViewModel

class RegisterSalerViewModelTest {

    @Test
    fun `register exitoso retorna resultado`() = runTest {
        val vm = RegisterSalerViewModel(FakeRegisterSaler(), testLoggerFactory)
        vm.state = RegisterSalerViewModel.RegisterSalerUIState("saler@test.com")

        val result = vm.register()

        assertTrue(result.isSuccess)
    }

    @Test
    fun `isValid con email valido retorna true`() {
        val vm = RegisterSalerViewModel(FakeRegisterSaler(), testLoggerFactory)
        vm.state = RegisterSalerViewModel.RegisterSalerUIState("saler@test.com")
        assertTrue(vm.isValid())
    }

    @Test
    fun `isValid con email invalido retorna false`() {
        val vm = RegisterSalerViewModel(FakeRegisterSaler(), testLoggerFactory)
        vm.state = RegisterSalerViewModel.RegisterSalerUIState("invalido")
        assertFalse(vm.isValid())
    }
}

// endregion

// region ConfirmSignUpViewModel

class ConfirmSignUpViewModelTest {

    @Test
    fun `confirmSignUp exitoso retorna resultado`() = runTest {
        val vm = ConfirmSignUpViewModel(FakeConfirmSignUp(), FakeSignUp(), testLoggerFactory)
        vm.state = ConfirmSignUpViewModel.ConfirmSignUpUIState("test@test.com", "123456")

        val result = vm.confirmSignUp()

        assertTrue(result.isSuccess)
        assertEquals(200, result.getOrThrow().statusCode.value)
    }

    @Test
    fun `isValid con datos validos retorna true`() {
        val vm = ConfirmSignUpViewModel(FakeConfirmSignUp(), FakeSignUp(), testLoggerFactory)
        vm.state = ConfirmSignUpViewModel.ConfirmSignUpUIState("test@test.com", "123456")
        assertTrue(vm.isValid())
    }

    @Test
    fun `isValid con email invalido retorna false`() {
        val vm = ConfirmSignUpViewModel(FakeConfirmSignUp(), FakeSignUp(), testLoggerFactory)
        vm.state = ConfirmSignUpViewModel.ConfirmSignUpUIState("invalido", "123456")
        assertFalse(vm.isValid())
    }

    @Test
    fun `isValid con codigo invalido retorna false`() {
        val vm = ConfirmSignUpViewModel(FakeConfirmSignUp(), FakeSignUp(), testLoggerFactory)
        vm.state = ConfirmSignUpViewModel.ConfirmSignUpUIState("test@test.com", "abc")
        assertFalse(vm.isValid())
    }

    @Test
    fun `resendCode exitoso retorna resultado`() = runTest {
        val vm = ConfirmSignUpViewModel(FakeConfirmSignUp(), FakeSignUp(), testLoggerFactory)
        vm.state = ConfirmSignUpViewModel.ConfirmSignUpUIState("test@test.com", "")

        val result = vm.resendCode()

        assertTrue(result.isSuccess)
    }
}

// endregion
