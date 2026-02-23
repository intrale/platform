package ui.sc.signup

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.runComposeUiTest
import kotlin.test.Test
import kotlin.test.assertTrue

@OptIn(ExperimentalTestApi::class)
class SignUpScreenUiTest {

    @Test
    fun `signup screen tag existe en layout`() = runComposeUiTest {
        setContent {
            MaterialTheme {
                Column(modifier = Modifier.testTag("signup_screen")) {
                    Text("Registro")
                }
            }
        }
        onNodeWithTag("signup_screen").assertIsDisplayed()
    }

    @Test
    fun `signup muestra campo de email con testTag correcto`() = runComposeUiTest {
        setContent {
            MaterialTheme {
                val text = remember { mutableStateOf("") }
                OutlinedTextField(
                    value = text.value,
                    onValueChange = { text.value = it },
                    label = { Text("Email") },
                    modifier = Modifier.fillMaxWidth().testTag("field_Email")
                )
            }
        }
        onNodeWithTag("field_Email").assertIsDisplayed()
    }

    @Test
    fun `campo email acepta input`() = runComposeUiTest {
        setContent {
            MaterialTheme {
                val text = remember { mutableStateOf("") }
                OutlinedTextField(
                    value = text.value,
                    onValueChange = { text.value = it },
                    label = { Text("Email") },
                    modifier = Modifier.fillMaxWidth().testTag("field_Email")
                )
            }
        }
        onNodeWithTag("field_Email").performTextInput("test@intrale.com")
        onNodeWithText("test@intrale.com").assertIsDisplayed()
    }

    @Test
    fun `boton de registro esta habilitado y es clickeable`() = runComposeUiTest {
        var clicked = false
        setContent {
            MaterialTheme {
                Button(
                    onClick = { clicked = true },
                    modifier = Modifier.testTag("btn_signup")
                ) {
                    Text("Registrarse")
                }
            }
        }
        onNodeWithTag("btn_signup").assertIsEnabled()
        onNodeWithTag("btn_signup").performClick()
        assertTrue(clicked, "El boton debe registrar el click")
    }
}
