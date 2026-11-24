import { expect, it } from "vitest";
import { proxyUrlSchema } from "./contracts.js";

it.each([
  ["http://h:8080", "http://h:8080"],
  ["https://u:p@H:3128/", "https://u:p@h:3128"],
  ["http://h:80", "http://h"],
])("normalizes HTTP(S) proxy URL %s", (input, expected) => {
  expect(proxyUrlSchema.parse(input)).toBe(expected);
});

it.each([
  "socks5://h:1",
  "http://u:%zz@h:1",
  "https://%FF:p@h:1",
  "http://user:pass@h:0",
  "http://user:pass word@h",
  "http://user:pass@h/path",
  "http://user:pass@h/path/..",
  "http://user:pass@h/?",
  "http://user:pass@h/#",
  "http://user:pass@h/?query=1",
  "http://user:pass@h/#fragment",
  "http://user:páss@h",
  "http://user:pass@h\n",
  "http://user:pass@",
  `http://user:${"x".repeat(2049)}@h`,
])("rejects invalid proxy URL case %# without exposing the input", (input) => {
  const parsed = proxyUrlSchema.safeParse(input);
  expect(parsed.success).toBe(false);
  expect(JSON.stringify(parsed.error)).not.toContain("user:");
  expect(String(parsed.error)).not.toContain(input);
});

it("rejects an empty proxy URL", () => {
  expect(proxyUrlSchema.safeParse("").success).toBe(false);
});

it.each(["http://user@h:1", "http://user:@h:1", "http://:tok@h:1"])(
  "rejects incomplete proxy credentials in case %# with a safe message",
  (input) => {
    const parsed = proxyUrlSchema.safeParse(input);
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({
        message: "proxy credentials need both a username and a password",
      }),
    ]);
    expect(String(parsed.error)).not.toContain(input);
  },
);
