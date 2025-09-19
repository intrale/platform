package ui.cp.inputs

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.jetbrains.compose.resources.StringResource
import org.jetbrains.compose.resources.stringResource
import ui.rs.text_field_hide_password
import ui.rs.text_field_show_password

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
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    placeholder: StringResource? = null,
    supportingText: (@Composable () -> Unit)? = null,
    enabled: Boolean = true,
) {
    var isVisible by remember { mutableStateOf(!visualTransformation) }

    val labelString = stringResource(label)
    val placeholderString = placeholder?.let { stringResource(it) }
    val showPassword = stringResource(ui.rs.Res.string.text_field_show_password )
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
            label = { Text(labelString, style = MaterialTheme.typography.labelMedium) },
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
            textStyle = MaterialTheme.typography.bodyLarge,
            visualTransformation = if (visualTransformation && !isVisible) {
                PasswordVisualTransformation()
            } else {
                VisualTransformation.None
            },
            keyboardOptions = keyboardOptions,
            keyboardActions = keyboardActions,
            placeholder = placeholderString?.let { placeholderText ->
                {
                    Text(
                        text = placeholderText,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            },
            supportingText = {
                when {
                    errorMessage != null -> Text(
                        text = errorMessage,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.labelSmall,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                    supportingText != null -> supportingText()
                }
            },
            shape = MaterialTheme.shapes.medium
        )
    }
}
