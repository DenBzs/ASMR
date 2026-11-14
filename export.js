// Subtitles (SRT) and subtitled video (canvas + audio recorded in real time with MediaRecorder).

const pad = (n, w = 2) => String(n).padStart(w, '0');
const stamp = (t) => {
    const ms = Math.max(0, Math.round(t * 1000));
    return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
};

/** The text a cue shows for a subtitle mode: 'translation' | 'original' | 'both'. */
export function cueLines(cue, mode) {
    if (cue.kind === 'sfx') return { main: `(${cue.text})`, sub: '' };
    const o = cue.text || '';
    const t = cue.translation || '';
    if (mode === 'original') return { main: o || t, sub: '' };
    if (mode === 'translation') return { main: t || o, sub: '' };
    return t ? { main: t, sub: o } : { main: o, sub: '' };
}

export function visibleCues(cues, { showSfx = false } = {}) {
    return cues.filter((c) => c.kind === 'voice' || showSfx);
}

export function buildSrt(cues, { mode = 'translation', showSfx = false } = {}) {
    const list = visibleCues(cues, { showSfx });
    return (
        list
            .map((c, i) => {
                const { main, sub } = cueLines(c, mode);
                return `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${main}${sub ? `\n${sub}` : ''}\n`;
            })
            .join('\n') || ''
    );
}

export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function wrap(g, text, maxW) {
    const lines = [];
    for (const para of String(text).split('\n')) {
        let line = '';
        for (const tok of para.match(/\S+\s*|\s+/g) || ['']) {
            if (g.measureText(line + tok).width <= maxW) {
                line += tok;
                continue;
            }
            if (line) {
                lines.push(line.trimEnd());
                line = '';
            }
            if (g.measureText(tok).width <= maxW) {
                line = tok;
                continue;
            }
            for (const ch of tok) {
                if (g.measureText(line + ch).width > maxW && line) {
                    lines.push(line);
                    line = '';
                }
                line += ch;
            }
        }
        lines.push(line.trimEnd());
    }
    return lines;
}

function paint(g, w, h, t, o) {
    g.fillStyle = o.bgColor;
    g.fillRect(0, 0, w, h);
    if (o.bgImage) {
        const r = Math.max(w / o.bgImage.width, h / o.bgImage.height);
        const iw = o.bgImage.width * r;
        const ih = o.bgImage.height * r;
        g.drawImage(o.bgImage, (w - iw) / 2, (h - ih) / 2, iw, ih);
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.fillRect(0, 0, w, h);
    }
    if (o.title) {
        g.font = `${Math.round(h * 0.03)}px sans-serif`;
        g.fillStyle = 'rgba(255,255,255,0.55)';
        g.textAlign = 'left';
        g.textBaseline = 'top';
        g.fillText(o.title, w * 0.04, h * 0.045);
    }

    const active = o.cues.filter((c) => t >= c.start && t < c.end);
    const voice = active.filter((c) => c.kind === 'voice').pop();
    const sfx = o.showSfx ? active.filter((c) => c.kind === 'sfx').pop() : null;

    const draw = (cue, y0, big) => {
        const { main, sub } = cueLines(cue, o.mode);
        const size = Math.round(h * (big ? 0.052 : 0.04));
        const small = Math.round(size * 0.72);
        const maxW = w * 0.84;
        g.textAlign = 'center';
        g.textBaseline = 'top';
        g.font = `${size}px sans-serif`;
        const l1 = wrap(g, main, maxW);
        g.font = `${small}px sans-serif`;
        const l2 = sub ? wrap(g, sub, maxW) : [];
        const lh1 = size * 1.35;
        const lh2 = small * 1.35;
        const boxH = l1.length * lh1 + l2.length * lh2 + size * 0.7;
        const y = y0 - boxH;
        g.fillStyle = 'rgba(0,0,0,0.55)';
        g.beginPath();
        g.roundRect?.(w * 0.06, y, w * 0.88, boxH, 14);
        if (!g.roundRect) g.rect(w * 0.06, y, w * 0.88, boxH);
        g.fill();
        let yy = y + size * 0.35;
        g.fillStyle = '#fff';
        g.font = `${size}px sans-serif`;
        l1.forEach((l) => {
            g.fillText(l, w / 2, yy);
            yy += lh1;
        });
        g.fillStyle = 'rgba(255,255,255,0.7)';
        g.font = `${small}px sans-serif`;
        l2.forEach((l) => {
            g.fillText(l, w / 2, yy);
            yy += lh2;
        });
        return boxH;
    };
    let y = h * 0.92;
    if (voice) y -= draw(voice, y, true) + h * 0.015;
    if (sfx) draw(sfx, y, false);
}

function pickMime() {
    const list = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
    return list.find((m) => globalThis.MediaRecorder?.isTypeSupported?.(m)) || '';
}

/**
 * Records canvas + audio while the mix plays (takes as long as the audio). Keep the tab visible.
 * @returns {Promise<{blob: Blob, ext: string}>}
 */
export async function recordVideo({
    audioBuffer,
    cues,
    mode = 'translation',
    showSfx = false,
    width = 1280,
    height = 720,
    bgColor = '#0b0d12',
    bgImage = null,
    title = '',
    onProgress,
    signal,
}) {
    const mime = pickMime();
    if (!mime || !HTMLCanvasElement.prototype.captureStream)
        throw new Error('이 브라우저는 영상 녹화(MediaRecorder)를 지원하지 않습니다. Chrome/Edge를 사용해 주세요.');

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    const opts = { cues, mode, showSfx, bgColor, bgImage, title };

    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    const actx = new AC();
    await actx.resume();
    const dest = actx.createMediaStreamDestination();
    const src = actx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(dest);

    const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 192_000 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise((res) => (rec.onstop = res));

    const duration = audioBuffer.duration;
    let t0 = 0;
    const frame = () => {
        const t = Math.max(0, actx.currentTime - t0);
        paint(g, width, height, t, opts);
        onProgress?.(Math.min(1, t / duration));
    };
    paint(g, width, height, 0, opts);
    rec.start(1000);
    t0 = actx.currentTime + 0.1;
    src.start(t0);
    const timer = setInterval(frame, 1000 / 30);
    try {
        await new Promise((res) => {
            src.onended = res;
            signal?.addEventListener('abort', res, { once: true });
        });
        frame();
        await new Promise((r) => setTimeout(r, 300));
    } finally {
        clearInterval(timer);
        if (rec.state !== 'inactive') rec.stop();
        await stopped;
        stream.getTracks().forEach((t) => t.stop());
        actx.close?.();
    }
    if (signal?.aborted) throw new DOMException('중지됨', 'AbortError');
    return { blob: new Blob(chunks, { type: mime.split(';')[0] }), ext: mime.startsWith('video/mp4') ? 'mp4' : 'webm' };
}
