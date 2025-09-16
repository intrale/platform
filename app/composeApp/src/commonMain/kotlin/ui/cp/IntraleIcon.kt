package ui.cp

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

@Composable
expect fun IntraleIcon(
    assetName: String,
    contentDesc: String? = null,
    modifier: Modifier = Modifier
)
