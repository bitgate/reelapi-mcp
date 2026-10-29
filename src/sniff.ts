export const HEAD_BYTES = 1024;

// We recognise a file by its first bytes, never by its name
const SIGNATURES = [
  /^\x1a\x45\xdf\xa3/, // Matroska, WebM
  /^\x89PNG\r\n\x1a\n/,
  /^\xff\xd8\xff/, // JPEG
  /^GIF8[79]a/,
  /^RIFF[\s\S]{4}(?:AVI |WAVE|WEBP)/,
  /^(?:OggS|fLaC|ID3)/,
  /^BM[\s\S]{12}[\x0c\x28\x34\x38\x40\x6c\x7c]\x00\x00\x00/, // BMP, by its DIB header size
];

const TEXT_SIGNATURES = [
  /^WEBVTT(?:[ \t\r\n]|$)/,
  /^\[Script Info\]/i, // ASS, SSA
  /^\d+[ \t]*\r?\n\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}[ \t]*-->/, // SRT
  /^(?:ffconcat version|file[ \t]+\S)/, // ffmpeg concat list
];

const ISO_BOXES = new Set(["ftyp", "moov", "mdat", "free", "skip", "wide", "pnot"]);

export function isMediaHead(head: Buffer, fileSize: number): boolean {
  if (SIGNATURES.some((signature) => signature.test(head.toString("latin1")))) return true;
  if (isIsoMedia(head, fileSize) || isMpegAudio(head) || isTransportStream(head)) return true;

  const text = head.toString("utf8").replace(/^\ufeff/, "").trimStart();
  return TEXT_SIGNATURES.some((signature) => signature.test(text));
}

// MP4, MOV, M4A and AVIF open with a box whose size fits in the file
function isIsoMedia(head: Buffer, fileSize: number): boolean {
  if (head.length < 8 || !ISO_BOXES.has(head.toString("latin1", 4, 8))) return false;

  const boxSize = head.readUInt32BE(0);
  return boxSize <= 1 || (boxSize >= 8 && boxSize <= fileSize);
}

// MP3 and MP2 frames, and AAC in ADTS. Layer I is left out: its FF FE is also the UTF-16 byte order mark
function isMpegAudio(head: Buffer): boolean {
  if (head.length < 3 || head[0] !== 0xff) return false;

  const [flags, rate] = [head[1]!, head[2]!];
  const layer = (flags >> 1) & 3;
  const mpeg = (flags & 0xe0) === 0xe0 && ((flags >> 3) & 3) !== 1 && (layer === 1 || layer === 2) && rate >> 4 !== 0xf && ((rate >> 2) & 3) !== 3;
  return mpeg || (flags & 0xf6) === 0xf0;
}

// MPEG-TS packets start with 0x47 every 188 bytes, M2TS every 192 after a 4-byte timestamp
function isTransportStream(head: Buffer): boolean {
  return [
    [0, 188],
    [4, 192],
  ].some(([offset, step]) => [0, 1, 2].every((packet) => head[offset! + packet * step!] === 0x47));
}
