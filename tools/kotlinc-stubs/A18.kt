package android.graphics
class Typeface private constructor() {
    companion object { val DEFAULT = Typeface(); val DEFAULT_BOLD = Typeface(); fun create(a: String, b: Int): Typeface = Typeface() }
}
class Path
object Color {
    val WHITE = -1
    val BLACK = -16777216
    fun argb(a: Int, r: Int, g: Int, b: Int): Int = (a shl 24) or (r shl 16) or (g shl 8) or b
    fun rgb(r: Int, g: Int, b: Int): Int = (0xFF shl 24) or (r shl 16) or (g shl 8) or b
}
