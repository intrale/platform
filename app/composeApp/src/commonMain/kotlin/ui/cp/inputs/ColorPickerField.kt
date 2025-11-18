package ui.cp.inputs

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import ui.th.spacing
import ui.util.toColorOrNull
import ui.util.toHexString
import ui.util.normalizedHexOr

@Composable
fun ColorPickerField(
    label: MessageKey,
    value: String,
    state: MutableState<InputState>,
    onValueChange: (String) -> Unit
) {
    val normalizedValue = value.normalizedHexOr(value)
    val previewColor = normalizedValue.toColorOrNull() ?: Color.White
    val red = remember { mutableFloatStateOf(previewColor.red * 255f) }
    val green = remember { mutableFloatStateOf(previewColor.green * 255f) }
    val blue = remember { mutableFloatStateOf(previewColor.blue * 255f) }

    LaunchedEffect(normalizedValue) {
        val color = normalizedValue.toColorOrNull() ?: return@LaunchedEffect
        red.floatValue = color.red * 255f
        green.floatValue = color.green * 255f
        blue.floatValue = color.blue * 255f
    }

    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1_5)
    ) {
        TextField(
            label = label,
            value = value,
            state = state,
            onValueChange = { onValueChange(it.uppercase()) },
            leadingIcon = {
                Spacer(
                    modifier = Modifier
                        .size(32.dp)
                        .background(previewColor, MaterialTheme.shapes.small)
                )
            }
        )

        ColorSlider(
            channelLabel = MessageKey.personalization_colors_channel_red,
            channelValue = red.floatValue,
            onChannelChange = { newValue ->
                red.floatValue = newValue
                onValueChange(Color(newValue / 255f, green.floatValue / 255f, blue.floatValue / 255f).toHexString())
            }
        )
        ColorSlider(
            channelLabel = MessageKey.personalization_colors_channel_green,
            channelValue = green.floatValue,
            onChannelChange = { newValue ->
                green.floatValue = newValue
                onValueChange(Color(red.floatValue / 255f, newValue / 255f, blue.floatValue / 255f).toHexString())
            }
        )
        ColorSlider(
            channelLabel = MessageKey.personalization_colors_channel_blue,
            channelValue = blue.floatValue,
            onChannelChange = { newValue ->
                blue.floatValue = newValue
                onValueChange(Color(red.floatValue / 255f, green.floatValue / 255f, newValue / 255f).toHexString())
            }
        )
    }
}

@Composable
private fun ColorSlider(
    channelLabel: MessageKey,
    channelValue: Float,
    onChannelChange: (Float) -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = MaterialTheme.spacing.x1_5)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(text = Txt(channelLabel), style = MaterialTheme.typography.labelMedium)
            Text(text = channelValue.toInt().toString(), style = MaterialTheme.typography.labelSmall)
        }
        Spacer(modifier = Modifier.height(MaterialTheme.spacing.x0_5))
        Slider(
            value = channelValue,
            onValueChange = onChannelChange,
            valueRange = 0f..255f
        )
    }
}
