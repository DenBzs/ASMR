// ASMR Studio — SillyTavern extension entry point.
// Turns a chat message written with ((sound)) lines into audio: voice via ElevenLabs TTS,
// sound effects via ElevenLabs Sound Effects, mixed on a timeline (overlap, beds, panning).
import { Studio } from './ui.js';
import { Eleven, TTS_MODELS, keyStore } from './lib/eleven.js';
import { authoringGuide } from './lib/prompts.js';

const MODULE_NAME = 'asmr_studio';

const DEFAULTS = Object.freeze({
    route: 'st',
    voiceId: '',
    speakerVoices: {},
    model: 'eleven_v4',
    stability: 0.5,
    similarity: 0.75,
    style: 0,
    speed: 0.9,
    sfxModel: 'eleven_text_to_sound_v2',
    sfxInfluence: 0.4,
    sfxVolume: 0.5,
    bedVolume: 0.25,
    voiceGap: 0.7,
    sfxGap: 0.2,
    concurrency: 2,
    reuseSfx: false,
    open: '((',
    close: '))',
    legacyBracketSfx: true,
    skipAsterisk: true,
    translate: true,
    targetLanguage: 'Korean',
    density: 'high',
    subtitleMode: 'translation',
    showSfxCaption: false,
    sampleRate: 44100,
    mp3Kbps: 192,
    videoPreset: '720p',
    bgColor: '#0b0d12',
});

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) extensionSettings[MODULE_NAME] = structuredClone(DEFAULTS);
    const s = extensionSettings[MODULE_NAME];
    for (const key of Object.keys(DEFAULTS)) {
        if (!Object.hasOwn(s, key)) s[key] = structuredClone(DEFAULTS[key]);
    }
    return s;
}

const save = () => SillyTavern.getContext().saveSettingsDebounced();
const eleven = new Eleven(getSettings);
const studio = new Studio({ getSettings, save, eleven });

const SELECTS = {
    route: [
        ['st', 'ST 서버 경유 (ST에 등록한 ElevenLabs 키 사용)'],
        ['direct', '직접 호출 (아래 API 키 사용)'],
    ],
    model: TTS_MODELS,
    density: [
        ['high', '효과음 많이 (ASMR)'],
        ['normal', '보통'],
        ['low', '원문에 적힌 것만'],
    ],
    subtitleMode: [
        ['translation', '번역문'],
        ['original', '원문'],
        ['both', '번역문 + 원문'],
    ],
    sampleRate: [
        [44100, '44.1 kHz'],
        [32000, '32 kHz'],
        [24000, '24 kHz (가볍게)'],
    ],
    mp3Kbps: [
        [128, '128 kbps'],
        [192, '192 kbps'],
        [256, '256 kbps'],
    ],
    videoPreset: [
        ['720p', '가로 1280×720'],
        ['1080p', '가로 1920×1080'],
        ['vertical', '세로 720×1280'],
    ],
};

// type: text | password | number | range | select | check | color
const FIELDS = [
    { h: '연결' },
    { key: 'route', label: '음성 생성 경로', type: 'select' },
    { key: '__apiKey', label: 'ElevenLabs API 키 — 효과음에 필수 · 이 브라우저에만 저장', type: 'password' },
    { key: 'voiceId', label: '기본 목소리 ID', type: 'text', list: 'asmr-voices', voices: true },
    { key: 'model', label: '음성 모델', type: 'select' },
    { h: '음성' },
    { key: 'stability', label: '안정성', type: 'range', min: 0, max: 1, step: 0.05 },
    { key: 'similarity', label: '유사도', type: 'range', min: 0, max: 1, step: 0.05 },
    { key: 'style', label: '스타일 강조', type: 'range', min: 0, max: 1, step: 0.05 },
    { key: 'speed', label: '속도', type: 'range', min: 0.7, max: 1.2, step: 0.05 },
    { h: '효과음 · 믹스' },
    { key: 'sfxModel', label: '효과음 모델 ID', type: 'text' },
    { key: 'sfxInfluence', label: '프롬프트 반영도', type: 'range', min: 0, max: 1, step: 0.05 },
    { key: 'sfxVolume', label: '효과음 볼륨', type: 'range', min: 0, max: 1.5, step: 0.05 },
    { key: 'bedVolume', label: '배경음 볼륨', type: 'range', min: 0, max: 1, step: 0.05 },
    { key: 'voiceGap', label: '대사 뒤 간격(초)', type: 'range', min: 0, max: 3, step: 0.1 },
    { key: 'sfxGap', label: '효과음 뒤 간격(초)', type: 'range', min: 0, max: 2, step: 0.05 },
    { key: 'reuseSfx', label: '같은 효과음 묘사는 한 번만 생성해 재사용', type: 'check' },
    { key: 'concurrency', label: '동시 생성 수 (요금제 한도에 맞춰 낮추세요)', type: 'number', min: 1, max: 8 },
    { h: '대본 형식' },
    { key: 'open', label: '효과음 시작 기호', type: 'text' },
    { key: 'close', label: '효과음 끝 기호', type: 'text' },
    { key: 'legacyBracketSfx', label: '[긴 묘사] 줄도 효과음으로 처리', type: 'check' },
    { key: 'skipAsterisk', label: '*지문* 줄은 읽지 않음', type: 'check' },
    { h: 'LLM 연출 변환' },
    { key: 'translate', label: '자막용 번역 추가', type: 'check' },
    { key: 'targetLanguage', label: '번역 언어', type: 'text' },
    { key: 'density', label: '효과음 밀도', type: 'select' },
    { h: '자막 · 내보내기' },
    { key: 'subtitleMode', label: '자막 표시', type: 'select' },
    { key: 'showSfxCaption', label: '효과음 자막도 표시', type: 'check' },
    { key: 'sampleRate', label: '샘플레이트', type: 'select', num: true },
    { key: 'mp3Kbps', label: 'MP3 비트레이트', type: 'select', num: true },
    { key: 'videoPreset', label: '영상 크기', type: 'select' },
    { key: 'bgColor', label: '영상 배경색', type: 'color' },
];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function fieldHtml(f) {
    const id = `${MODULE_NAME}_${f.key}`;
    if (f.type === 'check')
        return `<label class="checkbox_label"><input id="${id}" type="checkbox"><span>${f.label}</span></label>`;
    let control;
    if (f.type === 'select')
        control = `<select id="${id}" class="text_pole">${SELECTS[f.key].map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>`;
    else if (f.type === 'range')
        control = `<input id="${id}" type="range" min="${f.min}" max="${f.max}" step="${f.step}"><span class="asmr-rv" id="${id}_v"></span>`;
    else if (f.type === 'number') control = `<input id="${id}" class="text_pole" type="number" min="${f.min}" max="${f.max}">`;
    else if (f.type === 'color') control = `<input id="${id}" type="color">`;
    else
        control = `<input id="${id}" class="text_pole" type="${f.type}"${f.list ? ` list="${f.list}"` : ''} autocomplete="off" spellcheck="false">${
            f.voices ? '<div class="menu_button asmr-load-voices">목소리 불러오기</div>' : ''
        }`;
    return `<label class="asmr-field"><span>${f.label}</span>${control}</label>`;
}

function bindField(f) {
    const el = document.getElementById(`${MODULE_NAME}_${f.key}`);
    if (!el) return;
    const s = getSettings();
    const isKey = f.key === '__apiKey';
    const read = () => (isKey ? keyStore.get() : s[f.key]);
    if (f.type === 'check') el.checked = !!read();
    else el.value = read();
    const show = () => {
        const out = document.getElementById(`${MODULE_NAME}_${f.key}_v`);
        if (out) out.textContent = el.value;
    };
    show();
    const onChange = () => {
        if (isKey) keyStore.set(el.value.trim());
        else {
            let v;
            if (f.type === 'check') v = el.checked;
            else if (f.type === 'range' || f.type === 'number' || f.num) v = Number(el.value);
            else v = el.value;
            if ((f.type === 'number' || f.type === 'range') && Number.isNaN(v)) return;
            s[f.key] = v;
            save();
        }
        show();
        if (!studio.root?.hidden && studio.root) studio.refresh();
    };
    el.addEventListener(f.type === 'range' || f.type === 'text' || f.type === 'password' ? 'input' : 'change', onChange);
}

function ensureVoiceList() {
    let dl = document.getElementById('asmr-voices');
    if (!dl) {
        dl = document.createElement('datalist');
        dl.id = 'asmr-voices';
        document.body.appendChild(dl);
    }
    return dl;
}

async function loadVoices() {
    try {
        const voices = await eleven.listVoices();
        ensureVoiceList().innerHTML = voices.map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('');
        toastr.success(`목소리 ${voices.length}개를 불러왔습니다. 입력칸을 눌러 이름으로 고르세요.`);
    } catch (e) {
        toastr.error(e.message || String(e));
    }
}

function lastMessageIndex() {
    const { chat } = SillyTavern.getContext();
    for (let i = chat.length - 1; i >= 0; i--) if (!chat[i].is_system && !chat[i].is_user) return i;
    return chat.length - 1;
}

function openForMessage(idx) {
    const { chat } = SillyTavern.getContext();
    const m = chat[idx];
    if (!m) return toastr.warning('열 수 있는 메시지가 없습니다.');
    studio.open({ text: m.mes, title: `${m.name || ''} #${idx}`.trim() });
}

function buildSettingsPanel() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host || document.getElementById(`${MODULE_NAME}_settings`)) return;
    const body = FIELDS.map((f) => (f.h ? `<h4 class="asmr-h">${f.h}</h4>` : fieldHtml(f))).join('');
    host.insertAdjacentHTML(
        'beforeend',
        `<div id="${MODULE_NAME}_settings" class="extension_settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>ASMR Studio</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content asmr-settings">
      <div class="asmr-row">
        <div class="menu_button asmr-open-last">마지막 메시지로 스튜디오 열기</div>
        <div class="menu_button asmr-copy-guide">작성 가이드 복사</div>
        <div class="menu_button asmr-clear-cache">캐시 비우기</div>
      </div>
      ${body}
    </div>
  </div>
</div>`,
    );
    FIELDS.filter((f) => f.key).forEach(bindField);
    ensureVoiceList();
    const root = document.getElementById(`${MODULE_NAME}_settings`);
    root.querySelector('.asmr-open-last').addEventListener('click', () => openForMessage(lastMessageIndex()));
    root.querySelector('.asmr-load-voices')?.addEventListener('click', loadVoices);
    root.querySelector('.asmr-copy-guide').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(authoringGuide());
            toastr.success('작성 가이드를 복사했습니다.');
        } catch {
            toastr.error('복사에 실패했습니다.');
        }
    });
    root.querySelector('.asmr-clear-cache').addEventListener('click', async () => {
        await eleven.clearCache();
        toastr.success('생성한 소리 캐시를 비웠습니다.');
    });
}

function decorateMessages() {
    document.querySelectorAll('#chat .mes').forEach((el) => {
        if (el.querySelector('.asmr-mes-btn')) return;
        const bar = el.querySelector('.extraMesButtons');
        if (!bar) return;
        const btn = document.createElement('div');
        btn.className = 'mes_button asmr-mes-btn fa-solid fa-headphones';
        btn.title = 'ASMR Studio로 열기';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openForMessage(Number(el.getAttribute('mesid')));
        });
        bar.prepend(btn);
    });
}

function start() {
    buildSettingsPanel();
    decorateMessages();
    const chatEl = document.getElementById('chat');
    if (chatEl) {
        let timer = 0;
        new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(decorateMessages, 150);
        }).observe(chatEl, { childList: true });
    }
    const { eventSource, event_types } = SillyTavern.getContext();
    eventSource.on(event_types.CHAT_CHANGED, () => setTimeout(decorateMessages, 300));
    globalThis.ASMR_STUDIO = { open: openForMessage, studio, eleven, getSettings };
    console.log(`[${MODULE_NAME}] loaded`);
}

if (document.getElementById('extensions_settings2')) start();
else SillyTavern.getContext().eventSource.on(SillyTavern.getContext().event_types.APP_READY, start);
