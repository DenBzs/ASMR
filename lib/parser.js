// Script markup -> event list. Pure functions: no DOM, runs in the browser and in Node tests.
//
// Events
//   voice : { type:'voice', speaker, text, plain, translation }
//   sfx   : { type:'sfx',   mode:'after'|'with_next', prompt, caption, pan, volume, duration }
//   bed   : { type:'bed',   prompt, caption, pan, volume, duration }
//   pause : { type:'pause', seconds }

export const PARSER_DEFAULTS = Object.freeze({
    open: '((',
    close: '))',
    legacyBracketSfx: true, // a line that is only a long [bracketed description] becomes a sound effect
    legacyMinWords: 4,
    skipAsterisk: true, // lines wrapped in *...* are narration and are not voiced
    speakerLabels: true,
    knownSpeakers: [],
});

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SPLIT_PIPE = /\s+[|｜]\s+/;
const CJK = /[぀-ヿ㐀-鿿가-힯]/g;
const PAN_WORDS = { LL: -1, L: -0.7, C: 0, R: 0.7, RR: 1 };

/** Text with its [audio tags] removed (what is shown as the subtitle). */
export function stripTags(text) {
    return String(text ?? '')
        .replace(/\[[^\]\n]{1,80}\]/g, ' ')
        .replace(/\s+([.,!?…])/g, '$1')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

export function wordCount(s) {
    const words = String(s).trim().split(/\s+/).filter(Boolean).length;
    const cjk = (String(s).match(CJK) || []).length;
    return Math.max(words, Math.ceil(cjk / 3));
}

/** Leading modifiers of a sound token: + (with next voice), ~ (bed), @pan, *volume, #seconds. */
function takeModifiers(raw) {
    let s = raw.trim();
    const out = { mode: null, pan: null, volume: null, duration: null, rest: '' };
    if (s[0] === '+') {
        out.mode = 'with_next';
        s = s.slice(1).trim();
    } else if (s[0] === '~') {
        out.mode = 'bed';
        s = s.slice(1).trim();
    }
    const apply = (kind, value) => {
        if (kind === 'pan') {
            const key = value.toUpperCase();
            out.pan = key in PAN_WORDS ? PAN_WORDS[key] : clamp(parseFloat(key), -1, 1);
        } else if (kind === 'volume') out.volume = clamp(parseFloat(value), 0, 3);
        else out.duration = clamp(parseFloat(value), 0.5, 30);
    };
    // Options right after the marker...
    const lead = [
        ['pan', /^@(LL|RR|L|R|C|-?\d+(?:\.\d+)?)(?=\s|$)\s*/i],
        ['volume', /^\*(\d+(?:\.\d+)?)(?=\s|$)\s*/],
        ['duration', /^#(\d+(?:\.\d+)?)s?(?=\s|$)\s*/i],
    ];
    for (let hit = true; hit; ) {
        hit = false;
        for (const [kind, re] of lead) {
            const m = re.exec(s);
            if (m) {
                apply(kind, m[1]);
                s = s.slice(m[0].length);
                hit = true;
            }
        }
    }
    // ...and, since models often put them last, at the very end too.
    const tail = [
        ['pan', /\s+@(LL|RR|L|R|C|-?\d+(?:\.\d+)?)$/i],
        ['volume', /\s+\*(\d+(?:\.\d+)?)$/],
        ['duration', /\s+#(\d+(?:\.\d+)?)s?$/i],
    ];
    for (let hit = true; hit; ) {
        hit = false;
        for (const [kind, re] of tail) {
            const m = re.exec(s);
            if (m) {
                apply(kind, m[1]);
                s = s.slice(0, m.index);
                hit = true;
            }
        }
    }
    out.rest = s.trim();
    return out;
}

export function parseScript(text, options = {}) {
    const o = { ...PARSER_DEFAULTS, ...options };
    const known = new Set((o.knownSpeakers || []).map((n) => String(n).trim().toUpperCase()).filter(Boolean));
    const src = String(text ?? '').replace(/\r\n?/g, '\n');
    const events = [];
    const speakers = new Set();
    let speaker = null;
    let nextId = 0;

    const push = (ev) => {
        ev.id = nextId++;
        events.push(ev);
    };

    const pushSound = (inner) => {
        const raw = inner.trim();
        if (!raw) return;
        const pm = /^pause\s*[:=]?\s*(\d+(?:\.\d+)?)\s*s?$/i.exec(raw);
        if (pm) {
            push({ type: 'pause', seconds: clamp(parseFloat(pm[1]), 0, 60) });
            return;
        }
        const mod = takeModifiers(raw);
        const [prompt, ...cap] = mod.rest.split(SPLIT_PIPE);
        if (!prompt || !prompt.trim()) return;
        push({
            type: mod.mode === 'bed' ? 'bed' : 'sfx',
            mode: mod.mode === 'with_next' ? 'with_next' : 'after',
            prompt: prompt.trim().replace(/\s+/g, ' '),
            caption: cap.join(' | ').trim(),
            pan: mod.pan,
            volume: mod.volume,
            duration: mod.duration,
        });
    };

    const pushText = (chunk) => {
        for (const rawLine of chunk.split('\n')) {
            let line = rawLine.trim();
            if (!line) continue;
            if (/^[-=*_~#]{3,}$/.test(line)) continue; // separators
            if (/^#{1,6}\s/.test(line)) continue; // markdown headings
            if (o.skipAsterisk && (/^\*[^*].*\*$/.test(line) || /^_[^_].*_$/.test(line))) continue;

            // Legacy: a line that is only a long [bracketed description] is a sound, not a voice tag.
            const br = /^\[([^\]]+)\]$/.exec(line);
            if (br && o.legacyBracketSfx && wordCount(br[1]) >= o.legacyMinWords) {
                push({
                    type: 'sfx',
                    mode: 'after',
                    prompt: br[1].trim().replace(/\s+/g, ' '),
                    caption: '',
                    pan: null,
                    volume: null,
                    duration: null,
                });
                continue;
            }

            if (o.speakerLabels) {
                // A line that is only an ALL-CAPS name.
                if (/^[A-Z][A-Z0-9 _-]{1,23}$/.test(line) && !/[a-z]/.test(line)) {
                    speaker = line;
                    speakers.add(speaker);
                    continue;
                }
                // "NAME: text": only for known speakers or ALL-CAPS names, so "Wait: what?" stays dialogue.
                const m = /^([^:：[\]()|｜]{1,24}?)\s*[:：]\s*(.*)$/.exec(line);
                if (m) {
                    const name = m[1].trim();
                    const isCaps = /[A-Z]/.test(name) && !/[a-z]/.test(name);
                    if (name && (known.has(name.toUpperCase()) || isCaps)) {
                        speaker = name;
                        speakers.add(speaker);
                        line = m[2].trim();
                        if (!line) continue;
                    }
                }
            }

            if (o.skipAsterisk) line = line.replace(/\*[^*\n]+\*/g, ' ');
            line = line.trim().replace(/^["“”「『]+|["“”」』]+$/g, '').trim();
            const [original, ...tr] = line.split(SPLIT_PIPE);
            const spoken = (original || '').replace(/\s{2,}/g, ' ').trim();
            if (!spoken) continue;
            push({
                type: 'voice',
                speaker,
                text: spoken,
                plain: stripTags(spoken),
                translation: tr.join(' | ').trim(),
            });
        }
    };

    const re = new RegExp(`${escapeRe(o.open)}([\\s\\S]*?)${escapeRe(o.close)}`, 'g');
    let last = 0;
    let m;
    while ((m = re.exec(src))) {
        pushText(src.slice(last, m.index));
        pushSound(m[1]);
        last = re.lastIndex;
    }
    pushText(src.slice(last));

    return { events, speakers: [...speakers] };
}

/** Counts for the summary line. `stripForPlain`: models without tag support get text without tags. */
export function estimate(events, { stripForPlain = false } = {}) {
    const c = { voice: 0, sfx: 0, bed: 0, pause: 0, chars: 0 };
    for (const ev of events) {
        c[ev.type] = (c[ev.type] || 0) + 1;
        if (ev.type === 'voice') c.chars += (stripForPlain ? ev.plain : ev.text).length;
    }
    return c;
}
