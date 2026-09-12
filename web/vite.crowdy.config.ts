/**
 * Vite config for the Crowdy page: the stock apps/web build plus one more
 * standalone entry (`crowdy-boot`) and a `crowdy.html` derived from the built
 * index.html exactly the way upstream derives `preview.html`.
 *
 * Copied into `apps/web/` of the upstream checkout by `scripts/build-image.sh`.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vite'
import type { Plugin, UserConfig } from 'vite'
import base from './vite.config.ts'
// The stock notice's namespace, field and copy version, read from the PINNED
// upstream at build time (this config runs inside its workspace; the boot page
// cannot import the package because apps/web does not depend on it). The boot
// page pre-acknowledges exactly this version -- see preAcknowledgeWelcome().
import {
  WELCOME_NOTICE_ACK_FIELD,
  WELCOME_NOTICE_SETTINGS_NAMESPACE,
  WELCOME_NOTICE_VERSION,
} from '../../packages/client/ui-settings-models/src/onboarding-copy.ts'

const src = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))

function emitCrowdyPage(): Plugin {
  let bootstrapFile: string | undefined
  let write = true
  return {
    name: 'crowdy-emit-page',
    configResolved(config) {
      write = config.build.write
    },
    generateBundle(_options, bundle) {
      if (!write) return
      for (const item of Object.values(bundle)) {
        if (item.type === 'chunk' && item.isEntry && item.name === 'crowdy-boot') bootstrapFile = item.fileName
      }
      if (bootstrapFile === undefined) throw new Error('vite: crowdy-boot entry missing from the bundle')
    },
    async closeBundle() {
      if (!write || bootstrapFile === undefined) return
      const page = await readFile(src('./dist/index.html'), 'utf8')
      const anchor = page.indexOf('<script type="module"')
      if (anchor === -1) throw new Error('vite: built index.html lost its module entry tag')
      const tag = `<script type="module" crossorigin src="./${bootstrapFile}"></script>`
      await writeFile(src('./dist/crowdy.html'), `${page.slice(0, anchor)}${tag}${page.slice(anchor)}`)
    },
  }
}

const baseConfig = base as UserConfig
const baseInput = (baseConfig.build?.rollupOptions?.input ?? {}) as Record<string, string>
const baseEntryFileNames = baseConfig.build?.rollupOptions?.output as { entryFileNames?: (chunk: { name: string }) => string } | undefined

export default mergeConfig(
  baseConfig,
  defineConfig({
    plugins: [emitCrowdyPage()],
    define: {
      __CROWDY_WELCOME_NOTICE__: JSON.stringify({
        namespace: WELCOME_NOTICE_SETTINGS_NAMESPACE,
        field: WELCOME_NOTICE_ACK_FIELD,
        version: WELCOME_NOTICE_VERSION,
      }),
    },
    build: {
      rollupOptions: {
        input: { ...baseInput, 'crowdy-boot': src('./src/crowdy-boot.ts') },
        output: {
          entryFileNames(chunk): string {
            if (chunk.name === 'crowdy-boot') return 'preview/[name]-[hash].js'
            return baseEntryFileNames?.entryFileNames?.(chunk) ?? 'assets/[name]-[hash].js'
          },
        },
      },
    },
  }),
)
