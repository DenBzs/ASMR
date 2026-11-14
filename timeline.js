// Places events on a time axis. Pure: every event that makes sound needs `dur` (seconds) set first.
//
//   voice / sfx(after)  play one after another, with a gap
//   sfx(with_next)      starts together with the next voice/sfx(after)
//   bed                 starts at the current position and runs until the next bed (or the end)
//   pause               moves the position forward

export const TIMELINE_DEFAULTS = Object.freeze({
    lead: 0.4,
    tail: 1.2,
    voiceGap: 0.7,
    sfxGap: 0.2,
    bedFade: 1.5,
});

export function buildTimeline(events, options = {}) {
    const o = { ...TIMELINE_DEFAULTS, ...options };
    const items = [];
    let cursor = o.lead;
    let pending = [];

    const place = (ev, start) => {
        const item = { ev, kind: ev.type, start, end: start + (ev.dur || 0) };
        items.push(item);
        return item;
    };

    for (const ev of events) {
        if (ev.type === 'pause') {
            cursor += ev.seconds;
            continue;
        }
        if (!(ev.dur > 0)) continue; // no audio (failed or empty)
        if (ev.type === 'bed') {
            place(ev, cursor);
            continue;
        }
        if (ev.type === 'sfx' && ev.mode === 'with_next') {
            pending.push(ev);
            continue;
        }
        const start = cursor;
        for (const p of pending) place(p, start);
        pending = [];
        const item = place(ev, start);
        cursor = item.end + (ev.type === 'voice' ? o.voiceGap : o.sfxGap);
    }
    for (const p of pending) {
        // "with next" but nothing follows: play it in sequence
        const item = place(p, cursor);
        cursor = item.end + o.sfxGap;
    }

    let end = 0;
    for (const it of items) if (it.kind !== 'bed') end = Math.max(end, it.end);
    let total = Math.max(end + o.tail, cursor);

    const beds = items.filter((it) => it.kind === 'bed').sort((a, b) => a.start - b.start);
    if (beds.length && end === 0) total = Math.max(total, ...beds.map((b) => b.start + b.ev.dur));
    beds.forEach((bed, i) => {
        const next = beds[i + 1];
        const explicit = bed.ev.duration ? bed.start + bed.ev.duration : null;
        bed.end = explicit ?? (next ? next.start + o.bedFade : total);
        bed.end = Math.min(bed.end, total);
        bed.fade = o.bedFade;
    });

    const cues = [];
    for (const it of items) {
        if (it.kind === 'voice') {
            if (!it.ev.plain && !it.ev.translation) continue;
            cues.push({
                kind: 'voice',
                start: it.start,
                end: it.end,
                text: it.ev.plain,
                translation: it.ev.translation,
                speaker: it.ev.speaker,
            });
        } else {
            cues.push({
                kind: 'sfx',
                start: it.start,
                end: it.kind === 'bed' ? Math.min(it.start + 4, it.end) : it.end,
                text: it.ev.caption || it.ev.prompt,
                translation: '',
                speaker: null,
            });
        }
    }
    cues.sort((a, b) => a.start - b.start);

    return { items, cues, total };
}
