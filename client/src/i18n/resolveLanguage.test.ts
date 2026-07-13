import { describe, it, expect } from "vitest";
import { resolveLanguage } from "./index";

// The backend rejects any language outside its allow-list, so a raw browser locale must never
// reach it: a German browser would otherwise fail every profile save on a language nobody
// picked, and an account created before the language was persisted carries an empty string.
describe("resolveLanguage", () => {
  it("should strip the region from a locale we ship", () => {
    expect(resolveLanguage("tr-TR")).toBe("tr");
    expect(resolveLanguage("en-GB")).toBe("en");
  });

  it("should pass through a bare supported language", () => {
    expect(resolveLanguage("tr")).toBe("tr");
  });

  it("should fall back for a language we do not ship", () => {
    expect(resolveLanguage("de")).toBe("en");
    expect(resolveLanguage("fr-FR")).toBe("en");
  });

  it("should fall back for a missing or empty value", () => {
    expect(resolveLanguage("")).toBe("en");
    expect(resolveLanguage(undefined)).toBe("en");
    expect(resolveLanguage(null)).toBe("en");
  });
});
