package com.labteto.dshmobile.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.ui.unit.dp

/**
 * DeepSeek Harness radius tokens:
 * capsules r18/r22/r24, cards r12, dialogs r24, bubbles r22, code blocks r12,
 * pills r12, tooltips r8, toasts r14, chips r6, tree rows r8.
 */
object DsShapes {
    val buttonCapsule = RoundedCornerShape(18.dp)
    val buttonSmall = RoundedCornerShape(14.dp)
    val bubble = RoundedCornerShape(22.dp)
    val composer = RoundedCornerShape(22.dp)
    val approvalCard = RoundedCornerShape(20.dp)
    val dialog = RoundedCornerShape(24.dp)
    val menu = RoundedCornerShape(12.dp)
    val toast = RoundedCornerShape(14.dp)
    val tooltip = RoundedCornerShape(8.dp)
    val block = RoundedCornerShape(12.dp)
    val pill = RoundedCornerShape(12.dp)
    val pillFull = RoundedCornerShape(999.dp)
    val chip = RoundedCornerShape(6.dp)
    val row = RoundedCornerShape(8.dp)
    val cube = RoundedCornerShape(16.dp)
}

val DsMaterialShapes = Shapes(
    extraSmall = DsShapes.chip,
    small = DsShapes.menu,
    medium = DsShapes.block,
    large = DsShapes.composer,
    extraLarge = DsShapes.dialog,
)
