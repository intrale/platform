package ui.cp

import androidx.compose.material3.Text
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ButtonColors
import androidx.compose.runtime.Composable

@Composable
fun Button(
    label: String,
    onClick: () -> Unit = {},
    loading: Boolean = false,
    enabled: Boolean = true,
    colors: ButtonColors = ButtonDefaults.buttonColors()
) {
    androidx.compose.material3.Button(
        onClick = onClick,
        enabled = enabled && !loading,
        colors = colors
    ) {
        if (loading) {
            CircularProgressIndicator()
        } else {
            Text(label)
        }
    }
}