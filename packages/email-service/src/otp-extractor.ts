// Known Amazon OTP email patterns
const OTP_PATTERNS = [
  /\b(\d{6})\b(?=\s*(?:is your|verification|code|PIN))/i,
  /verification code[:\s]+(\d{6})/i,
  /one.time.pass(?:word|code)[:\s]+(\d{6})/i,
  /your code is[:\s]+(\d{6})/i,
  /enter[:\s]+(\d{6})/i,
  /\b(\d{6})\b/, // last resort: any 6-digit number
];

// Patterns to identify original account email when using forwarding
const FORWARDED_TO_PATTERNS = [
  /X-Forwarded-To:\s*([\w.+-]+@[\w.+-]+)/i,
  /Delivered-To:\s*([\w.+-]+@[\w.+-]+)/i,
  /Original-To:\s*([\w.+-]+@[\w.+-]+)/i,
  /we sent.+to\s+([\w.+-]+@[\w.+-]+)/i,
  /sent to\s+([\w.+-]+@[\w.+-]+)/i,
];

export function extractOtp(body: string): string | null {
  for (const pattern of OTP_PATTERNS) {
    const match = body.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function extractOriginalRecipient(
  headers: Record<string, string>,
  bodyText: string
): string | null {
  // Check email headers first
  for (const [headerName, headerVal] of Object.entries(headers)) {
    const combined = `${headerName}: ${headerVal}`;
    for (const pattern of FORWARDED_TO_PATTERNS.slice(0, 3)) {
      const match = combined.match(pattern);
      if (match?.[1]) return match[1].toLowerCase();
    }
  }
  // Fall back to body parsing
  for (const pattern of FORWARDED_TO_PATTERNS.slice(3)) {
    const match = bodyText.match(pattern);
    if (match?.[1]) return match[1].toLowerCase();
  }
  return null;
}

export function isAmazonEmail(from: string, subject: string): boolean {
  const fromLower = from.toLowerCase();
  const subjectLower = subject.toLowerCase();
  return (
    (fromLower.includes("amazon") || fromLower.includes("noreply")) &&
    (subjectLower.includes("verification") ||
      subjectLower.includes("confirm") ||
      subjectLower.includes("sign in") ||
      subjectLower.includes("otp") ||
      subjectLower.includes("code"))
  );
}
