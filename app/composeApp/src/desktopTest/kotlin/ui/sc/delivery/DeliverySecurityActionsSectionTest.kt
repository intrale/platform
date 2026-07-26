package ui.sc.delivery

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import kotlin.test.Test
import kotlin.test.assertEquals

@OptIn(ExperimentalTestApi::class)
class DeliverySecurityActionsSectionTest {

    @Test
    fun `muestra acciones 2FA y ejecuta navegacion cuando el feature esta habilitado`() = runComposeUiTest {
        val navigations = mutableListOf<String>()

        setContent {
            MaterialTheme {
                DeliverySecurityActionsSection(
                    twoFactorEnabled = true,
                    setupLabel = SETUP_LABEL,
                    verifyLabel = VERIFY_LABEL,
                    onSetupTwoFactor = { navigations += "setup" },
                    onVerifyTwoFactor = { navigations += "verify" }
                )
            }
        }

        onNodeWithText(SETUP_LABEL).assertIsDisplayed().performClick()
        onNodeWithText(VERIFY_LABEL).assertIsDisplayed().performClick()

        assertEquals(listOf("setup", "verify"), navigations)
    }

    @Test
    fun `oculta acciones 2FA cuando el feature esta deshabilitado`() = runComposeUiTest {
        setContent {
            MaterialTheme {
                DeliverySecurityActionsSection(
                    twoFactorEnabled = false,
                    setupLabel = SETUP_LABEL,
                    verifyLabel = VERIFY_LABEL,
                    onSetupTwoFactor = {},
                    onVerifyTwoFactor = {}
                )
            }
        }

        onNodeWithText(SETUP_LABEL).assertDoesNotExist()
        onNodeWithText(VERIFY_LABEL).assertDoesNotExist()
    }

    private companion object {
        const val SETUP_LABEL = "Configurar autenticación en dos pasos"
        const val VERIFY_LABEL = "Verificar código"
    }
}
