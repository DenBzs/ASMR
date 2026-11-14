// ElevenLabs access.
//   voices + speech : through SillyTavern's own server route (the key stays in ST's secrets),
//                     or directly with a key typed in this extension ("direct").
//   sound effects   : always direct (ST has no sound-generation route as far as we know), key from this extension.
// The key is kept in the browser's localStorage, never in ST's extension settings.

export const TTS_MODELS = [
    ['eleven_v4', 'Eleven v4 · 태그 지원 (추천)'],
    ['eleven_v4_turbo', 'Eleven v4 Turbo · 태그 지원'],
    ['eleven_v3', 'Eleven v3 · 태그 지원'],
    ['eleven_multilingual_v2', 'Multilingual v2 · 태그 없음'],
    ['eleven_flash_v2_5', 'Flash v2.5 · 태그 없음'],
];
export const TAG_MODELS = new Set(['eleven_v4', 'eleven_v4_turbo', 'eleven_v3', 'eleven_v3_conversational']);

const KEY_STORE = 'asmr_studio_elevenlabs_key';
export const keyStore = {
    get() {
        try {
            return localStorage.getItem(KEY_STORE) || '';
        } catch {
            return '';
        }
    },
    set(v) {
        try {
            if (v) localStorage.setItem(KEY_STORE, v);
            else localStorage.removeItem(KEY_STORE);
        } catch {
            /* storage can be blocked; the key then lives only for this page load */
        }
    },
};

/** Small non-crypto string hash (crypto.subtle is missing on plain-http ST installs). */
export function hash(str) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stHeaders() {
    const ctx = globalThis.SillyTavern?.getContext?.();
    if (typeof ctx?.getRequestHeaders === 'function') return ctx.getRequestHeaders();
    const r = await fetch('/csrf-token');
    const { token } = await r.json();
    return { 'Content-Type': 'application/json', 'X-CSRF-Token': token };
}

async function readError(res) {
    let detail = '';
    try {
        const text = await res.text();
        try {
            const j = JSON.parse(text);
            const d = j.detail ?? j.error ?? j.message ?? j;
            detail = typeof d === 'string' ? d : (d.message ?? JSON.stringify(d));
        } catch {
            detail = text.slice(0, 200);
        }
    } catch {
        /* ignore */
    }
    return detail;
}

function explain(res, detail, what) {
    if (res.status === 401) return `${what}: 인증 실패(401). ElevenLabs 키를 확인해 주세요. ${detail}`;
    if (res.status === 402 || /quota|credit/i.test(detail)) return `${what}: 크레딧이 부족합니다. ${detail}`;
    if (res.status === 404) return `${what}: 경로를 찾을 수 없습니다(404). ${detail}`;
    if (res.status === 422) return `${what}: 요청이 거부되었습니다(422). ${detail}`;
    return `${what}: 오류 ${res.status}. ${detail}`;
}

async function withRetry(fn, { tries = 4, signal } = {}) {
    let last;
    for (let i = 0; i < tries; i++) {
        if (signal?.aborted) throw new DOMException('중지됨', 'AbortError');
        const res = await fn();
        if (res.status !== 429 && res.status < 500) return res;
        last = res;
        await sleep(800 * 2 ** i);
    }
    return last;
}

export class Eleven {
    /** @param {() => object} getSettings */
    constructor(getSettings) {
        this.getSettings = getSettings;
        this.store = null;
    }

    get cache() {
        if (!this.store) {
            const lf = globalThis.SillyTavern?.libs?.localforage;
            this.store = lf?.createInstance ? lf.createInstance({ name: 'asmr-studio' }) : null;
        }
        return this.store;
    }

    async cacheGet(key) {
        try {
            return (await this.cache?.getItem(key)) || null;
        } catch {
            return null;
        }
    }

    async cachePut(key, data) {
        try {
            await this.cache?.setItem(key, data);
        } catch {
            /* cache is best-effort */
        }
    }

    async clearCache() {
        try {
            await this.cache?.clear();
        } catch {
            /* ignore */
        }
    }

    requireKey() {
        const key = keyStore.get();
        if (!key) throw new Error('ElevenLabs API 키가 필요합니다(설정 → ASMR Studio → API 키).');
        return key;
    }

    async listVoices(signal) {
        const s = this.getSettings();
        let res;
        if (s.route === 'direct') {
            res = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': this.requireKey() }, signal });
        } else {
            res = await fetch('/api/speech/elevenlabs/voices', {
                method: 'POST',
                headers: await stHeaders(),
                body: '{}',
                signal,
            });
        }
        if (!res.ok) throw new Error(explain(res, await readError(res), '목소리 목록'));
        const j = await res.json();
        const list = Array.isArray(j) ? j : (j.voices ?? []);
        return list
            .map((v) => ({ id: v.voice_id ?? v.voiceId ?? v.id, name: v.name ?? v.voice_id ?? '' }))
            .filter((v) => v.id);
    }

    ttsBody(text) {
        const s = this.getSettings();
        const snap = (v) => [0, 0.5, 1].reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
        const v3 = s.model === 'eleven_v3' || s.model === 'eleven_v3_conversational';
        const voice_settings = {
            stability: v3 ? snap(s.stability) : s.stability,
            similarity_boost: s.similarity,
            speed: s.speed,
        };
        if (s.style > 0) voice_settings.style = s.style;
        return { text, model_id: s.model, voice_settings };
    }

    /** @returns {Promise<ArrayBuffer>} audio bytes (cached) */
    async tts(text, voiceId, { fresh = false, signal } = {}) {
        const s = this.getSettings();
        if (!voiceId) throw new Error('목소리 ID가 비어 있습니다. 기본 목소리 또는 화자별 목소리를 지정해 주세요.');
        const body = this.ttsBody(text);
        const key = `tts:${hash(JSON.stringify([s.route, voiceId, body]))}`;
        if (!fresh) {
            const hit = await this.cacheGet(key);
            if (hit) return hit;
        }
        const res = await withRetry(
            async () => {
                if (s.route === 'direct') {
                    return fetch(
                        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
                        {
                            method: 'POST',
                            headers: { 'xi-api-key': this.requireKey(), 'Content-Type': 'application/json' },
                            body: JSON.stringify(body),
                            signal,
                        },
                    );
                }
                return fetch('/api/speech/elevenlabs/synthesize', {
                    method: 'POST',
                    headers: await stHeaders(),
                    body: JSON.stringify({ voiceId, request: body }),
                    signal,
                });
            },
            { signal },
        );
        if (!res.ok) {
            const detail = await readError(res);
            if (res.status === 404 && s.route !== 'direct')
                throw new Error(
                    '이 ST에는 /api/speech/elevenlabs 경로가 없습니다(ST 1.15 이상 필요). 설정에서 "직접 호출"로 바꾸고 API 키를 넣어 주세요.',
                );
            throw new Error(explain(res, detail, '음성 생성'));
        }
        const type = res.headers.get('content-type') || '';
        if (type.includes('json')) throw new Error(explain(res, await readError(res), '음성 생성'));
        const data = await res.arrayBuffer();
        await this.cachePut(key, data);
        return data;
    }

    /** Sound effect. `loop` asks for a seamless loop (beds). */
    async sfx(prompt, { duration = null, loop = false, fresh = false, take = 0, signal } = {}) {
        const s = this.getSettings();
        const body = { text: prompt, prompt_influence: s.sfxInfluence };
        if (duration) body.duration_seconds = duration;
        if (s.sfxModel) body.model_id = s.sfxModel;
        if (loop) body.loop = true;
        const key = `sfx:${hash(JSON.stringify([body, take]))}`;
        if (!fresh) {
            const hit = await this.cacheGet(key);
            if (hit) return hit;
        }
        const call = (b) =>
            withRetry(
                () =>
                    fetch('https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128', {
                        method: 'POST',
                        headers: { 'xi-api-key': this.requireKey(), 'Content-Type': 'application/json' },
                        body: JSON.stringify(b),
                        signal,
                    }),
                { signal },
            );
        let res = await call(body);
        if (res.status === 422 && (body.loop || body.model_id)) {
            // An older sound model may not accept loop; retry once without the optional fields.
            const { loop: _l, model_id: _m, ...plain } = body;
            res = await call(plain);
        }
        if (!res.ok) throw new Error(explain(res, await readError(res), `효과음 "${prompt.slice(0, 40)}"`));
        const data = await res.arrayBuffer();
        await this.cachePut(key, data);
        return data;
    }
}
