package app.voxbridge.mic.audio

import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.log10
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * On-device processing. Mirrors the desktop worklet in
 * apps/desktop/src/renderer/audio.js so the same preset sounds the same on both
 * ends. Every stage is optional; with all stages off the chain is a limiter.
 *
 * All functions run on the capture thread. Nothing here allocates in steady
 * state except the output arrays, which are pooled at the call site.
 */
class Dsp(
    private val sampleRate: Int,
    denoise: Int,
    private val gateOn: Boolean,
    private val agcOn: Boolean,
    private val limiterOn: Boolean,
    gainDb: Int,
) {
    private val denoiser = if (denoise > 0) Denoiser(denoise / 4.0) else null

    private val highpass = Biquad.highpass(sampleRate.toDouble(), 80.0, 0.707)
    private val presence = Biquad.peaking(sampleRate.toDouble(), 3150.0, 0.9, 3.0)
    private val warmth = Biquad.lowshelf(sampleRate.toDouble(), 210.0, 2.5)

    private var inputGain = 10.0.pow(gainDb.coerceIn(-12, 24) / 20.0).toFloat()

    private var envelope = 0f
    private var holdSamples = 0
    private var gateGain = 1f
    private var gateTarget = 1f
    private var agcGain = 1f
    private var agcEnv = 0f
    private var compEnv = 0f
    private var compGain = 1f
    private var limitGain = 1f
    private var scratch = FloatArray(0)

    private var need = FloatArray(0)
    private var lookMin = FloatArray(0)
    private var dq = IntArray(0)

    private val dt = 1.0 / sampleRate
    private val envAttack = (1.0 - Math.exp(-dt / 0.002)).toFloat()
    private val envRelease = (1.0 - Math.exp(-dt / 0.180)).toFloat()
    private val agcAttack = (1.0 - Math.exp(-dt / 0.030)).toFloat()
    private val agcRelease = (1.0 - Math.exp(-dt / 0.400)).toFloat()
    private val gateAttack = (1.0 - Math.exp(-dt / 0.005)).toFloat()
    private val gateRelease = (1.0 - Math.exp(-dt / 0.150)).toFloat()
    private val compAttack = (1.0 - Math.exp(-dt / 0.003)).toFloat()
    private val compRelease = (1.0 - Math.exp(-dt / 0.120)).toFloat()
    private val limitRelease = (1.0 - Math.exp(-dt / 0.120)).toFloat()
    private val agcGlide = (1.0 - Math.exp(-dt / 0.600)).toFloat()
    private val lookahead = maxOf(8, sampleRate / 1000)
    private val holdFrames = (0.120 * sampleRate).toInt()

    fun setGainDb(db: Int) {
        inputGain = 10.0.pow(db.coerceIn(-12, 24) / 20.0).toFloat()
    }

    /** Processes 16-bit mono audio in place. */
    fun process(buffer: ShortArray, length: Int = buffer.size) {
        if (scratch.size < length) scratch = FloatArray(length)
        val floats = scratch
        for (i in 0 until length) floats[i] = buffer[i] / 32768f

        denoiser?.process(floats, length)

        val gateOpen = 0.0063f   // -44 dBFS
        val gateClose = 0.0032f  // -50 dBFS

        for (i in 0 until length) {
            var x = floats[i]
            x = highpass.process(x)
            x = presence.process(x)
            x = warmth.process(x)

            val raw = abs(x)

            // Auto gain rides the level slowly and freezes during silence, so
            // it cannot wind up and amplify the room between phrases.
            if (agcOn) {
                if (raw > gateOpen) {
                    agcEnv += (raw - agcEnv) * (if (raw > agcEnv) agcAttack else agcRelease)
                }
                if (agcEnv > 0.0016f) {
                    val currentDb = 20.0 * log10((agcEnv + 1e-9f).toDouble())
                    val targetGain = 10.0.pow(((-20.0 - currentDb) / 20.0).coerceIn(-6.0, 12.0))
                        .toFloat().coerceIn(0.5f, 4f)
                    agcGain += (targetGain - agcGain) * agcGlide
                }
                x *= agcGain
            }

            // Hysteresis gate with a hold and a slow release. The previous gate
            // released in milliseconds and chattered on every consonant.
            if (gateOn) {
                envelope += (raw - envelope) * (if (raw > envelope) envAttack else envRelease)
                if (envelope > gateOpen) {
                    holdSamples = holdFrames
                    gateTarget = 1f
                } else if (envelope < gateClose) {
                    if (holdSamples > 0) holdSamples -= 1 else gateTarget = 0.0005f
                }
                gateGain += (gateTarget - gateGain) *
                    (if (gateTarget > gateGain) gateAttack else gateRelease)
                x *= gateGain
            }

            // User gain before the compressor, so a hot signal is compressed
            // with a 3:1 ratio instead of being crushed by the limiter.
            x *= inputGain

            val level = abs(x)
            compEnv += (level - compEnv) * (if (level > compEnv) compAttack else compRelease)
            val levelDb = 20.0 * log10((compEnv + 1e-9f).toDouble())
            val threshold = -14.0
            val knee = 6.0
            var reduction = 0.0
            if (levelDb > threshold + knee) {
                reduction = (levelDb - threshold) * (1.0 - 1.0 / 3.0)
            } else if (levelDb > threshold - knee) {
                val t = (levelDb - (threshold - knee)) / (2 * knee)
                reduction = t * t * knee * (1.0 - 1.0 / 3.0)
            }
            val targetComp = 10.0.pow(-reduction / 20.0).toFloat()
            compGain += (targetComp - compGain) *
                (if (targetComp < compGain) compAttack else compRelease)
            x *= compGain

            floats[i] = x
        }

        if (limiterOn) applyLimiter(floats, length)

        for (i in 0 until length) {
            val clamped = floats[i].coerceIn(-0.999f, 0.999f)
            buffer[i] = (clamped * 32767f).toInt().toShort()
        }
    }

    /**
     * Lookahead limiter. Each sample's required attenuation is computed from a
     * one-millisecond window reaching *forward* in time, so a transient is
     * already attenuated when it arrives instead of being clamped after the
     * fact. Release is 120 ms, slow enough to avoid pumping.
     */
    private fun applyLimiter(block: FloatArray, length: Int) {
        if (need.size < length) {
            need = FloatArray(length)
            lookMin = FloatArray(length)
            dq = IntArray(length)
        }
        val ceiling = 0.891f
        for (i in 0 until length) {
            val a = abs(block[i])
            need[i] = if (a > ceiling) ceiling / a else 1f
        }
        // Sliding minimum over [i, i + lookahead], scanned right to left.
        var head = 0
        var tail = 0
        var i = length - 1
        while (i >= 0) {
            while (tail > head && need[dq[tail - 1]] >= need[i]) tail -= 1
            dq[tail] = i
            tail += 1
            while (dq[head] > i + lookahead) head += 1
            lookMin[i] = need[dq[head]]
            i -= 1
        }
        var g = limitGain
        for (k in 0 until length) {
            val target = lookMin[k]
            g = if (target < g) target else g + (target - g) * limitRelease
            block[k] *= g
        }
        limitGain = g
    }
}

/**
 * Spectral denoiser with decision-directed a priori SNR estimation
 * (Ephraim-Malah style). Keeps consonants intact and produces far less musical
 * noise than plain spectral subtraction.
 *
 * Overlap-add uses a square-root Hann window for analysis and synthesis. The
 * product is a Hann window, which sums to exactly 1.0 at 50% overlap; using
 * Hann twice would modulate the output at the frame rate and sound buzzy.
 *
 * Adds exactly [HOP] samples of latency, accounted for by the streaming FIFO.
 */
class Denoiser(private val strength: Double) {
    private val fft = Fft(FFT_SIZE)
    private val window = FloatArray(FFT_SIZE) { i ->
        sqrt(0.5 - 0.5 * cos(2.0 * Math.PI * i / FFT_SIZE)).toFloat()
    }
    private val frame = FloatArray(FFT_SIZE)
    private val overlap = FloatArray(FFT_SIZE)
    private val power = FloatArray(BINS)
    private val minCur = FloatArray(BINS)
    private val minPrev = FloatArray(BINS)
    private val smooth = FloatArray(BINS)
    private val prevGain = FloatArray(BINS) { 1f }
    private val prevGamma = FloatArray(BINS) { 1f }
    private val pending = FloatArray(HOP)
    private var pendingFill = 0
    private var warmup = 0
    private var windowCount = 0
    private var seeded = false
    private val fifo = ArrayDeque<FloatArray>()
    private var fifoOffset = 0

    fun process(samples: FloatArray, length: Int) {
        var read = 0
        while (read < length) {
            val take = minOf(HOP - pendingFill, length - read)
            System.arraycopy(samples, read, pending, pendingFill, take)
            pendingFill += take
            read += take
            if (pendingFill >= HOP) {
                pendingFill = 0
                fifo.addLast(renderHop())
            }
        }
        var written = 0
        while (written < length && fifo.isNotEmpty()) {
            val head = fifo.first()
            val avail = head.size - fifoOffset
            val take = minOf(avail, length - written)
            System.arraycopy(head, fifoOffset, samples, written, take)
            written += take
            fifoOffset += take
            if (fifoOffset >= head.size) {
                fifo.removeFirst()
                fifoOffset = 0
            }
        }
        while (written < length) {
            samples[written] = 0f
            written += 1
        }
    }

    private fun renderHop(): FloatArray {
        System.arraycopy(frame, HOP, frame, 0, FFT_SIZE - HOP)
        System.arraycopy(pending, 0, frame, FFT_SIZE - HOP, HOP)

        val re = fft.re
        val im = fft.im
        for (i in 0 until FFT_SIZE) {
            re[i] = frame[i] * window[i]
            im[i] = 0f
        }
        fft.forward()

        val floorGain = (0.5 - 0.44 * strength).toFloat()
        val alphaDD = 0.92f
        val seeding = warmup < 30

        windowCount += 1
        if (windowCount >= 240) {
            windowCount = 0
            for (i in 0 until BINS) {
                minPrev[i] = minCur[i]
                minCur[i] = Float.MAX_VALUE
            }
        }

        for (i in 0 until BINS) {
            val raw = re[i] * re[i] + im[i] * im[i]
            // Smooth the periodogram: raw FFT power has variance as large as
            // its mean, so a minimum taken directly on it collapses far below
            // the true noise floor and the suppressor stops working.
            power[i] += (raw - power[i]) * 0.25f
            val ps = power[i]

            if (!seeded) {
                minCur[i] = ps
                minPrev[i] = ps
            } else if (ps < minCur[i]) {
                minCur[i] = ps
            }
            val floorPower = minOf(minCur[i], minPrev[i]) * 1.6f + 1e-12f

            if (seeding) {
                smooth[i] = 1f
                prevGain[i] = 1f
                prevGamma[i] = 1f
                continue
            }

            val gamma = ps / floorPower
            val xi = alphaDD * (prevGain[i] * prevGain[i]) * prevGamma[i] +
                (1f - alphaDD) * maxOf(gamma - 1f, 0f)
            var g = xi / (1f + xi)
            if (g < floorGain) g = floorGain
            if (g > 1f) g = 1f
            smooth[i] = g
            prevGamma[i] = gamma
            prevGain[i] = g
        }
        if (!seeded) seeded = true

        for (i in 0 until BINS) {
            // Three-tap smoothing across neighbouring bins removes the isolated
            // "musical noise" spikes that make denoised speech sound metallic.
            var g = smooth[i]
            if (!seeding && i > 0 && i < BINS - 1) {
                g = 0.25f * smooth[i - 1] + 0.5f * smooth[i] + 0.25f * smooth[i + 1]
            }
            re[i] *= g
            im[i] *= g
        }
        for (i in 1 until BINS - 1) {
            re[FFT_SIZE - i] = re[i]
            im[FFT_SIZE - i] = -im[i]
        }
        fft.inverse()

        // sqrt-Hann analysis x sqrt-Hann synthesis = Hann, exactly unity-sum at
        // 50% overlap, so no normalisation gain is applied.
        for (i in 0 until FFT_SIZE) overlap[i] += re[i] * window[i]
        val hop = FloatArray(HOP)
        System.arraycopy(overlap, 0, hop, 0, HOP)
        overlap.copyInto(overlap, 0, HOP, FFT_SIZE)
        java.util.Arrays.fill(overlap, FFT_SIZE - HOP, FFT_SIZE, 0f)
        if (warmup < 1000) warmup += 1
        return hop
    }

    companion object {
        const val FFT_SIZE = 512
        const val HOP = 256
        const val BINS = FFT_SIZE / 2 + 1
    }
}

/** Iterative radix-2 FFT, in place. Sized for the voice band only. */
class Fft(private val n: Int) {
    val re = FloatArray(n)
    val im = FloatArray(n)
    private val rev = IntArray(n)
    private val cosTable = FloatArray(n / 2) { cos(-2.0 * Math.PI * it / n).toFloat() }
    private val sinTable = FloatArray(n / 2) { sin(-2.0 * Math.PI * it / n).toFloat() }

    init {
        val bits = Integer.numberOfTrailingZeros(n)
        for (i in 0 until n) {
            var x = i
            var r = 0
            repeat(bits) {
                r = (r shl 1) or (x and 1)
                x = x shr 1
            }
            rev[i] = r
        }
    }

    fun forward() = transform(false)

    fun inverse() = transform(true)

    private fun transform(inverse: Boolean) {
        for (i in 0 until n) {
            val j = rev[i]
            if (j > i) {
                var t = re[i]; re[i] = re[j]; re[j] = t
                t = im[i]; im[i] = im[j]; im[j] = t
            }
        }
        var size = 2
        while (size <= n) {
            val half = size / 2
            val step = n / size
            var i = 0
            while (i < n) {
                for (j in 0 until half) {
                    val k = j * step
                    val wr = cosTable[k]
                    val wi = if (inverse) -sinTable[k] else sinTable[k]
                    val a = i + j
                    val b = a + half
                    val tr = re[b] * wr - im[b] * wi
                    val ti = re[b] * wi + im[b] * wr
                    re[b] = re[a] - tr
                    im[b] = im[a] - ti
                    re[a] += tr
                    im[a] += ti
                }
                i += size
            }
            size = size shl 1
        }
        if (inverse) {
            val scale = 1f / n
            for (i in 0 until n) {
                re[i] = re[i] * scale
                im[i] = im[i] * scale
            }
        }
    }
}

class Biquad private constructor(
    private var b0: Float,
    private var b1: Float,
    private var b2: Float,
    private var a1: Float,
    private var a2: Float,
) {
    private var x1 = 0f
    private var x2 = 0f
    private var y1 = 0f
    private var y2 = 0f

    fun process(x: Float): Float {
        val y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2 = x1; x1 = x
        y2 = y1; y1 = y
        return y
    }

    companion object {
        fun highpass(rate: Double, hz: Double, q: Double): Biquad {
            val w = 2 * Math.PI * hz / rate
            val alpha = sin(w) / (2 * q)
            val cosW = cos(w)
            val a0 = 1 + alpha
            return Biquad(
                ((1 + cosW) / 2 / a0).toFloat(),
                (-(1 + cosW) / a0).toFloat(),
                ((1 + cosW) / 2 / a0).toFloat(),
                (-2 * cosW / a0).toFloat(),
                ((1 - alpha) / a0).toFloat(),
            )
        }

        fun peaking(rate: Double, hz: Double, q: Double, db: Double): Biquad {
            val a = 10.0.pow(db / 40)
            val w = 2 * Math.PI * hz / rate
            val alpha = sin(w) / (2 * q)
            val cosW = cos(w)
            val a0 = 1 + alpha / a
            return Biquad(
                ((1 + alpha * a) / a0).toFloat(),
                (-2 * cosW / a0).toFloat(),
                ((1 - alpha * a) / a0).toFloat(),
                (-2 * cosW / a0).toFloat(),
                ((1 - alpha / a) / a0).toFloat(),
            )
        }

        fun lowshelf(rate: Double, hz: Double, db: Double): Biquad {
            val a = 10.0.pow(db / 40)
            val w = 2 * Math.PI * hz / rate
            val cosW = cos(w)
            val sinW = sin(w)
            val alpha = sinW / Math.sqrt(2.0)
            val sq = 2 * Math.sqrt(a) * alpha
            val a0 = (a + 1) + (a - 1) * cosW + sq
            return Biquad(
                (a * ((a + 1) - (a - 1) * cosW + sq) / a0).toFloat(),
                (2 * a * ((a - 1) - (a + 1) * cosW) / a0).toFloat(),
                (a * ((a + 1) - (a - 1) * cosW - sq) / a0).toFloat(),
                (-2 * ((a - 1) + (a + 1) * cosW) / a0).toFloat(),
                ((a + 1) + (a - 1) * cosW - sq).toFloat() / a0.toFloat(),
            )
        }
    }
}

/** RMS/peak meter for the UI, updated on the audio thread. */
class LevelMeter {
    @Volatile
    var rms = 0f
        private set

    @Volatile
    var peak = 0f
        private set

    fun update(buffer: ShortArray, length: Int = buffer.size) {
        var sum = 0.0
        var top = 0f
        for (i in 0 until length) {
            val v = buffer[i] / 32768f
            sum += v * v
            if (abs(v) > top) top = abs(v)
        }
        val next = sqrt(sum / length.coerceAtLeast(1)).toFloat()
        rms = rms * 0.7f + next * 0.3f
        peak = if (top > peak) top else peak * 0.9f
    }
}

/** IMA ADPCM encoder matching apps/desktop/service/src/vb_core.h. */
class AdpcmEncoder {
    private var predictor = 0
    private var index = 0

    fun reset() {
        predictor = 0
        index = 0
    }

    fun encode(samples: ShortArray, length: Int = samples.size): ByteArray {
        val out = ByteArray(4 + (length + 1) / 2)
        out[0] = (predictor and 0xff).toByte()
        out[1] = ((predictor shr 8) and 0xff).toByte()
        out[2] = index.toByte()
        out[3] = 0
        var oi = 4
        var i = 0
        while (i < length) {
            val lo = encodeSample(samples[i].toInt())
            var hi = 0
            if (i + 1 < length) hi = encodeSample(samples[i + 1].toInt())
            out[oi++] = (lo or (hi shl 4)).toByte()
            i += 2
        }
        return out
    }

    private fun encodeSample(sample: Int): Int {
        val step = STEP_TABLE[index]
        var diff = sample - predictor
        var code = 0
        if (diff < 0) {
            code = 8
            diff = -diff
        }
        var temp = step
        if (diff >= temp) { code = code or 4; diff -= temp }
        temp = temp shr 1
        if (diff >= temp) { code = code or 2; diff -= temp }
        temp = temp shr 1
        if (diff >= temp) code = code or 1

        var pred = predictor
        var d = step shr 3
        if (code and 4 != 0) d += step
        if (code and 2 != 0) d += step shr 1
        if (code and 1 != 0) d += step shr 2
        pred = if (code and 8 != 0) pred - d else pred + d
        predictor = pred.coerceIn(-32768, 32767)
        index = (index + INDEX_TABLE[code and 0x0f]).coerceIn(0, 88)
        return code
    }

    companion object {
        private val INDEX_TABLE = intArrayOf(-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8)
        private val STEP_TABLE = intArrayOf(
            7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21,
            23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66,
            73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209,
            230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658,
            724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
            2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484,
            7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350,
            22385, 24623, 27086, 29794, 32767,
        )
    }
}
