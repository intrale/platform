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
import ui.rs.text_field_hide_password
import ui.rs.text_field_show_password
import ui.util.RES_ERROR_PREFIX
import ui.util.fb
import ui.util.resString

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
    val labelString = resString(
        composeId = label,
        fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Etiqueta de campo"),
    )
    val placeholderString = placeholder?.let {
        resString(
            composeId = it,
            fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Placeholder de campo"),
        )
    }
    val showPassword = resString(
        composeId = ui.rs.Res.string.text_field_show_password,
        fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Mostrar contrasena"),
    )
    val hidePassword = resString(
        composeId = ui.rs.Res.string.text_field_hide_password,
        fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Ocultar contrasena"),
    )

    TextFieldContent(
        labelString = labelString,
        value = value,
        state = state,
        visualTransformation = visualTransformation,
        onValueChange = onValueChange,
        modifier = modifier,
        leadingIcon = leadingIcon,
        keyboardOptions = keyboardOptions,
        keyboardActions = keyboardActions,
        placeholderString = placeholderString,
        supportingText = supportingText,
        enabled = enabled,
        showPasswordText = showPassword,
        hidePasswordText = hidePassword,
    )
}

@OptIn(ExperimentalResourceApi::class)
@Composable
fun TextField(
    labelText: String,
    value: String,
    state: MutableState<InputState>,
    visualTransformation: Boolean = false,
    onValueChange: (value: String) -> Unit = {},
    modifier: Modifier = Modifier,
    leadingIcon: (@Composable () -> Unit)? = null,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    placeholderText: String? = null,
    supportingText: (@Composable () -> Unit)? = null,
    enabled: Boolean = true,
    showPasswordText: String? = null,
    hidePasswordText: String? = null,
) {
    val showPassword = showPasswordText ?: resString(
        composeId = ui.rs.Res.string.text_field_show_password,
        fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Mostrar contrasena"),
    )
    val hidePassword = hidePasswordText ?: resString(
        composeId = ui.rs.Res.string.text_field_hide_password,
        fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Ocultar contrasena"),
    )

    TextFieldContent(
        labelString = labelText,
        value = value,
        state = state,
        visualTransformation = visualTransformation,
        onValueChange = onValueChange,
        modifier = modifier,
        leadingIcon = leadingIcon,
        keyboardOptions = keyboardOptions,
        keyboardActions = keyboardActions,
        placeholderString = placeholderText,
        supportingText = supportingText,
        enabled = enabled,
        showPasswordText = showPassword,
        hidePasswordText = hidePassword,
    )
}

@Composable
private fun TextFieldContent(
    labelString: String,
    value: String,
    state: MutableState<InputState>,
    visualTransformation: Boolean,
    onValueChange: (value: String) -> Unit,
    modifier: Modifier,
    leadingIcon: (@Composable () -> Unit)?,
    keyboardOptions: KeyboardOptions,
    keyboardActions: KeyboardActions,
    placeholderString: String?,
    supportingText: (@Composable () -> Unit)?,
    enabled: Boolean,
    showPasswordText: String,
    hidePasswordText: String,
) {
    var isVisible by remember { mutableStateOf(!visualTransformation) }

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
                        val description = if (isVisible) hidePasswordText else showPasswordText
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
