/**
 * An in-memory `ctx.attachments` provider for the browser worker.
 *
 * The stock `@deepseek-ai/dsh-attachment-local` decodes and normalizes images
 * with `sharp`, a native module the browser worker replaces with a stub that
 * refuses every call — so in the worker neither `read_image` nor a pasted
 * screenshot could ever produce an image block. This store keeps the bytes it
 * is handed, reads intrinsic dimensions from the container header (PNG, JPEG,
 * WebP, GIF), and serves model requests verbatim. The Studio page already
 * downscales captures before sharing them, and the byte caps here bound what a
 * pasted image can cost.
 *
 * Attachments live for the life of the harness only: reloading the page drops
 * the bytes, and a replayed session shows the image envelope without pixels.
 *
 * @module @crowdedkingdoms/crowdy-dsh/attachments
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  AttachmentError,
  AttachmentId,
  AttachmentStore,
  ImageVariantId,
} from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageMediaType,
  ImageRequestPolicy,
  RequestImageAttachment,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'

export interface Config {
  /** Largest encoded image accepted, in bytes. */
  maxImageBytes?: number
  /** Largest intrinsic side accepted, in pixels. */
  maxImageDimension?: number
}

const MEDIA_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Intrinsic dimensions read from the container header, or undefined when the bytes are not that format. */
export function imageDimensions(
  data: Uint8Array,
  mediaType: ImageMediaType,
): { width: number; height: number } | undefined {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  switch (mediaType) {
    case 'image/png': {
      if (data.byteLength < 24) return undefined
      const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
      if (!signature.every((byte, index) => data[index] === byte)) return undefined
      return { width: view.getUint32(16), height: view.getUint32(20) }
    }
    case 'image/gif': {
      if (data.byteLength < 10 || data[0] !== 0x47 || data[1] !== 0x49 || data[2] !== 0x46) return undefined
      return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
    }
    case 'image/webp': {
      if (data.byteLength < 30) return undefined
      if (String.fromCharCode(...data.subarray(0, 4)) !== 'RIFF') return undefined
      if (String.fromCharCode(...data.subarray(8, 12)) !== 'WEBP') return undefined
      const chunk = String.fromCharCode(...data.subarray(12, 16))
      if (chunk === 'VP8 ') {
        return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
      }
      if (chunk === 'VP8L') {
        const bits = view.getUint32(21, true)
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
      }
      if (chunk === 'VP8X') {
        const width = 1 + (data[24]! | (data[25]! << 8) | (data[26]! << 16))
        const height = 1 + (data[27]! | (data[28]! << 8) | (data[29]! << 16))
        return { width, height }
      }
      return undefined
    }
    case 'image/jpeg': {
      if (data.byteLength < 4 || data[0] !== 0xff || data[1] !== 0xd8) return undefined
      let offset = 2
      while (offset + 9 < data.byteLength) {
        if (data[offset] !== 0xff) {
          offset += 1
          continue
        }
        const marker = data[offset + 1]!
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
          offset += 2
          continue
        }
        const length = view.getUint16(offset + 2)
        const isSof =
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf)
        if (isSof) {
          return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) }
        }
        offset += 2 + length
      }
      return undefined
    }
    default:
      return undefined
  }
}

function digest(data: Uint8Array): string {
  // FNV-1a over the bytes, two lanes; content addressing only needs to make
  // identical captures share one id, not resist an adversary.
  let h1 = 0x811c9dc5
  let h2 = 0x9747b28c
  for (let index = 0; index < data.byteLength; index += 1) {
    h1 = Math.imul(h1 ^ data[index]!, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ data[index]!, 0x85ebca6b) >>> 0
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}${data.byteLength.toString(16)}`
}

function sanitizeName(name: string | undefined): string | undefined {
  if (!name) return undefined
  const leaf = name.split(/[\\/]/).pop() ?? ''
  const cleaned = leaf.replace(/[^\w.\- ]+/g, '_').slice(0, 120)
  return cleaned || undefined
}

export class CrowdyAttachmentStore extends AttachmentStore {
  static Config: z<Config> = z.object({
    maxImageBytes: z.number().default(4 * 1024 * 1024),
    maxImageDimension: z.number().default(8192),
  }) as unknown as z<Config>

  readonly imageLimits: ImageAttachmentLimits
  private readonly images = new Map<string, StoredImageAttachment>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    const maxImageBytes = config.maxImageBytes ?? 4 * 1024 * 1024
    const maxImageDimension = config.maxImageDimension ?? 8192
    this.imageLimits = {
      maxImageBytes,
      maxImagesPerMessage: 6,
      maxMessageImageBytes: maxImageBytes * 3,
      maxImagePixels: maxImageDimension * maxImageDimension,
      maxImageDimension,
      mediaTypes: MEDIA_TYPES,
    }
  }

  private inspect(input: SaveImageAttachment): { width: number; height: number } {
    if (!MEDIA_TYPES.includes(input.mediaType)) {
      throw new AttachmentError(`Unsupported image media type ${input.mediaType}.`, 'UNSUPPORTED_IMAGE_TYPE')
    }
    if (input.data.byteLength > this.imageLimits.maxImageBytes) {
      throw new AttachmentError(
        `The image is ${input.data.byteLength} bytes; the limit is ${this.imageLimits.maxImageBytes}.`,
        'IMAGE_TOO_LARGE',
      )
    }
    const dimensions = imageDimensions(input.data, input.mediaType)
    if (!dimensions) {
      // Declared type and bytes disagree, or the header is unreadable.
      const sniffed = MEDIA_TYPES.find((type) => imageDimensions(input.data, type))
      throw new AttachmentError(
        sniffed
          ? `The bytes are ${sniffed}, not ${input.mediaType}.`
          : 'The bytes are not a PNG, JPEG, WebP or GIF image.',
        sniffed ? 'IMAGE_TYPE_MISMATCH' : 'INVALID_IMAGE',
      )
    }
    if (dimensions.width > this.imageLimits.maxImageDimension || dimensions.height > this.imageLimits.maxImageDimension) {
      throw new AttachmentError(
        `The image is ${dimensions.width}x${dimensions.height}; each side may be at most ${this.imageLimits.maxImageDimension} px.`,
        'IMAGE_DIMENSION_TOO_LARGE',
      )
    }
    if (dimensions.width * dimensions.height > this.imageLimits.maxImagePixels) {
      throw new AttachmentError('The image has too many pixels.', 'IMAGE_TOO_MANY_PIXELS')
    }
    return dimensions
  }

  async validateImage(input: SaveImageAttachment): Promise<void> {
    this.inspect(input)
  }

  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    const { width, height } = this.inspect(input)
    const id = `img-${digest(input.data)}`
    const name = sanitizeName(input.name)
    const ref: ImageAttachmentRef = {
      attachmentId: AttachmentId(id),
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width,
      height,
      ...(name === undefined ? {} : { name }),
    }
    if (!this.images.has(id)) this.images.set(id, { ref, data: input.data.slice() })
    return ref
  }

  async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    signal?.throwIfAborted()
    const stored = this.images.get(String(ref.attachmentId))
    if (!stored) {
      throw new AttachmentError(
        `Attachment ${String(ref.attachmentId)} is not in memory (the page was reloaded since it was captured).`,
        'ATTACHMENT_NOT_FOUND',
      )
    }
    return { ref: { ...stored.ref }, data: stored.data }
  }

  override async readImageRequest(
    ref: ImageAttachmentRef,
    policy: ImageRequestPolicy,
    signal?: AbortSignal,
  ): Promise<RequestImageAttachment> {
    const stored = await this.readImage(ref, signal)
    if (stored.data.byteLength > policy.maxBytes * 4) {
      // No encoder here: an image far above the route's byte target would be
      // rejected by the provider, so refuse with the reason instead.
      throw new AttachmentError(
        `The image (${stored.data.byteLength} bytes) is too large for this model route; capture a smaller screenshot.`,
        'IMAGE_TOO_LARGE',
      )
    }
    return {
      variantId: ImageVariantId(`${String(ref.attachmentId)}:${policy.maxPixels}:${policy.maxBytes}:verbatim`),
      attachment: { ...stored.ref },
      data: stored.data,
      mediaType: stored.ref.mediaType,
      bytes: stored.data.byteLength,
      width: stored.ref.width,
      height: stored.ref.height,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: stored.ref.mediaType === 'image/png' || stored.ref.mediaType === 'image/webp' || stored.ref.mediaType === 'image/gif',
    }
  }
}

export default CrowdyAttachmentStore
