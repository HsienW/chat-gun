import { describe, expect, it } from "vitest";
import { JsonStringFieldProjector } from "./json-string-field-projector.js";

function project(chunks: string[], field = "answer") {
  const projector = new JsonStringFieldProjector(field);
  const fragments = chunks.map((chunk) => projector.push(chunk));
  projector.finish();
  return { fragments, text: fragments.join(""), stopped: projector.stopped };
}

describe("JsonStringFieldProjector", () => {
  it.each([true, false])("projects at every UTF-8 boundary (abstained first: %s)", (abstainedFirst) => {
    const raw = (abstainedFirst ? '{"abstained":false,' : '{') +
      String.raw`"nested":[{"answer":"hidden","n":-12.5e+3},true,null],"answ\u0065r":"中\"\\\/\b\f\n\r\t\u4E16\uD83D\uDE00🌈","answer":"duplicate"` +
      (abstainedFirst ? '}' : ',"abstained":false}');
    const bytes = new TextEncoder().encode(raw);
    const expected = '中"\\/\b\f\n\r\t世😀🌈';
    for (let boundary = 0; boundary <= bytes.length; boundary++) {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const result = project([decoder.decode(bytes.slice(0, boundary), { stream: true }), decoder.decode(bytes.slice(boundary))]);
      expect(result.text).toBe(expected);
      expect(result.stopped).toBe(false);
    }
    expect(project(raw.split("")).text).toBe(expected);
  });

  it("withholds an incomplete escape and either half of a surrogate pair", () => {
    expect(project(['{"answer":"A\\uD8', '3D\\u', 'DE00B', '"}']).fragments).toEqual(["A", "", "😀B", ""]);
    expect(project(['{"answer":"\uD83D', '\uDE00"}']).fragments).toEqual(["", "😀"]);
  });

  it.each(['17', 'null', '{"answer":"hidden"}', '["hidden"]', '""'])("never exposes a later duplicate when the first value is %s", (value) => {
    expect(project([`{"answer":${value},"answer":"duplicate"}`]).text).toBe("");
  });

  it("marks an unfinished answer only when the input actually ends", () => {
    const projector = new JsonStringFieldProjector("answer");
    expect(projector.push('{"answer":"prefix')).toBe("prefix");
    expect(projector.stopped).toBe(false);
    projector.finish();
    expect(projector.stopped).toBe(true);
    expect(projector.push('discarded"}')).toBe("");
  });

  it.each([
    ['["not an object"]', ''],
    ['{"a" 0,"answer":"no"}', ''],
    ['{"a":[1,],"answer":"no"}', ''],
    ['{"a":01,"answer":"no"}', ''],
    [String.raw`{"answer":"prefix\xnever"}`, 'prefix'],
    [String.raw`{"answer":"prefix\uD800bad"}`, 'prefix'],

    ['{"answer":"prefix"} junk', 'prefix'],
  ])("stops safely for malformed input %s", (input, expected) => {
    expect(project([input, '{"answer":"not published"}'])).toMatchObject({ text: expected, stopped: true });
  });
});
