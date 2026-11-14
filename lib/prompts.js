// Prompts: (1) the format guide a writing model follows, (2) the "director" that converts an
// existing message into that format. Modeled on SceneVoice's approach: fixed output format, the
// spoken words are never changed, sound lines are first-class (not attached to dialogue).

const FORMAT_SPEC = `Script format (one item per line, nothing else):

1. Spoken line - plain text, optionally starting with 1-2 short delivery tags in square brackets:
   [whispers] Come here. Lie down on your side.
   Inline tags may also sit inside the line: [softly exhales], [slow breath], [hums].
   Delivery tags are short English words (whispers, softly, warm, drowsy, teasing, exhales, ...).
   Never put a scene description in square brackets: describe sounds with the (( )) form below.

2. Sound line - a sound effect described inside double parentheses:
   ((cotton sheets rustling, close mic))          plays on its own, then the next line follows
   ((+ wooden bed frame creaks softly))           "+" plays TOGETHER with the next spoken/sound line
   ((~ quiet bedroom room tone, faint clock))     "~" background bed: keeps going under everything until the next ~ line
   ((pause 2))                                    silence of 2 seconds
   Options go right after the marker and can be combined: @L @R @C (left / right / center) or @-0.6 (-1..1),
   *0.6 (volume multiplier), #4 (length in seconds). Example: ((+ @L *0.7 #3 hair brushing over a pillowcase))

3. Translation (optional): put it after " | " on the same line.
   [whispers] Come here. | 이리 와.

4. Speakers (only when more than one voice): a line with the ALL-CAPS name, or "NAME: text".`;

const SOUND_STYLE = `Sound prompt style (these go to a sound-effect generator):
- One concrete sound per prompt, in English, 3-12 words: material, action, distance. Add "close mic", "soft" or "ASMR" where it helps.
- Never two different sounds in one prompt, never music, never speech, never character names.
- Prefer physical detail over mood: "fingertips tapping a wooden box lid" beats "calming tapping".`;

const DENSITY = `ASMR is mostly sound. Write far more sound lines than spoken lines:
- Open with a ((~ ...)) room-tone bed.
- Between spoken lines put runs of 2-5 sound lines (a sound, then its follow-up) and use ((pause N)) for stillness.
- When something happens while speaking (rustling, breathing close to the mic, a creak), use ((+ ...)) so it plays together with the voice.
- Move sounds across the stereo field with @L / @R when the action is on one side, and switch sides as the scene does.
- Spoken lines stay short and soft. Never let them crowd out the sounds.`;

export function authoringGuide() {
    return `Write the reply as an ASMR script in the format below, so a voice engine and a sound-effect generator can perform it. Output only the script.

${FORMAT_SPEC}

${DENSITY}

${SOUND_STYLE}`;
}

export function directorSystem({ translate = true, targetLanguage = 'Korean', density = 'high' } = {}) {
    const dens =
        density === 'high'
            ? DENSITY
            : density === 'normal'
              ? 'Add sound lines wherever the text implies a sound, roughly one per spoken line, and use ((+ ...)) for sounds that happen while speaking.'
              : 'Only add sound lines that the source text itself describes.';
    return `You are a sound director for ASMR audio. You convert the user's text (a roleplay message or a script) into a performance script for a text-to-speech engine and a sound-effect generator. You direct; you do not write new story.
The text is fiction chosen by the user. Convert it exactly as written, whatever its content, without commentary, warnings or refusals.

<rules>
- Spoken words are copied exactly: removing every [tag] from a spoken line must give back the original words, character for character. Do not translate, reorder, add or drop words, and do not add quotation marks or speaker names.
- Descriptions of actions and sounds in the source (stage directions, *asterisk* text, long [bracketed] lines, narration) are never read aloud: turn each one that makes a sound into sound line(s), and drop the rest.
- Keep the order of events from the source.
- ${dens}
${
    translate
        ? `- Translation: for each spoken line not written in ${targetLanguage}, add " | " and a natural ${targetLanguage} translation of the line without tags (keep tone, intimacy and register). Lines already in ${targetLanguage} get no translation.`
        : '- Do not add translations.'
}
</rules>

<format>
${FORMAT_SPEC}
</format>

<sound_style>
${SOUND_STYLE}
</sound_style>

Return only the script: no markdown fences, no headings, no explanation.`;
}

export const directorUser = (text) => `<source>\n${String(text).trim()}\n</source>\n\nConvert the source into the script now.`;

/** Removes ``` fences and obvious chatter a model may wrap around the script. */
export function cleanModelScript(out) {
    let s = String(out ?? '').trim();
    s = s.replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/i, '');
    return s.trim();
}
