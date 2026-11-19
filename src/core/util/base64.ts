/**
 * Base64 与文本编码工具。
 * 只用 atob/btoa/TextEncoder/TextDecoder，浏览器和 Node 都能运行。
 */

// String.fromCharCode(...arr) 参数过多会栈溢出，分块拼接
const CHUNK_SIZE = 0x8000

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE))
  }
  return btoa(binary)
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64.trim())
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export function utf8ToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text))
}

export function base64ToUtf8(base64: string): string {
  return new TextDecoder().decode(base64ToBytes(base64))
}

/** Latin-1 解码：每个字节对应一个字符（PNG tEXt 块使用的编码） */
export function latin1Decode(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    text += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE))
  }
  return text
}

/** Latin-1 编码：遇到超出 0-255 的字符直接报错，避免静默损坏数据 */
export function latin1Encode(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code > 0xff) {
      throw new RangeError(`字符 "${text[i]}" 不是 Latin-1 字符，无法写入 PNG 文本块`)
    }
    bytes[i] = code
  }
  return bytes
}
