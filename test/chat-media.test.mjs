import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectAttachmentMedia } from '../src/chat-media.mjs';

// Two 2x2 frames; only the first has a graphic-control delay. No loop extension.
const gif = Buffer.from('47494638396102000200800000ff00000000ff21f904040a0000002c000000000200020000020404411005002c00000000020002000002040cc33005003b', 'hex');

test('GIF graphic-control delay applies to one frame, not all following frames', () => {
  assert.deepEqual(inspectAttachmentMedia(gif, 'image/gif'), {
    dimension: { width: 2, height: 2 },
    media: { format: 'gif', animated: true, frameCount: 2, encodedDurationMs: 100, loopCount: null },
  });
});

test('valid image dimensions cannot hide a truncated GIF frame payload', () => {
  assert.throws(() => inspectAttachmentMedia(gif.subarray(0, gif.length - 3), 'image/gif'), { code: 'INVALID_MEDIA' });
});

test('declared JPEG cannot accept GIF bytes with otherwise valid dimensions', () => {
  assert.throws(() => inspectAttachmentMedia(gif, 'image/jpeg'), { code: 'INVALID_MEDIA' });
});

// Chrome-encoded 2x3 red WebP, with VP8X/ICC/VP8L chunks.
const webp = Buffer.from('UklGRv4BAABXRUJQVlA4WAoAAAAgAAAAAQAAAgAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDhMDwAAAC8BgAAABxD9j/4HIqL/AQA=', 'base64');

test('WebP animation flag cannot be reported as a verified static image', () => {
  const animated = Buffer.from(webp);
  animated[20] |= 2;
  assert.throws(() => inspectAttachmentMedia(animated, 'image/webp'), { code: 'UNSUPPORTED_MEDIA_FORMAT' });
});

test('valid WebP dimensions cannot hide a truncated RIFF payload', () => {
  assert.throws(() => inspectAttachmentMedia(webp.subarray(0, webp.length - 2), 'image/webp'), { code: 'INVALID_MEDIA' });
});
