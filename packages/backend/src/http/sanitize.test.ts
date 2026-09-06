import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { sanitizeDeep, sanitizeRichText, sanitizeText } from "./sanitize";

/** Built at runtime so this test file, like the module it tests, stays ASCII. */
const cp = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
const RLO = cp(0x202e);
const LRO = cp(0x202d);
const PDI = cp(0x2069);
const ZWSP = cp(0x200b);
const ZWJ = cp(0x200d);
const BOM = cp(0xfeff);
const NUL = cp(0x00);
const BELL = cp(0x07);

/**
 * The module declares its character classes as numeric ranges specifically so the source
 * contains none of the characters it defends against. This asserts that, because a literal
 * U+202E introduced by a careless edit would reorder the file in every editor and review
 * tool that renders it — hiding the very change that introduced it.
 */
describe("the sanitiser's own source", () => {
  it("contains no invisible or bidi characters", () => {
    const source = readFileSync(new URL("./sanitize.ts", import.meta.url), "utf8");

    const suspect = Array.from(source).filter((char) => {
      const c = char.codePointAt(0) as number;
      return (
        c < 0x09 ||
        (c > 0x0d && c < 0x20) ||
        c === 0x7f ||
        (c >= 0x200b && c <= 0x200f) ||
        (c >= 0x202a && c <= 0x202e) ||
        (c >= 0x2066 && c <= 0x2069) ||
        c === 0xfeff
      );
    });

    expect(suspect).toEqual([]);
  });
});

describe("sanitizeText — markup", () => {
  it("removes a script tag and its contents", () => {
    const result = sanitizeText("<script>alert(1)</script>hello");

    expect(result.value).toBe("hello");
    expect(result.findings).toContain("markup");
  });

  it("keeps the text inside a formatting tag", () => {
    expect(sanitizeText("<b>Ada</b> Lovelace").value).toBe("Ada Lovelace");
  });

  it("neutralises an img onerror payload", () => {
    const result = sanitizeText('<img src=x onerror="alert(document.cookie)">');

    expect(result.value).toBe("");
    expect(result.value).not.toContain("onerror");
  });

  it("neutralises an svg onload payload", () => {
    expect(sanitizeText("<svg/onload=alert(1)>").value).not.toContain("onload");
  });

  it("removes a javascript: anchor entirely", () => {
    // xss-audit:allow attack string under test, asserted to be removed
    const result = sanitizeText('<a href="javascript:alert(1)">click</a>');

    expect(result.value).toBe("click");
    expect(result.value).not.toContain("javascript:");
  });

  it("does not leave an escaped entity for React to escape a second time", () => {
    // The user typed a less-than sign. Returning "&lt;" would render as those four
    // characters once React escapes the ampersand.
    const result = sanitizeText("2 < 3 and 4 > 3");

    expect(result.value).toBe("2 < 3 and 4 > 3");
    expect(result.value).not.toContain("&lt;");
  });

  it("leaves an already-clean string byte-identical and reports nothing", () => {
    const clean = "Ada Lovelace";
    const result = sanitizeText(clean);

    expect(result.value).toBe(clean);
    expect(result.findings).toEqual([]);
  });

  it("leaves an ethereum address untouched", () => {
    const address = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

    expect(sanitizeText(address).value).toBe(address);
    expect(sanitizeText(address).findings).toEqual([]);
  });

  it("leaves an ipfs uri untouched", () => {
    const uri = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

    expect(sanitizeText(uri).findings).toEqual([]);
  });
});

describe("sanitizeText — invisible characters", () => {
  it("removes a right-to-left override", () => {
    const result = sanitizeText(`report${RLO}fdp.exe`);

    expect(result.value).toBe("reportfdp.exe");
    expect(result.findings).toContain("bidi_control");
  });

  it("removes every bidi class member", () => {
    const result = sanitizeText(`a${LRO}b${RLO}c${PDI}d`);

    expect(result.value).toBe("abcd");
    expect(result.findings).toEqual(["bidi_control"]);
  });

  it("removes zero-width characters that make two names look identical", () => {
    const withZeroWidth = `Ad${ZWSP}min`;

    expect(withZeroWidth).not.toBe("Admin");
    expect(sanitizeText(withZeroWidth).value).toBe("Admin");
    expect(sanitizeText(withZeroWidth).findings).toContain("zero_width");
  });

  it("removes a byte order mark and a zero-width joiner", () => {
    expect(sanitizeText(`${BOM}Ada${ZWJ}`).value).toBe("Ada");
  });

  it("removes NUL and other control characters", () => {
    const result = sanitizeText(`Ada${NUL}${BELL}Lovelace`);

    expect(result.value).toBe("AdaLovelace");
    expect(result.findings).toContain("control_char");
  });

  it("does not split a surrogate pair", () => {
    // A four-byte emoji is one code point but two UTF-16 units. Iterating by unit would
    // copy half of it and produce a lone surrogate.
    const withEmoji = "Ada \u{1F510} Lovelace";

    expect(sanitizeText(withEmoji).value).toBe(withEmoji);
  });

  it("normalises to NFC so two spellings of one name compare equal", () => {
    const decomposed = "André";
    const composed = "André";

    expect(decomposed).not.toBe(composed);
    expect(sanitizeText(decomposed).value).toBe(composed);
  });
});

describe("sanitizeText — line breaks", () => {
  it("folds newlines to a space by default, so a single-line field stays one line", () => {
    const result = sanitizeText("line one\nline two");

    expect(result.value).toBe("line one line two");
    expect(result.findings).toContain("line_break");
  });

  it("prevents log forging by removing the newline a fake entry would need", () => {
    const forged = 'Ada\n{"level":"info","msg":"role.granted","role":"ADMIN"}';

    expect(sanitizeText(forged).value).not.toContain("\n");
  });

  it("keeps newlines when the field allows them", () => {
    const result = sanitizeText("line one\nline two", { allowNewlines: true });

    expect(result.value).toBe("line one\nline two");
    expect(result.findings).toEqual([]);
  });

  it("normalises CRLF to LF so a stored string does not vary by platform", () => {
    expect(sanitizeText("a\r\nb", { allowNewlines: true }).value).toBe("a\nb");
  });

  it("turns a lone CR into a newline rather than dropping the line break", () => {
    expect(sanitizeText("a\rb", { allowNewlines: true }).value).toBe("a\nb");
  });

  it("collapses a run of CRLF without doubling the blank lines", () => {
    expect(sanitizeText("a\r\n\r\nb", { allowNewlines: true }).value).toBe("a\n\nb");
  });

  it("truncates past maxLength and says so", () => {
    const result = sanitizeText("abcdefghij", { maxLength: 4 });

    expect(result.value).toBe("abcd");
    expect(result.findings).toContain("truncated");
  });
});

describe("sanitizeRichText", () => {
  it("keeps allowed formatting tags", () => {
    expect(sanitizeRichText("<b>bold</b> and <em>italic</em>").value).toBe(
      "<b>bold</b> and <em>italic</em>",
    );
  });

  it("drops a script tag while keeping the surrounding formatting", () => {
    const result = sanitizeRichText("<b>ok</b><script>alert(1)</script>");

    expect(result.value).toBe("<b>ok</b>");
    expect(result.findings).toContain("rich_text_filtered");
  });

  it("strips a javascript: href but keeps an https one", () => {
    // xss-audit:allow attack string under test, asserted to be removed
    expect(sanitizeRichText('<a href="javascript:alert(1)">x</a>').value).not.toContain(
      "javascript:",
    );
    expect(sanitizeRichText('<a href="https://example.com">x</a>').value).toContain(
      'href="https://example.com"',
    );
  });

  it("strips an event handler attribute from an otherwise allowed tag", () => {
    expect(sanitizeRichText('<b onclick="steal()">x</b>').value).toBe("<b>x</b>");
  });

  it("strips a style attribute, which can be an exfiltration channel", () => {
    expect(sanitizeRichText('<p style="background:url(//evil)">x</p>').value).toBe("<p>x</p>");
  });
});

describe("sanitizeDeep", () => {
  it("sanitises nested strings and reports the path of each finding", () => {
    const { value, findings } = sanitizeDeep({
      profile: { displayName: "<script>alert(1)</script>Ada" },
      tags: ["clean", `dirty${RLO}`],
    });

    expect(value.profile.displayName).toBe("Ada");
    expect(value.tags[1]).toBe("dirty");
    expect(Object.keys(findings)).toEqual(["profile.displayName", "tags[1]"]);
  });

  it("reports the finding names but never the offending value", () => {
    const { findings } = sanitizeDeep({ bio: "<script>secret_payload</script>" });

    expect(findings.bio).toEqual(["markup"]);
    expect(JSON.stringify(findings)).not.toContain("secret_payload");
  });

  it("leaves a clean payload structurally and byte identical", () => {
    const payload = {
      tokenId: "42",
      ownerDID: "0xabc",
      tokenURI: "ipfs://bafyclean",
      mintedAt: "2026-01-01T00:00:00.000Z",
      soulbound: false,
      transfers: 3,
      metadata: null,
    };

    const { value, findings } = sanitizeDeep(payload);

    expect(value).toEqual(payload);
    expect(findings).toEqual({});
  });

  it("passes opaque tokens through byte for byte", () => {
    // A JWT contains no markup, so it would survive anyway. The passthrough list exists so
    // that a future policy change to sanitizeText can never corrupt a credential.
    const token = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIweGFiYyJ9.c2lnbmF0dXJl"; // secrets-scan:allow
    const { value } = sanitizeDeep({ accessToken: token, refreshToken: token });

    expect(value.accessToken).toBe(token);
    expect(value.refreshToken).toBe(token);
  });

  it("stops at the depth cap rather than recursing without bound", () => {
    let deep: Record<string, unknown> = { value: "<b>x</b>" };
    for (let i = 0; i < 20; i += 1) deep = { nested: deep };

    expect(() => sanitizeDeep(deep)).not.toThrow();
  });

  it("preserves newlines, so a multi-line payload survives the response path", () => {
    // The SIWE message is the concrete case: it is newline-delimited and must round-trip.
    const message = "example.com wants you to sign in\n\nURI: https://example.com\nNonce: abc";

    expect(sanitizeDeep({ message }).value.message).toBe(message);
  });
});
