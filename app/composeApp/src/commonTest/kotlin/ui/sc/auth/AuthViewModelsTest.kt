package ui.sc.auth

import asdo.auth.*
import kotlinx.coroutines.test.runTest
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private val testLoggerFactory = LoggerFactory(listOf(simplePrintFrontend))

// region Fakes

private class FakeLogin(
    private val result: Result<DoLoginResult> = Result.success(DoLoginResult(StatusCode(200, "OK")))
) : ToDoLogin {
    override suspend fun execute(
        user: String, password: String, newPassword: String?, name: String?, familyName: String?
    ): Result<DoLoginResult> = result
}

private class FakeCheckPreviousLogin(private val result: Boolean = false) : ToDoCheckPreviousLogin {
    override suspend fun execute(): Boolean = result
}

private class FakeChangePassword(
    private val result: Result<DoChangePasswordResult> = Result.success(
        DoChangePasswordResult(ChangePasswordStatusCode(200, "OK"))
    )
) : ToDoChangePassword {
    override suspend fun execute(oldPassword: String, newPassword: String): Result<DoChangePasswordResult> = result
}

private class FakePasswordRecovery(
    private val result: Result<DoPasswordRecoveryResult> = Result.success(
        DoPasswordRecoveryResult(PasswordRecoveryStatusCode(200, "OK"))
    )
) : ToDoPasswordRecovery {
    override suspend fun execute(email: String): Result<DoPasswordRecoveryResult> = result
}

private class FakeConfirmPasswordRecovery(
    private val result: Result<DoConfirmPasswordRecoveryResult> = Result.success(
        DoConfirmPasswordRecoveryResult(ConfirmPasswordRecoveryStatusCode(200, "OK"))
    )
) : ToDoConfirmPasswordRecovery {
    override suspend fun execute(email: String, code: String, password: String): Result<DoConfirmPasswordRecoveryResult> = result
}

private class FakeTwoFactorSetup(
    private val result: Result<DoTwoFactorSetupResult> = Result.success(
        DoTwoFactorSetupResult(TwoFactorSetupStatusCode(200, "OK"), "otpauth://totp/test?secret=ABCD1234EFGH5678&issuer=Intrale")
    )
) : ToDoTwoFactorSetup {
    override suspend fun execute(): Result<DoTwoFactorSetupResult> = result
}

private class FakeTwoFactorVerify(
    private val result: Result<DoTwoFactorVerifyResult> = Result.success(
        DoTwoFactorVerifyResult(TwoFactorVerifyStatusCode(200, "OK"))
    )
) : ToDoTwoFactorVerify {
    override suspend fun execute(code: String): Result<DoTwoFactorVerifyResult> = result
}

// endregion

// region LoginViewModel

class LoginViewModelTest {

    private fun createVm(
        login: ToDoLogin = FakeLogin(),
        checkPrevious: ToDoCheckPreviousLogin = FakeCheckPreviousLogin()
    ) = LoginViewModel(login, checkPrevious, testLoggerFactory)

    @Test
    fun `login exitoso retorna resultado`() = runTest {
        val vm = createVm()
        vm.onUserChange("test@test.com")
        vm.onPasswordChange("password123")

        val result = vm.login()

        assertTrue(result.isSuccess)
        assertEquals(200, result.getOrThrow().statusCode.value)
    }

    @Test
    fun `login fallido retorna error`() = runTest {
        val vm = createVm(login = FakeLogin(Result.failure(RuntimeException("Error"))))
        vm.onUserChange("test@test.com")
        vm.onPasswordChange("password123")

        val result = vm.login()

        assertTrue(result.isFailure)
    }

    @Test
    fun `previousLogin retorna true cuando hay sesion`() = runTest {
        val vm = createVm(checkPrevious = FakeCheckPreviousLogin(true))

        assertTrue(vm.previousLogin())
    }

    @Test
    fun `previousLogin retorna false cuando no hay sesion`() = runTest {
        val vm = createVm(checkPrevious = FakeCheckPreviousLogin(false))

        assertFalse(vm.previousLogin())
    }

    @Test
    fun `onUserChange actualiza estado`() {
        val vm = createVm()
        vm.onUserChange("nuevo@correo.com")
        assertEquals("nuevo@correo.com", vm.state.user)
    }

    @Test
    fun `onPasswordChange actualiza estado`() {
        val vm = createVm()
        vm.onPasswordChange("secret123")
        assertEquals("secret123", vm.state.password)
    }

    @Test
    fun `isValid con datos correctos retorna true`() {
        val vm = createVm()
        vm.onUserChange("test@test.com")
        vm.onPasswordChange("password123")
        assertTrue(vm.isValid())
    }

    @Test
    fun `isValid con email invalido retorna false`() {
        val vm = createVm()
        vm.onUserChange("invalido")
        vm.onPasswordChange("password123")
        assertFalse(vm.isValid())
    }

    @Test
    fun `requirePasswordChange activa campos adicionales`() {
        val vm = createVm()
        vm.requirePasswordChange()
        assertTrue(vm.changePasswordRequired)
    }

    @Test
    fun `markCredentialsAsInvalid marca campos como invalidos`() {
        val vm = createVm()
        vm.markCredentialsAsInvalid("Credenciales incorrectas")
        assertFalse(vm["user"].isValid)
        assertFalse(vm["password"].isValid)
    }
}

// endregion

// region ChangePasswordViewModel

class ChangePasswordViewModelTest {

    @Test
    fun `changePassword exitoso retorna resultado`() = runTest {
        val vm = ChangePasswordViewModel(FakeChangePassword(), testLoggerFactory)
        vm.state = ChangePasswordViewModel.ChangePasswordUIState("oldpass12", "newpass12")

        val result = vm.changePassword()

        assertTrue(result.isSuccess)
        assertEquals(200, result.getOrThrow().statusCode.value)
    }

    @Test
    fun `isValid con contraseñas validas retorna true`() {
        val vm = ChangePasswordViewModel(FakeChangePassword(), testLoggerFactory)
        vm.state = ChangePasswordViewModel.ChangePasswordUIState("oldpass12", "newpass12")
        assertTrue(vm.isValid())
    }

    @Test
    fun `isValid con contraseña corta retorna false`() {
        val vm = ChangePasswordViewModel(FakeChangePassword(), testLoggerFactory)
        vm.state = ChangePasswordViewModel.ChangePasswordUIState("short", "newpass12")
        assertFalse(vm.isValid())
    }
}

// endregion

// region PasswordRecoveryViewModel

class PasswordRecoveryViewModelTest {

    @Test
    fun `recovery exitoso retorna resultado`() = runTest {
        val vm = PasswordRecoveryViewModel(FakePasswordRecovery(), testLoggerFactory)
        vm.state = PasswordRecoveryViewModel.PasswordRecoveryUIState("test@test.com")

        val result = vm.recovery()

        assertTrue(result.isSuccess)
    }

    @Test
    fun `isValid con email invalido retorna false`() {
        val vm = PasswordRecoveryViewModel(FakePasswordRecovery(), testLoggerFactory)
        vm.state = PasswordRecoveryViewModel.PasswordRecoveryUIState("invalido")
        assertFalse(vm.isValid())
    }
}

// endregion

// region ConfirmPasswordRecoveryViewModel

class ConfirmPasswordRecoveryViewModelTest {

    @Test
    fun `confirm exitoso retorna resultado`() = runTest {
        val vm = ConfirmPasswordRecoveryViewModel(FakeConfirmPasswordRecovery(), testLoggerFactory)
        vm.state = ConfirmPasswordRecoveryViewModel.ConfirmPasswordRecoveryUIState(
            email = "test@test.com", code = "123456", password = "newpass12"
        )

        val result = vm.confirm()

        assertTrue(result.isSuccess)
    }

    @Test
    fun `isValid con datos validos retorna true`() {
        val vm = ConfirmPasswordRecoveryViewModel(FakeConfirmPasswordRecovery(), testLoggerFactory)
        vm.state = ConfirmPasswordRecoveryViewModel.ConfirmPasswordRecoveryUIState(
            email = "test@test.com", code = "123456", password = "newpass12"
        )
        assertTrue(vm.isValid())
    }

    @Test
    fun `isValid con email invalido retorna false`() {
        val vm = ConfirmPasswordRecoveryViewModel(FakeConfirmPasswordRecovery(), testLoggerFactory)
        vm.state = ConfirmPasswordRecoveryViewModel.ConfirmPasswordRecoveryUIState(
            email = "invalido", code = "123456", password = "newpass12"
        )
        assertFalse(vm.isValid())
    }
}

// endregion

// region TwoFactorSetupViewModel

class TwoFactorSetupViewModelTest {

    @Test
    fun `setup exitoso retorna resultado`() = runTest {
        val vm = TwoFactorSetupViewModel(FakeTwoFactorSetup(), testLoggerFactory)

        val result = vm.setup()

        assertTrue(result.isSuccess)
    }

    @Test
    fun `onOtpAuthUri parsea URI correctamente`() {
        val vm = TwoFactorSetupViewModel(FakeTwoFactorSetup(), testLoggerFactory)
        vm.onOtpAuthUri("otpauth://totp/user@test.com?secret=ABCD1234EFGH5678&issuer=Intrale")

        assertEquals("Intrale:user@test.com", vm.state.issuerAccount)
        assertEquals("ABCD****5678", vm.state.secretMasked)
    }

    @Test
    fun `onDeepLinkResult muestra QR cuando falla`() {
        val vm = TwoFactorSetupViewModel(FakeTwoFactorSetup(), testLoggerFactory)
        vm.onDeepLinkResult(false)

        assertTrue(vm.state.showQr)
        assertTrue(vm.state.deepLinkTried)
    }

    @Test
    fun `copySecret retorna secreto completo`() {
        val vm = TwoFactorSetupViewModel(FakeTwoFactorSetup(), testLoggerFactory)
        vm.onOtpAuthUri("otpauth://totp/user@test.com?secret=ABCD1234EFGH5678&issuer=Intrale")

        assertEquals("ABCD1234EFGH5678", vm.copySecret())
    }
}

// endregion

// region TwoFactorVerifyViewModel

class TwoFactorVerifyViewModelTest {

    @Test
    fun `verify exitoso retorna resultado`() = runTest {
        val vm = TwoFactorVerifyViewModel(FakeTwoFactorVerify(), testLoggerFactory)
        vm.state = TwoFactorVerifyViewModel.TwoFactorVerifyUIState("123456")

        val result = vm.verify()

        assertTrue(result.isSuccess)
    }

    @Test
    fun `isValid con codigo valido retorna true`() {
        val vm = TwoFactorVerifyViewModel(FakeTwoFactorVerify(), testLoggerFactory)
        vm.state = TwoFactorVerifyViewModel.TwoFactorVerifyUIState("123456")
        assertTrue(vm.isValid())
    }

    @Test
    fun `isValid con codigo corto retorna false`() {
        val vm = TwoFactorVerifyViewModel(FakeTwoFactorVerify(), testLoggerFactory)
        vm.state = TwoFactorVerifyViewModel.TwoFactorVerifyUIState("123")
        assertFalse(vm.isValid())
    }
}

// endregion
