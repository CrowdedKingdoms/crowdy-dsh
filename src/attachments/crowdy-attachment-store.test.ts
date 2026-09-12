import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'

import { CrowdyAttachmentStore, imageDimensions } from './crowdy-attachment-store.js'

/** A 3x2 PNG header (IHDR only; enough for dimension sniffing). */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

function gifHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13)
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0)
  const view = new DataView(bytes.buffer)
  view.setUint16(6, width, true)
  view.setUint16(8, height, true)
  return bytes
}

describe('imageDimensions', () => {
  it('reads PNG and GIF headers', () => {
    assert.deepEqual(imageDimensions(pngHeader(320, 200), 'image/png'), { width: 320, height: 200 })
    assert.deepEqual(imageDimensions(gifHeader(16, 9), 'image/gif'), { width: 16, height: 9 })
  })

  it('refuses bytes that do not match the declared type', () => {
    assert.equal(imageDimensions(gifHeader(1, 1), 'image/png'), undefined)
    assert.equal(imageDimensions(new Uint8Array(4), 'image/jpeg'), undefined)
  })
})

describe('CrowdyAttachmentStore', () => {
  it('mounts as ctx.attachments and round-trips an image without native decoders', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(CrowdyAttachmentStore, { maxImageBytes: 1024 })
    const store = ctx.attachments as CrowdyAttachmentStore
    assert.ok(store instanceof CrowdyAttachmentStore)

    const ref = await store.saveImage({ data: pngHeader(320, 200), mediaType: 'image/png', name: '../captures/shot.png' })
    assert.equal(ref.width, 320)
    assert.equal(ref.height, 200)
    assert.equal(ref.name, 'shot.png', 'path information is stripped from the display name')

    const again = await store.saveImage({ data: pngHeader(320, 200), mediaType: 'image/png' })
    assert.equal(again.attachmentId, ref.attachmentId, 'identical bytes share one id')

    const stored = await store.readImage(ref)
    assert.equal(stored.data.byteLength, 33)

    const request = await store.readImageRequest(ref, { maxPixels: 1_000_000, maxBytes: 100_000 })
    assert.equal(request.mediaType, 'image/png')
    assert.equal(request.bytes, 33)
    assert.equal(request.depth, 'uchar')
    await fiber.dispose()
  })

  it('reports type mismatches and oversize images with the shared error codes', async () => {
    const ctx = new Context()
    await ctx.plugin(CrowdyAttachmentStore, { maxImageBytes: 40 })
    const store = ctx.attachments as CrowdyAttachmentStore
    await assert.rejects(
      store.saveImage({ data: gifHeader(1, 1), mediaType: 'image/png' }),
      (error: unknown) => (error as { code?: string }).code === 'IMAGE_TYPE_MISMATCH',
    )
    await assert.rejects(
      store.saveImage({ data: new Uint8Array(64), mediaType: 'image/png' }),
      (error: unknown) => (error as { code?: string }).code === 'IMAGE_TOO_LARGE',
    )
    await assert.rejects(
      store.readImage({ attachmentId: 'img-missing' as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1 }),
      (error: unknown) => (error as { code?: string }).code === 'ATTACHMENT_NOT_FOUND',
    )
  })
})
