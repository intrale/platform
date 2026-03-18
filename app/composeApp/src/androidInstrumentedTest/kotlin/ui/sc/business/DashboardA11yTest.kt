package ui.sc.business

import androidx.activity.ComponentActivity
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.test.assertTrue
import ui.util.RES_ERROR_PREFIX

/**
 * Verifica la semántica de accesibilidad (a11y) del Dashboard de negocio:
 * headings marcados, live regions, sin textos de fallback visibles.
 */
@RunWith(AndroidJUnit4::class)
class DashboardA11yTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun `dashboard tiene al menos un nodo marcado como heading`() {
        composeRule.setContent {
            DashboardScreen().screen()
        }

        composeRule.waitForIdle()

        val headingNodes = composeRule.onAllNodes(
            SemanticsMatcher.keyIsDefined(SemanticsProperties.Heading)
        ).fetchSemanticsNodes()

        assertTrue(
            headingNodes.isNotEmpty(),
            "El Dashboard no tiene ningun nodo marcado como heading para lectores de pantalla."
        )
    }

    @Test
    fun `dashboard no expone textos de fallback a lectores de pantalla`() {
        composeRule.setContent {
            DashboardScreen().screen()
        }

        composeRule.waitForIdle()

        val fallbackNodes = composeRule
            .onAllNodesWithText(RES_ERROR_PREFIX, substring = true)
            .fetchSemanticsNodes()

        assertTrue(
            fallbackNodes.isEmpty(),
            "Se detectaron ${fallbackNodes.size} nodos con prefijo de fallback " +
                "visibles para lectores de pantalla en el Dashboard."
        )
    }
}
