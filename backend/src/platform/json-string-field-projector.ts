type Frame =
  | { kind: "object"; next: "firstKey" | "key" | "colon" | "value" | "comma" }
  | { kind: "array"; next: "firstValue" | "value" | "comma" };

type StringKind = "rootKey" | "answer" | "ignored";
type StringState = { kind: StringKind; escape: string; pendingHigh: string; keyOffset: number; keyMatches: boolean };

const escapes = new Map([
  ['"', '"'], ["\\", "\\"], ["/", "/"], ["b", "\b"], ["f", "\f"], ["n", "\n"], ["r", "\r"], ["t", "\t"],
]);
const whitespace = /^[ \t\r\n]$/;
const scalar = /^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[Ee][+-]?[0-9]+)?)$/;

/** Incremental JSON syntax reader. It never retains or publishes text outside the selected string. */
export class JsonStringFieldProjector {
  private readonly frames: Frame[] = [];
  private string: StringState | undefined;
  private atom = "";
  private complete = false;
  private matched = false;
  private targetNext = false;
  private invalid = false;

  constructor(private readonly field: string) {}

  get stopped(): boolean {
    return this.invalid;
  }

  push(chunk: string): string {
    const output: string[] = [];
    // Iterate UTF-16 code units so raw or escaped surrogate halves can share the same buffer.
    for (let i = 0; i < chunk.length && !this.invalid; i++) {
      const char = chunk[i];
      if (this.string) {
        this.readString(this.string, char, output);
        continue;
      }
      if (this.atom) {
        if (!whitespace.test(char) && char !== "," && char !== "]" && char !== "}") {
          if (/^[a-zA-Z0-9+.-]$/.test(char)) this.atom += char;
          else this.invalid = true;
          continue;
        }
        if (!scalar.test(this.atom)) {
          this.invalid = true;
          break;
        }
        this.atom = "";
      }
      if (!whitespace.test(char)) this.readSyntax(char);
    }
    return output.join("");
  }

  finish(): void {
    if (!this.complete || !this.matched) this.invalid = true;
  }

  private beginString(kind: StringKind): void {
    this.string = { kind, escape: "", pendingHigh: "", keyOffset: 0, keyMatches: true };
  }

  private readString(state: StringState, char: string, output: string[]): void {
    if (state.escape === "\\") {
      if (char === "u") {
        state.escape += char;
        return;
      }
      const decoded = escapes.get(char);
      if (decoded === undefined) this.invalid = true;
      else this.acceptDecoded(state, decoded, output);
      state.escape = "";
      return;
    }
    if (state.escape) {
      if (!/^[a-fA-F0-9]$/.test(char)) {
        this.invalid = true;
        return;
      }
      state.escape += char;
      if (state.escape.length === 6) {
        this.acceptDecoded(state, String.fromCharCode(Number.parseInt(state.escape.slice(2), 16)), output);
        state.escape = "";
      }
      return;
    }
    if (char === '"') {
      if (state.pendingHigh) this.invalid = true;
      if (state.kind === "rootKey" && state.keyMatches && state.keyOffset === this.field.length) {
        this.targetNext = !this.matched;
        this.matched = true;
      }
      this.string = undefined;
    } else if (char === "\\") {
      state.escape = char;
    } else if (char.charCodeAt(0) < 0x20) {
      this.invalid = true;
    } else {
      this.acceptDecoded(state, char, output);
    }
  }

  private acceptDecoded(state: StringState, char: string, output: string[]): void {
    if (state.kind === "rootKey") {
      state.keyMatches &&= this.field[state.keyOffset++] === char;
    } else if (state.kind === "answer") {
      const code = char.charCodeAt(0);
      const low = code >= 0xdc00 && code <= 0xdfff;
      if (state.pendingHigh) {
        if (low) output.push(state.pendingHigh + char);
        else this.invalid = true;
        state.pendingHigh = "";
      } else if (code >= 0xd800 && code <= 0xdbff) {
        state.pendingHigh = char;
      } else if (low) {
        this.invalid = true;
      } else {
        output.push(char);
      }
    }
  }

  private readSyntax(char: string): void {
    const frame = this.frames.at(-1);
    if (!frame) {
      if (!this.complete && char === "{") this.frames.push({ kind: "object", next: "firstKey" });
      else this.invalid = true;
      return;
    }

    if (frame.kind === "object") {
      if ((frame.next === "firstKey" || frame.next === "comma") && char === "}") {
        this.frames.pop();
        this.complete = this.frames.length === 0;
        return;
      }
      if ((frame.next === "firstKey" || frame.next === "key") && char === '"') {
        frame.next = "colon";
        this.beginString(this.frames.length === 1 ? "rootKey" : "ignored");
      } else if (frame.next === "colon" && char === ":") {
        frame.next = "value";
      } else if (frame.next === "comma" && char === ",") {
        frame.next = "key";
      } else if (frame.next === "value") {
        frame.next = "comma";
        this.beginValue(char);
      } else {
        this.invalid = true;
      }
    } else if ((frame.next === "firstValue" || frame.next === "comma") && char === "]") {
      this.frames.pop();
    } else if (frame.next === "comma" && char === ",") {
      frame.next = "value";
    } else if (frame.next === "firstValue" || frame.next === "value") {
      frame.next = "comma";
      this.beginValue(char);
    } else {
      this.invalid = true;
    }
  }

  private beginValue(char: string): void {
    const target = this.targetNext;
    this.targetNext = false;
    if (char === '"') this.beginString(target ? "answer" : "ignored");
    else if (target) this.invalid = true;
    else if (char === "{") this.frames.push({ kind: "object", next: "firstKey" });
    else if (char === "[") this.frames.push({ kind: "array", next: "firstValue" });
    else if (/^[-0-9tfn]$/.test(char)) this.atom = char;
    else this.invalid = true;
  }
}
