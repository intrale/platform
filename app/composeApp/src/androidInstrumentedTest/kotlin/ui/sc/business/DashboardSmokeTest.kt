package ui.sc.business

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import ui.util.RES_ERROR_PREFIX

@RunWith(AndroidJUnit4::class)
class DashboardSmokeTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    @OptIn(ExperimentalResourceApi::class)
    @Test
    fun dashboardFirstFrame_withoutFallbacks() {
        composeRule.setContent {
            DashboardScreen().screen()
        }

        composeRule.waitForIdle()

        composeRule.onNodeWithText("Panel principal").assertExists()
        composeRule
            .onAllNodesWithText(RES_ERROR_PREFIX, substring = true)
            .assertCountEquals(0)
    }
}
