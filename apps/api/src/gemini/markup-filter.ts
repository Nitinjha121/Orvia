/**
 * Strips bracketed markup written by the model into its own transcript.
 *
 * The model occasionally echoes editor notes or emits uppercase bracketed labels
 * (e.g. `[CODE SNAPSHOT: {...}]`). This streaming filter parses brackets and
 * nested strings to remove the markup from the live transcript displayed to the user.
 */

/** A complete opener: `[`, an upper-case label, then `:`, `]` or a dash. */
const OPENER = /^\[\s*[A-Z][A-Z_ ]+(?::|\]|\s[—–-])/;
/** Still possibly growing into one. */
const OPENER_PREFIX = /^\[\s*(?:[A-Z][A-Z_ ]*)?$/;
/** Past this a bracket that never became a label is ordinary text. */
const OPENER_MAX_CHARS = 40;

export class MarkupFilter {
  private mode: 'text' | 'opener' | 'markup' = 'text';
  /** The possible opener held back, or the markup span so far. */
  private held = '';
  private depth = 0;
  private inString = false;
  private escaped = false;
  private removed: string[] = [];

  /** One fragment in; whatever of it is safe to show out. */
  push(fragment: string): string {
    let out = '';
    for (const ch of fragment) {
      if (this.mode === 'text') {
        if (ch === '[') {
          this.mode = 'opener';
          this.held = ch;
        } else out += ch;
        continue;
      }

      this.held += ch;
      if (this.mode === 'opener') {
        if (OPENER.test(this.held)) {
          this.mode = 'markup';
          // The label's own `]` closes a bare "[SESSION ENDS]" at once.
          this.depth = this.held.endsWith(']') ? 0 : 1;
          if (this.depth === 0) this.closeSpan();
        } else if (!OPENER_PREFIX.test(this.held) || this.held.length > OPENER_MAX_CHARS) {
          out += this.held;
          this.held = '';
          this.mode = 'text';
        }
        continue;
      }

      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (ch === '\\') this.escaped = true;
        else if (ch === '"') this.inString = false;
      } else if (ch === '"') this.inString = true;
      else if (ch === '[') this.depth += 1;
      else if (ch === ']') {
        this.depth -= 1;
        if (this.depth === 0) this.closeSpan();
      }
    }
    return out;
  }

  /**
   * The turn ended. A held opener was text after all; a span still open was
   * markup the model never closed, and is dropped with the rest of it.
   */
  end(): string {
    const out = this.mode === 'opener' ? this.held : '';
    if (this.mode === 'markup') this.removed.push(this.held);
    this.reset();
    return out;
  }

  /** The spans removed since the last call, for reporting. */
  takeRemoved(): string[] {
    const r = this.removed;
    this.removed = [];
    return r;
  }

  reset() {
    this.mode = 'text';
    this.held = '';
    this.depth = 0;
    this.inString = false;
    this.escaped = false;
  }

  private closeSpan() {
    this.removed.push(this.held);
    this.held = '';
    this.mode = 'text';
    this.inString = false;
    this.escaped = false;
  }
}
