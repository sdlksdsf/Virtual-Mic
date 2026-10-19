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
    sampleRate: Int,
    denoise: Int,
    private val gateOn: Boolean,
    private val agcOn: Boolean,
    private val limiterOn: Boolean,
    gainDb: Int,
) {
    private val denoiser = if (denoise > 0) Denoiser(denoise / 4.0) else null

    private val highpass = Biquad.highpass(sampleRate.toDouble(), 78.0, 0.707)
    private val presence = Biquad.peaking(sampleRate.toDouble(), 3150.0, 0.9, 3.0)
    private val warmth = Biquad.lowshelf(sampleRate.toDouble(), 210.0, 2.5)

    private var inputGain = 10.0.pow(gainDb.coerceIn(-12, 24) / 20.0).toFloat()

    private var envelope = 0f
    private var holdCounter = 0
    private var gateGain = 1f
    private var agcGain = 1f
    private var agcEnv = 0f
    private var compEnv = 0f
    private var limitGain = 1f
    private var scratch = FloatArray(0)

    fun setGainDb(db: Int) {
        inputGain = 10.0.pow(db.coerceIn(-12, 24) / 20.0).toFloat()
    }

    /** Processes 16-bit mono audio in place. */
    fun process(buffer: ShortArray, length: Int = buffer.size) {
        if (scratch.size < length) scratch = FloatArray(length)
        val floats = scratch
        for (i in 0 until length) floats[i] = buffer[i] / 32768f

        if (denoiser != null) denoiser.process(floats, length)

        for (i in 0 until length) {
            var x = floats[i]
            x = highpass.process(x)
            x = presence.process(x)
            x = warmth.process(x)

            if (gateOn) {
                val a = abs(x)
                envelope = if (a > envelope) {
                    envelope + (a - envelope) * 0.004f
                } else {
                    envelope * 0.9991f
                }
                if (envelope > 0.0032f) holdCounter = 8
                else if (holdCounter > 0) holdCounter -= 1
                val target = if (envelope > 0.0032f || holdCounter > 0) 1f else 0.0006f
                gateGain += (target - gateGain) * (if (target > gateGain) 0.02f else 0.0015f)
                x *= gateGain
            }

            if (agcOn) {
                agcEnv += (abs(x) - agcEnv) * 0.0006f
                if (agcEnv > 0.002f) {
                    val currentDb = 20.0 * log10((agcEnv + 1e-9).toDouble())
                    val desired = (-19.0 - currentDb).coerceIn(-3.0, 18.0)
                    val currentGainDb = 20.0 * log10((agcGain + 1e-9).toDouble())
                    val step = ((desired - currentGainDb) * 0.35).coerceIn(-0.6, 0.6)
                    agcGain = (agcGain * 10.0.pow(step / 20.0)).toFloat().coerceIn(0.35f, 8f)
                }
                x *= agcGain
            }

            compEnv = if (abs(x) > compEnv) {
                compEnv + (abs(x) - compEnv) * 0.06f
            } else {
                compEnv * 0.9992f
            }
            if (compEnv > 0.125f) {
                val over = 20.0 * log10((compEnv / 0.125f).toDouble())
                x *= 10.0.pow((-over * 0.66) / 20.0).toFloat()
            }

            x *= inputGain

            if (limiterOn) {
                val ceiling = 0.891f
                val a = abs(x)
                val target = if (a > ceiling) ceiling / a else 1f
                limitGain = if (target < limitGain) target else limitGain + (1f - limitGain) * 0.0009f
                x *= limitGain
            }

            val clamped = x.coerceIn(-0.999f, 0.999f)
            buffer[i] = (clamped * 32767f).toInt().coerceIn(-32768, 32767).toShort()
        }
    }
}

/**
 * Spectral subtraction with a learned noise floor. Adds exactly [HOP] samples of
 * latency, which is accounted for by the streaming FIFO inside [process].
 */
class Denoiser(private val strength: Double) {
    private val fft = Fft(FFT_SIZE)
    private val window = FloatArray(FFT_SIZE) { i ->
        (0.5 - 0.5 * cos(2.0 * Math.PI * i / FFT_SIZE)).toFloat()
    }
    private val frame = FloatArray(FFT_SIZE)
    private val overlap = FloatArray(FFT_SIZE)
    private val noise = FloatArray(BINS)
    private val gain = FloatArray(BINS) { 1f }
    private val pending = FloatArray(HOP)
    private var pendingFill = 0
    private var warmup = 0
    private val fifo = ArrayList<FloatArray>()
    private var fifoOffset = 0
    private var fifoCount = 0

    fun process(samples: FloatArray, length: Int) {
        var consumed = 0
        while (consumed < length) {
            val take = min(HOP - pendingFill, length - consumed)
            System.arraycopy(samples, consumed, pending, pendingFill, take)
            pendingFill += take
            consumed += take
            if (pendingFill == HOP) {
                pendingFill = 0
                val hop = renderHop()
                fifo.add(hop)
                fifoCount += hop.size
            }
        }

        // Emit the same number of samples we received. The initial latency of
        // one hop arrives with the next call; the worklet behaves the same.
        var written = 0
        while (written < length && fifo.isNotEmpty()) {
            val head = fifo[0]
            val avail = head.size - fifoOffset
            val take = min(avail, length - written)
            System.arraycopy(head, fifoOffset, samples, written, take)
            written += take
            fifoOffset += take
            fifoCount -= take
            if (fifoOffset >= head.size) {
                fifo.removeAt(0)
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

        for (i in 0 until BINS) {
            val mag = sqrt(re[i] * re[i] + im[i] * im[i])
            if (warmup < 18) {
                noise[i] = maxOf(noise[i] * 0.92f, mag * 0.82f)
                gain[i] = 1f
            } else {
                if (mag < noise[i]) noise[i] = noise[i] * 0.9f + mag * 0.1f
                else noise[i] = noise[i] * 0.9995f + mag * 0.0005f
                var g = if (mag > 1e-7f) ((mag - strength.toFloat() * noise[i] * 1.45f) / mag) else 0f
                g = g.coerceIn(0f, 1f)
                val floor = (1.0 - 0.9 * strength).toFloat()
                if (g < floor) g = floor
                gain[i] = gain[i] * 0.5f + g * 0.5f
            }
            re[i] *= gain[i]
            im[i] *= gain[i]
        }
        for (i in 1 until BINS - 1) {
            re[FFT_SIZE - i] = re[i]
            im[FFT_SIZE - i] = -im[i]
        }
        fft.inverse()

        for (i in 0 until FFT_SIZE) overlap[i] += re[i] * window[i] / 1.5f
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
            for (i in 0 until n) {
                re[i] /= n
                im[i] /= n
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
