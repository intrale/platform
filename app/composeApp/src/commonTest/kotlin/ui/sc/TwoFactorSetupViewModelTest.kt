package ui.sc

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TwoFactorSetupViewModelTest {
    @Test
    fun `deep link exitoso y fallback a QR`() {
        val vm = TwoFactorSetupViewModel()
        vm.onDeepLinkResult(true)
        assertFalse(vm.state.showQr)
        vm.onDeepLinkResult(false)
        assertTrue(vm.state.showQr)
    }

    @Test
    fun `copia de secret y url`() {
        val vm = TwoFactorSetupViewModel()
        val uri = "otpauth://totp/intrale:demo?secret=ABCDEF123456&issuer=intrale"
        vm.onOtpAuthUri(uri)
        assertEquals("ABCDEF123456", vm.copySecret())
        assertEquals(uri, vm.copyLink())
    }
}
