/**
 * Whether a file's bytes are text (F08, #101). A NUL byte or invalid UTF-8 is enough to refuse it;
 * common formats are named so the tool error can say what the file is. SVG, JSON, CSV and other
 * UTF-8 text stays readable.
 */
export function binaryKindOf(bytes: Uint8Array): string | undefined {
  const magic = magicKind(bytes);
  if (magic) return magic;
  if (bytes.includes(0)) return 'binary';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return undefined;
  } catch {
    return 'binary';
  }
}

function magicKind(bytes: Uint8Array): string | undefined {
  const starts = (...prefix: number[]) => prefix.every((byte, i) => bytes[i] === byte);
  const ascii = (offset: number, text: string) =>
    [...text].every((char, i) => bytes[offset + i] === char.charCodeAt(0));

  if (starts(0xff, 0xd8, 0xff)) return 'JPEG image';
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'PNG image';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'GIF image';
  if (ascii(0, '%PDF-')) return 'PDF document';
  if (starts(0x50, 0x4b, 0x03, 0x04)) return 'ZIP archive';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'WebP image';
  if (starts(0x1f, 0x8b)) return 'gzip archive';
  if (starts(0x42, 0x4d)) return 'BMP image';
  return undefined;
}
