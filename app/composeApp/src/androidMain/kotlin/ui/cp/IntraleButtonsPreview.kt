package ui.cp

import android.content.res.Configuration
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
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
        // Contraste AA validado con el gradiente accesible y texto blanco en ambos extremos.
        IntralePrimaryButton(
            text = "Primario",
            iconAsset = "ic_login.svg",
            onClick = {}
        )
        IntralePrimaryButton(
            text = "Primario deshabilitado",
            iconAsset = "ic_login.svg",
            enabled = false,
            onClick = {}
        )

        IntraleOutlinedButton(
            text = "Outlined",
            iconAsset = "ic_register.svg",
            onClick = {}
        )
        IntraleOutlinedButton(
            text = "Outlined cargando",
            iconAsset = "ic_register.svg",
            loading = true,
            onClick = {}
        )
        IntraleOutlinedButton(
            text = "Outlined deshabilitado",
            iconAsset = "ic_register.svg",
            enabled = false,
            onClick = {}
        )

        IntraleGhostButton(
            text = "Ghost",
            iconAsset = "ic_logout.svg",
            onClick = {}
        )
        IntraleGhostButton(
            text = "Ghost cargando",
            iconAsset = "ic_logout.svg",
            loading = true,
            onClick = {}
        )
        IntraleGhostButton(
            text = "Ghost deshabilitado",
            iconAsset = "ic_logout.svg",
            enabled = false,
            onClick = {}
        )
    }
}
