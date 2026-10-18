// Normalises a phone number to E.164 (+27821234567).
// Local numbers starting with 0 get the default country code.
export function normalizePhone(input, defaultCountryCode = '27') {
  const raw = String(input ?? '').trim();
  let digits = raw.replace(/[\s\-().]/g, '');
  if (digits.startsWith('whatsapp:')) digits = digits.slice('whatsapp:'.length);

  if (digits.startsWith('+')) {
    digits = digits.slice(1);
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (digits.startsWith('0')) {
    digits = defaultCountryCode + digits.slice(1);
  }

  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  return '+' + digits;
}

export function firstName(name) {
  return String(name ?? '').trim().split(/[\s,]+/)[0] || 'there';
}
