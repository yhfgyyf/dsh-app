package com.labteto.dshmobile.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * DeepSeek Harness design tokens, ported from
 * packages/client/ui-theme/src/styles/design-platform.css (harness repo).
 * Static primitive scales + semantic alias tokens for light and dark.
 */

// ---- Primitive scales (identical in light & dark) ---------------------------

object Ds {
    // Neutral-bluish UI scale
    val Bluish00 = Color(0xFFFFFFFF)
    val Bluish50 = Color(0xFFF9FAFB)
    val Bluish60 = Color(0xFFF5F6F7)
    val Bluish75 = Color(0xFFF1F3F5)
    val Bluish100 = Color(0xFFEBEEF2)
    val Bluish150 = Color(0xFFE9ECF2)
    val Bluish200 = Color(0xFFE1E5EE)
    val Bluish300 = Color(0xFFCFD3D6)
    val Bluish400 = Color(0xFFADB2B8)
    val Bluish500 = Color(0xFF979DA6)
    val Bluish600 = Color(0xFF81858C)
    val Bluish700 = Color(0xFF61666B)
    val Bluish750 = Color(0xFF43454A)
    val Bluish800 = Color(0xFF353638)
    val Bluish850 = Color(0xFF2C2C2E)
    val Bluish875 = Color(0xFF232324)
    val Bluish900 = Color(0xFF1B1B1C)
    val Bluish950 = Color(0xFF151517)
    val Bluish1000 = Color(0xFF0F1115)

    // DeepSeek brand blue
    val Deepseek50 = Color(0xFFEDF3FE)
    val Deepseek100 = Color(0xFFE4EDFD)
    val Deepseek200 = Color(0xFFD3E2FF)
    val Deepseek300 = Color(0xFFB7C8FE)
    val Deepseek400 = Color(0xFF679EFE)
    val Deepseek450 = Color(0xFF5686FE)
    val Deepseek500 = Color(0xFF4176E6)
    val Deepseek600 = Color(0xFF4868B2)
    val Deepseek800 = Color(0xFF34415B)
    val Deepseek900 = Color(0xFF283142)

    // Semantic
    val Green100 = Color(0xFFE6FAED)
    val Green400 = Color(0xFF4ED17E)
    val Green500 = Color(0xFF22C55E)
    val Green900 = Color(0xFF233C2C)
    val Red50 = Color(0xFFFEF2F2)
    val Red100 = Color(0xFFFEE2E2)
    val Red400 = Color(0xFFF25A5A)
    val Red500 = Color(0xFFEF4444)
    val Red600 = Color(0xFFEC1313)
    val Red900 = Color(0xFF570C0C)
    val Amber100 = Color(0xFFFEF5E7)
    val Amber400 = Color(0xFFF7AD31)
    val Amber500 = Color(0xFFF59E0B)
    val Amber600 = Color(0xFFDD8629)
    val Amber900 = Color(0xFF27241F)

    // Syntax colors (shiki.css, light theme)
    val SyntaxConstant = Color(0xFF1C7ED6)
    val SyntaxString = Color(0xFF2F9E44)
    val SyntaxComment = Color(0xFF868E96)
    val SyntaxKeyword = Color(0xFFD6336C)
    val SyntaxParameter = Color(0xFFE8590C)
    val SyntaxFunction = Color(0xFF6741D9)
    val SyntaxPunctuation = Color(0xFF495057)
    val SyntaxLink = Color(0xFF1971C2)

    // Context meter tints
    val MeterSystem = Color(0xFFADB2B8)
    val MeterTools = Color(0xFFA78BFA)
    val MeterMessages = Color(0xFF4D93F8)
}

/** Semantic alias tokens for the light theme. */
object DsLight {
    val bgBase = Ds.Bluish00
    val bgLayer1 = Color(0xFFFFFFFF)
    val bgLayer2 = Color(0xFFFFFFFF)
    val bgLayer3 = Color(0xFFFFFFFF)
    val bgModulePlatform = Ds.Bluish60
    val borderL1 = Color(0x0A000000) // rgba(0,0,0,.04)
    val borderL2 = Color(0x1A000000) // rgba(0,0,0,.10)
    val borderL3 = Color(0x1F000000) // rgba(0,0,0,.12)
    val brandPrimary = Ds.Bluish1000 // ink button fill
    val onBrandPrimary = Color(0xFFFFFFFF)
    val labelPrimary = Ds.Bluish1000
    val labelSecondary = Ds.Bluish700
    val labelTertiary = Ds.Bluish600
    val labelCaption = Ds.Bluish400
    val labelDimmed = Ds.Bluish200
    val accent = Ds.Deepseek500
    val onAccent = Color(0xFFFFFFFF)
    val accentTertiary = Ds.Deepseek100
    val accentHover = Ds.Deepseek400
    val hover = Color(0x0F263148) // rgba(38,49,72,.06)
    val hoverSolid = Ds.Bluish75
    val hoverAccent = Color(0x24263148) // rgba(38,49,72,.14)
    val active = Color(0x1A263148) // rgba(38,49,72,.10)
    val dangerHover = Color(0x0DEC1313) // rgba(236,19,19,.05)
    val buttonPrimaryHover = Ds.Bluish750
    val buttonPrimaryDimmed = Ds.Bluish100
    val buttonInfoFill = Ds.Deepseek500
    val buttonInfoHover = Ds.Deepseek400
    val error = Ds.Red600
    val errorSecondary = Ds.Red400
    val errorTertiary = Ds.Red50
    val success = Ds.Green500
    val successSecondary = Ds.Green400
    val successTertiary = Ds.Green100
    val warnLabel = Ds.Amber600
    val warn = Ds.Amber500
    val warnSecondary = Ds.Amber400
    val warnTertiary = Ds.Amber100
    val toastBg = Ds.Bluish800
    val tooltipBg = Ds.Bluish850
    /**
     * One step darker than the harness's own `--dsw-specific-bubble` (`Deepseek50`), and the one
     * deliberate divergence in this table.
     *
     * The web value is 1.06:1 against the white transcript — legible there only because the bubble
     * is a wide pill in a 748px column on a desk monitor. At phone size and phone brightness the
     * shape stopped reading, and a message you cannot tell apart from the assistant's is a worse
     * failure than a fill that is a shade off the reference.
     */
    val userBubble = Ds.Deepseek100
    val userBubbleHighlight = Ds.Deepseek200
    val composerCard = Color(0xFFFFFFFF)
    val sidebar = Ds.Bluish50
    val sidebarNavActive = Ds.Bluish100
    val sidebarNavAccent = Ds.Deepseek100
    val sidebarNavHover = Ds.Bluish75
    val tipSurface = Ds.Bluish60
    val codeBlockBg = Ds.Bluish50
    val codeBlockBanner = Ds.Bluish50
    val inlineCode = Ds.Bluish100
    val citation = Ds.Bluish100
    val markdownTag = Ds.Bluish75
    val overlayMask = Color(0x3D000000) // rgba(0,0,0,.24)
}

/** Semantic alias tokens for the dark theme. */
object DsDark {
    val bgBase = Ds.Bluish950
    val bgLayer1 = Ds.Bluish875
    val bgLayer2 = Ds.Bluish850
    val bgLayer3 = Ds.Bluish800
    val bgModulePlatform = Ds.Bluish800
    val borderL1 = Color(0x0FFFFFFF) // rgba(255,255,255,.06)
    val borderL2 = Color(0x1FFFFFFF) // rgba(255,255,255,.12)
    val borderL3 = Color(0x29FFFFFF) // rgba(255,255,255,.16)
    val brandPrimary = Ds.Bluish50 // inverted ink button fill
    val onBrandPrimary = Ds.Bluish1000
    val labelPrimary = Ds.Bluish50
    val labelSecondary = Ds.Bluish300
    val labelTertiary = Ds.Bluish400
    val labelCaption = Ds.Bluish600
    val labelDimmed = Ds.Bluish750
    val accent = Ds.Deepseek400
    val onAccent = Color(0xFFFFFFFF)
    val accentTertiary = Ds.Deepseek800
    val accentHover = Ds.Deepseek500
    val hover = Color(0x14FFFFFF) // rgba(255,255,255,.08)
    val hoverSolid = Ds.Bluish850
    val hoverAccent = Color(0x3DFFFFFF) // rgba(255,255,255,.24)
    val active = Color(0x24FFFFFF) // rgba(255,255,255,.14)
    val dangerHover = Color(0x26F25A5A) // rgba(242,90,90,.15)
    val buttonPrimaryHover = Ds.Bluish100
    val buttonPrimaryDimmed = Ds.Bluish750
    val buttonInfoFill = Ds.Deepseek400
    val buttonInfoHover = Ds.Deepseek500
    val error = Ds.Red400
    val errorSecondary = Ds.Red400
    val errorTertiary = Ds.Red900
    val success = Ds.Green500
    val successSecondary = Ds.Green400
    val successTertiary = Ds.Green900
    val warnLabel = Ds.Amber600
    val warn = Ds.Amber500
    val warnSecondary = Ds.Amber400
    val warnTertiary = Ds.Amber900
    val toastBg = Ds.Bluish750
    val tooltipBg = Ds.Bluish750
    val userBubble = Ds.Bluish850
    val userBubbleHighlight = Ds.Bluish750
    val composerCard = Ds.Bluish850
    val sidebar = Ds.Bluish900
    val sidebarNavActive = Ds.Bluish750
    val sidebarNavAccent = Ds.Bluish800
    val sidebarNavHover = Ds.Bluish850
    val tipSurface = Ds.Bluish800
    val codeBlockBg = Ds.Bluish900
    val codeBlockBanner = Ds.Bluish875
    val inlineCode = Ds.Bluish850
    val citation = Ds.Bluish800
    val markdownTag = Ds.Bluish850
    val overlayMask = Color(0x80000000) // rgba(0,0,0,.5)
}
