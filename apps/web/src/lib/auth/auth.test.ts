import { describe, expect, it } from "vitest";

import {
  hashConfirmationArguments,
  issueConfirmationToken,
  verifyConfirmationToken,
} from "@/lib/auth/confirmation";
import { hashPassword, verifyPassword } from "@/lib/auth/password";

describe("authentication primitives", () => {
  it("hashes and verifies passwords without retaining plaintext", async () => {
    const encoded = await hashPassword("Long-Enough-Passphrase-42");
    expect(encoded).not.toContain("Long-Enough-Passphrase-42");
    await expect(verifyPassword("Long-Enough-Passphrase-42", encoded)).resolves.toBe(true);
    await expect(verifyPassword("incorrect", encoded)).resolves.toBe(false);
  });

  it("binds confirmation tokens to the user, action, subject, and expiry", () => {
    const claims = { userId: "user-1", action: "automation.run", subjectId: "flow-1" };
    const token = issueConfirmationToken(claims);
    expect(() => verifyConfirmationToken(token, claims)).not.toThrow();
    expect(() => verifyConfirmationToken(token, { ...claims, userId: "user-2" })).toThrow();
    const expired = issueConfirmationToken(claims, -1);
    expect(() => verifyConfirmationToken(expired, claims)).toThrow();
  });

  it("canonicalizes confirmation arguments before hashing", () => {
    expect(hashConfirmationArguments({ b: 2, a: { y: 1, x: true } })).toBe(
      hashConfirmationArguments({ a: { x: true, y: 1 }, b: 2 }),
    );
    expect(hashConfirmationArguments({ a: 1 })).not.toBe(
      hashConfirmationArguments({ a: 2 }),
    );
  });
});
