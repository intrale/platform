@file:OptIn(ExperimentalResourceApi::class)

package ui.th

import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.jetbrains.compose.resources.Font
import ui.rs.Res

@Composable
fun IntraleTypography(): Typography {
    val regular = Font(Res.font.intrale_regular, weight = FontWeight.Normal)
    val medium = Font(Res.font.intrale_medium, weight = FontWeight.Medium)
    val semiBold = Font(Res.font.intrale_semibold, weight = FontWeight.SemiBold)

    val intraleFontFamily = remember(regular, medium, semiBold) {
        FontFamily(regular, medium, semiBold)
    }

    return remember(intraleFontFamily) {
        Typography(
            displayLarge = TextStyle(
                fontFamily = intraleFontFamily,
                fontWeight = FontWeight.SemiBold,
                fontSize = 40.sp,
                lineHeight = 48.sp
            ),
            headlineMedium = TextStyle(
                fontFamily = intraleFontFamily,
                fontWeight = FontWeight.SemiBold,
                fontSize = 28.sp,
                lineHeight = 36.sp
            ),
            titleLarge = TextStyle(
                fontFamily = intraleFontFamily,
                fontWeight = FontWeight.SemiBold,
                fontSize = 22.sp,
                lineHeight = 28.sp
            ),
            titleMedium = TextStyle(
                fontFamily = intraleFontFamily,
                fontWeight = FontWeight.Medium,
                fontSize = 18.sp,
                lineHeight = 24.sp
            ),
            titleSmall = TextStyle(
                fontFamily = intraleFontFamily,
                fontWeight = FontWeight.Medium,
                fontSize = 16.sp,
                lineHeight = 22.sp
            ),
            bodyLarge = TextStyle(
                fontFamily = intraleFontFamily,
                fontWeight = FontWeight.Normal,
                fontSize = 16.sp,
                lineHeight = 24.sp
            ),
            bodyMedium = TextStyle(
                fontFamily = intraleFontFamily,
                fontWeight = FontWeight.Normal,
                fontSize = 14.sp,
                lineHeight = 20.sp
            ),
            bodySmall = TextStyle(
                fontFamily = intraleFontFamily,
                fontWeight = FontWeight.Normal,
                fontSize = 12.sp,
                lineHeight = 16.sp
            ),
            labelLarge = TextStyle(
                fontFamily = intraleFontFamily,
                fontWeight = FontWeight.SemiBold,
                fontSize = 16.sp,
                lineHeight = 20.sp
            ),
            labelMedium = TextStyle(
                fontFamily = intraleFontFamily,
                fontWeight = FontWeight.Medium,
                fontSize = 14.sp,
                lineHeight = 18.sp
            ),
            labelSmall = TextStyle(
                fontFamily = intraleFontFamily,
                fontWeight = FontWeight.Medium,
                fontSize = 12.sp,
                lineHeight = 16.sp
            )
        )
    }
}
