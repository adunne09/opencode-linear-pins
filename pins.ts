import { closedReason, parseReference, type Issue } from "./linear.ts"

export const STALE_AFTER_MS = 24 * 60 * 60 * 1000

export type Pin = {
  id: string
  identifier: string
  title: string
  url: string
  stateName: string
  stateType: string
  /** Linear's color for the state, such as #f2c94c. Missing on pins saved before it was stored. */
  stateColor?: string
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
    stateColor: issue.state.color,
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

/** Finds the pin a reference (ID, identifier or URL) points at. */
export function findPin(items: readonly Pin[], reference: string) {
  const wanted = parseReference(reference)
  const raw = reference.trim()
  return items.find((pin) => pin.id === raw || pin.identifier.toUpperCase() === wanted.toUpperCase() || pin.url === raw)
}

/** The list as the agent sees it. */
export function describe(items: readonly Pin[], now: number) {
  if (items.length === 0) return "No Linear TODOs are pinned."
  const lines = items.map((pin) => {
    const overdue = isStale(pin, now) ? " OVERDUE (pinned over 24h)" : ""
    return `- ${pin.identifier}: ${pin.title} [${pin.stateName}, pinned ${age(now - pin.pinnedAt)} ago]${overdue} ${pin.url}`
  })
  return [`Pinned Linear TODOs (${items.length}):`, ...lines].join("\n")
}

export type PinResult =
  | { reference: string; status: "not_found" }
  | { reference: string; identifier: string; status: "pinned" | "already_pinned" }
  | { reference: string; identifier: string; status: "closed"; reason: string }

/**
 * Adds the open issues among `found` to the pins. Issues Linear couldn't find, closed ones (done, canceled, duplicate,
 * archived or deleted) and ones already pinned are left out, and each gets a result saying why.
 */
export function addPins(items: readonly Pin[], found: readonly { reference: string; issue: Issue | null }[], now: number) {
  const next = [...items]
  const results: PinResult[] = []
  for (const { reference, issue } of found) {
    if (!issue) {
      results.push({ reference, status: "not_found" })
      continue
    }
    const reason = closedReason(issue)
    if (reason) results.push({ reference, identifier: issue.identifier, status: "closed", reason })
    else if (next.some((pin) => pin.id === issue.id)) results.push({ reference, identifier: issue.identifier, status: "already_pinned" })
    else {
      next.push(toPin(issue, now))
      results.push({ reference, identifier: issue.identifier, status: "pinned" })
    }
  }
  return { items: next, results, added: next.length - items.length }
}

/** One line explaining a pin result, for the agent and for toasts. */
export function pinNote(result: PinResult) {
  switch (result.status) {
    case "not_found":
      return `${result.reference}: not found in Linear`
    case "already_pinned":
      return `${result.identifier}: already pinned`
    case "pinned":
      return `${result.identifier}: pinned`
    case "closed":
      return `${result.identifier}: not pinned, it's ${result.reason === "deleted" || result.reason === "archived" ? result.reason : result.reason.toLowerCase()}`
  }
}

// Linear's default state colors, for pins saved before the color was stored.
const DEFAULT_STATE_COLORS: Record<string, string> = {
  triage: "#fc7840",
  backlog: "#bec2c8",
  unstarted: "#e2e2e2",
  started: "#f2c94c",
}

// Stand-ins for Linear's state icons: dotted circle for backlog, empty for todo, half-filled for in progress.
const STATE_ICONS: Record<string, string> = {
  triage: "◇",
  backlog: "◌",
  unstarted: "○",
  started: "◐",
}

/** The icon and color to show for a pin's state. */
export function stateStyle(pin: Pick<Pin, "stateType" | "stateColor">) {
  return {
    icon: STATE_ICONS[pin.stateType] ?? "○",
    color: pin.stateColor ?? DEFAULT_STATE_COLORS[pin.stateType] ?? DEFAULT_STATE_COLORS.unstarted!,
  }
}
