export type SensitiveMemoryCategory =
  | "authentication-secret"
  | "financial-account"
  | "government-identifier"
  | "medical-information"
  | "payment-card"
  | "private-key";

export interface MemoryPolicyResult {
  allowed: boolean;
  blockedCategories: SensitiveMemoryCategory[];
}

export class MemoryPolicyError extends Error {
  readonly code = "SENSITIVE_MEMORY_REJECTED";
  readonly blockedCategories: SensitiveMemoryCategory[];

  constructor(categories: SensitiveMemoryCategory[]) {
    super(`This information cannot be stored in memory (${categories.join(", ")})`);
    this.name = "MemoryPolicyError";
    this.blockedCategories = categories;
  }
}

const privateKeyPattern = /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|\b(?:seed|recovery|mnemonic) phrase\s*(?:is|=|:)\s*[a-z]+(?:\s+[a-z]+){7,}/i;
const explicitSecretPattern = /\b(?:password|passcode|pin|api[ _-]?key|access[ _-]?token|auth(?:entication)?[ _-]?token|client[ _-]?secret)\s*(?:(?:is|equals?)\s+|[=:]\s*)["']?\S{4,}/i;
const knownTokenPattern = /\b(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|xox[baprs]-[a-z0-9-]{16,}|eyJ[a-zA-Z0-9_-]{12,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,})\b/i;
const financialPattern = /\b(?:bank account|account number|routing number|iban|swift|sort code)\s*(?:is|=|:)\s*[a-z0-9 -]{5,}/i;
const governmentIdPattern = /\b(?:ssn|social security(?: number)?|taxpayer id|passport number|driver'?s license(?: number)?)\s*(?:is|=|:)\s*[a-z0-9 -]{5,}/i;
const medicalPattern = /\b(?:my|i|patient(?:'s)?|client(?:'s)?)\b.{0,48}\b(?:medical|health|diagnos(?:is|ed)|medication|prescription|allerg(?:y|ies|ic)|disease|disorder|syndrome|treatment|therapy|pregnan(?:t|cy)|diabetes|cancer|asthma|hiv|depression|anxiety)\b|\b(?:medical|health) (?:record|history|condition|information)\s*(?:is|=|:)\s*\S+/i;

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function passesLuhn(value: string): boolean {
  const digits = digitsOnly(value);
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false;
  let total = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    total += digit;
    doubleDigit = !doubleDigit;
  }
  return total % 10 === 0;
}

function containsPaymentCard(value: string): boolean {
  const candidates = value.match(/(?:\d[ -]?){13,19}/g) ?? [];
  return candidates.some(passesLuhn) ||
    /\b(?:credit|debit|payment)? ?card(?: number)?\s*(?:is|=|:)\s*(?:\d[ -]?){8,19}/i.test(value) ||
    /\b(?:cvv|cvc|security code)\s*(?:is|=|:)\s*\d{3,4}\b/i.test(value);
}

/**
 * Inspect proposed long-term memory without ever returning the matched secret.
 * This guard applies to explicit and automatic memory writes.
 */
export function inspectMemoryPolicy(value: string): MemoryPolicyResult {
  const blocked = new Set<SensitiveMemoryCategory>();
  if (privateKeyPattern.test(value)) blocked.add("private-key");
  if (explicitSecretPattern.test(value) || knownTokenPattern.test(value)) blocked.add("authentication-secret");
  if (financialPattern.test(value)) blocked.add("financial-account");
  if (governmentIdPattern.test(value)) blocked.add("government-identifier");
  if (medicalPattern.test(value)) blocked.add("medical-information");
  if (containsPaymentCard(value)) blocked.add("payment-card");
  return { allowed: blocked.size === 0, blockedCategories: [...blocked] };
}

export function assertMemoryAllowed(value: string): void {
  const policy = inspectMemoryPolicy(value);
  if (!policy.allowed) throw new MemoryPolicyError(policy.blockedCategories);
}
