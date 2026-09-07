package android.content
open class Context {
    companion object { const val MODE_PRIVATE = 0 }
    open fun getSharedPreferences(n: String, m: Int): SharedPreferences = SharedPreferences()
    val applicationContext: Context get() = this
    val assets: android.content.res.AssetManager = android.content.res.AssetManager()
}

class SharedPreferences {
    interface Editor {
        fun putInt(k: String, v: Int): Editor
        fun putFloat(k: String, v: Float): Editor
        fun putString(k: String, v: String?): Editor
        fun apply()
    }
    fun getInt(k: String, d: Int): Int = d
    fun getFloat(k: String, d: Float): Float = d
    fun getString(k: String, d: String?): String? = d
    fun edit(): Editor = EditorImpl()
    class EditorImpl : Editor {
        override fun putInt(k: String, v: Int) = this
        override fun putFloat(k: String, v: Float) = this
        override fun putString(k: String, v: String?) = this
        override fun apply() {}
    }
}
