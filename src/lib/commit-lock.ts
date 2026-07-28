/**
 * Commit-phase async mutex.
 *
 * Why this exists: with concurrent ingests, the "commit" phase —
 * updating wiki/index.md, appending to wiki/log.md, saving
 * ingest-cache.json — involves read-modify-write on shared files.
 * Without a lock, concurrent commits would interleave and corrupt
 * these aggregate files.
 *
 * Unlike the page-write lock (per-page), this is a single lock per
 * project because all commit targets are project-level singletons.
 * The lock is held only for the brief I/O phase (no LLM calls), so
 * contention is minimal.
 *
 * Same promise-chain pattern as project-mutex.ts.
 */

const locks = new Map<string, Promise<unknown>>()

/**
 * Run `fn` while holding the per-project commit lock. Returns the
 * value `fn` resolves to. If `fn` throws, the lock is released and
 * the rejection is propagated.
 */
export async function withCommitLock<T>(
  projectPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = locks.get(projectPath) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>((resolve) => {
    release = resolve
  })
  locks.set(projectPath, prev.then(() => next))
  try {
    await prev.catch(() => {})
    return await fn()
  } finally {
    release()
    if (locks.get(projectPath) === next || locks.size > 1024) {
      const tail = locks.get(projectPath)
      if (tail) {
        Promise.resolve().then(() => {
          if (locks.get(projectPath) === tail) {
            locks.delete(projectPath)
          }
        })
      }
    }
  }
}

/** Test-only — drop all live locks. */
export function __resetCommitLocksForTesting(): void {
  locks.clear()
}
