package com.fablecities.android

/**
 * The site's post-processing chain (the Engine.js composer tail), ported to GLSL ES 3.0:
 *
 * RenderPass → GroundFXPass(+EffectsPass copy) → GTAO → UnrealBloomPass → ColorGradingPass
 * → OutputPass (AgX + sRGB) → SMAAPass
 *
 * The native frame graph (GlCityRenderer): scene → HDR sceneFbo → GroundFX blit → fxFbo →
 * precipitation → sun-occlusion probe → bloom mip chain → additive bloom composite → luma
 * meter → grade+AgX+sRGB → outFbo → SMAA → screen. Every shader below is a faithful port of
 * the corresponding three.js / site module source.
 */
object PostShaders {

    /** Fullscreen quad VS (4-vertex triangle strip covering NDC). */
    val VS_POST = """
        #version 300 es
        layout(location=0) in vec3 aPos;
        out vec2 vUv;
        void main() { vUv = aPos.xy * 0.5 + 0.5; gl_Position = vec4(aPos.xy, 0.0, 1.0); }
    """.trimIndent()

    // ------------------------------------------------------------------ EffectsPass

    /** EffectsPass PROBE_FRAG: 13 depth taps around the sun → fraction of sky (1×1 R8).
     *  three packing.h perspectiveDepthToViewZ inlined. */
    val FS_OCCLUSION_PROBE = """
        #version 300 es
        precision highp float;
        uniform sampler2D tDepth;
        uniform vec2 uSunUv;
        uniform vec2 uTexel;
        uniform vec2 uNearFar;
        uniform float uRadius;    // px
        uniform float uActive;    // 0 → write 0 (sun off screen / below horizon)
        out vec4 fragColor;
        float linDepth(vec2 uv) {
          float d = texture(tDepth, clamp(uv, vec2(0.001), vec2(0.999))).x;
          // perspectiveDepthToViewZ (three packing.h): viewZ = (near*far) / ((far-near)*d - far)
          return -((uNearFar.x * uNearFar.y) / ((uNearFar.y - uNearFar.x) * d - uNearFar.y));
        }
        void main() {
          float far = max(uNearFar.y * 0.4, 1500.0);          // sky dome / clear depth are beyond this
          float occ = step(far, linDepth(uSunUv));
          for (int k = 0; k < 12; k++) {
            float a = float(k) * 0.5235988;
            float r = (k < 6) ? uRadius * 0.5 : uRadius;
            vec2 o = vec2(cos(a), sin(a)) * r * uTexel;
            occ += step(far, linDepth(uSunUv + o));
          }
          fragColor = vec4(occ / 13.0 * uActive, 0.0, 0.0, 1.0);
        }
    """.trimIndent()

    /** CopyShader (three) — the additive bloom composite blend uses this with ONE/ONE blending. */
    val FS_COPY = """
        #version 300 es
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform float opacity;
        in vec2 vUv;
        out vec4 fragColor;
        void main() {
          fragColor = opacity * texture(tDiffuse, vUv);
        }
    """.trimIndent()

    // ------------------------------------------------------------------ UnrealBloomPass

    /** LuminosityHighPassShader: keep texels above the threshold with a 0.01 smooth knee. */
    val FS_BRIGHT = """
        #version 300 es
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform vec3 defaultColor;
        uniform float defaultOpacity;
        uniform float luminosityThreshold;
        uniform float smoothWidth;
        in vec2 vUv;
        out vec4 fragColor;
        float luminance(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
        void main() {
          vec4 texel = texture(tDiffuse, vUv);
          float v = luminance(texel.xyz);
          vec4 outputColor = vec4(defaultColor.rgb, defaultOpacity);
          float alpha = smoothstep(luminosityThreshold, luminosityThreshold + smoothWidth, v);
          fragColor = mix(outputColor, texel, alpha);
        }
    """.trimIndent()

    /** UnrealBloomPass separable blur (KERNEL_RADIUS injected; gaussian coefficients uniform). */
    fun fsBlur(radius: Int): String = """
        #version 300 es
        precision highp float;
        #define KERNEL_RADIUS $radius
        uniform sampler2D colorTexture;
        uniform vec2 invSize;
        uniform vec2 direction;
        uniform float gaussianCoefficients[KERNEL_RADIUS];
        in vec2 vUv;
        out vec4 fragColor;
        void main() {
          float weightSum = gaussianCoefficients[0];
          vec3 diffuseSum = texture(colorTexture, vUv).rgb * weightSum;
          for (int i = 1; i < KERNEL_RADIUS; i++) {
            float x = float(i);
            float w = gaussianCoefficients[i];
            vec2 uvOffset = direction * invSize * x;
            vec3 sample1 = texture(colorTexture, vUv + uvOffset).rgb;
            vec3 sample2 = texture(colorTexture, vUv - uvOffset).rgb;
            diffuseSum += (sample1 + sample2) * w;
          }
          fragColor = vec4(diffuseSum, 1.0);
        }
    """.trimIndent()

    /** UnrealBloomPass composite: the 5 blurred mips, factor-lerped by bloomRadius. */
    val FS_BLOOM_COMPOSITE = """
        #version 300 es
        precision highp float;
        uniform sampler2D blurTexture1;
        uniform sampler2D blurTexture2;
        uniform sampler2D blurTexture3;
        uniform sampler2D blurTexture4;
        uniform sampler2D blurTexture5;
        uniform float bloomStrength;
        uniform float bloomRadius;
        in vec2 vUv;
        out vec4 fragColor;
        float lerpBloomFactor(const in float factor) {
          float mirrorFactor = 1.2 - factor;
          return mix(factor, mirrorFactor, bloomRadius);
        }
        void main() {
          // 3.0 for backwards compatibility with previous alpha-based intensity
          vec3 bloom = 3.0 * bloomStrength * (
            lerpBloomFactor(1.0) * vec3(1.0) * texture(blurTexture1, vUv).rgb +
            lerpBloomFactor(0.8) * vec3(1.0) * texture(blurTexture2, vUv).rgb +
            lerpBloomFactor(0.6) * vec3(1.0) * texture(blurTexture3, vUv).rgb +
            lerpBloomFactor(0.4) * vec3(1.0) * texture(blurTexture4, vUv).rgb +
            lerpBloomFactor(0.2) * vec3(1.0) * texture(blurTexture5, vUv).rgb);
          float bloomAlpha = max(bloom.r, max(bloom.g, bloom.b));
          fragColor = vec4(bloom, bloomAlpha);
        }
    """.trimIndent()

    // ------------------------------------------------------------------ ColorGradingPass

    /** ColorGradingPass METER_FRAG: 256-tap geometric-mean + p4 power-mean luminance,
     *  temporally blended with the previous 1×1 measurement. */
    val FS_LUMA_METER = """
        #version 300 es
        precision highp float;
        uniform sampler2D tScene;
        uniform sampler2D tPrev;
        uniform float uBlend;     // 0 → snap to the measurement, →1 keep the previous value
        out vec4 fragColor;
        void main() {
          float sumLog = 0.0;
          float p4 = 0.0;
          for (int j = 0; j < 16; j++) {
            for (int i = 0; i < 16; i++) {
              vec2 uv = (vec2(float(i), float(j)) + 0.5) / 16.0;
              vec3 c = texture(tScene, uv).rgb;
              float l = clamp(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-4, 64.0);
              sumLog += log2(l);
              float l2 = l * l;
              p4 += l2 * l2;
            }
          }
          vec2 m = vec2(exp2(sumLog / 256.0), pow(p4 / 256.0, 0.25));
          vec2 prev = texture(tPrev, vec2(0.5)).rg;
          if (prev.y <= 0.0) prev = m;
          fragColor = vec4(mix(m, prev, uBlend), 0.0, 1.0);
        }
    """.trimIndent()

    /**
     * ColorGradingPass FRAG (the site's CS2-like grade) + the OutputPass tail:
     * AgX tone mapping (three.js tonemapping_pars_fragment, toneMappingExposure = 1) and the
     * sRGB transfer. The LUT path is kept (uLUTAmount = 0 — the site ships no LUT).
     */
    val FS_GRADE = """
        #version 300 es
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform sampler2D tOcc;      // 1×1: fraction of sky around the sun (EffectsPass probe)
        uniform sampler2D tMeter;    // 1×1: geometric-mean luminance, p4 power-mean luminance
        uniform vec2 uResolution;
        uniform float uTime;

        uniform vec4 uAuto;          // white target, gain min, gain max, strength
        uniform float uExposure;
        uniform float uContrast;
        uniform float uToe;          // -1..1 shadow toe: < 0 crush (day), > 0 lift (night)
        uniform float uShoulder;     // 0..1 highlight roll-off
        uniform float uBlack;        // linear black level pulled to 0
        uniform float uSaturation;
        uniform float uMidSat;       // extra saturation around mid grey
        uniform float uHiDesat;      // highlight desaturation
        uniform vec3 uTint;
        uniform vec3 uLift;
        uniform vec3 uGain;
        uniform vec3 uShadowTint;
        uniform vec3 uHighlightTint;
        uniform vec2 uVignette;      // strength, radius

        uniform vec4 uSun;           // ndc x, ndc y, visibility, unused
        uniform vec3 uSunColor;
        uniform float uGlare;

        uniform float uLUTAmount;

        const int MAX_SHIMMER = 6;
        uniform vec4 uShimmer[MAX_SHIMMER];  // uv.x, uv.y, radius (uv), strength
        uniform int uShimmerCount;

        in vec2 vUv;
        out vec4 fragColor;

        float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

        uniform float uExposureTone;   // renderer.toneMappingExposure (1.0)

        // soft aperture disc with a slightly brighter rim (lens ghost)
        float ghostDisc(float gd) {
          return smoothstep(1.0, 0.6, gd) * (0.55 + 0.45 * smoothstep(0.35, 0.95, gd));
        }

        // AgX (three.js tonemapping_pars_fragment; inputs/outputs linear-sRGB)
        const mat3 LINEAR_SRGB_TO_LINEAR_REC2020 = mat3(
          vec3(0.6274, 0.0691, 0.0164),
          vec3(0.3293, 0.9195, 0.0880),
          vec3(0.0433, 0.0113, 0.8956)
        );
        const mat3 LINEAR_REC2020_TO_LINEAR_SRGB = mat3(
          vec3(1.6605, -0.1246, -0.0182),
          vec3(-0.5876, 1.1329, -0.1006),
          vec3(-0.0728, -0.0083, 1.1187)
        );
        vec3 agxDefaultContrastApprox(vec3 x) {
          vec3 x2 = x * x;
          vec3 x4 = x2 * x2;
          return + 15.5 * x4 * x2
            - 40.14 * x4 * x
            + 31.96 * x4
            - 6.868 * x2 * x
            + 0.4298 * x2
            + 0.1191 * x
            - 0.00232;
        }
        vec3 AgXToneMapping(vec3 color) {
          const mat3 AgXInsetMatrix = mat3(
            vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
            vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
            vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859)
          );
          const mat3 AgXOutsetMatrix = mat3(
            vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
            vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
            vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405)
          );
          const float AgxMinEv = -12.47393;
          const float AgxMaxEv = 4.026069;
          color *= uExposureTone;
          color = LINEAR_SRGB_TO_LINEAR_REC2020 * color;
          color = AgXInsetMatrix * color;
          color = max(color, 1e-10);
          color = log2(color);
          color = (color - AgxMinEv) / (AgxMaxEv - AgxMinEv);
          color = clamp(color, 0.0, 1.0);
          color = agxDefaultContrastApprox(color);
          color = AgXOutsetMatrix * color;
          color = pow(max(vec3(0.0), color), vec3(2.2));
          color = LINEAR_REC2020_TO_LINEAR_SRGB * color;
          color = clamp(color, 0.0, 1.0);
          return color;
        }

        vec3 sRGBTransferOETF(vec3 v) {
          return mix(pow(v, vec3(0.41666)) * 1.055 - vec3(0.055), v * 12.92, vec3(lessThanEqual(v, vec3(0.0031308))));
        }

        void main() {
          vec2 uv = vUv;
          float aspect = uResolution.x / uResolution.y;

          // --- heat shimmer: warp UV inside a soft ellipse above each hot source ---
          for (int i = 0; i < MAX_SHIMMER; i++) {
            if (i >= uShimmerCount) break;
            vec4 s = uShimmer[i];
            vec2 d = (uv - s.xy) * vec2(aspect, 1.0);
            float above = smoothstep(-0.2 * s.z, 0.6 * s.z, d.y);           // mostly above the source
            float m = (1.0 - smoothstep(0.0, s.z, length(d * vec2(1.0, 0.45)))) * above;
            if (m > 0.0) {
              float n1 = sin(uv.y * 160.0 * aspect + uTime * 7.0 + uv.x * 40.0);
              float n2 = cos(uv.y * 110.0 + uTime * 5.3 + uv.x * 90.0);
              uv += vec2(n1, n2 * 0.6) * m * s.w;
            }
          }

          vec3 c = texture(tDiffuse, uv).rgb;

          // --- white-point anchoring (auto exposure from the meter) ---
          {
            vec2 m = texture(tMeter, vec2(0.5)).rg;
            float gain = clamp(uAuto.x / max(m.y, 1e-3), uAuto.y, uAuto.z);
            c *= mix(1.0, gain, uAuto.w);
          }

          // --- white balance & exposure trim ---
          c *= uTint * uExposure;

          // --- log S-curve around mid grey: contrast, small toe, soft shoulder ---
          {
            vec3 lc = log2(max(c, vec3(1e-5)) / 0.18);
            lc *= uContrast;
            vec3 below = min(lc + 3.0, 0.0);
            lc += below * (uToe < 0.0 ? -uToe * 0.55 : -uToe * 0.35);
            vec3 above = max(lc - 2.9, 0.0);
            lc -= above * uShoulder * 0.3;
            c = 0.18 * exp2(lc);
            // SOFT black level: c*c/(c+black) rolls smoothly into a floor, never a hard clamp
            c = (c * c) / (c + vec3(uBlack) + 1e-6) / (1.0 - uBlack);
          }

          // --- saturation: base, mid-tone boost, highlight desaturation ---
          {
            float l = luma(c);
            float stops = log2(max(l, 1e-4) / 0.18);
            float mid = exp(-stops * stops * 0.35);                 // gaussian around mid grey
            float hi = smoothstep(0.5, 3.0, stops);
            float sat = uSaturation * (1.0 + uMidSat * mid) * (1.0 - uHiDesat * hi);
            c = mix(vec3(l), c, sat);
          }

          // --- split toning + lift / gain ---
          {
            float l = luma(c);
            float sh = 1.0 - smoothstep(0.015, 0.22, l);
            float hi = smoothstep(0.35, 2.5, l);
            c *= mix(vec3(1.0), uShadowTint, sh) * mix(vec3(1.0), uHighlightTint, hi);
            c = c * uGain + uLift * sh;
          }

          // --- sun glare (restrained): core + halo, weak anamorphic streak, 3 small chromatic ghosts ---
          float vis = uSun.z * texture(tOcc, vec2(0.5)).r;
          if (vis > 0.001) {
            vec2 sunUv = uSun.xy * 0.5 + 0.5;
            vec2 d = (vUv - sunUv) * vec2(aspect, 1.0);
            float dist = length(d);
            float glow = exp(-dist * dist * 260.0) * 2.2 + exp(-dist * 9.0) * 0.42 + exp(-dist * 2.4) * 0.05;
            float streak = exp(-abs(d.y) * 95.0) * exp(-abs(d.x) * 2.4) * 0.75;
            vec3 flare = uSunColor * (glow + streak);
            vec2 centre = vec2(0.5);
            vec2 axis = (centre - sunUv) * vec2(aspect, 1.0);
            vec2 p = (vUv - centre) * vec2(aspect, 1.0);
            vec3 gcol = vec3(0.0);
            const int NG = 3;
            float ks[NG]; ks[0] = -0.6; ks[1] = -1.25; ks[2] = 0.35;
            float rs[NG]; rs[0] = 0.035; rs[1] = 0.05; rs[2] = 0.022;
            float bs[NG]; bs[0] = 0.08; bs[1] = 0.06; bs[2] = 0.07;
            for (int i = 0; i < NG; i++) {
              vec2 gp = -axis * ks[i];
              float gd = length(p - gp) / rs[i];
              vec3 disc = vec3(ghostDisc(gd * 0.94), ghostDisc(gd), ghostDisc(gd * 1.07));
              vec3 tint = mix(vec3(0.6, 0.85, 1.0), vec3(1.0, 0.75, 0.6), float(i) / float(NG - 1));
              gcol += tint * disc * bs[i];
            }
            flare += gcol * max(uSunColor.g, 0.2);
            c += flare * vis * uGlare;
          }

          // --- vignette ---
          float vr = length((vUv - 0.5) * vec2(aspect, 1.0)) / length(vec2(aspect, 1.0) * 0.5);
          float vig = 1.0 - uVignette.x * smoothstep(uVignette.y, 1.05, vr);
          c *= vig;

          // --- OutputPass: AgX tone mapping + sRGB transfer ---
          c = AgXToneMapping(c);
          c = sRGBTransferOETF(c);
          fragColor = vec4(max(c, vec3(0.0)), 1.0);
        }
    """.trimIndent()

    // ------------------------------------------------------------------ SMAAPass

    /** SMAAEdgesShader VS. */
    val VS_SMAA_EDGES = """
        #version 300 es
        precision highp float;
        uniform vec2 resolution;
        layout(location=0) in vec3 aPos;
        out vec2 vUv;
        out vec4 vOffset[3];
        void main() {
          vUv = aPos.xy * 0.5 + 0.5;
          vOffset[0] = vUv.xyxy + resolution.xyxy * vec4(-1.0, 0.0, 0.0, 1.0);
          vOffset[1] = vUv.xyxy + resolution.xyxy * vec4(1.0, 0.0, 0.0, -1.0);
          vOffset[2] = vUv.xyxy + resolution.xyxy * vec4(-2.0, 0.0, 0.0, 2.0);
          gl_Position = vec4(aPos.xy, 0.0, 1.0);
        }
    """.trimIndent()

    /** SMAAEdgesShader FS (color edge detection, SMAA_THRESHOLD 0.1). */
    val FS_SMAA_EDGES = """
        #version 300 es
        precision highp float;
        #define SMAA_THRESHOLD 0.1
        uniform sampler2D tDiffuse;
        in vec2 vUv;
        in vec4 vOffset[3];
        out vec4 fragColor;
        vec4 SMAAColorEdgeDetectionPS(vec2 texcoord, vec4 offset[3], sampler2D colorTex) {
          vec2 threshold = vec2(SMAA_THRESHOLD, SMAA_THRESHOLD);
          vec4 delta;
          vec3 C = texture(colorTex, texcoord).rgb;
          vec3 Cleft = texture(colorTex, offset[0].xy).rgb;
          vec3 t = abs(C - Cleft);
          delta.x = max(max(t.r, t.g), t.b);
          vec3 Ctop = texture(colorTex, offset[0].zw).rgb;
          t = abs(C - Ctop);
          delta.y = max(max(t.r, t.g), t.b);
          vec2 edges = step(threshold, delta.xy);
          if (dot(edges, vec2(1.0, 1.0)) == 0.0)
            discard;
          vec3 Cright = texture(colorTex, offset[1].xy).rgb;
          t = abs(C - Cright);
          delta.z = max(max(t.r, t.g), t.b);
          vec3 Cbottom = texture(colorTex, offset[1].zw).rgb;
          t = abs(C - Cbottom);
          delta.w = max(max(t.r, t.g), t.b);
          float maxDelta = max(max(max(delta.x, delta.y), delta.z), delta.w);
          vec3 Cleftleft = texture(colorTex, offset[2].xy).rgb;
          t = abs(C - Cleftleft);
          delta.z = max(max(t.r, t.g), t.b);
          vec3 Ctoptop = texture(colorTex, offset[2].zw).rgb;
          t = abs(C - Ctoptop);
          delta.w = max(max(t.r, t.g), t.b);
          maxDelta = max(max(maxDelta, delta.z), delta.w);
          edges.xy *= step(0.5 * maxDelta, delta.xy);
          return vec4(edges, 0.0, 0.0);
        }
        void main() {
          fragColor = SMAAColorEdgeDetectionPS(vUv, vOffset, tDiffuse);
        }
    """.trimIndent()

    /** SMAAWeightsShader VS. */
    val VS_SMAA_WEIGHTS = """
        #version 300 es
        precision highp float;
        #define SMAA_MAX_SEARCH_STEPS 8
        uniform vec2 resolution;
        layout(location=0) in vec3 aPos;
        out vec2 vUv;
        out vec4 vOffset[3];
        out vec2 vPixcoord;
        void main() {
          vUv = aPos.xy * 0.5 + 0.5;
          vPixcoord = vUv / resolution;
          vOffset[0] = vUv.xyxy + resolution.xyxy * vec4(-0.25, 0.125, 1.25, 0.125);
          vOffset[1] = vUv.xyxy + resolution.xyxy * vec4(-0.125, 0.25, -0.125, -1.25);
          vOffset[2] = vec4(vOffset[0].xz, vOffset[1].yw) + vec4(-2.0, 2.0, -2.0, 2.0) * resolution.xxyy * float(SMAA_MAX_SEARCH_STEPS);
          gl_Position = vec4(aPos.xy, 0.0, 1.0);
        }
    """.trimIndent()

    /** SMAAWeightsShader FS (the full blending-weight calculation against the area/search LUTs). */
    val FS_SMAA_WEIGHTS = """
        #version 300 es
        precision highp float;
        #define SMAA_MAX_SEARCH_STEPS 8
        #define SMAA_AREATEX_MAX_DISTANCE 16
        #define SMAA_AREATEX_PIXEL_SIZE (1.0 / vec2(160.0, 560.0))
        #define SMAA_AREATEX_SUBTEX_SIZE (1.0 / 7.0)
        uniform sampler2D tDiffuse;
        uniform sampler2D tArea;
        uniform sampler2D tSearch;
        uniform vec2 resolution;
        in vec2 vUv;
        in vec4 vOffset[3];
        in vec2 vPixcoord;
        out vec4 fragColor;
        float SMAASearchLength(sampler2D searchTex, vec2 e, float bias, float scale) {
          e.r = bias + e.r * scale;
          return 255.0 * texture(searchTex, e).r;
        }
        float SMAASearchXLeft(sampler2D edgesTex, sampler2D searchTex, vec2 texcoord, float end) {
          vec2 e = vec2(0.0, 1.0);
          for (int i = 0; i < SMAA_MAX_SEARCH_STEPS; i++) {
            e = texture(edgesTex, texcoord).rg;
            texcoord -= vec2(2.0, 0.0) * resolution;
            if (!(texcoord.x > end && e.g > 0.8281 && e.r == 0.0)) break;
          }
          texcoord.x += 0.25 * resolution.x;
          texcoord.x += resolution.x;
          texcoord.x += 2.0 * resolution.x;
          texcoord.x -= resolution.x * SMAASearchLength(searchTex, e, 0.0, 0.5);
          return texcoord.x;
        }
        float SMAASearchXRight(sampler2D edgesTex, sampler2D searchTex, vec2 texcoord, float end) {
          vec2 e = vec2(0.0, 1.0);
          for (int i = 0; i < SMAA_MAX_SEARCH_STEPS; i++) {
            e = texture(edgesTex, texcoord).rg;
            texcoord += vec2(2.0, 0.0) * resolution;
            if (!(texcoord.x < end && e.g > 0.8281 && e.r == 0.0)) break;
          }
          texcoord.x -= 0.25 * resolution.x;
          texcoord.x -= resolution.x;
          texcoord.x -= 2.0 * resolution.x;
          texcoord.x += resolution.x * SMAASearchLength(searchTex, e, 0.5, 0.5);
          return texcoord.x;
        }
        float SMAASearchYUp(sampler2D edgesTex, sampler2D searchTex, vec2 texcoord, float end) {
          vec2 e = vec2(1.0, 0.0);
          for (int i = 0; i < SMAA_MAX_SEARCH_STEPS; i++) {
            e = texture(edgesTex, texcoord).rg;
            texcoord += vec2(0.0, 2.0) * resolution;
            if (!(texcoord.y > end && e.r > 0.8281 && e.g == 0.0)) break;
          }
          texcoord.y -= 0.25 * resolution.y;
          texcoord.y -= resolution.y;
          texcoord.y -= 2.0 * resolution.y;
          texcoord.y += resolution.y * SMAASearchLength(searchTex, e.gr, 0.0, 0.5);
          return texcoord.y;
        }
        float SMAASearchYDown(sampler2D edgesTex, sampler2D searchTex, vec2 texcoord, float end) {
          vec2 e = vec2(1.0, 0.0);
          for (int i = 0; i < SMAA_MAX_SEARCH_STEPS; i++) {
            e = texture(edgesTex, texcoord).rg;
            texcoord -= vec2(0.0, 2.0) * resolution;
            if (!(texcoord.y < end && e.r > 0.8281 && e.g == 0.0)) break;
          }
          texcoord.y += 0.25 * resolution.y;
          texcoord.y += resolution.y;
          texcoord.y += 2.0 * resolution.y;
          texcoord.y -= resolution.y * SMAASearchLength(searchTex, e.gr, 0.5, 0.5);
          return texcoord.y;
        }
        vec2 SMAAArea(sampler2D areaTex, vec2 dist, float e1, float e2, float offset) {
          vec2 texcoord = float(SMAA_AREATEX_MAX_DISTANCE) * round(4.0 * vec2(e1, e2)) + dist;
          texcoord = SMAA_AREATEX_PIXEL_SIZE * texcoord + (0.5 * SMAA_AREATEX_PIXEL_SIZE);
          texcoord.y += SMAA_AREATEX_SUBTEX_SIZE * offset;
          return texture(areaTex, texcoord).rg;
        }
        vec4 SMAABlendingWeightCalculationPS(vec2 texcoord, vec2 pixcoord, vec4 offset[3],
            sampler2D edgesTex, sampler2D areaTex, sampler2D searchTex, vec4 subsampleIndices) {
          vec4 weights = vec4(0.0, 0.0, 0.0, 0.0);
          vec2 e = texture(edgesTex, texcoord).rg;
          if (e.g > 0.0) { // Edge at north
            vec2 d;
            vec2 coords;
            coords.x = SMAASearchXLeft(edgesTex, searchTex, offset[0].xy, offset[2].x);
            coords.y = offset[1].y;
            d.x = coords.x;
            float e1 = texture(edgesTex, coords).r;
            coords.x = SMAASearchXRight(edgesTex, searchTex, offset[0].zw, offset[2].y);
            d.y = coords.x;
            d = d / resolution.x - pixcoord.x;
            vec2 sqrt_d = sqrt(abs(d));
            coords.y -= 1.0 * resolution.y;
            float e2 = texture(edgesTex, coords + vec2(1.0, 0.0) * resolution).r;
            weights.rg = SMAAArea(areaTex, sqrt_d, e1, e2, subsampleIndices.y);
          }
          if (e.r > 0.0) { // Edge at west
            vec2 d;
            vec2 coords;
            coords.y = SMAASearchYUp(edgesTex, searchTex, offset[1].xy, offset[2].z);
            coords.x = offset[0].x;
            d.x = coords.y;
            float e1 = texture(edgesTex, coords).g;
            coords.y = SMAASearchYDown(edgesTex, searchTex, offset[1].zw, offset[2].w);
            d.y = coords.y;
            d = d / resolution.y - pixcoord.y;
            vec2 sqrt_d = sqrt(abs(d));
            coords.y -= 1.0 * resolution.y;
            float e2 = texture(edgesTex, coords + vec2(0.0, 1.0) * resolution).g;
            weights.ba = SMAAArea(areaTex, sqrt_d, e1, e2, subsampleIndices.x);
          }
          return weights;
        }
        void main() {
          fragColor = SMAABlendingWeightCalculationPS(vUv, vPixcoord, vOffset, tDiffuse, tArea, tSearch, vec4(0.0));
        }
    """.trimIndent()

    /** SMAABlendShader VS. */
    val VS_SMAA_BLEND = """
        #version 300 es
        precision highp float;
        uniform vec2 resolution;
        layout(location=0) in vec3 aPos;
        out vec2 vUv;
        out vec4 vOffset[2];
        void main() {
          vUv = aPos.xy * 0.5 + 0.5;
          vOffset[0] = vUv.xyxy + resolution.xyxy * vec4(-1.0, 0.0, 0.0, 1.0);
          vOffset[1] = vUv.xyxy + resolution.xyxy * vec4(1.0, 0.0, 0.0, -1.0);
          gl_Position = vec4(aPos.xy, 0.0, 1.0);
        }
    """.trimIndent()

    /** SMAABlendShader FS (neighborhood blending with the site's gamma-aware mix). */
    val FS_SMAA_BLEND = """
        #version 300 es
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform sampler2D tColor;
        uniform vec2 resolution;
        in vec2 vUv;
        in vec4 vOffset[2];
        out vec4 fragColor;
        vec4 SMAANeighborhoodBlendingPS(vec2 texcoord, vec4 offset[2], sampler2D colorTex, sampler2D blendTex) {
          vec4 a;
          a.xz = texture(blendTex, texcoord).xz;
          a.y = texture(blendTex, offset[1].zw).g;
          a.w = texture(blendTex, offset[1].xy).a;
          if (dot(a, vec4(1.0, 1.0, 1.0, 1.0)) < 1e-5) {
            return texture(colorTex, texcoord);
          } else {
            vec2 offset;
            offset.x = a.a > a.b ? a.a : -a.b; // left vs. right
            offset.y = a.g > a.r ? -a.g : a.r; // top vs. bottom
            if (abs(offset.x) > abs(offset.y)) {
              offset.y = 0.0;
            } else {
              offset.x = 0.0;
            }
            vec4 C = texture(colorTex, texcoord);
            texcoord += sign(offset) * resolution;
            vec4 Cop = texture(colorTex, texcoord);
            float s = abs(offset.x) > abs(offset.y) ? abs(offset.x) : abs(offset.y);
            C.xyz = pow(C.xyz, vec3(2.2));
            Cop.xyz = pow(Cop.xyz, vec3(2.2));
            vec4 mixed = mix(C, Cop, s);
            mixed.xyz = pow(mixed.xyz, vec3(1.0 / 2.2));
            return mixed;
          }
        }
        void main() {
          fragColor = SMAANeighborhoodBlendingPS(vUv, vOffset, tColor, tDiffuse);
        }
    """.trimIndent()
}
