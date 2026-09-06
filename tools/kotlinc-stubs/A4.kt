package android.graphics
class Typeface private constructor() { companion object { val DEFAULT_BOLD = Typeface(); val DEFAULT = Typeface() } }
class RectF() {
    constructor(left: Float, top: Float, right: Float, bottom: Float) : this()
    var left = 0f; var top = 0f; var right = 0f; var bottom = 0f
    fun set(l: Float, t: Float, r: Float, b: Float) { left = l; top = t; right = r; bottom = b }
    fun width(): Float = right - left
    fun height(): Float = bottom - top
}
class Canvas {
    fun save(): Int = 0
    fun restore(): Unit = Unit
    fun clipRect(l: Float, t: Float, r: Float, b: Float): Boolean = true
    fun clipRect(r: RectF): Boolean = true
    fun translate(dx: Float, dy: Float): Unit = Unit
    fun scale(sx: Float, sy: Float, px: Float = 0f, py: Float = 0f): Unit = Unit
    fun drawRoundRect(r: RectF, rx: Float, ry: Float, p: Paint): Unit = Unit
    fun drawText(v: String, x: Float, y: Float, p: Paint): Unit = Unit
    fun drawRect(r: RectF, p: Paint): Unit = Unit
}
class Paint(flags: Int = 0) {
    enum class Style { FILL, STROKE, FILL_AND_STROKE }
    enum class Align { LEFT, CENTER, RIGHT }
    var textSize: Float
        get() = 0f
        set(v: Float) {}
    var textAlign: Align
        get() = Align.LEFT
        set(v: Align) {}
    var typeface: Typeface
        get() = Typeface.DEFAULT
        set(v: Typeface) {}
    var style: Style
        get() = Style.FILL
        set(v: Style) {}
    var color: Int
        get() = 0
        set(v: Int) {}
    var strokeWidth: Float
        get() = 0f
        set(v: Float) {}
    var isAntiAlias: Boolean
        get() = false
        set(v: Boolean) {}
    companion object { const val ANTI_ALIAS_FLAG = 1 }
}
object Color {
    val WHITE = -1
    fun rgb(r: Int, g: Int, b: Int): Int = 0
    fun argb(a: Int, r: Int, g: Int, b: Int): Int = 0
}
