package ui.session

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

object LookAndFeelStore {
    private val mutablePalette = MutableStateFlow(BusinessColorPalette())

    val palette: StateFlow<BusinessColorPalette> = mutablePalette.asStateFlow()

    fun updatePalette(palette: BusinessColorPalette) {
        mutablePalette.value = palette.normalized()
    }

    fun reset() {
        updatePalette(BusinessColorPalette())
    }
}
