package ui.cp

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable

@Composable
fun Button(label: String, onClick: () -> Unit = {}) {
    androidx.compose.material3.Button(onClick = onClick) {
        Text(label)
    }
}