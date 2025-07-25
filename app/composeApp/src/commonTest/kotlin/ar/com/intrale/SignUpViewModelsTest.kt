package ar.com.intrale

import DIManager
import asdo.*
import kotlinx.coroutines.runBlocking
import org.kodein.di.DI
import org.kodein.di.bindSingleton
import ui.sc.SignUpDeliveryViewModel
import ui.sc.SignUpPlatformAdminViewModel
import ui.sc.SignUpSalerViewModel
import ui.sc.SignUpViewModel
import kotlin.test.Test
import kotlin.test.assertTrue

class SignUpViewModelsTest {

    private class FakePlatformAdminSignUp : ToDoSignUpPlatformAdmin {
        var executed = false
        override suspend fun execute(email: String): Result<DoSignUpResult> {
            executed = true
            return Result.success(DoSignUpResult(SignUpStatusCode(200, null)))
        }
    }

    private class FakeDeliverySignUp : ToDoSignUpDelivery {
        var executed = false
        override suspend fun execute(email: String): Result<DoSignUpResult> {
            executed = true
            return Result.success(DoSignUpResult(SignUpStatusCode(200, null)))
        }
    }

    private class FakeSalerSignUp : ToDoSignUpSaler {
        var executed = false
        override suspend fun execute(email: String): Result<DoSignUpResult> {
            executed = true
            return Result.success(DoSignUpResult(SignUpStatusCode(200, null)))
        }
    }

    private class FakeSignUp : ToDoSignUp {
        var executed = false
        override suspend fun execute(email: String): Result<DoSignUpResult> {
            executed = true
            return Result.success(DoSignUpResult(SignUpStatusCode(200, null)))
        }
    }

    @Test
    fun signupPlatformAdminInvokesService() = runBlocking {
        val fake = FakePlatformAdminSignUp()
        DIManager.di = DI { bindSingleton<ToDoSignUpPlatformAdmin> { fake } }
        val vm = SignUpPlatformAdminViewModel()
        vm.state = SignUpPlatformAdminViewModel.SignUpUIState("test@example.com")
        vm.signup()
        assertTrue(fake.executed)
    }

    @Test
    fun signupDeliveryInvokesService() = runBlocking {
        val fake = FakeDeliverySignUp()
        DIManager.di = DI { bindSingleton<ToDoSignUpDelivery> { fake } }
        val vm = SignUpDeliveryViewModel()
        vm.state = SignUpDeliveryViewModel.SignUpUIState("test@example.com")
        vm.signup()
        assertTrue(fake.executed)
    }

    @Test
    fun signupSalerInvokesService() = runBlocking {
        val fake = FakeSalerSignUp()
        DIManager.di = DI { bindSingleton<ToDoSignUpSaler> { fake } }
        val vm = SignUpSalerViewModel()
        vm.state = SignUpSalerViewModel.SignUpUIState("test@example.com")
        vm.signup()
        assertTrue(fake.executed)
    }

    @Test
    fun signupGenericInvokesService() = runBlocking {
        val fake = FakeSignUp()
        DIManager.di = DI { bindSingleton<ToDoSignUp> { fake } }
        val vm = SignUpViewModel()
        vm.state = SignUpViewModel.SignUpUIState("test@example.com")
        vm.signup()
        assertTrue(fake.executed)
    }
}

