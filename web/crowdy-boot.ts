/**
 * Crowdy Studio bootstrap for the in-browser harness page (`crowdy.html`).
 *
 * The page is the stock DeepSeek Harness web client plus this one module,
 * spliced ahead of the client entry. It:
 *
 *   1. tells the embedding Studio page it is ready and waits for a `boot`
 *      message carrying the home files to seed (`crowdy.json`, `settings.yaml`)
 *      and a persistence scope;
 *   2. restores the previous visit's sessions for that scope from the
 *      origin-private file system, packs them with the seed files into one
 *      overlay archive (a blob URL), and starts the worker host with the Crowdy
 *      VFS image plus that overlay;
 *   3. once the tree is up, registers the project mount as the one Workspace.
 *      The web client opens a session in it by itself.
 *
 * Standalone use (developer debugging without a Studio page): open
 * `index.html?standalone=1` and the worker boots with no overlay; the fs
 * backend then reports what is missing on the first file call.
 *
 * This file is copied into `apps/web/src/` of the upstream checkout by
 * `scripts/build-image.sh`; keep its imports to what that workspace provides.
 */
import DshWorker from '@deepseek-ai/dsh-experimental-webworker-runtime/worker?worker'
import { connectWorkerHost, IMAGE_FILE_NAME } from '@deepseek-ai/dsh-experimental-webworker-runtime/client'

/** Injected by vite.crowdy.config.ts from the pinned upstream's onboarding-copy.ts. */
declare const __CROWDY_WELCOME_NOTICE__: { namespace: string, field: string, version: string }

// Hold the stock shell boot until our asynchronous handshake completes.
// `connectWorkerHost` settles this same gate once index injections are applied.
interface BootReadyGlobal {
  __DSH_BOOT_READY__?: PromiseWithResolvers<void>
}
;(globalThis as BootReadyGlobal).__DSH_BOOT_READY__ ??= Promise.withResolvers<void>()

/** `crowdy-dsh:boot`, posted by the Studio page. */
interface BootMessage {
  type: 'crowdy-dsh:boot'
  /** Home-relative files to seed, e.g. `{ 'crowdy.json': '…', 'settings.yaml': '…' }`. */
  files?: Record<string, string>
  /** Extra overlay archive URLs (same-origin or blob:), applied after the built one. */
  overlays?: string[]
  /** OPFS scope whose mirrored sessions are restored; omit to start fresh. */
  persistScope?: string
  /** Project mount inside the image; must match `crowdy-fs.root`. */
  mount?: string
}

const MOUNT = '/dsh/workspace'
const OPFS_ROOT = 'crowdy-dsh'
const image = `preview/${IMAGE_FILE_NAME}`
const params = new URLSearchParams(location.search)
const standalone = params.get('standalone') === '1'
const embedded = window.parent !== window
const encoder = new TextEncoder()

function post(message: Record<string, unknown>): void {
  if (!embedded) return
  window.parent.postMessage({ ...message, source: 'crowdy-dsh' }, location.origin)
}

function waitForBoot(): Promise<BootMessage> {
  return new Promise((resolve) => {
    // Repeat the announcement until the parent answers: the parent may attach
    // its listener after this frame's first tick.
    const ping = setInterval(() => post({ type: 'crowdy-dsh:ready' }), 250)
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== location.origin) return
      const data = event.data as Partial<BootMessage> | null
      if (!data || data.type !== 'crowdy-dsh:boot') return
      clearInterval(ping)
      window.removeEventListener('message', onMessage)
      resolve(data as BootMessage)
    }
    window.addEventListener('message', onMessage)
    post({ type: 'crowdy-dsh:ready' })
  })
}

// ── overlay archive ─────────────────────────────────────────────────────────

function octal(header: Uint8Array, offset: number, length: number, value: number): void {
  header.set(encoder.encode(value.toString(8).padStart(length - 1, '0')), offset)
}

/** Minimal ustar writer: regular files only, names under 100 bytes or split at a slash. */
function packTar(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const chunks: Uint8Array[] = []
  for (const [fullName, bytes] of files) {
    let name = fullName
    let prefix = ''
    if (encoder.encode(fullName).length > 100) {
      const slash = fullName.lastIndexOf('/', fullName.length - 100)
      if (slash <= 0) throw new Error(`overlay: entry name too long: ${fullName}`)
      prefix = fullName.slice(0, slash)
      name = fullName.slice(slash + 1)
    }
    const header = new Uint8Array(512)
    header.set(encoder.encode(name), 0)
    octal(header, 100, 8, 0o644)
    octal(header, 108, 8, 0)
    octal(header, 116, 8, 0)
    octal(header, 124, 12, bytes.length)
    octal(header, 136, 12, 0)
    header.fill(0x20, 148, 156)
    header[156] = 0x30
    header.set(encoder.encode('ustar'), 257)
    header.set(encoder.encode('00'), 263)
    header.set(encoder.encode(prefix), 345)
    let checksum = 0
    for (const byte of header) checksum += byte
    header.set(encoder.encode(checksum.toString(8).padStart(6, '0')), 148)
    header[154] = 0
    header[155] = 0x20
    chunks.push(header, bytes)
    const padding = bytes.length % 512
    if (padding !== 0) chunks.push(new Uint8Array(512 - padding))
  }
  chunks.push(new Uint8Array(1024))
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const archive = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    archive.set(chunk, offset)
    offset += chunk.length
  }
  return archive
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Read every file under the scope's OPFS mirror as `home/<relative>` entries. */
async function restoreMirror(scope: string, into: Map<string, Uint8Array>): Promise<number> {
  const storage = navigator.storage
  if (!storage || typeof storage.getDirectory !== 'function') return 0
  let directory: FileSystemDirectoryHandle
  try {
    directory = await storage.getDirectory()
    for (const segment of [OPFS_ROOT, ...scope.split('/').filter(Boolean)]) {
      directory = await directory.getDirectoryHandle(segment)
    }
  } catch {
    return 0 // first visit for this scope
  }
  let count = 0
  const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
    // `entries()` is not yet in every lib.dom; cast once.
    const iterable = (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()
    for await (const [entryName, handle] of iterable) {
      const path = `${prefix}${entryName}`
      if (handle.kind === 'directory') {
        await walk(handle as FileSystemDirectoryHandle, `${path}/`)
      } else {
        const file = await (handle as FileSystemFileHandle).getFile()
        into.set(`home/${path}`, new Uint8Array(await file.arrayBuffer()))
        count += 1
      }
    }
  }
  await walk(directory, '')
  return count
}

async function buildOverlay(boot: BootMessage): Promise<string | undefined> {
  const files = new Map<string, Uint8Array>()
  let restored = 0
  if (boot.persistScope) {
    try {
      restored = await restoreMirror(boot.persistScope, files)
    } catch (error) {
      console.warn('crowdy-dsh: session restore failed; starting fresh', error)
      files.clear()
    }
  }
  for (const [name, text] of Object.entries(boot.files ?? {})) {
    const clean = name.replace(/^\/+/, '')
    if (!clean || clean.includes('..')) continue
    const seeded = clean === 'settings.yaml' || clean === 'home/settings.yaml' ? preAcknowledgeWelcome(text) : text
    files.set(clean.startsWith('home/') ? clean : `home/${clean}`, encoder.encode(seeded))
  }
  if (files.size === 0) return undefined
  console.info(`crowdy-dsh: overlay carries ${files.size} file(s) (${restored} restored)`)
  const archive = await gzip(packTar(files))
  return URL.createObjectURL(new Blob([archive as BlobPart], { type: 'application/gzip' }))
}

/**
 * THE STOCK HARNESS SHOWS DEEPSEEK'S "INTERNAL TESTING NOTICE" ON FIRST BOOT and
 * records the acknowledgement as `ui-onboarding.welcomeNoticeVersion` in the
 * harness settings. Two reasons it must not reach a Crowdy Studio player: the
 * player has already accepted Crowded Kingdoms' own provider-data notice in the
 * pane, and the page re-seeds `settings.yaml` on every boot, so the stock
 * acknowledgement would be overwritten and the modal would return each time.
 *
 * The version string is the pinned upstream's own constant, injected at build
 * time by vite.crowdy.config.ts rather than copied, so a pin bump that changes the notice copy is acknowledged too
 * -- the decision here is "Crowded Kingdoms' notice stands in for DeepSeek's",
 * not "this one version of it". A page that already wrote the section wins.
 */
function preAcknowledgeWelcome(settingsYaml: string): string {
  const { namespace, field, version } = __CROWDY_WELCOME_NOTICE__
  if (new RegExp(`^${namespace}:`, 'm').test(settingsYaml)) return settingsYaml
  const section = `${namespace}:\n  ${field}: ${JSON.stringify(version)}\n`
  return `${settingsYaml.replace(/\n*$/, '\n')}${section}`
}

// ── host RPC ────────────────────────────────────────────────────────────────

interface RpcEnvelope {
  type: 'server-response'
  rpcId: string
  result: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }
}

/** One unary Host call over the tunnel, in the Connection's own envelope. */
async function remote<T>(
  fetcher: (input: string, init?: RequestInit) => Promise<Response>,
  endpoint: string,
  args: Record<string, unknown>,
): Promise<T> {
  const rpcId = `crowdy-${Math.random().toString(36).slice(2)}`
  const response = await fetcher(`/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
  })
  if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}`)
  const envelope = (await response.json()) as RpcEnvelope
  if (!envelope.result.ok) throw new Error(`${endpoint}: ${envelope.result.error.code} ${envelope.result.error.message}`)
  return envelope.result.value as T
}

async function main(): Promise<void> {
  const boot: BootMessage = standalone || !embedded ? { type: 'crowdy-dsh:boot', mount: MOUNT } : await waitForBoot()
  const mount = boot.mount ?? MOUNT
  const overlays: string[] = []
  const built = await buildOverlay(boot)
  if (built) overlays.push(built)
  overlays.push(...(boot.overlays ?? []))

  const worker = new DshWorker({ name: 'dsh-host' })
  const connection = await connectWorkerHost(worker, { image, overlays })
  const fetcher = (input: string, init?: RequestInit) => connection.tunnel.fetch(input, init)
  try {
    // The web client selects the sole Workspace and opens a session in it on its own.
    await remote(fetcher, 'workspace/create', { request: { path: mount } })
  } catch (error) {
    console.warn('crowdy-dsh: workspace registration failed', error)
  }
  post({ type: 'crowdy-dsh:booted', mount })
}

void main().catch((error: unknown) => {
  console.error('crowdy-dsh: boot failed', error)
  post({ type: 'crowdy-dsh:failed', message: error instanceof Error ? error.message : String(error) })
})
