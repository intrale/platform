package ui.sc

import asdo.auth.DoTwoFactorSetupResult
import asdo.auth.ToDoTwoFactorSetup
import asdo.auth.TwoFactorSetupStatusCode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend
import ui.sc.auth.TwoFactorSetupViewModel

private class FakeTwoFactorSetup : ToDoTwoFactorSetup {
    override suspend fun execute() = Result.success(
        DoTwoFactorSetupResult(TwoFactorSetupStatusCode(200, "OK"), "otpauth://totp/test?secret=ABCD1234EFGH5678&issuer=Intrale")
    )
}

class TwoFactorSetupViewModelTest {
    private val loggerFactory = LoggerFactory(listOf(simplePrintFrontend))

    @Test
    fun `deep link exitoso y fallback a QR`() {
        val vm = TwoFactorSetupViewModel(FakeTwoFactorSetup(), loggerFactory)
        vm.onDeepLinkResult(true)
        assertFalse(vm.state.showQr)
        vm.onDeepLinkResult(false)
        assertTrue(vm.state.showQr)
    }

    @Test
    fun `copia de secret y url`() {
        val vm = TwoFactorSetupViewModel(FakeTwoFactorSetup(), loggerFactory)
        val uri = "otpauth://totp/intrale:demo?secret=ABCDEF123456&issuer=intrale"
        vm.onOtpAuthUri(uri)
        assertEquals("ABCDEF123456", vm.copySecret())
        assertEquals(uri, vm.copyLink())
    }
}
