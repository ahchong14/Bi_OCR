/**
 * 银行卡号掩码。收据文字里可能带完整卡号;PCI DSS 要求存储时不可读。
 * 做法: 找 13–19 位、通过 Luhn 校验的数字串(可带空格或短横),只保留最后 4 位。
 * 通过 Luhn 才掩码,避免误伤小票号、电话、条码。
 */
const CANDIDATE = /(?<![\d])(?:\d[ -]?){12,18}\d(?![\d])/g

export function luhn(digits: string): boolean {
  let sum = 0
  let dbl = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48
    if (dbl) { n *= 2; if (n > 9) n -= 9 }
    sum += n
    dbl = !dbl
  }
  return sum % 10 === 0
}

export function maskPan(text: string): { text: string; masked: number } {
  let masked = 0
  const out = text.replace(CANDIDATE, (m) => {
    const digits = m.replace(/\D/g, '')
    if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits) || !luhn(digits)) return m
    masked++
    return '**** **** **** ' + digits.slice(-4)
  })
  return { text: out, masked }
}
