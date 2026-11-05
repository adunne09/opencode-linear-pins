import { closedReason, type Issue } from "./linear.ts"

export const DEFAULT_MAX_PINS = 5
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000

export type Pin = {
  id: string
  identifier: string
  title: string
  url: string
  stateName: string
  stateType: string
  pinnedAt: number
}

export function toPin(issue: Issue, pinnedAt: number): Pin {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    stateName: issue.state.name,
    stateType: issue.state.type,
    pinnedAt,
  }
}

export function isStale(pin: Pin, now: number) {
  return now - pin.pinnedAt >= STALE_AFTER_MS
}

/** "5m", "3h", "1d 4h": how long an issue has been pinned. */
export function age(ms: number) {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  const rest = hours % 24
  return rest ? `${days}d ${rest}h` : `${days}d`
}

export function maxPins(options: Readonly<Record<string, unknown>> | undefined) {
  const value = options?.max
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_PINS
}

/**
 * Applies fresh Linear data to the pins: closed issues drop out (with a note saying why) and open ones pick up
 * their latest title and state. Pins missing from `issues` weren't looked up and stay as they are.
 */
export function reconcile(items: readonly Pin[], issues: ReadonlyMap<string, Issue | null>) {
  const closed: string[] = []
  const kept: Pin[] = []
  for (const pin of items) {
    if (!issues.has(pin.id)) {
      kept.push(pin)
      continue
    }
    const issue = issues.get(pin.id) ?? null
    const reason = closedReason(issue)
    if (reason || !issue) {
      closed.push(`${pin.identifier} (${reason})`)
      continue
    }
    kept.push(toPin(issue, pin.pinnedAt))
  }
  return { items: kept, closed }
}
