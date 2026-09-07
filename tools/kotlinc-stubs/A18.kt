package android.graphics
open class Shader {
    enum class TileMode { CLAMP, REPEAT, MIRROR }
}
class LinearGradient(startX: Float, startY: Float, endX: Float, endY: Float, colors: IntArray, positions: FloatArray?, tile: Shader.TileMode) : Shader()
class Typeface private constructor() {
    companion object { val DEFAULT = Typeface(); val DEFAULT_BOLD = Typeface(); fun create(a: String, b: Int): Typeface = Typeface() }
}
class Path {
    constructor()
    fun moveTo(x: Float, y: Float): Path = this
    fun quadTo(x1: Float, y1: Float, x2: Float, y2: Float): Path = this
    fun close(): Path = this
}
object Color {
    val WHITE = -1
    val BLACK = -16777216
    fun argb(a: Int, r: Int, g: Int, b: Int): Int = (a shl 24) or (r shl 16) or (g shl 8) or b
    fun rgb(r: Int, g: Int, b: Int): Int = (0xFF shl 24) or (r shl 16) or (g shl 8) or b
}
