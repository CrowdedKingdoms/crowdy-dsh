/**
 * The player's app token in this worker. It arrives over the bridge
 * (`page.hello`, `page.token`), lives in memory only, and is published to
 * `process.env.CROWDY_APP_TOKEN` because the model route reads it from there
 * per request. It is never written to a seed file, the virtual filesystem or
 * OPFS.
 */

export const APP_TOKEN_ENV = 'CROWDY_APP_TOKEN'

export function publishAppToken(token: string | undefined): void {
  if (!token) return
  if (typeof process === 'undefined' || !process.env) return
  process.env[APP_TOKEN_ENV] = token
}
