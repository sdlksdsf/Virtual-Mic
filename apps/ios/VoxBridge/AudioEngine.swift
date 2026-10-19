import Foundation
import AVFoundation
import Accelerate

/// Captures 20 ms frames from the microphone, optionally cleans them and hands
/// PCM16 to the session for framing. Uses a manual converter so the capture
/// rate follows whatever the desktop asks for.
final class AudioEngine {
    private let engine = AVAudioEngine()
    private let queue = DispatchQueue(label: "app.voxbridge.audio", qos: .userInteractive)
    private var converter: AVAudioConverter?
    private var targetFormat: AVAudioFormat?
    private var dsp: Dsp?
    private var frameBuffer: [Int16] = []
    private var frameSamples = 960
    private var running = false

    var onFrame: (([Int16]) -> Void)?
    var onLevel: ((Float, Float) -> Void)?

    func configure(rate: Int, denoise: Int, gate: Bool, agc: Bool, limiter: Bool, gainDb: Int) {
        queue.async {
            self.frameSamples = max(160, rate / 1000 * Proto.defaultFrameMs)
            self.frameBuffer.reserveCapacity(self.frameSamples * 2)
            self.dsp = Dsp(
                sampleRate: Double(rate),
                denoise: denoise,
                gate: gate,
                agc: agc,
                limiter: limiter,
                gainDb: gainDb
            )
            self.targetFormat = AVAudioFormat(
                commonFormat: .pcmFormatInt16,
                sampleRate: Double(rate),
                channels: 1,
                interleaved: true
            )
        }
    }

    func start() throws {
        guard !running else { return }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: [.allowBluetooth])
        try session.setPreferredSampleRate(48_000)
        try session.setActive(true, options: [])

        let input = engine.inputNode
        let inputFormat = input.inputFormat(forBus: 0)
        let outputFormat = targetFormat ?? AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: 48_000,
            channels: 1,
            interleaved: true
        )!
        converter = AVAudioConverter(from: inputFormat, to: outputFormat)

        let tapBuffer: AVAudioFrameCount = 1024
        input.installTap(onBus: 0, bufferSize: tapBuffer, format: inputFormat) { [weak self] buffer, _ in
            self?.handle(buffer, outputFormat: outputFormat)
        }
        engine.prepare()
        try engine.start()
        running = true
        voxLog.info("capture started at \(outputFormat.sampleRate, privacy: .public) Hz")
    }

    func stop() {
        guard running else { return }
        running = false
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        converter = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    func setGain(_ db: Int) {
        queue.async { self.dsp?.setGainDb(db) }
    }

    private func handle(_ buffer: AVAudioPCMBuffer, outputFormat: AVAudioFormat) {
        guard let converter else { return }
        let ratio = outputFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
        guard let converted = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return }
        var error: NSError?
        var supplied = false
        let status = converter.convert(to: converted, error: &error) { _, outStatus in
            if supplied {
                outStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            outStatus.pointee = .haveData
            return buffer
        }
        guard status != .error, converted.frameLength > 0 else { return }
        guard let channel = converted.int16ChannelData?[0] else { return }
        var samples = Array(UnsafeBufferPointer(start: channel, count: Int(converted.frameLength)))

        queue.async {
            if let dsp = self.dsp { dsp.process(&samples) }
            var sum: Float = 0
            var peak: Float = 0
            for value in samples {
                let v = Float(value) / 32768
                sum += v * v
                peak = max(peak, abs(v))
            }
            let rms = (sum / Float(max(1, samples.count))).squareRoot()
            self.onLevel?(rms, peak)

            self.frameBuffer.append(contentsOf: samples)
            while self.frameBuffer.count >= self.frameSamples {
                let frame = Array(self.frameBuffer.prefix(self.frameSamples))
                self.frameBuffer.removeFirst(self.frameSamples)
                self.onFrame?(frame)
            }
        }
    }
}

/// Speech chain matching the Android and desktop presets.
final class Dsp {
    private var denoiser: SpectralGate?
    private var highpass: Biquad
    private var presence: Biquad
    private var warmth: Biquad
    private var inputGain: Float
    private var gateOn: Bool
    private var agcOn: Bool
    private var limiterOn: Bool
    private var envelope: Float = 0
    private var hold = 0
    private var gateGain: Float = 0.0006
    private var agcGain: Float = 1
    private var agcEnv: Float = 0
    private var compEnv: Float = 0
    private var limitGain: Float = 1

    init(sampleRate: Double, denoise: Int, gate: Bool, agc: Bool, limiter: Bool, gainDb: Int) {
        self.gateOn = gate
        self.agcOn = agc
        self.limiterOn = limiter
        self.inputGain = pow(10, Float(gainDb) / 20)
        self.highpass = .highpass(rate: sampleRate, hz: 78, q: 0.707)
        self.presence = .peaking(rate: sampleRate, hz: 3150, q: 0.9, db: 3)
        self.warmth = .lowshelf(rate: sampleRate, hz: 210, db: 2.5)
        if denoise > 0 { self.denoiser = SpectralGate(strength: Double(denoise) / 4) }
    }

    func setGainDb(_ db: Int) {
        inputGain = pow(10, Float(max(-12, min(24, db))) / 20)
    }

    func process(_ buffer: inout [Int16]) {
        var floats = buffer.map { Float($0) / 32768 }
        denoiser?.process(&floats)

        for i in 0..<floats.count {
            var x = floats[i]
            x = highpass.process(x)
            x = presence.process(x)
            x = warmth.process(x)

            if gateOn {
                let a = abs(x)
                envelope = a > envelope ? envelope + (a - envelope) * 0.004 : envelope * 0.9991
                if envelope > 0.0032 { hold = 8 } else if hold > 0 { hold -= 1 }
                let target: Float = (envelope > 0.0032 || hold > 0) ? 1 : 0.0006
                gateGain += (target - gateGain) * (target > gateGain ? 0.02 : 0.0015)
                x *= gateGain
            }

            if agcOn {
                agcEnv += (abs(x) - agcEnv) * 0.0006
                if agcEnv > 0.002 {
                    let currentDb = 20 * log10(agcEnv + 1e-9)
                    let desired = min(18, max(-3, -19 - currentDb))
                    let gainDb = 20 * log10(agcGain + 1e-9)
                    let step = min(0.6, max(-0.6, (desired - gainDb) * 0.35))
                    agcGain = min(8, max(0.35, agcGain * pow(10, step / 20)))
                }
                x *= agcGain
            }

            compEnv = abs(x) > compEnv ? compEnv + (abs(x) - compEnv) * 0.06 : compEnv * 0.9992
            if compEnv > 0.125 {
                let over = 20 * log10(compEnv / 0.125)
                x *= pow(10, (-over * 0.66) / 20)
            }

            x *= inputGain

            if limiterOn {
                let ceiling: Float = 0.891
                let a = abs(x)
                let target: Float = a > ceiling ? ceiling / a : 1
                limitGain = target < limitGain ? target : limitGain + (1 - limitGain) * 0.0009
                x *= limitGain
            }

            floats[i] = min(0.999, max(-0.999, x))
        }

        for i in 0..<buffer.count {
            buffer[i] = Int16(max(-32768, min(32767, floats[i] * 32767)))
        }
    }
}

struct Biquad {
    var b0: Float, b1: Float, b2: Float, a1: Float, a2: Float
    var x1: Float = 0, x2: Float = 0, y1: Float = 0, y2: Float = 0

    mutating func process(_ x: Float) -> Float {
        let y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2 = x1; x1 = x
        y2 = y1; y1 = y
        return y
    }

    static func highpass(rate: Double, hz: Double, q: Double) -> Biquad {
        let w = 2 * Double.pi * hz / rate
        let alpha = sin(w) / (2 * q)
        let cosW = cos(w)
        let a0 = 1 + alpha
        return Biquad(
            b0: Float((1 + cosW) / 2 / a0),
            b1: Float(-(1 + cosW) / a0),
            b2: Float((1 + cosW) / 2 / a0),
            a1: Float(-2 * cosW / a0),
            a2: Float((1 - alpha) / a0)
        )
    }

    static func peaking(rate: Double, hz: Double, q: Double, db: Double) -> Biquad {
        let a = pow(10, db / 40)
        let w = 2 * Double.pi * hz / rate
        let alpha = sin(w) / (2 * q)
        let cosW = cos(w)
        let a0 = 1 + alpha / a
        return Biquad(
            b0: Float((1 + alpha * a) / a0),
            b1: Float(-2 * cosW / a0),
            b2: Float((1 - alpha * a) / a0),
            a1: Float(-2 * cosW / a0),
            a2: Float((1 - alpha / a) / a0)
        )
    }

    static func lowshelf(rate: Double, hz: Double, db: Double) -> Biquad {
        let a = pow(10, db / 40)
        let w = 2 * Double.pi * hz / rate
        let cosW = cos(w)
        let alpha = sin(w) / sqrt(2)
        let sq = 2 * sqrt(a) * alpha
        let a0 = (a + 1) + (a - 1) * cosW + sq
        return Biquad(
            b0: Float(a * ((a + 1) - (a - 1) * cosW + sq) / a0),
            b1: Float(2 * a * ((a - 1) - (a + 1) * cosW) / a0),
            b2: Float(a * ((a + 1) - (a - 1) * cosW - sq) / a0),
            a1: Float(-2 * ((a - 1) + (a + 1) * cosW) / a0),
            a2: Float(((a + 1) + (a - 1) * cosW - sq) / a0)
        )
    }
}

/// Spectral subtraction with a learned floor. 512-point FFT, 50% overlap.
final class SpectralGate {
    private let n = 512
    private let hop = 256
    private let log2n: vDSP_Length
    private let setup: FFTSetup
    private var window: [Float]
    private var noise: [Float]
    private var gain: [Float]
    private var frame: [Float]
    private var overlap: [Float]
    private var pending: [Float] = []
    private var fifo: [Float] = []
    private let strength: Float
    private var warmup = 0

    init(strength: Double) {
        self.strength = Float(strength)
        self.log2n = vDSP_Length(log2(Double(n)))
        self.setup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2))!
        self.window = (0..<n).map { 0.5 - 0.5 * cos(2 * .pi * Float($0) / Float(n)) }
        self.noise = [Float](repeating: 0, count: n / 2)
        self.gain = [Float](repeating: 1, count: n / 2)
        self.frame = [Float](repeating: 0, count: n)
        self.overlap = [Float](repeating: 0, count: n)
    }

    deinit { vDSP_destroy_fftsetup(setup) }

    func process(_ samples: inout [Float]) {
        pending.append(contentsOf: samples)
        while pending.count >= hop {
            let chunk = Array(pending.prefix(hop))
            pending.removeFirst(hop)
            fifo.append(contentsOf: renderHop(chunk))
        }
        let count = min(samples.count, fifo.count)
        for i in 0..<count { samples[i] = fifo[i] }
        if count < samples.count { for i in count..<samples.count { samples[i] = 0 } }
        if count > 0 { fifo.removeFirst(count) }
    }

    private func renderHop(_ chunk: [Float]) -> [Float] {
        frame.removeFirst(hop)
        frame.append(contentsOf: chunk)
        var re = [Float](repeating: 0, count: n / 2)
        var im = [Float](repeating: 0, count: n / 2)
        for i in 0..<n { frame[i] *= window[i] }
        frame.withUnsafeBufferPointer { pointer in
            pointer.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: n / 2) { complex in
                var split = DSPSplitComplex(realp: &re, imagp: &im)
                vDSP_ctoz(complex, 2, &split, 1, vDSP_Length(n / 2))
                vDSP_fft_zrip(setup, &split, 1, log2n, FFTDirection(FFT_FORWARD))
            }
        }
        var magnitudes = [Float](repeating: 0, count: n / 2)
        re.withUnsafeMutableBufferPointer { realBuffer in
            im.withUnsafeMutableBufferPointer { imagBuffer in
                var split = DSPSplitComplex(realp: realBuffer.baseAddress!, imagp: imagBuffer.baseAddress!)
                vDSP_zvabs(&split, 1, &magnitudes, 1, vDSP_Length(n / 2))
            }
        }
        for i in 0..<(n / 2) {
            let mag = magnitudes[i]
            if warmup < 18 {
                noise[i] = max(noise[i] * 0.92, mag * 0.82)
                gain[i] = 1
            } else {
                if mag < noise[i] { noise[i] = noise[i] * 0.9 + mag * 0.1 }
                else { noise[i] = noise[i] * 0.9995 + mag * 0.0005 }
                var g: Float = mag > 1e-7 ? (mag - strength * noise[i] * 1.45) / mag : 0
                g = min(1, max(0, g))
                let floor: Float = 1 - 0.9 * strength
                if g < floor { g = floor }
                gain[i] = gain[i] * 0.5 + g * 0.5
            }
            re[i] *= gain[i]
            im[i] *= gain[i]
        }
        for i in 1..<(n / 2) {
            re[i] *= 2
            im[i] *= 2
        }
        var output = [Float](repeating: 0, count: n)
        re.withUnsafeMutableBufferPointer { realBuffer in
            im.withUnsafeMutableBufferPointer { imagBuffer in
                var split = DSPSplitComplex(realp: realBuffer.baseAddress!, imagp: imagBuffer.baseAddress!)
                vDSP_fft_zrip(setup, &split, 1, log2n, FFTDirection(FFT_INVERSE))
                output.withUnsafeMutableBufferPointer { outBuffer in
                    outBuffer.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: n / 2) { complex in
                        vDSP_ztoc(&split, 1, complex, 2, vDSP_Length(n / 2))
                    }
                }
            }
        }
        let scale = 1 / Float(2 * n)
        for i in 0..<n { output[i] *= scale * window[i] }
        for i in 0..<n { overlap[i] += output[i] }
        let result = Array(overlap.prefix(hop))
        overlap.removeFirst(hop)
        overlap.append(contentsOf: [Float](repeating: 0, count: hop))
        if warmup < 1000 { warmup += 1 }
        return result
    }
}

/// IMA ADPCM encoder, byte-compatible with the desktop and Android clients.
final class AdpcmEncoder {
    private var predictor = 0
    private var index = 0

    private static let indexTable: [Int] = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8]
    private static let stepTable: [Int] = [
        7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55,
        60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
        337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411,
        1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358,
        5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500,
        20350, 22385, 24623, 27086, 29794, 32767,
    ]

    func reset() {
        predictor = 0
        index = 0
    }

    func encode(_ samples: [Int16]) -> Data {
        var out = Data(capacity: 4 + (samples.count + 1) / 2)
        out.append(UInt8(predictor & 0xff))
        out.append(UInt8((predictor >> 8) & 0xff))
        out.append(UInt8(index))
        out.append(0)
        var i = 0
        while i < samples.count {
            let low = encodeSample(Int(samples[i]))
            var high = 0
            if i + 1 < samples.count { high = encodeSample(Int(samples[i + 1])) }
            out.append(UInt8(low | (high << 4)))
            i += 2
        }
        return out
    }

    private func encodeSample(_ sample: Int) -> Int {
        let step = Self.stepTable[index]
        var diff = sample - predictor
        var code = 0
        if diff < 0 {
            code = 8
            diff = -diff
        }
        var temp = step
        if diff >= temp { code |= 4; diff -= temp }
        temp >>= 1
        if diff >= temp { code |= 2; diff -= temp }
        temp >>= 1
        if diff >= temp { code |= 1 }

        var delta = step >> 3
        if code & 4 != 0 { delta += step }
        if code & 2 != 0 { delta += step >> 1 }
        if code & 1 != 0 { delta += step >> 2 }
        predictor += (code & 8 != 0) ? -delta : delta
        predictor = max(-32768, min(32767, predictor))
        index = max(0, min(88, index + Self.indexTable[code & 0x0f]))
        return code
    }
}
