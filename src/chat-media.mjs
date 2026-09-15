import { imageSize } from 'image-size';
import { AppError } from './session.mjs';

const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' };

function gifAnimation(bytes, dimension) {
  let offset = 13, frames = 0, delay = 0, duration = 0, loopCount = null;
  const invalid = () => { throw new AppError('INVALID_MEDIA', 'GIF animation metadata is truncated or unsupported.'); };
  const advance = size => {
    if (offset + size > bytes.length) invalid();
    const start = offset; offset += size; return start;
  };
  const subblocks = () => {
    for (;;) {
      const size = bytes[advance(1)];
      if (!size) return;
      advance(size);
    }
  };
  if (bytes[10] & 0x80) advance(3 * 2 ** ((bytes[10] & 7) + 1));
  for (;;) {
    const marker = bytes[advance(1)];
    if (marker === 0x3b) {
      if (!frames || offset !== bytes.length) invalid();
      return { animated: frames > 1, frameCount: frames, encodedDurationMs: duration, loopCount };
    }
    if (marker === 0x21) {
      const label = bytes[advance(1)];
      if (label === 0xf9) {
        const start = advance(6);
        if (bytes[start] !== 4 || bytes[start + 5] !== 0) invalid();
        delay = bytes.readUInt16LE(start + 2) * 10;
      } else if (label === 0xff) {
        const size = bytes[advance(1)], start = advance(size);
        const name = bytes.toString('ascii', start, start + size);
        if (name === 'NETSCAPE2.0' || name === 'ANIMEXTS1.0') {
          if (offset + 4 > bytes.length || bytes[offset] !== 3 || bytes[offset + 1] !== 1) invalid();
          const value = bytes.readUInt16LE(offset + 2);
          if (loopCount !== null && loopCount !== value) invalid();
          loopCount = value;
        }
        subblocks();
      } else if (label === 0xfe) subblocks();
      else invalid();
      continue;
    }
    if (marker !== 0x2c) invalid();
    const start = advance(9), left = bytes.readUInt16LE(start), top = bytes.readUInt16LE(start + 2);
    const width = bytes.readUInt16LE(start + 4), height = bytes.readUInt16LE(start + 6), packed = bytes[start + 8];
    if (!width || !height || left + width > dimension.width || top + height > dimension.height) invalid();
    if (packed & 0x80) advance(3 * 2 ** ((packed & 7) + 1));
    const codeSize = bytes[advance(1)];
    if (codeSize < 2 || codeSize > 8) invalid();
    subblocks();
    frames++; duration += delay; delay = 0;
  }
}

export function inspectAttachmentMedia(bytes, mime) {
  if (mime === 'application/octet-stream' || mime === 'text/plain') return { dimension: null, media: null };
  const expected = IMAGE_TYPES[mime];
  if (!expected) throw new AppError('UNSUPPORTED_MEDIA_FORMAT', 'Verified image MIME types are image/png, image/jpeg, image/gif, image/webp and image/bmp. Animated WebP, other media and stickers are not ordinary verified image sends.');
  let image;
  try { image = imageSize(bytes); } catch { throw new AppError('INVALID_MEDIA', 'Image headers cannot be decoded.'); }
  if (image.type !== expected || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 1 || image.height < 1) {
    throw new AppError('INVALID_MEDIA', 'Image bytes do not match the declared MIME type and dimensions.');
  }
  const orientation = image.orientation ?? 1;
  if (orientation !== 1) throw new AppError('UNSUPPORTED_MEDIA_FORMAT', 'Oriented image metadata requires a verified native geometry contract.');
  if (expected === 'webp') {
    const invalid = () => { throw new AppError('INVALID_MEDIA', 'WebP RIFF chunks are truncated or inconsistent.'); };
    if (bytes.readUInt32LE(4) + 8 !== bytes.length) invalid();
    for (let offset = 12; offset < bytes.length;) {
      if (offset + 8 > bytes.length) invalid();
      const type = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4);
      const end = offset + 8 + size + (size & 1);
      if (end > bytes.length) invalid();
      if (type === 'ANIM' || type === 'ANMF' || (type === 'VP8X' && (bytes[offset + 8] & 2))) {
        throw new AppError('UNSUPPORTED_MEDIA_FORMAT', 'Animated WebP requires a separately verified native animation contract; use a verified GIF instead.');
      }
      offset = end;
    }
  }
  const dimension = { width: image.width, height: image.height };
  return { dimension, media: { format: expected === 'jpg' ? 'jpeg' : expected,
    ...(expected === 'gif' ? gifAnimation(bytes, dimension) : {}) } };
}
