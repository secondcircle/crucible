// @vitest-environment node
//
// Which words of a reply are web addresses, and where one ends. A link that
// swallows the full stop after it opens a page that is not there.
import { describe, expect, it } from "vitest";
import { isWebAddress, webAddressIn } from "./web-address";

describe("what reads as a web address", () => {
  it("takes http and https, and nothing else", () => {
    expect(isWebAddress("https://blaportal.com/account/notifications")).toBe(
      true,
    );
    expect(isWebAddress("http://localhost:5173/settings")).toBe(true);
    expect(isWebAddress("ftp://example.test/file")).toBe(false);
    expect(isWebAddress("mailto:someone@example.test")).toBe(false);
    expect(isWebAddress("javascript:alert(1)")).toBe(false);
  });

  it("guesses no scheme", () => {
    expect(isWebAddress("www.example.test")).toBe(false);
    expect(isWebAddress("example.test/path")).toBe(false);
  });

  it("takes nothing with no host, or with a space in it", () => {
    expect(isWebAddress("https://")).toBe(false);
    expect(isWebAddress("https:///path")).toBe(false);
    expect(isWebAddress("https://example.test/a b")).toBe(false);
  });
});

describe("where a bare address ends", () => {
  it("leaves the sentence’s punctuation out", () => {
    for (const closing of [
      ".",
      ",",
      ";",
      ":",
      "!",
      "?",
      '"',
      "’",
      "”",
      '."',
      "),",
    ]) {
      expect(webAddressIn(`https://blaportal.com/account${closing}`)).toBe(
        "https://blaportal.com/account",
      );
    }
  });

  it("keeps punctuation inside the address", () => {
    expect(webAddressIn("https://example.test/a.b?c=1&d=2#e")).toBe(
      "https://example.test/a.b?c=1&d=2#e",
    );
    expect(webAddressIn("http://127.0.0.1:8080/x")).toBe(
      "http://127.0.0.1:8080/x",
    );
  });

  it("keeps a parenthesis the address opened, and drops one it did not", () => {
    expect(webAddressIn("https://en.wikipedia.org/wiki/Foo_(bar)")).toBe(
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    );
    expect(webAddressIn("https://en.wikipedia.org/wiki/Foo_(bar)).")).toBe(
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    );
    expect(webAddressIn("https://example.test/docs)")).toBe(
      "https://example.test/docs",
    );
  });

  it("is nothing when punctuation is all there was after the scheme", () => {
    expect(webAddressIn("https://.")).toBeUndefined();
    expect(webAddressIn("https://)")).toBeUndefined();
  });
});
