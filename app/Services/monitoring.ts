import { Database } from '../Support/db'
import { log } from '@stacksjs/logging'

/**
 * Making a background failure findable.
 *
 * A request that throws leaves a user staring at an error and someone
 * eventually hears about it. A scheduled job that throws leaves a line in
 * a log file on whichever machine happened to run it, and the only
 * external symptom is that something quietly stopped happening — which is
 * indistinguishable from nothing needing to happen. The monitoring bundle
 * already ships a table for exactly this and nothing was writing to it.
 *
 * Recording is best effort and never masks the original failure. The
 * error is re-thrown so the queue still counts the attempt, retries what
 * it is configured to retry, and moves the job to the failed set; this
 * only makes sure that by then there is a durable record of why.
 */

/** Write one failure to the errors table. Never throws. */
export async function captureError(
  source: string,
  error: unknown,
  context: Record<string, unknown> = {},
): Promise<void> {
  const db = new Database()

  try {
    const thrown = error instanceof Error ? error : new Error(String(error))

    await db.prepare(`
      INSERT INTO errors (type, message, stack, status, additional_info, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      thrown.name || 'Error',
      // The framework errors table uses VARCHAR(255) for these fields on
      // MySQL/Vitess. Keep the durable record useful without letting an
      // oversized provider/SQL error make the reporting path fail too.
      thrown.message.slice(0, 255),
      (thrown.stack ?? '').slice(0, 255),
      // Background work has no HTTP status. Zero rather than null keeps
      // the column readable as "not a request".
      0,
      JSON.stringify({ source, ...context }).slice(0, 255),
      new Date().toISOString(),
      new Date().toISOString(),
    )
  }
  catch (failure) {
    // The reporting path failing must not become the failure anyone
    // investigates, but it cannot be silent either — that would make the
    // absence of records mean two very different things.
    log.warn(`[monitoring] could not record a failure from ${source}: ${failure instanceof Error ? failure.message : String(failure)}`)
  }
  finally {
    db.close()
  }
}

/**
 * Wrap a job handler so its failures are recorded before they propagate.
 *
 * Written as a wrapper rather than a try/catch in each job because the
 * one job that forgets is the one that fails, and a convention that has
 * to be remembered at ten call sites is not a convention.
 */
export function monitored<T>(source: string, run: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      return await run()
    }
    catch (error) {
      log.error(`[${source}] failed: ${error instanceof Error ? error.message : String(error)}`)
      await captureError(source, error)
      throw error
    }
  }
}
