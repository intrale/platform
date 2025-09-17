package ui.cp

import androidx.compose.foundation.layout.Column
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardOptions
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.sp
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.jetbrains.compose.resources.StringResource
import org.jetbrains.compose.resources.stringResource

@OptIn(ExperimentalResourceApi::class)
@Composable
fun TextField(
    label: StringResource,
    value: String,
    state: MutableState<InputState>,
    visualTransformation: Boolean = false,
    onValueChange: (value: String) -> Unit = {},
    modifier: Modifier = Modifier,
    leadingIcon: (@Composable () -> Unit)? = null,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: androidx.compose.ui.text.input.KeyboardActions = androidx.compose.ui.text.input.KeyboardActions.Default,
    placeholder: StringResource? = null,
    supportingText: (@Composable () -> Unit)? = null,
    enabled: Boolean = true,
) {
    var isVisible by remember { mutableStateOf(!visualTransformation) }

    val labelString = stringResource(label)
    val placeholderString = placeholder?.let { stringResource(it) }
    val showPassword = stringResource(ui.rs.Res.string.text_field_show_password)
    val hidePassword = stringResource(ui.rs.Res.string.text_field_hide_password)
    val errorMessage = state.value.details.takeIf { !state.value.isValid }

    val fieldModifier = if (errorMessage != null) {
        modifier.semantics { error(errorMessage) }
    } else {
        modifier
    }

    Column {
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            label = { Text(labelString) },
            modifier = fieldModifier,
            leadingIcon = leadingIcon,
            trailingIcon = if (visualTransformation) {
                {
                    IconButton(onClick = { isVisible = !isVisible }) {
                        val icon = if (isVisible) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility
                        val description = if (isVisible) hidePassword else showPassword
                        Icon(imageVector = icon, contentDescription = description)
                    }
                }
            } else {
                null
            },
            isError = errorMessage != null,
            enabled = enabled,
            singleLine = true,
            visualTransformation = if (visualTransformation && !isVisible) {
                PasswordVisualTransformation()
            } else {
                VisualTransformation.None
            },
            keyboardOptions = keyboardOptions,
            keyboardActions = keyboardActions,
            placeholder = placeholderString?.let { placeholderText ->
                { Text(text = placeholderText) }
            },
            supportingText = {
                when {
                    errorMessage != null -> Text(
                        text = errorMessage,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp),
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                    supportingText != null -> supportingText()
                }
            }
        )
    }
}
