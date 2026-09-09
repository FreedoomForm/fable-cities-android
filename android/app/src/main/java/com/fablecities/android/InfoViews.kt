package com.fablecities.android

import android.opengl.GLES30

/**
 * The site's info-view system, native port of src/modules/simulation/infoview.js +
 * src/modules/ui/infoview.js (legend). This file owns the GPU-side pieces:
 *
 *  - VS_INFOOVERLAY / FS_INFOOVERLAY — the terrain-draped coverage plane: a three-stop ramp
 *    (crimson where the city is built but the service cannot reach, amber at the thin edge,
 *    the service's own colour as a whisper where it is fully served), a hatched gap wash,
 *    one crisp ring + soft glow per facility (max 48), a composite boundary line, and the
 *    site's exponential fog.
 *  - INFO_VIEWS metadata (label / desc / legend stops / invert) mirrored from ui/catalog.js
 *    for the HUD legend panel.
 *  - trafficColor() — roads/index.js traffic load → sRGB tint (green / amber / red).
 *
 * The texture bake, mesh drape and draw calls live in GlCityRenderer (they need the
 * renderer's private world data).
 */
object InfoViews {

    // ------------------------------------------------------------------ shader sources

    val VS_INFOOVERLAY = """
        #version 300 es
        precision highp float;
        layout(location=0) in vec2 aXZ;   // world-plane vertex (metres)
        layout(location=1) in float aY;   // draped terrain height + 0.45
        uniform mat4 uVP;
        out vec2 vUv;
        out vec3 vWorld;
        void main() {
            vWorld = vec3(aXZ.x, aY, aXZ.y);
            // uv: world 2048 m → 0..1 (matches the 8 m texel bake, ClampToEdge)
            vUv = aXZ / 2048.0 + 0.5;
            gl_Position = uVP * vec4(vWorld, 1.0);
        }
    """

    val FS_INFOOVERLAY = """
        #version 300 es
        precision highp float;
        uniform sampler2D tex;            // R coverage (strain-scaled), G boundary ramp, B developed mask
        uniform vec3 colCovered;
        uniform vec3 colWarn;
        uniform vec3 colBad;
        uniform vec3 colRing;
        uniform vec4 uRings[48];          // x, z, radius, weight
        uniform int ringCount;
        uniform float edgeLine;           // 1 = composite boundary line (no rings)
        uniform float dim;                // the desaturate-under-info-view dim (web: grading sat 0.55)
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        uniform vec3 uCamPos;
        in vec2 vUv;
        in vec3 vWorld;
        out vec4 fragColor;
        void main() {
            vec4 s = texture(tex, vUv);
            float c = s.r;            // coverage 0..1 (strain-scaled)
            float sdn = s.g;          // 0.5 at the coverage boundary, < 0.5 outside
            float dev = s.b;          // developed-area mask (blurred)
            float devM = smoothstep(0.05, 0.34, dev);
            float strength = smoothstep(0.02, 0.85, c);

            // Three-stop ramp: crimson (no service) -> amber (thin) -> the service colour (served).
            vec3 col = mix(colBad, colWarn, smoothstep(0.0, 0.34, strength));
            col = mix(col, colCovered, smoothstep(0.30, 0.88, strength));

            // Served land gets a whisper of colour; built land the service cannot reach gets a
            // strong warning wash, hatched so the gap reads as a gap and not as a tint.
            float aServed = (0.040 + 0.080 * strength) * devM;
            float gap = 1.0 - smoothstep(0.02, 0.32, strength);
            float hatch = smoothstep(0.42, 0.58, fract((vWorld.x + vWorld.z) * 0.055));
            float aGap = gap * devM * 0.38 * (0.62 + 0.38 * hatch);
            float a = max(aServed, aGap);

            // boundary line for composite views
            float edge = (1.0 - smoothstep(0.0, 0.018, abs(sdn - 0.5))) * edgeLine;
            col = mix(col, vec3(1.0), edge * 0.55);
            a = max(a, edge * 0.5);

            // one crisp anti-aliased ring per facility of the selected type, with a soft outer glow
            float ring = 0.0, glow = 0.0;
            for (int i = 0; i < 48; i++) {
                if (i >= ringCount) break;
                vec4 r = uRings[i];
                float d = abs(length(vWorld.xz - r.xy) - r.z);
                float w = fwidth(d) * 1.8 + 1.6;
                ring = max(ring, (1.0 - smoothstep(0.0, w, d)) * r.w);
                glow = max(glow, exp(-d * 0.045) * r.w);
            }
            col = mix(col, colRing, max(ring * 0.92, glow * 0.35));
            a = max(a, ring * 0.92 + glow * 0.16);

            // the site's fog (terrain FS: fog = 1 - exp(-d * density))
            float dist = length(vWorld - uCamPos);
            float fog = 1.0 - exp(-dist * uFogDensity);
            fragColor = vec4(mix(col * dim, uFogColor, fog), a * mix(1.0, 0.6, 1.0 - dim));
        }
    """

    // ------------------------------------------------------------------ traffic tint

    /** Traffic tint shader: per-vertex colour quad strips along the lane polylines. */
    val VS_TRAFFIC_TINT = """
        #version 300 es
        precision highp float;
        layout(location=0) in vec3 aPos;
        layout(location=1) in vec4 aCol;
        uniform mat4 uVP;
        out vec4 vCol;
        out vec3 vWorld;
        void main() {
            vCol = aCol;
            vWorld = aPos;
            gl_Position = uVP * vec4(aPos, 1.0);
        }
    """

    val FS_TRAFFIC_TINT = """
        #version 300 es
        precision highp float;
        uniform float uAlpha;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        uniform vec3 uCamPos;
        in vec4 vCol;
        in vec3 vWorld;
        out vec4 fragColor;
        void main() {
            float d = length(vWorld - uCamPos);
            float fog = 1.0 - exp(-d * uFogDensity);
            fragColor = vec4(mix(vCol.rgb, uFogColor, fog), vCol.a * uAlpha);
        }
    """

    /** roads/index.js trafficColor: load 0..1 → green / amber / red (sRGB). */
    fun trafficColor(t: Double, out: FloatArray) {
        val t = t.coerceIn(0.0, 1.0)
        if (t < 0.5) {
            out[0] = (0.25 + 1.4 * t).toFloat(); out[1] = 0.78f; out[2] = (0.25 - 0.1 * t).toFloat()
        } else {
            out[0] = 0.95f; out[1] = (0.78 - 1.2 * (t - 0.5)).toFloat(); out[2] = (0.2 - 0.1 * (t - 0.5)).toFloat()
        }
    }

    // ------------------------------------------------------------------ HUD legend metadata

    /** ui/catalog.js INFO_VIEWS legend + copy (the bits the legend panel shows). */
    class ViewDef(
        val id: String, val label: String, val desc: String, val color: String,
        val low: String?, val high: String?, val stops: List<String>?,
        val chips: Boolean,           // zoning: categorical chips instead of a gradient
        val service: String?,         // power/water: drives the coverage overlay
        val invert: Boolean,          // traffic/pollution: red is bad AND low values are good
    )

    val VIEWS = listOf(
        ViewDef("traffic", "Traffic Flow",
            "Colour roads by congestion — green free-flowing, red jammed.",
            "#ff8a65", "Free flow", "Jammed",
            listOf("#3ddc84", "#ffd54f", "#ff7043", "#d50000"), false, null, true),
        ViewDef("landvalue", "Land Value",
            "Where the city is worth the most. Parks, water and services raise it.",
            "#ffd66b", "Low", "High",
            listOf("#1e3a5f", "#2b8ac6", "#6fe08c", "#ffd66b"), false, null, false),
        ViewDef("pollution", "Pollution",
            "Ground and air pollution from industry, traffic and landfills.",
            "#b58cff", "Clean", "Toxic",
            listOf("#2ea86f", "#c8b560", "#9b6b3f", "#5d2e8c"), false, null, true),
        ViewDef("happiness", "Happiness",
            "How content each household is. Fix the red blocks first.",
            "#6fe08c", "Unhappy", "Delighted",
            listOf("#ff5252", "#ffc247", "#8fd95a", "#2ea86f"), false, null, false),
        ViewDef("power", "Electricity",
            "Power plant coverage. Buildings outside the glow have no electricity.",
            "#f4b942", "No power", "Powered",
            listOf("#1b1b2f", "#5a4a1c", "#c99a2e", "#ffe082"), false, "power", false),
        ViewDef("water", "Water & Sewage",
            "Water tower and sewage treatment coverage.",
            "#4fc3f7", "Dry", "Served",
            listOf("#1b1b2f", "#1f4d6e", "#2b8ac6", "#8fe0ff"), false, "water", false),
        ViewDef("zoning", "Zoning",
            "Show all zoned lots and their density.",
            "#8fd95a", null, null, null, true, null, false),
    )

    fun def(id: String): ViewDef? = VIEWS.firstOrNull { it.id == id }

    /** '#rrggbb' → 0..1 floats. */
    fun hex(h: String): FloatArray = floatArrayOf(
        Integer.parseInt(h.substring(1, 3), 16) / 255f,
        Integer.parseInt(h.substring(3, 5), 16) / 255f,
        Integer.parseInt(h.substring(5, 7), 16) / 255f,
    )
}
