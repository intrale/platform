package ui.cp

import androidx.compose.foundation.Image
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.platform.LocalContext
import coil.compose.AsyncImagePainter
import coil.compose.rememberAsyncImagePainter
import coil.decode.SvgDecoder
import coil.request.ImageRequest

@Composable
actual fun IntraleIcon(
    assetName: String,
    contentDesc: String?,
    modifier: Modifier,
    tint: Color?
) {
    val context = LocalContext.current
    val normalizedAssetName = remember(assetName) {
        assetName.substringAfterLast('/').ifEmpty { assetName }
    }
    val request = remember(normalizedAssetName, context) {
        ImageRequest.Builder(context)
            .data("file:///android_asset/icons/$normalizedAssetName")
            .decoderFactory(SvgDecoder.Factory())
            .build()
    }
    val painter = rememberAsyncImagePainter(model = request)
    if (painter.state is AsyncImagePainter.State.Success) {
        Image(
            painter = painter,
            contentDescription = contentDesc,
            modifier = modifier,
            colorFilter = tint?.let(ColorFilter::tint)
        )
    }
}
