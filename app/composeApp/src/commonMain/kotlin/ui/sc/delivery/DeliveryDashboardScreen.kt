package ui.sc.delivery

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.IntralePrimaryButton
import ui.sc.shared.Screen
import ui.th.elevations
import ui.th.spacing

const val DELIVERY_DASHBOARD_PATH = "/delivery/dashboard"

class DeliveryDashboardScreen : Screen(DELIVERY_DASHBOARD_PATH) {

    override val messageTitle: MessageKey = MessageKey.delivery_dashboard_title

    private val logger = LoggerFactory.default.newLogger<DeliveryDashboardScreen>()

    @Composable
    override fun screen() {
        LaunchedEffect(Unit) {
            logger.info { "[Delivery] Mostrando dashboard inicial" }
        }

        val title = Txt(MessageKey.delivery_dashboard_title)
        val subtitle = Txt(MessageKey.delivery_dashboard_subtitle)
        val profileCta = Txt(MessageKey.delivery_dashboard_profile_cta)

        Surface(
            modifier = Modifier.fillMaxSize(),
            tonalElevation = MaterialTheme.elevations.level2
        ) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(MaterialTheme.spacing.x4),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.headlineSmall,
                    textAlign = TextAlign.Center
                )
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = MaterialTheme.spacing.x2)
                )
                IntralePrimaryButton(
                    text = profileCta,
                    onClick = { navigate(DELIVERY_PROFILE_PATH) },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = MaterialTheme.spacing.x4),
                    leadingIcon = Icons.Default.Person,
                    iconContentDescription = profileCta
                )
            }
        }
    }
}
