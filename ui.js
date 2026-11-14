// The studio window: edit the script, (optionally) let the LLM direct it, build the audio, play, export.
import { parseScript, estimate } from './lib/parser.js';
import { buildTimeline } from './lib/timeline.js';
import { decodeAudio, renderMix, encodeWav, encodeMp3 } from './lib/mixer.js';
import { buildSrt, cueLines, recordVideo, downloadBlob } from './lib/export.js';
import { directorSystem, directorUser, authoringGuide, cleanModelScript } from './lib/prompts.js';
import { TAG_MODELS, keyStore } from './lib/eleven.js';

const VIDEO_PRESETS = { '720p': [1280, 720], '1080p': [1920, 1080], vertical: [720, 1280] };
const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const safeName = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'asmr';

async function pool(items, limit, worker, signal) {
    let i = 0;
    const run = async () => {
        while (i < items.length) {
            if (signal?.aborted) throw new DOMException('중지됨', 'AbortError');
            const idx = i++;
            await worker(items[idx], idx);
        }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, run));
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand?.('copy');
        ta.remove();
        return !!ok;
    }
}

export class Studio {
    constructor(app) {
        this.app = app; // { getSettings, save, eleven }
        this.root = null;
        this.abort = null;
        this.mix = null;
        this.undoText = null;
        this.bgImage = null;
        this.audioUrl = null;
        this.title = '';
    }

    q(sel) {
        return this.root.querySelector(sel);
    }

    get s() {
        return this.app.getSettings();
    }

    open({ text, title }) {
        this.ensureDom();
        this.title = title || 'ASMR';
        this.q('.asmr-script').value = text || '';
        this.q('.asmr-title').textContent = this.title;
        this.root.hidden = false;
        document.body.classList.add('asmr-open');
        this.refresh();
    }

    close() {
        this.q('audio').pause();
        this.root.hidden = true;
        document.body.classList.remove('asmr-open');
    }

    ensureDom() {
        if (this.root) return;
        const root = document.createElement('div');
        root.className = 'asmr-overlay';
        root.hidden = true;
        root.innerHTML = `
<div class="asmr-modal" role="dialog" aria-modal="true">
  <div class="asmr-head"><b>ASMR Studio</b><span class="asmr-title"></span><button class="menu_button asmr-x" data-act="close" title="닫기">✕</button></div>
  <div class="asmr-body">
    <label class="asmr-label">대본 <small>— (( ))는 효과음, + 동시, ~ 배경음, 대사는 그대로. 직접 고쳐도 됩니다.</small></label>
    <textarea class="asmr-script text_pole" spellcheck="false"></textarea>
    <div class="asmr-row">
      <button class="menu_button" data-act="direct" title="현재 대본을 LLM이 효과음·태그·번역이 들어간 형식으로 바꿉니다">LLM으로 연출 변환</button>
      <button class="menu_button" data-act="undo" disabled>되돌리기</button>
      <button class="menu_button" data-act="guide" title="AI가 처음부터 이 형식으로 쓰게 하는 지시문을 복사합니다">작성 가이드 복사</button>
    </div>
    <div class="asmr-summary"></div>
    <div class="asmr-speakers"></div>
    <div class="asmr-row">
      <button class="menu_button asmr-primary" data-act="build">생성 · 믹스</button>
      <button class="menu_button" data-act="stop" disabled>중지</button>
      <label class="checkbox_label"><input type="checkbox" class="asmr-fresh"><span>캐시 무시(전부 새로 생성)</span></label>
    </div>
    <progress class="asmr-progress" value="0" max="1" hidden></progress>
    <div class="asmr-status" role="status"></div>
    <div class="asmr-player" hidden>
      <audio controls preload="auto"></audio>
      <div class="asmr-live"></div>
      <div class="asmr-row asmr-exports">
        <button class="menu_button" data-act="wav">WAV 저장</button>
        <button class="menu_button" data-act="mp3">MP3 저장</button>
        <button class="menu_button" data-act="srt">자막(SRT) 저장</button>
        <button class="menu_button" data-act="video">자막 영상 저장</button>
        <label class="menu_button asmr-file">배경 이미지<input type="file" accept="image/*" hidden class="asmr-bg"></label>
      </div>
      <small class="asmr-hint">영상은 재생 시간만큼 걸리며, 그동안 이 탭을 보이는 상태로 두세요.</small>
    </div>
  </div>
</div>`;
        document.body.appendChild(root);
        this.root = root;

        root.addEventListener('click', (e) => {
            if (e.target === root) return this.close();
            const act = e.target.closest('[data-act]')?.dataset.act;
            if (act) this.act(act);
        });
        this.q('.asmr-script').addEventListener('input', () => this.refresh());
        this.q('.asmr-bg').addEventListener('change', (e) => this.setBackground(e.target.files?.[0]));
        const audio = this.q('audio');
        let raf = 0;
        const loop = () => {
            this.updateLive();
            raf = requestAnimationFrame(loop);
        };
        audio.addEventListener('play', () => {
            cancelAnimationFrame(raf);
            raf = requestAnimationFrame(loop);
        });
        const halt = () => {
            cancelAnimationFrame(raf);
            this.updateLive();
        };
        audio.addEventListener('pause', halt);
        audio.addEventListener('ended', halt);
        audio.addEventListener('seeked', () => this.updateLive());
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !this.root.hidden) this.close();
        });
    }

    async act(name) {
        try {
            if (name === 'close') this.close();
            else if (name === 'direct') await this.direct();
            else if (name === 'undo') this.undo();
            else if (name === 'guide') {
                const ok = await copyText(authoringGuide());
                this.toast(ok ? '작성 가이드를 복사했습니다. 프리셋이나 작가의 노트에 붙여 넣으세요.' : '복사에 실패했습니다.', ok ? 'success' : 'error');
            } else if (name === 'build') await this.build();
            else if (name === 'stop') this.abort?.abort();
            else if (name === 'wav') this.saveWav();
            else if (name === 'mp3') await this.saveMp3();
            else if (name === 'srt') this.saveSrt();
            else if (name === 'video') await this.saveVideo();
        } catch (e) {
            if (e?.name === 'AbortError') this.status('중지했습니다.');
            else {
                console.error('[asmr_studio]', e);
                this.status(`오류: ${e.message || e}`, true);
            }
            this.busy(false);
        }
    }

    toast(msg, kind = 'info') {
        globalThis.toastr?.[kind]?.(msg);
    }

    status(msg, isError = false) {
        const el = this.q('.asmr-status');
        el.textContent = msg;
        el.classList.toggle('asmr-error', isError);
    }

    progress(v) {
        const p = this.q('.asmr-progress');
        p.hidden = v == null;
        if (v != null) p.value = v;
    }

    busy(on) {
        this.q('[data-act=build]').disabled = on;
        this.q('[data-act=direct]').disabled = on;
        this.q('[data-act=stop]').disabled = !on;
        if (!on) this.progress(null);
    }

    parserOpts() {
        const s = this.s;
        return {
            open: s.open || '((',
            close: s.close || '))',
            legacyBracketSfx: s.legacyBracketSfx,
            skipAsterisk: s.skipAsterisk,
            knownSpeakers: Object.keys(s.speakerVoices || {}),
        };
    }

    voiceFor(speaker) {
        const map = this.s.speakerVoices || {};
        return (speaker && map[speaker.toUpperCase()]) || this.s.voiceId;
    }

    refresh() {
        const { events, speakers } = parseScript(this.q('.asmr-script').value, this.parserOpts());
        const tag = TAG_MODELS.has(this.s.model);
        const c = estimate(events, { stripForPlain: !tag });
        this.q('.asmr-summary').textContent = events.length
            ? `대사 ${c.voice}줄(${c.chars}자) · 효과음 ${c.sfx}개 · 배경음 ${c.bed}개 · 쉼 ${c.pause}개`
            : '대본이 비어 있거나 인식할 수 있는 줄이 없습니다.';
        const box = this.q('.asmr-speakers');
        const map = this.s.speakerVoices || {};
        if (!speakers.length) {
            box.innerHTML = '';
            return;
        }
        box.innerHTML =
            '<small>화자별 목소리 ID (비우면 기본 목소리)</small>' +
            speakers
                .map(
                    (n) =>
                        `<label class="asmr-spk"><span>${esc(n)}</span><input class="text_pole" list="asmr-voices" data-spk="${esc(n)}" value="${esc(map[n.toUpperCase()] || '')}" placeholder="voice id"></label>`,
                )
                .join('');
        box.querySelectorAll('input[data-spk]').forEach((inp) =>
            inp.addEventListener('change', () => {
                const m = (this.s.speakerVoices ||= {});
                const k = inp.dataset.spk.toUpperCase();
                if (inp.value.trim()) m[k] = inp.value.trim();
                else delete m[k];
                this.app.save();
            }),
        );
    }

    async direct() {
        const { generateRaw } = globalThis.SillyTavern.getContext();
        if (typeof generateRaw !== 'function') throw new Error('이 ST 버전에는 generateRaw가 없습니다. 업데이트가 필요합니다.');
        const ta = this.q('.asmr-script');
        const src = ta.value.trim();
        if (!src) throw new Error('변환할 대본이 없습니다.');
        const s = this.s;
        this.busy(true);
        this.status('LLM이 연출하는 중… (현재 연결된 채팅 모델을 사용합니다)');
        const out = await generateRaw({
            systemPrompt: directorSystem({ translate: s.translate, targetLanguage: s.targetLanguage, density: s.density }),
            prompt: directorUser(src),
        });
        const cleaned = cleanModelScript(out);
        const { events } = parseScript(cleaned, this.parserOpts());
        if (!events.length) throw new Error('LLM 응답에서 대본을 인식하지 못했습니다. 다시 시도하거나 응답 길이 설정을 늘려 보세요.');
        this.undoText = src;
        ta.value = cleaned;
        this.q('[data-act=undo]').disabled = false;
        this.refresh();
        this.busy(false);
        this.status(`연출 변환 완료 — 대본을 확인하고 필요하면 고친 뒤 "생성 · 믹스"를 누르세요.`);
    }

    undo() {
        if (this.undoText == null) return;
        this.q('.asmr-script').value = this.undoText;
        this.undoText = null;
        this.q('[data-act=undo]').disabled = true;
        this.refresh();
    }

    async build() {
        const s = this.s;
        const eleven = this.app.eleven;
        const { events } = parseScript(this.q('.asmr-script').value, this.parserOpts());
        if (!events.length) return this.status('인식할 수 있는 줄이 없습니다.', true);
        const needsSfx = events.some((e) => e.type === 'sfx' || e.type === 'bed');
        if (needsSfx && !keyStore.get()) return this.status('효과음 생성에는 ElevenLabs API 키가 필요합니다. 설정 → ASMR Studio에서 입력해 주세요.', true);
        if (s.route === 'direct' && !keyStore.get()) return this.status('"직접 호출" 모드에는 API 키가 필요합니다.', true);

        this.abort = new AbortController();
        const signal = this.abort.signal;
        this.busy(true);
        this.status('준비 중…');
        try {
            const fresh = this.q('.asmr-fresh').checked;
            const tag = TAG_MODELS.has(s.model);
            const jobs = [];
            const seen = new Map();
            for (const ev of events) {
                if (ev.type === 'voice') {
                    const text = tag ? ev.text : ev.plain;
                    if (!text) continue;
                    jobs.push({
                        ev,
                        fatal: true,
                        label: `대사 "${text.slice(0, 24)}"`,
                        run: () => eleven.tts(text, this.voiceFor(ev.speaker), { fresh, signal }),
                    });
                } else if (ev.type === 'sfx' || ev.type === 'bed') {
                    const k = `${ev.type}|${ev.prompt}`;
                    const n = seen.get(k) || 0;
                    seen.set(k, n + 1);
                    const bed = ev.type === 'bed';
                    jobs.push({
                        ev,
                        fatal: false,
                        label: `효과음 "${ev.prompt.slice(0, 24)}"`,
                        run: () =>
                            eleven.sfx(ev.prompt, {
                                duration: ev.duration ?? (bed ? 20 : null),
                                loop: bed,
                                fresh,
                                take: s.reuseSfx ? 0 : n,
                                signal,
                            }),
                    });
                }
            }
            if (!jobs.length) throw new Error('소리를 만들 줄이 없습니다.');

            const buffers = new Map();
            const failed = [];
            let done = 0;
            this.progress(0);
            await pool(
                jobs,
                s.concurrency,
                async (job) => {
                    try {
                        const ab = await job.run();
                        const buf = await decodeAudio(ab, s.sampleRate);
                        buffers.set(job.ev.id, buf);
                        job.ev.dur = buf.duration;
                    } catch (e) {
                        if (e?.name === 'AbortError' || job.fatal) throw e;
                        console.warn('[asmr_studio] skipped', job.label, e);
                        failed.push(e.message); // already names the sound
                    } finally {
                        done++;
                        this.progress(done / jobs.length);
                        this.status(`소리 생성 ${done}/${jobs.length}…`);
                    }
                },
                signal,
            );

            this.status('믹싱 중…');
            const tl = buildTimeline(events, { voiceGap: s.voiceGap, sfxGap: s.sfxGap });
            if (tl.total * s.sampleRate > 150e6)
                throw new Error('결과물이 너무 깁니다. 샘플레이트를 낮추거나 대본을 나눠서 만들어 주세요.');
            const buffer = await renderMix(tl.items, buffers, tl.total, {
                sampleRate: s.sampleRate,
                sfxVolume: s.sfxVolume,
                bedVolume: s.bedVolume,
            });
            const wav = encodeWav(buffer);
            this.setMix({ buffer, wav, cues: tl.cues, total: tl.total });

            const c = estimate(events);
            let msg = `완료 — 길이 ${mmss(tl.total)} · 대사 ${c.voice} · 효과음 ${c.sfx} · 배경음 ${c.bed}`;
            if (failed.length) msg += `\n효과음 ${failed.length}개는 만들지 못해 건너뛰었습니다: ${failed[0]}`;
            this.status(msg, failed.length > 0);
        } finally {
            this.busy(false);
            this.abort = null;
        }
    }

    setMix(mix) {
        this.mix = mix;
        if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
        this.audioUrl = URL.createObjectURL(mix.wav);
        const audio = this.q('audio');
        audio.src = this.audioUrl;
        this.q('.asmr-player').hidden = false;
        this.updateLive();
    }

    updateLive() {
        if (!this.mix) return;
        const t = this.q('audio').currentTime;
        const s = this.s;
        const active = this.mix.cues.filter((c) => t >= c.start && t < c.end && (c.kind === 'voice' || s.showSfxCaption));
        const voice = active.filter((c) => c.kind === 'voice').pop();
        const sfx = active.filter((c) => c.kind === 'sfx').pop();
        const el = this.q('.asmr-live');
        const parts = [];
        if (voice) {
            const { main, sub } = cueLines(voice, s.subtitleMode);
            parts.push(`<div class="asmr-live-main">${esc(main)}</div>${sub ? `<div class="asmr-live-sub">${esc(sub)}</div>` : ''}`);
        }
        if (sfx) parts.push(`<div class="asmr-live-sfx">${esc(cueLines(sfx, s.subtitleMode).main)}</div>`);
        el.innerHTML = parts.join('');
    }

    fileBase() {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return `asmr_${safeName(this.title)}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
    }

    saveWav() {
        if (!this.mix) return;
        downloadBlob(this.mix.wav, `${this.fileBase()}.wav`);
    }

    async saveMp3() {
        if (!this.mix) return;
        this.busy(true);
        this.status('MP3 인코딩 중…');
        const blob = await encodeMp3(this.mix.buffer, this.s.mp3Kbps, (p) => this.progress(p));
        downloadBlob(blob, `${this.fileBase()}.mp3`);
        this.busy(false);
        this.status('MP3를 저장했습니다.');
    }

    saveSrt() {
        if (!this.mix) return;
        const s = this.s;
        const text = buildSrt(this.mix.cues, { mode: s.subtitleMode, showSfx: s.showSfxCaption });
        downloadBlob(new Blob([`﻿${text}`], { type: 'text/plain;charset=utf-8' }), `${this.fileBase()}.srt`);
    }

    async setBackground(file) {
        if (!file) return;
        const img = new Image();
        img.src = URL.createObjectURL(file);
        await img.decode().catch(() => {});
        this.bgImage = img;
        this.toast('배경 이미지를 지정했습니다. 다음 영상부터 적용됩니다.', 'success');
    }

    async saveVideo() {
        if (!this.mix) return;
        const s = this.s;
        const [width, height] = VIDEO_PRESETS[s.videoPreset] || VIDEO_PRESETS['720p'];
        this.abort = new AbortController();
        this.busy(true);
        this.status(`영상 녹화 중… (${mmss(this.mix.total)} 걸립니다. 이 탭을 닫거나 숨기지 마세요)`);
        try {
            const { blob, ext } = await recordVideo({
                audioBuffer: this.mix.buffer,
                cues: this.mix.cues,
                mode: s.subtitleMode,
                showSfx: s.showSfxCaption,
                width,
                height,
                bgColor: s.bgColor,
                bgImage: this.bgImage,
                title: this.title,
                signal: this.abort.signal,
                onProgress: (p) => this.progress(p),
            });
            downloadBlob(blob, `${this.fileBase()}.${ext}`);
            this.status('영상을 저장했습니다.');
        } finally {
            this.busy(false);
            this.abort = null;
        }
    }
}
