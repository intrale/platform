package ui.cp.inputs

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.unit.dp
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey

enum class PasswordStrength {
    WEAK, MEDIUM, STRONG
}

fun calculatePasswordStrength(password: String): PasswordStrength {
    if (password.length < 8) return PasswordStrength.WEAK
    val hasLetters = password.any { it.isLetter() }
    val hasDigits = password.any { it.isDigit() }
    val hasSymbols = password.any { !it.isLetterOrDigit() }
    return when {
        hasLetters && hasDigits && hasSymbols -> PasswordStrength.STRONG
        hasLetters && hasDigits -> PasswordStrength.MEDIUM
        else -> PasswordStrength.WEAK
    }
}

@Composable
fun PasswordStrengthIndicator(
    password: String,
    modifier: Modifier = Modifier,
) {
    if (password.isEmpty()) return

    val strength = calculatePasswordStrength(password)

    val strengthColor = when (strength) {
        PasswordStrength.WEAK -> Color(0xFFF44336)
        PasswordStrength.MEDIUM -> Color(0xFFFFC107)
        PasswordStrength.STRONG -> Color(0xFF4CAF50)
    }

    val strengthProgress = when (strength) {
        PasswordStrength.WEAK -> 0.33f
        PasswordStrength.MEDIUM -> 0.66f
        PasswordStrength.STRONG -> 1.0f
    }

    val strengthLabel = when (strength) {
        PasswordStrength.WEAK -> Txt(MessageKey.password_strength_weak)
        PasswordStrength.MEDIUM -> Txt(MessageKey.password_strength_medium)
        PasswordStrength.STRONG -> Txt(MessageKey.password_strength_strong)
    }

    val hintText = when (strength) {
        PasswordStrength.WEAK -> Txt(MessageKey.password_strength_hint_weak)
        PasswordStrength.MEDIUM -> Txt(MessageKey.password_strength_hint_medium)
        PasswordStrength.STRONG -> Txt(MessageKey.password_strength_hint_strong)
    }

    val animatedColor by animateColorAsState(
        targetValue = strengthColor,
        animationSpec = tween(durationMillis = 300),
        label = "strengthColor"
    )

    val animatedProgress by animateFloatAsState(
        targetValue = strengthProgress,
        animationSpec = tween(durationMillis = 300),
        label = "strengthProgress"
    )

    Column(modifier = modifier.fillMaxWidth()) {
        LinearProgressIndicator(
            progress = { animatedProgress },
            modifier = Modifier
                .fillMaxWidth()
                .height(6.dp),
            color = animatedColor,
            trackColor = MaterialTheme.colorScheme.surfaceVariant,
            strokeCap = StrokeCap.Round,
        )
        Text(
            text = "$strengthLabel — $hintText",
            style = MaterialTheme.typography.labelSmall,
            color = animatedColor,
            modifier = Modifier.padding(top = 2.dp),
        )
    }
}
