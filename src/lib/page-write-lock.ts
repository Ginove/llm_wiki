/**
 * Per-page-path async mutex.
 *
 * Why this exists: with concurrent ingests, two tasks may both try to
 * read-merge-write the same wiki page (e.g. `wiki/concepts/foo.md`).
 * Without a lock, each reads the same pre-state, each calls the LLM to
 * merge, and the second write silently overwrites the first.
 *
 * The lock is keyed by `${projectPath}:${pagePath}` so writes to
 * DIFFERENT pages run in parallel while writes to the SAME page
 * serialize. The lock is held for the entire read-merge-write cycle
 * (including the LLM merge call) because the merge depends on the
 * current on-disk content.
 *
 * Same promise-chain pattern as project-mutex.ts.
 */

const locks = new Map<string, Promise<unknown>>()

function lockKey(projectPath: string, pagePath: string): string {
  return `${projectPath}\n${pagePath}`
}

/**
 * Run `fn` while holding the per-page lock. Returns the value `fn`
 * resolves to. If `fn` throws, the lock is released and the rejection
 * is propagated.
 */
export async function withPageWriteLock<T>(
  projectPath: string,
  pagePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = lockKey(projectPath, pagePath)
  const prev = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>((resolve) => {
    release = resolve
  })
  locks.set(key, prev.then(() => next))
  try {
    await prev.catch(() => {})
    return await fn()
  } finally {
    release()
    if (locks.get(key) === next || locks.size > 2048) {
      const tail = locks.get(key)
      if (tail) {
        Promise.resolve().then(() => {
          if (locks.get(key) === tail) {
            locks.delete(key)
          }
        })
      }
    }
  }
}

/** Test-only — drop all live locks. */
export function __resetPageWriteLocksForTesting(): void {
  locks.clear()
}
