package android.opengl
object GLES30 {
    const val GL_TRIANGLE_STRIP = 0x0005
    const val GL_FRAMEBUFFER_COMPLETE = 0x8CD5
    const val GL_NEAREST = 0x2600
    const val GL_DEPTH_COMPONENT = 0x1902
    const val GL_RG16F = 0x822F
    const val GL_RG = 0x8227
    const val GL_RGB8 = 0x8051
    const val GL_RGB = 0x1907
    const val GL_UNSIGNED_SHORT = 0x1403
    fun glBlendFuncSeparate(srgb: Int, drgb: Int, sa: Int, da: Int): Unit = Unit
    fun glReadPixels(x: Int, y: Int, w: Int, h: Int, format: Int, type: Int, pixels: java.nio.Buffer?): Unit = Unit
    fun glBufferSubData(target: Int, offset: Int, size: Int, data: java.nio.Buffer?): Unit = Unit

    // --- terrain splat slice: 2D arrays, extra texture units, element buffers, anisotropy ---
    const val GL_TEXTURE_2D_ARRAY = 0x8C1A
    const val GL_TEXTURE5 = 0x84C5
    const val GL_TEXTURE6 = 0x84C6
    const val GL_TEXTURE7 = 0x84C7
    const val GL_ELEMENT_ARRAY_BUFFER = 0x8893
    const val GL_EXTENSIONS = 0x1F03
    const val GL_TEXTURE_MAX_ANISOTROPY_EXT = 0x84FE
    const val GL_POLYGON_OFFSET_FILL = 0x8037
    const val GL_UNSIGNED_INT = 0x1405
    fun glPolygonOffset(factor: Float, units: Float): Unit = Unit
    fun glUniform1fv(location: Int, count: Int, value: FloatArray, offset: Int): Unit = Unit
    fun glDrawElements(mode: Int, count: Int, type: Int, offsets: Int): Unit = Unit
    fun glVertexAttribDivisor(index: Int, divisor: Int): Unit = Unit
    fun glDrawElementsInstanced(mode: Int, count: Int, type: Int, indices: Int, instanceCount: Int): Unit = Unit
    fun glTexParameterf(t: Int, pname: Int, param: Float): Unit = Unit
    fun glGetString(name: Int): String? = ""
    const val GL_ARRAY_BUFFER = 0x8892
    const val GL_BACK = 0x0405
    const val GL_BLEND = 0x0BE2
    const val GL_COLOR_BUFFER_BIT = 0x4000
    const val GL_COMPILE_STATUS = 0x8B81
    const val GL_CULL_FACE = 0x0B44
    const val GL_DEPTH_BUFFER_BIT = 0x0100
    const val GL_DEPTH_TEST = 0x0B71
    const val GL_FLOAT = 0x1406
    const val GL_FRAGMENT_SHADER = 0x8B30
    const val GL_LINK_STATUS = 0x8B82
    const val GL_NO_ERROR = 0
    const val GL_ONE_MINUS_SRC_ALPHA = 0x0303
    const val GL_SRC_ALPHA = 0x0302
    const val GL_STATIC_DRAW = 0x88E4
    const val GL_LEQUAL = 0x0203
    const val GL_LESS = 0x0201
    const val GL_RGBA16F = 0x881A
    const val GL_HALF_FLOAT = 0x8D61
    const val GL_DYNAMIC_DRAW = 0x88E8
    const val GL_TRIANGLES = 0x0004
    const val GL_POINTS = 0x0000
    const val GL_TEXTURE_3D = 0x806F
    const val GL_TEXTURE_WRAP_R = 0x8072
    const val GL_ONE = 0x1
    fun glDepthFunc(func: Int): Unit = Unit
    fun glDisableVertexAttribArray(index: Int): Unit = Unit
    fun glVertexAttrib4f(index: Int, x: Float, y: Float, z: Float, w: Float): Unit = Unit
    fun glUniform4fv(loc: Int, n: Int, v: FloatArray, off: Int): Unit = Unit
    fun glUniform3fv(loc: Int, n: Int, v: FloatArray, off: Int): Unit = Unit
    fun glTexImage3D(t: Int, lvl: Int, ifmt: Int, w: Int, h: Int, d: Int, b: Int, fmt: Int, type: Int, data: java.nio.Buffer?): Unit = Unit
    fun glTexSubImage2D(t: Int, lvl: Int, x: Int, y: Int, w: Int, h: Int, fmt: Int, type: Int, data: java.nio.Buffer?): Unit = Unit
    const val GL_FRONT = 0x0404
    const val GL_TEXTURE4 = 0x84C4
    const val GL_VERTEX_SHADER = 0x8B31
    const val GL_CLAMP_TO_EDGE = 0x812F
    const val GL_LINEAR = 0x2601
    const val GL_LINEAR_MIPMAP_LINEAR = 0x2703
    const val GL_R16F = 0x822D
    const val GL_R8 = 0x8229
    const val GL_RED = 0x1903
    const val GL_REPEAT = 0x2901
    const val GL_RGBA = 0x1908
    const val GL_RGBA8 = 0x8058
    const val GL_TEXTURE0 = 0x84C0
    const val GL_TEXTURE1 = 0x84C1
    const val GL_TEXTURE2 = 0x84C2
    const val GL_TEXTURE3 = 0x84C3
    const val GL_TEXTURE_2D = 0x0DE1
    const val GL_TEXTURE_CUBE_MAP = 0x8513
    const val GL_TEXTURE_MAG_FILTER = 0x2800
    const val GL_TEXTURE_MIN_FILTER = 0x2801
    const val GL_TEXTURE_WRAP_S = 0x2802
    const val GL_TEXTURE_WRAP_T = 0x2803
    const val GL_UNPACK_ALIGNMENT = 0x0CF5
    const val GL_UNSIGNED_BYTE = 0x1401
    fun glAttachShader(p: Int, s: Int): Unit = Unit
    fun glBindBuffer(t: Int, b: Int): Unit = Unit
    fun glBlendFunc(a: Int, b: Int): Unit = Unit
    fun glBufferData(t: Int, size: Int, data: java.nio.Buffer?, usage: Int): Unit = Unit
    fun glClear(m: Int): Unit = Unit
    fun glClearColor(r: Float, g: Float, b: Float, a: Float): Unit = Unit
    fun glCompileShader(s: Int): Unit = Unit
    fun glCreateProgram(): Int = 1
    fun glCreateShader(t: Int): Int = 1
    fun glCullFace(m: Int): Unit = Unit
    fun glDeleteBuffers(n: Int, b: IntArray?, o: Int): Unit = Unit
    fun glDeleteShader(s: Int): Unit = Unit
    fun glDisable(m: Int): Unit = Unit
    fun glDrawArrays(m: Int, f: Int, c: Int): Unit = Unit
    fun glEnable(m: Int): Unit = Unit
    fun glEnableVertexAttribArray(i: Int): Unit = Unit
    fun glGenBuffers(n: Int, b: IntArray?, o: Int): Unit = Unit
    fun glGetError(): Int = 0
    fun glGetUniformLocation(p: Int, n: String): Int = 0
    fun glGetProgramInfoLog(p: Int): String = ""
    fun glGetProgramiv(p: Int, t: Int, out: IntArray, o: Int): Unit = Unit
    fun glGetShaderInfoLog(s: Int): String = ""
    fun glGetShaderiv(s: Int, t: Int, out: IntArray, o: Int): Unit = Unit
    fun glLinkProgram(p: Int): Unit = Unit
    fun glShaderSource(s: Int, src: String): Unit = Unit
    fun glUniform1f(l: Int, v: Float): Unit = Unit
    fun glUniform2f(l: Int, a: Float, b: Float): Unit = Unit
    fun glUniform3f(l: Int, a: Float, b: Float, c: Float): Unit = Unit
    fun glUniform4f(l: Int, a: Float, b: Float, c: Float, d: Float): Unit = Unit
    fun glUniform1i(l: Int, v: Int): Unit = Unit
    fun glUniformMatrix4fv(l: Int, n: Int, t: Boolean, m: FloatArray, o: Int): Unit = Unit
    fun glUseProgram(p: Int): Unit = Unit
    fun glVertexAttribPointer(i: Int, sz: Int, t: Int, n: Boolean, st: Int, o: Int): Unit = Unit
    fun glViewport(x: Int, y: Int, w: Int, h: Int): Unit = Unit
    fun glPointSize(v: Float): Unit = Unit
    fun glActiveTexture(t: Int): Unit = Unit
    fun glBindTexture(t: Int, tex: Int): Unit = Unit
    fun glDepthMask(f: Boolean): Unit = Unit
    fun glGenTextures(n: Int, tex: IntArray, o: Int): Unit = Unit
    fun glDeleteTextures(n: Int, tex: IntArray, o: Int): Unit = Unit
    fun glGenerateMipmap(t: Int): Unit = Unit
    fun glPixelStorei(k: Int, v: Int): Unit = Unit
    fun glTexImage2D(t: Int, lvl: Int, ifmt: Int, w: Int, h: Int, b: Int, fmt: Int, type: Int, data: java.nio.Buffer?): Unit = Unit
    fun glTexParameteri(t: Int, k: Int, v: Int): Unit = Unit
    fun glUniformMatrix3fv(l: Int, n: Int, t: Boolean, m: FloatArray, o: Int): Unit = Unit

const val GL_FRAMEBUFFER = 0x8D40
const val GL_RENDERBUFFER = 0x84D5
const val GL_DEPTH_COMPONENT24 = 0x81A6
const val GL_COLOR_ATTACHMENT0 = 0x8CE0
const val GL_DEPTH_ATTACHMENT = 0x8D00
fun glGenFramebuffers(n: Int, fb: IntArray, o: Int): Unit = Unit
fun glBindFramebuffer(t: Int, fb: Int): Unit = Unit
fun glDeleteFramebuffers(n: Int, fb: IntArray, o: Int): Unit = Unit
fun glGenRenderbuffers(n: Int, rb: IntArray, o: Int): Unit = Unit
fun glBindRenderbuffer(t: Int, rb: Int): Unit = Unit
fun glDeleteRenderbuffers(n: Int, rb: IntArray, o: Int): Unit = Unit
fun glRenderbufferStorage(t: Int, ifmt: Int, w: Int, h: Int): Unit = Unit
fun glFramebufferTexture2D(t: Int, att: Int, texT: Int, tex: Int, lvl: Int): Unit = Unit
fun glFramebufferRenderbuffer(t: Int, att: Int, rbT: Int, rb: Int): Unit = Unit
fun glCheckFramebufferStatus(t: Int): Int = 36053
}
object Matrix {
    fun invertM(m: FloatArray, o: Int, src: FloatArray, so: Int): Unit = Unit
    fun multiplyMM(dst: FloatArray, doff: Int, a: FloatArray, ao: Int, b: FloatArray, bo: Int): Unit = Unit
    fun multiplyMV(dst: FloatArray, doff: Int, m: FloatArray, mo: Int, v: FloatArray, vo: Int): Unit = Unit
    fun perspectiveM(m: FloatArray, o: Int, fovy: Float, aspect: Float, near: Float, far: Float): Unit = Unit
    fun setLookAtM(m: FloatArray, o: Int, ex: Float, ey: Float, ez: Float, tx: Float, ty: Float, tz: Float, ux: Float, uy: Float, uz: Float): Unit = Unit
}
open class GLSurfaceView(context: Any?) : android.widget.FrameLayout(context) {
    interface Renderer {
        fun onSurfaceCreated(gl: javax.microedition.khronos.opengles.GL10?, config: javax.microedition.khronos.egl.EGLConfig?)
        fun onSurfaceChanged(gl: javax.microedition.khronos.opengles.GL10?, w: Int, h: Int)
        fun onDrawFrame(gl: javax.microedition.khronos.opengles.GL10?)
    }
    companion object {
        const val RENDERMODE_CONTINUOUSLY = 1
        const val RENDERMODE_WHEN_DIRTY = 0
    }
    fun setEGLContextClientVersion(v: Int): Unit = Unit
    fun setEGLConfigChooser(r: Int, g: Int, b: Int, a: Int, d: Int, s: Int): Unit = Unit
    fun setRenderer(r: Renderer): Unit = Unit
    var renderMode: Int = 0
    var preserveEGLContextOnPause: Boolean = false

}
