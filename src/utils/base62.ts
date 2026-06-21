const ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const BASE = ALPHABET.length; // 62

export function encodeBase62(num: number): string {
  if (num === 0) return ALPHABET[0];

  let result = "";
  while (num > 0) {
    const remainder = num % BASE;
    result = ALPHABET[remainder] + result;
    num = Math.floor(num / BASE);
  }
  return result;
}

export function decodeBase62(str: string): number {
  let result = 0;
  for (const char of str) {
    const value = ALPHABET.indexOf(char);
    result = result * BASE + value;
  }
  return result;
}

module.exports = {
  encodeBase62,
  decodeBase62,
};
