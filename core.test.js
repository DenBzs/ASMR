import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScript, stripTags, estimate } from '../lib/parser.js';
import { buildTimeline } from '../lib/timeline.js';
import { encodeWav } from '../lib/mixer.js';
import { cleanModelScript, directorSystem } from '../lib/prompts.js';

// The script the user first tried (long [bracket] descriptions, ALL-CAPS speaker labels).
const LEGACY = `[Muted rustle of heavy cotton sheets shifting across the mattress]

[Deep, unhurried exhale from above, followed by the soft creak of the wooden bed frame as weight settles against the headboard]

[Gentle pat of an open palm against the pillow surface—once, twice]

SOREN
Come here. Lie down on your side.

[Quiet clink of a small ceramic tray being set down on the walnut nightstand]

SOREN
No, turn the other way first. Face the lamp so I can actually see what I'm doing.

[Rustle of hair and fabric turning over; left channel shifts closer, warm and enclosed against the pillow, while right channel opens clearly to the quiet room]`;

test('legacy bracket lines become sound effects, speakers are picked up', () => {
    const { events, speakers } = parseScript(LEGACY);
    assert.deepEqual(speakers, ['SOREN']);
    assert.deepEqual(
        events.map((e) => e.type),
        ['sfx', 'sfx', 'sfx', 'voice', 'sfx', 'voice', 'sfx'],
    );
    assert.equal(events[3].speaker, 'SOREN');
    assert.equal(events[3].text, 'Come here. Lie down on your side.');
});

test('short bracket tags stay voice tags', () => {
    const { events } = parseScript('[whispers] Come here.\n[softly exhales]');
    assert.equal(events.length, 2);
    assert.ok(events.every((e) => e.type === 'voice'));
    assert.equal(events[0].plain, 'Come here.');
    assert.equal(events[1].plain, '');
});

test('(( )) syntax: modes, pan, volume, duration, pause, bed', () => {
    const src = `((~ quiet room tone))
((+ @L *0.6 #3 sheets rustling | 시트 스치는 소리))
[whispers] Come here. | 이리 와.
((pause 2))
((@-0.5 hair brushing))`;
    const { events } = parseScript(src);
    assert.deepEqual(
        events.map((e) => e.type),
        ['bed', 'sfx', 'voice', 'pause', 'sfx'],
    );
    assert.equal(events[1].mode, 'with_next');
    assert.equal(events[1].pan, -0.7);
    assert.equal(events[1].volume, 0.6);
    assert.equal(events[1].duration, 3);
    assert.equal(events[1].caption, '시트 스치는 소리');
    assert.equal(events[2].translation, '이리 와.');
    assert.equal(events[3].seconds, 2);
    assert.equal(events[4].pan, -0.5);
    assert.equal(events[4].mode, 'after');
});

test('inline sound inside a line splits into sound + voice', () => {
    const { events } = parseScript('((+ creak)) Come closer. ((rustle)) Good.');
    assert.deepEqual(
        events.map((e) => e.type),
        ['sfx', 'voice', 'sfx', 'voice'],
    );
});

test('"Wait: what?" is dialogue, "NAME: text" and known speakers are labels', () => {
    const a = parseScript('Wait: what is that?');
    assert.equal(a.events[0].type, 'voice');
    assert.equal(a.events[0].speaker, null);
    const b = parseScript('SOREN: Hello.');
    assert.equal(b.events[0].speaker, 'SOREN');
    const c = parseScript('Mira: Hello.', { knownSpeakers: ['mira'] });
    assert.equal(c.events[0].speaker, 'Mira');
});

test('asterisk narration is skipped, quotes trimmed', () => {
    const { events } = parseScript('*he leans closer*\n"Hello there." *smiles*');
    assert.equal(events.length, 1);
    assert.equal(events[0].text, 'Hello there.');
});

test('custom delimiters', () => {
    const { events } = parseScript('<<creak>> hi', { open: '<<', close: '>>' });
    assert.deepEqual(
        events.map((e) => e.type),
        ['sfx', 'voice'],
    );
});

test('stripTags and estimate', () => {
    assert.equal(stripTags('[whispers] Come [sighs] here .'), 'Come here.');
    const { events } = parseScript('[whispers] Hi.\n((x y))');
    assert.deepEqual(estimate(events), { voice: 1, sfx: 1, bed: 0, pause: 0, chars: 14 });
});

const withDur = (events, d = 1) => events.map((e) => ({ ...e, dur: e.type === 'pause' ? undefined : d }));

test('timeline: sequence, with_next overlap, bed span, total', () => {
    const { events } = parseScript(`((~ room tone #3))
((rustle))
((+ creak))
[whispers] Hello.
((pause 1))
((thud))`);
    const ev = withDur(events, 1);
    ev[0].dur = 20; // bed audio length
    const { items, cues, total } = buildTimeline(ev, { lead: 0, tail: 1, voiceGap: 0.5, sfxGap: 0.1 });
    const by = (t) => items.filter((i) => i.kind === t);
    const [bed] = by('bed');
    const sfx = by('sfx');
    const [voice] = by('voice');
    assert.equal(bed.start, 0);
    assert.equal(sfx[0].start, 0); // rustle
    // creak is with_next: starts exactly when the voice starts (after rustle 1s + 0.1 gap)
    assert.equal(sfx[1].start, voice.start);
    assert.ok(Math.abs(voice.start - 1.1) < 1e-9);
    // pause 1s then thud
    const thud = sfx[2];
    assert.ok(Math.abs(thud.start - (voice.end + 0.5 + 1)) < 1e-9);
    assert.ok(total >= thud.end + 1 - 1e-9);
    assert.equal(bed.end, bed.start + 3); // explicit #3 duration (shorter than the script)
    assert.equal(cues.filter((c) => c.kind === 'voice').length, 1);
});

test('timeline: trailing with_next sound still plays; failed audio is skipped', () => {
    const { events } = parseScript('((+ lonely sound))\n((broken))');
    const ev = [
        { ...events[0], dur: 2 },
        { ...events[1], dur: 0 },
    ];
    const { items } = buildTimeline(ev, { lead: 0 });
    assert.equal(items.length, 1);
    assert.equal(items[0].start, 0);
});

test('wav encoder: header, length, clipping guard', async () => {
    const sr = 8000;
    const len = 800;
    const l = new Float32Array(len).fill(0.5);
    const r = new Float32Array(len).fill(2); // would clip
    const fake = { numberOfChannels: 2, sampleRate: sr, length: len, getChannelData: (c) => (c ? r : l) };
    const blob = encodeWav(fake);
    const buf = Buffer.from(await blob.arrayBuffer());
    assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
    assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
    assert.equal(buf.readUInt16LE(22), 2);
    assert.equal(buf.readUInt32LE(24), sr);
    assert.equal(buf.length, 44 + len * 4);
    const maxSample = Math.max(...Array.from({ length: len * 2 }, (_, i) => Math.abs(buf.readInt16LE(44 + i * 2))));
    assert.ok(maxSample <= 32767 && maxSample >= 31000);
});

test('prompts: fences are stripped, translation toggle', () => {
    assert.equal(cleanModelScript('```text\n((a))\nHi\n```'), '((a))\nHi');
    assert.match(directorSystem({ translate: true }), /Korean translation|natural Korean/);
    assert.match(directorSystem({ translate: false }), /Do not add translations/);
});
