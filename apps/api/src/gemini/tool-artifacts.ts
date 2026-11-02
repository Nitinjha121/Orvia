/**
 * Strips verbalized tool call invocations and response artifacts from output transcripts.
 *
 * Audio models occasionally verbalize their internal function call parameters or
 * result payloads into output transcripts before speaking a genuine sentence.
 * This filter strips the parameter prefix while preserving the spoken response.
 */

/**
 * Parameter names taken from the tool declarations in `coach/coach.tools.ts`.
 * Split by how their value ends, which is the only way to know where the
 * artifact stops and the sentence starts.
 *
 * Keep both lists in step with the declarations — a parameter missing here is
 * a parameter that leaks.
 */
const ENUM_PARAMS = ['kind', 'round', 'part'];
const FREE_PARAMS = ['content', 'focus', 'memory'];
const ALL_PARAMS = [...ENUM_PARAMS, ...FREE_PARAMS];

const PARAM_LABEL = new RegExp(`\\b(?:${ALL_PARAMS.join('|')})\\s*:`, 'i');

/**
 * A turn that opens with a verbalised tool call. The tool name may or may not
 * be spoken first ("save memory kind:" versus a bare "kind:"), so the prefix is
 * optional — but a parameter label is required. Without that requirement
 * "Remember to breathe before you answer" would be treated as a `remember`
 * call.
 */
const CALL_OPENER = new RegExp(`^[a-z_ ]{0,24}\\b(?:${ALL_PARAMS.join('|')})\\s*:`, 'i');

/**
 * A verbalised tool RESULT. Unambiguous — no one says "response colon".
 *
 * Entries must be COMMA separated. Allowing whitespace to join them let the
 * match run past the end of the blob and swallow the first real word after it:
 * "…,saved Understood. I've saved that…" came back as "…. I've saved that…".
 * The closing brace is optional because the transcript usually truncates before
 * it — the leak observed ended at ",saved" with no brace at all.
 */
const RESPONSE_ARTIFACT =
  /\bresponse\s*:\s*[a-z_][a-z0-9_]*\s*\{\s*[a-z_][a-z0-9_]*(?:\s*:\s*[^,\s{}]*)?(?:\s*,\s*[a-z_][a-z0-9_]*(?:\s*:\s*[^,\s{}]*)?)*\s*\}?/gi;

/**
 * Whether a head fragment could still grow into an artifact.
 *
 * Fragments arrive a few characters at a time, so "save" alone has to be held
 * long enough to become "save memory kind:". Anything with punctuation in it
 * cannot be a tool name or a bare label, so ordinary speech is released on its
 * first fragment — and the 24 character cap bounds the wait for the speech that
 * happens to open with two or three plain words.
 */
export function mayOpenToolArtifact(head: string): boolean {
  return /^response\s*:?$/i.test(head) || /^[a-z_ ]{1,24}$/i.test(head) || opensToolArtifact(head);
}

export function opensToolArtifact(head: string): boolean {
  return CALL_OPENER.test(head) || /^response\s*:\s*[a-z_]/i.test(head);
}

/**
 * Strips verbalised tool calls and results, returning whatever real speech was
 * left behind.
 *
 * The value of an enumerated parameter is a single token; the value of a free
 * text one runs until the next parameter label. That is what makes the end of
 * "round: latest" findable and the end of "content: <a whole sentence>" not
 * guessable — so free text is bounded by what follows it rather than by trying
 * to detect where a sentence begins.
 */
export function scrubToolArtifacts(text: string): { clean: string; removed: string } {
  let out = text.replace(RESPONSE_ARTIFACT, ' ');

  if (CALL_OPENER.test(out.trimStart())) {
    const lead = out.length - out.trimStart().length;
    let i = lead;

    // Skip the spoken tool name, if there is one, up to the first label.
    const firstLabel = out.slice(i).search(PARAM_LABEL);
    if (firstLabel > 0) i += firstLabel;

    // Then consume label/value pairs for as long as they keep coming.
    for (;;) {
      const rest = out.slice(i);
      const m = rest.match(new RegExp(`^\\s*\\b(${ALL_PARAMS.join('|')})\\s*:\\s*`, 'i'));
      if (!m) break;
      i += m[0].length;
      const param = m[1]!.toLowerCase();

      if (ENUM_PARAMS.includes(param)) {
        // One token, then either the next label or the real sentence.
        i += (out.slice(i).match(/^\S*/) ?? [''])[0].length;
      } else {
        // Free text: it ends where the next label begins, and if none follows
        // there is nothing left to salvage from this turn anyway.
        const next = out.slice(i).search(PARAM_LABEL);
        i += next === -1 ? out.length - i : next;
      }
    }
    out = out.slice(0, lead) + out.slice(i);
  }

  const clean = out.replace(/\s+/g, ' ').trimStart();
  return { clean, removed: clean === text.replace(/\s+/g, ' ').trimStart() ? '' : text };
}
