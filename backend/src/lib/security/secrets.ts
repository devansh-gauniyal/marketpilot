import crypto from "node:crypto";

const ENCRYPTION_PREFIX = "enc:v1:";
const DEV_SECRET = "marketpilot-local-development-secret";

export function encryptSecret(value: string): string {
  const plain = value.trim();
  if (!plain) return "";

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `${ENCRYPTION_PREFIX}${[
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".")}`;
}

export function decryptSecret(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const stored = value.trim();

  // Older/local records may have plain tokens. Read them, but every new OAuth
  // save writes encrypted values.
  if (!stored.startsWith(ENCRYPTION_PREFIX)) return stored;

  const parts = stored.slice(ENCRYPTION_PREFIX.length).split(".");
  if (parts.length !== 3) return undefined;

  try {
    const [ivPart, tagPart, encryptedPart] = parts;
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      Buffer.from(ivPart, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedPart, "base64url")),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  } catch {
    return undefined;
  }
}

export function connectionEncryptionMode(): "configured" | "local-dev" {
  return configuredSecret() ? "configured" : "local-dev";
}

function encryptionKey(): Buffer {
  return crypto
    .createHash("sha256")
    .update(configuredSecret() ?? DEV_SECRET, "utf8")
    .digest();
}

function configuredSecret(): string | undefined {
  const value =
    process.env.CONNECTION_ENCRYPTION_KEY?.trim() ??
    process.env.MARKETPILOT_SECRET?.trim();
  return value || undefined;
}
