// Audio mixing and encoding. Browser-only parts use Web Audio; the WAV encoder is pure.

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export async function decodeAudio(arrayBuffer, sampleRate = 44100) {
    const Ctx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    const ctx = new Ctx(2, 1, sampleRate);
    return await ctx.decodeAudioData(arrayBuffer.slice(0));
}

/**
 * Renders the timeline into one stereo AudioBuffer.
 * items: from buildTimeline(); buffers: Map(event id -> AudioBuffer).
 */
export async function renderMix(items, buffers, total, opts = {}) {
    const { sampleRate = 44100, sfxVolume = 0.5, bedVolume = 0.25, voiceVolume = 1 } = opts;
    const Ctx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    const ctx = new Ctx(2, Math.max(1, Math.ceil(total * sampleRate)), sampleRate);

    const master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -8;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.005;
    comp.release.value = 0.25;
    master.connect(comp);
    comp.connect(ctx.destination);

    for (const it of items) {
        const buf = buffers.get(it.ev.id);
        if (!buf) continue;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const gain = ctx.createGain();
        let node = gain;
        src.connect(gain);

        const pan = it.ev.pan;
        if (it.kind !== 'voice' && pan != null && pan !== 0 && ctx.createStereoPanner) {
            const p = ctx.createStereoPanner();
            p.pan.value = clamp(pan, -1, 1);
            gain.connect(p);
            node = p;
        }
        node.connect(master);

        const mult = it.ev.volume ?? 1;
        if (it.kind === 'voice') {
            gain.gain.value = voiceVolume;
            src.start(it.start);
        } else if (it.kind === 'sfx') {
            gain.gain.value = sfxVolume * mult;
            src.start(it.start);
        } else {
            const level = bedVolume * mult;
            const fade = Math.min(it.fade ?? 1.5, (it.end - it.start) / 2);
            src.loop = true;
            gain.gain.setValueAtTime(0, it.start);
            gain.gain.linearRampToValueAtTime(level, it.start + fade);
            gain.gain.setValueAtTime(level, Math.max(it.start + fade, it.end - fade));
            gain.gain.linearRampToValueAtTime(0, it.end);
            src.start(it.start);
            src.stop(it.end);
        }
    }
    return await ctx.startRendering();
}

export function peakOf(buf) {
    let max = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < d.length; i++) {
            const a = Math.abs(d[i]);
            if (a > max) max = a;
        }
    }
    return max;
}

/** 16-bit PCM WAV. Scales down only if the peak would clip. */
export function encodeWav(buf) {
    const ch = Math.min(2, buf.numberOfChannels);
    const len = buf.length;
    const sr = buf.sampleRate;
    const data = [];
    for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
    const peak = peakOf(buf);
    const gain = peak > 0.97 ? 0.97 / peak : 1;

    const bytes = len * ch * 2;
    const ab = new ArrayBuffer(44 + bytes);
    const v = new DataView(ab);
    const str = (off, s) => [...s].forEach((c, i) => v.setUint8(off + i, c.charCodeAt(0)));
    str(0, 'RIFF');
    v.setUint32(4, 36 + bytes, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, ch, true);
    v.setUint32(24, sr, true);
    v.setUint32(28, sr * ch * 2, true);
    v.setUint16(32, ch * 2, true);
    v.setUint16(34, 16, true);
    str(36, 'data');
    v.setUint32(40, bytes, true);
    let o = 44;
    for (let i = 0; i < len; i++) {
        for (let c = 0; c < ch; c++) {
            const s = clamp(data[c][i] * gain, -1, 1);
            v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
            o += 2;
        }
    }
    return new Blob([ab], { type: 'audio/wav' });
}

async function loadLame() {
    if (globalThis.lamejs) return globalThis.lamejs;
    await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('MP3 인코더(lamejs)를 불러오지 못했습니다. WAV로 저장해 주세요.'));
        document.head.appendChild(s);
    });
    if (!globalThis.lamejs) throw new Error('MP3 인코더(lamejs)를 불러오지 못했습니다. WAV로 저장해 주세요.');
    return globalThis.lamejs;
}

export async function encodeMp3(buf, kbps = 192, onProgress) {
    const lame = await loadLame();
    const ch = Math.min(2, buf.numberOfChannels);
    const enc = new lame.Mp3Encoder(ch, buf.sampleRate, kbps);
    const peak = peakOf(buf);
    const gain = peak > 0.97 ? 0.97 / peak : 1;
    const d0 = buf.getChannelData(0);
    const d1 = ch > 1 ? buf.getChannelData(1) : null;
    const toI16 = (src, from, to) => {
        const out = new Int16Array(to - from);
        for (let i = from; i < to; i++) {
            const s = clamp(src[i] * gain, -1, 1);
            out[i - from] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        return out;
    };
    const chunks = [];
    const block = 1152 * 16;
    for (let i = 0, n = 0; i < buf.length; i += block, n++) {
        const to = Math.min(i + block, buf.length);
        const l = toI16(d0, i, to);
        const out = d1 ? enc.encodeBuffer(l, toI16(d1, i, to)) : enc.encodeBuffer(l);
        if (out.length) chunks.push(new Uint8Array(out));
        if (n % 30 === 0) {
            onProgress?.(i / buf.length);
            await new Promise((r) => setTimeout(r));
        }
    }
    const end = enc.flush();
    if (end.length) chunks.push(new Uint8Array(end));
    return new Blob(chunks, { type: 'audio/mpeg' });
}
