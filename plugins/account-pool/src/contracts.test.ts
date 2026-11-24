import { expect, it } from "vitest";
import { proxyUrlSchema } from "./contracts.js";

it.each([
  ["http://h:8080", "http://h:8080"],
  ["https://u:p@H:3128/", "https://u:p@h:3128"],
  ["http://h:80", "http://h"],
  ["socks5://h:1080", "socks5://h:1080"],
  ["socks5://u:p@h:1080", "socks5://u:p@h:1080"],
  ["socks5h://h:1080", "socks5h://h:1080"],
  ["SOCKS5H://u:%40@H:01080/", "socks5h://u:%40@h:1080"],
  ["socks5://%48:80", "socks5://h:80"],
])("normalizes proxy URL %s", (input, expected) => {
  expect(proxyUrlSchema.parse(input)).toBe(expected);
});

it.each([
  "socks4://h:1",
  "socks://h:1",
  "socks5://u:%zz@h:1080",
  "socks5://u:p@%zz:1080",
  "socks5h://u:p@h:0",
  "socks5://u:p@h:65536",
  "socks5://u:p@h/path/..",
  "socks5://u:p@h/?",
  "socks5h://u:p@h/#",
  "socks5://u:p@",
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

it.each([
  "http://user@h:1",
  "http://user:@h:1",
  "http://:tok@h:1",
  "socks5://user@h:1080",
  "socks5://user:@h:1080",
  "socks5h://:tok@h:1080",
])(
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
