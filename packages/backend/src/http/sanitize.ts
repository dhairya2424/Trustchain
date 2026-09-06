/**
 * Server-side sanitisation of user-provided strings.
 *
 * Everything else in this codebase that could reasonably be written by hand was written by
 * hand. This is the deliberate exception. Recognising markup means implementing the HTML
 * parsing algorithm, and the entire history of XSS is bypasses of bespoke parsers that were
 * *almost* right — mutation XSS, namespace confusion, mXSS through `noscript`. DOMPurify is
 * the reference implementation, is adversarially tested, and runs against a real DOM
 * (jsdom) rather than against a regex. A hand-rolled sanitiser here would be a liability
 * rather than craftsmanship.
 *
 * The API's contract is that every string it stores and returns is PLAIN TEXT. There is no
 * rich-text field today, so `sanitizeText` is the path everything takes: markup is removed
 * rather than filtered, which is a far smaller thing to get right than deciding which tags
 * are safe. `sanitizeRichText` exists for the day a field genuinely needs HTML, so that
 * such a field arrives with an allowlist instead of an ad-hoc call to `sanitize()`.
 */
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";

/** A named set of code point ranges, inclusive at both ends. */
interface CharClass {
  readonly name: string;
  readonly ranges: ReadonlyArray<readonly [number, number]>;
}

/**
 * Character classes are declared as numbers, not as regex literals.
 *
 * A regex literal for these would have to contain the characters themselves, and a literal
 * U+202E in this file would reorder the source in every editor and review tool that renders
 * it — the exact attack the class exists to defend against. Numbers keep the file ASCII and
 * make each range greppable.
 */
const BIDI_CONTROLS: CharClass = {
  name: "bidi_control",
  ranges: [
    [0x202a, 0x202e], // LRE, RLE, PDF, LRO, RLO
    [0x2066, 0x2069], // LRI, RLI, FSI, PDI
    [0x200e, 0x200f], // LRM, RLM
    [0x061c, 0x061c], // ARABIC LETTER MARK
  ],
};

/** Zero-width characters: two visually identical names that are different strings. */
const ZERO_WIDTH: CharClass = {
  name: "zero_width",
  ranges: [
    [0x200b, 0x200d], // ZWSP, ZWNJ, ZWJ
    [0x2060, 0x2060], // WORD JOINER
    [0xfeff, 0xfeff], // ZERO WIDTH NO-BREAK SPACE / BOM
  ],
};

/** Tab, line feed and carriage return. Kept or folded to a space, never simply deleted. */
const LINE_BREAKS: CharClass = {
  name: "line_break",
  ranges: [
    [0x09, 0x09],
    [0x0a, 0x0a],
    [0x0d, 0x0d],
  ],
};

/** C0 and C1 control characters, excluding the three above. */
const CONTROL_CHARS: CharClass = {
  name: "control_char",
  ranges: [
    [0x00, 0x08],
    [0x0b, 0x0c],
    [0x0e, 0x1f],
    [0x7f, 0x9f],
  ],
};

function inClass(codePoint: number, cls: CharClass): boolean {
  return cls.ranges.some(([low, high]) => codePoint >= low && codePoint <= high);
}

export interface SanitizeOptions {
  /** Keep newline and tab characters. Off for single-line fields, on for free text. */
  allowNewlines?: boolean;
  /** Truncate after this many characters. Zod caps lengths; this is a backstop. */
  maxLength?: number;
}

export interface SanitizeResult {
  value: string;
  /** What had to be removed. Empty means the input was already clean. */
  findings: string[];
}

/**
 * A single jsdom window shared by every call.
 *
 * Constructing one costs tens of milliseconds, which would otherwise be paid per request.
 * It is created lazily so that importing this module in a context that never sanitises — a
 * migration script, a test of an unrelated unit — does not pay for it either.
 */
let purifier: ReturnType<typeof createDOMPurify> | undefined;
let sharedWindow: JSDOM["window"] | undefined;

function purify(): { instance: ReturnType<typeof createDOMPurify>; window: JSDOM["window"] } {
  if (!purifier || !sharedWindow) {
    // No network, no external resources, no script execution: the window exists only to
    // give DOMPurify a parser.
    const dom = new JSDOM("", { url: "https://sanitizer.invalid" });
    sharedWindow = dom.window;
    purifier = createDOMPurify(dom.window as unknown as Window & typeof globalThis);
  }
  return { instance: purifier, window: sharedWindow };
}

const CARRIAGE_RETURN = 0x0d;
const LINE_FEED = 0x0a;
const SPACE = " ";

/**
 * Removes invisible and control characters in a single pass over the code points.
 *
 * Iterating with `for...of` walks by code point rather than by UTF-16 unit, so an emoji or
 * any other surrogate pair is copied whole instead of being split in half.
 */
function stripInvisible(
  input: string,
  allowNewlines: boolean,
): { value: string; findings: Set<string> } {
  const findings = new Set<string>();
  const out: string[] = [];

  // Indexed rather than `for...of` because CR needs one code point of lookahead. Built with
  // Array.from, which splits by code point, so a surrogate pair stays a single entry.
  const chars = Array.from(input);

  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i] as string;
    const codePoint = char.codePointAt(0) as number;

    if (inClass(codePoint, LINE_BREAKS)) {
      if (!allowNewlines) {
        findings.add(LINE_BREAKS.name);
        out.push(SPACE);
      } else if (codePoint !== CARRIAGE_RETURN) {
        out.push(char);
      } else {
        // CRLF collapses to LF and a lone CR becomes LF, so a stored string does not vary
        // by the client's platform. The CR is dropped only when the LF that follows will
        // be emitted in its place.
        const next = chars[i + 1];
        if (next !== undefined && next.codePointAt(0) === LINE_FEED) continue;
        out.push("\n");
      }
      continue;
    }

    if (inClass(codePoint, BIDI_CONTROLS)) {
      findings.add(BIDI_CONTROLS.name);
      continue;
    }
    if (inClass(codePoint, ZERO_WIDTH)) {
      findings.add(ZERO_WIDTH.name);
      continue;
    }
    if (inClass(codePoint, CONTROL_CHARS)) {
      findings.add(CONTROL_CHARS.name);
      continue;
    }

    out.push(char);
  }

  return { value: out.join(""), findings };
}

/**
 * Reduces a string to plain text.
 *
 * DOMPurify parses with an empty tag allowlist and `KEEP_CONTENT`, so markup is dropped and
 * the text inside it survives — except inside `script`, `style` and the other
 * content-forbidden elements, whose bodies DOMPurify discards entirely. The result is
 * HTML-escaped, so it is read back through `textContent` to get true plain text: returning
 * the escaped form would double-escape once React renders it, and the user typed a
 * less-than sign, not an entity.
 */
export function sanitizeText(input: string, options: SanitizeOptions = {}): SanitizeResult {
  // Normalise first. Composed and decomposed forms of the same name compare unequal, and
  // normalising afterwards could re-form a character that had just been removed.
  const normalized = input.normalize("NFC");

  const stripped = stripInvisible(normalized, options.allowNewlines === true);
  const findings = stripped.findings;
  let value = stripped.value;

  const { instance, window } = purify();
  const escaped = instance.sanitize(value, {
    ALLOWED_TAGS: [],
    ALLOWED_ATTR: [],
    KEEP_CONTENT: true,
  });

  // `escaped` contains no elements, so this assignment only decodes entities.
  const decoder = window.document.createElement("div");
  decoder.innerHTML = escaped;
  const text = decoder.textContent ?? "";

  if (text !== value) findings.add("markup");
  value = text;

  if (options.maxLength !== undefined && value.length > options.maxLength) {
    findings.add("truncated");
    value = value.slice(0, options.maxLength);
  }

  return { value, findings: [...findings] };
}

/** Tags permitted in a rich-text field. Deliberately short and inline-only. */
const RICH_TEXT_TAGS = ["b", "i", "em", "strong", "u", "p", "br", "ul", "ol", "li", "a"];
const RICH_TEXT_ATTRS = ["href", "title"];

/**
 * Sanitises a field that is allowed to contain formatting.
 *
 * No field uses this yet; it exists so that the first one to need it cannot invent its own
 * policy. `ALLOWED_URI_REGEXP` is the important line — without it an anchor survives with a
 * `javascript:` href, which is tag-allowlisting's classic hole.
 */
export function sanitizeRichText(input: string): SanitizeResult {
  const { instance } = purify();
  const prepared = stripInvisible(input.normalize("NFC"), true).value;

  const clean = instance.sanitize(prepared, {
    ALLOWED_TAGS: RICH_TEXT_TAGS,
    ALLOWED_ATTR: RICH_TEXT_ATTRS,
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|ipfs:)/i,
    FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form"],
    FORBID_ATTR: ["style", "srcset", "formaction", "xlink:href"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });

  return { value: clean, findings: clean === input ? [] : ["rich_text_filtered"] };
}

/** Field names whose values are opaque tokens that must survive byte for byte. */
/**
 * Fields carried through byte for byte.
 *
 * These are opaque cryptographic artifacts, and altering one by even a character destroys
 * it: a JWT whose payload was touched no longer verifies, and a content key that lost a
 * byte no longer decrypts. None of them can contain markup — they are base64, base64url
 * or hex — so exempting them removes no protection, while a future tightening of
 * `sanitizeText` that did touch them would silently corrupt credentials.
 */
const PASSTHROUGH_KEYS = new Set([
  "accesstoken",
  "refreshtoken",
  "signature",
  "proof",
  "sig",
  "jwt",
  "credentialjwt",
  "contentkey",
  "cursor",
  "nextcursor",
]);

export interface DeepSanitizeResult<T> {
  value: T;
  /** `field path -> findings`, populated only where something was actually removed. */
  findings: Record<string, string[]>;
}

/**
 * Walks a payload and sanitises every string in it.
 *
 * Newlines are permitted here because outbound payloads legitimately contain multi-line
 * strings, and because the guarantee this provides is narrower and more useful than
 * reformatting: a string is only ever altered when it contains markup, a control character,
 * a bidi override or a zero-width character. None of those appear in an address, a CID, a
 * JWT, a hex hash or an ISO timestamp, so nothing legitimate is touched — which is exactly
 * why any alteration at all is worth logging.
 */
export function sanitizeDeep<T>(input: T): DeepSanitizeResult<T> {
  const findings: Record<string, string[]> = {};

  const walk = (value: unknown, at: string, level: number): unknown => {
    if (level > 8) return value;

    if (typeof value === "string") {
      const result = sanitizeText(value, { allowNewlines: true });
      if (result.findings.length > 0) findings[at || "(root)"] = result.findings;
      return result.value;
    }

    if (Array.isArray(value)) return value.map((item, i) => walk(item, `${at}[${i}]`, level + 1));

    if (value !== null && typeof value === "object") {
      const output: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        const child = at ? `${at}.${key}` : key;
        output[key] = PASSTHROUGH_KEYS.has(key.toLowerCase())
          ? entry
          : walk(entry, child, level + 1);
      }
      return output;
    }

    return value;
  };

  return { value: walk(input, "", 0) as T, findings };
}
