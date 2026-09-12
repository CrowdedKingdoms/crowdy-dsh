/**
 * Connectivity probe: proves the cockpit's credentials and project id reach a
 * real Crowdy Studio project before the harness is booted against it.
 *
 * With `--write` it also performs a guarded round-trip write, which is the
 * end-to-end check that the agent's edits will actually land.
 */

import { CrowdyStudioClient } from '../crowdy/client.js'
import { describeMissing, loadCrowdyConfig } from '../crowdy/config.js'
import { selectProjectStore } from '../crowdy/project-store.js'

async function main(): Promise<void> {
  const boot = loadCrowdyConfig()
  const missing = describeMissing(boot)
  if (missing) {
    console.error(`${missing} See .env.example.`)
    process.exit(1)
  }
  const client = new CrowdyStudioClient({
    endpoint: boot.graphqlUrl,
    appId: boot.appId,
    appToken: boot.appToken,
    email: boot.email,
    password: boot.password,
  })
  const projectId = boot.projectId

  const selection = await selectProjectStore(client, projectId, {
    githubFirst: boot.githubFirst ?? true,
    warn: (message) => console.warn(`  warn: ${message}`),
  })
  console.log(`store: ${selection.store.kind} — ${selection.reason}`)
  const snapshot = await selection.store.load()
  console.log(`  ${snapshot.label}: ${snapshot.files.length} file(s)`)

  const project = await client.loadProject(projectId)
  console.log(`project ${project.name} (${project.projectId})`)
  console.log(`  revision ${project.revision}, ${project.files.length} file(s)`)
  for (const file of project.files) {
    console.log(
      `  ${file.target.toLowerCase().padEnd(6)} ${file.path.padEnd(28)} ` +
        `${Buffer.byteLength(file.content, 'utf8')} bytes  rev ${file.revision}`,
    )
  }

  if (!process.argv.includes('--write')) return

  // Round-trip a marker through the same mutation the filesystem backend uses.
  const path = 'src/cockpit_probe.rs'
  const content = `// cockpit probe ${new Date().toISOString()}\n`
  const updated = await client.saveFiles({
    projectId,
    expectedRevision: project.revision,
    upserts: [{ target: 'SERVER', path, content }],
  })
  console.log(`\nwrote server/${path}; revision ${project.revision} -> ${updated.revision}`)

  const reverted = await client.saveFiles({
    projectId,
    expectedRevision: updated.revision,
    deletes: [{ target: 'SERVER', path }],
  })
  console.log(`removed the probe file; revision ${updated.revision} -> ${reverted.revision}`)
}

await main()
