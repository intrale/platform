package ui.cp.icons

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color

@Composable
expect fun IntraleIcon(
    assetName: String,
    contentDesc: String? = null,
    modifier: Modifier = Modifier,
    tint: Color? = null
)
