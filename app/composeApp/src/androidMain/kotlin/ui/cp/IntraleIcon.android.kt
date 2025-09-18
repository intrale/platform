package ui.cp

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import coil.compose.AsyncImagePainter
import coil.compose.rememberAsyncImagePainter
import coil.ImageLoader
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
    val imageLoader = remember(context) {
        ImageLoader.Builder(context)
            .components { add(SvgDecoder.Factory()) }
            .respectCacheHeaders(false)
            .build()
    }
    val request = remember(normalizedAssetName, context) {
        ImageRequest.Builder(context)
            .data("file:///android_asset/icons/$normalizedAssetName")
            .decoderFactory(SvgDecoder.Factory())
            .allowHardware(false)
            .build()
    }
    val painter = rememberAsyncImagePainter(
        model = request,
        imageLoader = imageLoader
    )
    when (painter.state) {
        is AsyncImagePainter.State.Success -> {
            Image(
                painter = painter,
                contentDescription = contentDesc,
                modifier = modifier,
                colorFilter = tint?.let(ColorFilter::tint)
            )
        }

        is AsyncImagePainter.State.Loading -> {
            IntraleIconPlaceholder(
                normalizedAssetName = normalizedAssetName,
                modifier = modifier,
                tint = tint
            )
        }

        is AsyncImagePainter.State.Error,
        AsyncImagePainter.State.Empty -> {
            IntraleIconPlaceholder(
                normalizedAssetName = normalizedAssetName,
                modifier = modifier,
                tint = tint
            )
        }
    }
}

@Composable
private fun IntraleIconPlaceholder(
    normalizedAssetName: String,
    modifier: Modifier,
    tint: Color?
) {
    val label = remember(normalizedAssetName) {
        normalizedAssetName
            .substringAfterLast('/')
            .removeSuffix(".svg")
            .replace('_', ' ')
            .trim()
            .ifEmpty { normalizedAssetName }
            .take(10)
    }

    Box(
        modifier = modifier
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f)),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = tint ?: MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 6.dp, vertical = 4.dp)
        )
    }
}
