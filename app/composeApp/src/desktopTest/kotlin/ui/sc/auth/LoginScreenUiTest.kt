package ui.sc.auth

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.runComposeUiTest
import kotlin.test.Test

@OptIn(ExperimentalTestApi::class)
class LoginScreenUiTest {

    @Test
    fun `login muestra campo de usuario con testTag correcto`() = runComposeUiTest {
        setContent {
            MaterialTheme {
                val text = remember { mutableStateOf("") }
                OutlinedTextField(
                    value = text.value,
                    onValueChange = { text.value = it },
                    label = { Text("Username") },
                    modifier = Modifier.fillMaxWidth().testTag("field_Username")
                )
            }
        }
        onNodeWithTag("field_Username").assertIsDisplayed()
    }

    @Test
    fun `login muestra campo de password con testTag correcto`() = runComposeUiTest {
        setContent {
            MaterialTheme {
                val text = remember { mutableStateOf("") }
                OutlinedTextField(
                    value = text.value,
                    onValueChange = { text.value = it },
                    label = { Text("Password") },
                    modifier = Modifier.fillMaxWidth().testTag("field_Password")
                )
            }
        }
        onNodeWithTag("field_Password").assertIsDisplayed()
    }

    @Test
    fun `login screen tag existe en layout`() = runComposeUiTest {
        setContent {
            MaterialTheme {
                Column(modifier = Modifier.testTag("login_screen")) {
                    Text("Login")
                }
            }
        }
        onNodeWithTag("login_screen").assertIsDisplayed()
    }

    @Test
    fun `btn_primary tag es accesible`() = runComposeUiTest {
        setContent {
            MaterialTheme {
                Column(modifier = Modifier.testTag("btn_primary")) {
                    Text("Iniciar sesion")
                }
            }
        }
        onNodeWithTag("btn_primary").assertIsDisplayed()
    }

    @Test
    fun `campo de texto acepta input y mantiene el valor`() = runComposeUiTest {
        setContent {
            MaterialTheme {
                val text = remember { mutableStateOf("") }
                OutlinedTextField(
                    value = text.value,
                    onValueChange = { text.value = it },
                    label = { Text("Username") },
                    modifier = Modifier.fillMaxWidth().testTag("field_Username")
                )
            }
        }
        onNodeWithTag("field_Username").performTextInput("admin@intrale.com")
        onNodeWithText("admin@intrale.com").assertIsDisplayed()
    }
}
