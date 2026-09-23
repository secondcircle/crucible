// Which of an agent's words are web addresses. Pure, so the rule can be pinned
// without a browser: the text is recognized here and never interpreted, and
// where a click on one goes is decided elsewhere.

/**
 * True when the whole of this text is an `http` or `https` address: what a
 * code span or a markdown link's href is checked against. No other scheme, and
 * no guessing one for `www.example.com`.
 */
export function isWebAddress(text: string): boolean {
  if (!/^https?:\/\/[^\s/]\S*$/i.test(text)) return false;
  try {
    return new URL(text).hostname !== "";
  } catch {
    return false;
  }
}

// What a sentence puts after an address rather than in it.
const CLOSING = /[.,;:!?'"’”]$/;

/**
 * The address a bare run of prose starting with `http://` or `https://`
 * names, with the sentence's punctuation left off it; nothing when what is
 * left is no address at all. A `)` stays only while it closes a `(` the
 * address itself opened, so a Wikipedia page keeps its parenthesis and an
 * aside in parentheses keeps its own.
 */
export function webAddressIn(run: string): string | undefined {
  let address = run;
  for (;;) {
    if (
      CLOSING.test(address) ||
      (address.endsWith(")") && !balanced(address))
    ) {
      address = address.slice(0, -1);
      continue;
    }
    return isWebAddress(address) ? address : undefined;
  }
}

function balanced(address: string): boolean {
  const count = (character: string): number =>
    address.split(character).length - 1;
  return count("(") >= count(")");
}
