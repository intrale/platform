package ui.cp

import androidx.compose.material3.Text
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable

@Composable
fun Button(
    label: String,
    onClick: () -> Unit = {},
    loading: Boolean = false,
    enabled: Boolean = true
) {
    androidx.compose.material3.Button(
        onClick = onClick,
        enabled = enabled && !loading
    ) {
        if (loading) {
            CircularProgressIndicator()
        } else {
            Text(label)
        }
    }
}