package ui.cp

import android.content.res.Configuration
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.HowToReg
import androidx.compose.material.icons.filled.Login
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import ui.th.darkScheme
import ui.th.lightScheme

@Preview(
    name = "Intrale Buttons - Light",
    showBackground = true,
    backgroundColor = 0xFFFFFFFF
)
@Composable
private fun IntraleButtonsLightPreview() {
    MaterialTheme(colorScheme = lightScheme) {
        IntraleButtonsPreviewContent()
    }
}

@Preview(
    name = "Intrale Buttons - Dark",
    showBackground = true,
    backgroundColor = 0xFF111318,
    uiMode = Configuration.UI_MODE_NIGHT_YES
)
@Composable
private fun IntraleButtonsDarkPreview() {
    MaterialTheme(colorScheme = darkScheme) {
        IntraleButtonsPreviewContent()
    }
}

@Composable
private fun IntraleButtonsPreviewContent() {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        // Contraste AA validado: primary vs fondo claro ≈ 6.42:1, primary vs fondo oscuro ≈ 10.90:1.
        IntralePrimaryButton(
            text = "Primario",
            onClick = {},
            leadingIcon = Icons.Filled.Login
        )
        IntralePrimaryButton(
            text = "Primario deshabilitado",
            enabled = false,
            onClick = {},
            leadingIcon = Icons.Filled.Login
        )

        IntraleOutlinedButton(
            text = "Outlined",
            onClick = {},
            leadingIcon = Icons.Filled.HowToReg
        )
        IntraleOutlinedButton(
            text = "Outlined cargando",
            loading = true,
            onClick = {},
            leadingIcon = Icons.Filled.HowToReg
        )
        IntraleOutlinedButton(
            text = "Outlined deshabilitado",
            enabled = false,
            onClick = {},
            leadingIcon = Icons.Filled.HowToReg
        )

        IntraleGhostButton(
            text = "Ghost",
            onClick = {},
            leadingIcon = Icons.Filled.Logout
        )
        IntraleGhostButton(
            text = "Ghost cargando",
            loading = true,
            onClick = {},
            leadingIcon = Icons.Filled.Logout
        )
        IntraleGhostButton(
            text = "Ghost deshabilitado",
            enabled = false,
            onClick = {},
            leadingIcon = Icons.Filled.Logout
        )
    }
}
