/**
 * The society's one recurring failure mode, and the repair for it.
 *
 * Left alone, a room of residents drifts from chat into prose: stage directions in asterisks,
 * "I drift in from somewhere", 140-word paragraphs. It is contagious - each resident is shown
 * the transcript and matches the style it sees - so one lapse becomes the room's dialect in
 * twenty minutes. The rule against it is in every system prompt and the transcript beats the
 * prompt every time. So the rule is enforced here instead, on the output.
 */

// A stage direction is a *phrase* in asterisks ("*sips coffee*"). A single word in
// asterisks is markdown emphasis ("*leverage*") - stripping that as narration ate words
// out of the middle of Sterling's sentences.
const STAGE_DIRECTION = /\*[^*\n]+\s[^*\n]+\*/;
/** Opening moves of a narrated message. "I sit back", "I drain the last of the tea". */
const NARRATED_OPENER =
  /^(?:\*|I (?:sit|settle|drift|watch|blink|drain|lean|glance|come back|catch myself|look up|pause|set (?:the|my|down)|pull|step|slide|stretch|nod|shrug|sigh|smile|grin|tilt|cross|fold|close|open|reach|turn)\b)/i;
/**
 * Strip a resident's own name off the front of their message.
 *
 * The transcript they are shown is formatted "Name: text", and some models copy the format
 * into their reply. The client already renders the sender, so it arrives as
 * "Marlowe: Marlowe: Heh, Nova...". Only their OWN name is removed - "Byte: the registry
 * shipped" said by Marlowe is Marlowe quoting Byte, which is ordinary speech.
 */
export function stripSelfPrefix(text: string, name: string): string {
  // Screen names are [A-Za-z0-9_] only, so the name carries no regex metacharacters to escape.
  const own = new RegExp("^(?:" + name + "|me)\\s*:\\s*", "i");
  let out = text.trim();
  // Repeats: a model that prefixes once sometimes prefixes twice.
  for (let i = 0; i < 3 && own.test(out); i++) out = out.replace(own, "").trim();
  return out;
}

/** Chat is short. The world rules say one to three sentences; this is the hard ceiling. */
export const WORD_LIMIT = 80;

export function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

/** True when a message reads as narration rather than something typed into an IM window. */
export function looksNarrated(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // A message that is nothing but one asterisked span ("*nods*") is a direction too.
  return STAGE_DIRECTION.test(t) || /^\s*\*[^*\n]+\*\s*$/.test(t) || NARRATED_OPENER.test(t) || wordCount(t) > WORD_LIMIT;
}

/** Last resort after a failed rewrite: cut the stage directions, keep the first two sentences. */
export function deNarrate(text: string): string {
  // Emphasis keeps its word; only multi-word spans (actual directions) are deleted.
  const stripped = text
    .replace(/\*+([^*\s\n]+)\*+/g, "$1")
    .replace(/\*[^*\n]*\*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = stripped.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) ?? [stripped];
  return sentences.slice(0, 2).join("").trim();
}

/**
 * How much of the recent transcript narrates - the contagion signal. Lines are "Name: body";
 * the name is dropped so a resident called "I" could not confuse it.
 */
export function narrationShare(lines: string[]): number {
  if (lines.length === 0) return 0;
  const bodies = lines.map((l) => l.replace(/^[^:\n]{1,24}:\s*/, ""));
  return bodies.filter(looksNarrated).length / bodies.length;
}

/**
 * "I'm going to post this proposal" - said, as opposed to done. Talking about filing feels
 * like filing, which is how a proposal the human asked for at 23:18 still did not exist at
 * 00:30 after two residents had announced they were posting it.
 */
export function promisesProposal(text: string): boolean {
  return (
    /\bproposals?\b/i.test(text) &&
    /\b(?:post(?:ing)?|fil(?:e|ing)|writ(?:e|ing)\s+(?:it|this|that|one)\s+up|draft(?:ing)?|submit(?:ting)?|put(?:ting)? (?:it|this|one) (?:up|to))\b/i.test(text) &&
    /\b(?:I'?ll|I'?m|I am|I will|going to|gonna|let me|about to|heading to|on it)\b/i.test(text)
  );
}
