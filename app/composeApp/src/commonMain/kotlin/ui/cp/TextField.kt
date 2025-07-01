package ui.cp

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BlurOff
import androidx.compose.material.icons.filled.BlurOn
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.jetbrains.compose.resources.StringResource
import org.jetbrains.compose.resources.stringResource
import org.kodein.log.Logger
import org.kodein.log.LoggerFactory

@OptIn(ExperimentalResourceApi::class)
@Composable
fun TextField(label: StringResource,
              value: String,
              state: InputState,
              visualTransformation: Boolean = false,
              onValueChange:(value:String) -> Unit = {},
                  ){

    var logger = LoggerFactory.default.newLogger(Logger.Tag("ui.cp", "TextField"))

    var isVisible by remember { mutableStateOf(!visualTransformation) }

    var labelString = stringResource(label)

    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        androidx.compose.material3.TextField(
            value=value,
            onValueChange={
                          onValueChange(it)
            }, label = { Text(labelString) },
            visualTransformation = if (isVisible)
                            VisualTransformation.None else PasswordVisualTransformation(),
            trailingIcon = {
                val image = if (isVisible)
                    Icons.Filled.BlurOff
                else Icons.Filled.BlurOn

                // Please provide localized description for accessibility services
                val description = if (isVisible) "Hide password" else "Show password"
                AnimatedVisibility(visualTransformation) {
                    IconButton(onClick = { isVisible = !isVisible }) {
                        Icon(image, contentDescription = null)
                    }
                }
            }
        )

    Spacer(modifier = Modifier.fillMaxHeight())

            AnimatedVisibility(!state.isValid){
                Text(
                    text = state.details,
                    //modifier = Modifier.fillMaxWidth(),
                    color = MaterialTheme.colorScheme.error
                )
            }
    }

}
