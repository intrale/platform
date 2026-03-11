package ui.cp.inputs

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey

@Composable
fun PasswordMatchIndicator(
    password: String,
    confirmPassword: String,
    modifier: Modifier = Modifier,
) {
    if (confirmPassword.isEmpty()) return

    val matches = password == confirmPassword
    val iconColor = if (matches) Color(0xFF4CAF50) else MaterialTheme.colorScheme.error
    val icon = if (matches) Icons.Filled.CheckCircle else Icons.Filled.Cancel
    val label = if (matches) Txt(MessageKey.password_match) else Txt(MessageKey.password_no_match)

    Row(
        modifier = modifier,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = label,
            tint = iconColor,
            modifier = Modifier.size(16.dp),
        )
        Spacer(modifier = Modifier.width(4.dp))
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = iconColor,
        )
    }
}
