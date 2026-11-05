import { describe, expect, test } from "bun:test"
import { closedReason, createLinear, LinearError, type Issue } from "./linear.ts"
import { age, isStale, maxPins, reconcile, STALE_AFTER_MS, toPin } from "./pins.ts"

const issue = (overrides: Partial<Issue> & { stateType?: string; stateName?: string } = {}): Issue => ({
  id: overrides.id ?? "id-1",
  identifier: overrides.identifier ?? "ENG-1",
  title: overrides.title ?? "Write the plugin",
  url: "https://linear.app/x/issue/ENG-1",
  state: { name: overrides.stateName ?? "Todo", type: overrides.stateType ?? "unstarted", color: "#fff" },
  team: { id: "team", key: "ALE" },
  archivedAt: overrides.archivedAt ?? null,
  trashed: overrides.trashed ?? null,
})

type Call = { query: string; variables: Record<string, unknown> }

function fakeFetch(respond: (call: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = []
  const fetcher = (async (_url: string, init: RequestInit) => {
    const call = JSON.parse(String(init.body)) as Call
    calls.push(call)
    const { status = 200, body } = respond(call)
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

describe("closedReason", () => {
  test("open states stay pinned", () => {
    for (const type of ["triage", "backlog", "unstarted", "started"]) expect(closedReason(issue({ stateType: type }))).toBeUndefined()
  })
  test("done, canceled and duplicate states close the pin", () => {
    expect(closedReason(issue({ stateType: "completed", stateName: "Done" }))).toBe("Done")
    expect(closedReason(issue({ stateType: "canceled", stateName: "Canceled" }))).toBe("Canceled")
    expect(closedReason(issue({ stateType: "duplicate", stateName: "Duplicate" }))).toBe("Duplicate")
  })
  test("archived, trashed and deleted issues close the pin", () => {
    expect(closedReason(issue({ archivedAt: "2026-11-05T00:00:00Z" }))).toBe("archived")
    expect(closedReason(issue({ trashed: true, archivedAt: "2026-11-05T00:00:00Z" }))).toBe("deleted")
    expect(closedReason(null)).toBe("deleted")
  })
})

describe("reconcile", () => {
  const pinnedAt = 1_000
  const open = toPin(issue({ id: "a", identifier: "ENG-1" }), pinnedAt)
  const done = toPin(issue({ id: "b", identifier: "ENG-2" }), pinnedAt)
  const gone = toPin(issue({ id: "c", identifier: "ENG-3" }), pinnedAt)
  const unchecked = toPin(issue({ id: "d", identifier: "ENG-4" }), pinnedAt)

  test("drops closed issues, refreshes open ones and keeps the order", () => {
    const result = reconcile(
      [open, done, gone, unchecked],
      new Map<string, Issue | null>([
        ["a", issue({ id: "a", identifier: "ENG-1", title: "Renamed", stateName: "In Progress", stateType: "started" })],
        ["b", issue({ id: "b", identifier: "ENG-2", stateName: "Done", stateType: "completed" })],
        ["c", null],
      ]),
    )
    expect(result.items.map((pin) => pin.id)).toEqual(["a", "d"])
    expect(result.items[0]).toMatchObject({ title: "Renamed", stateName: "In Progress", pinnedAt })
    expect(result.closed).toEqual(["ENG-2 (Done)", "ENG-3 (deleted)"])
  })
})

describe("pins", () => {
  test("a pin is overdue after 24 hours", () => {
    const pin = toPin(issue(), 0)
    expect(isStale(pin, STALE_AFTER_MS - 1)).toBe(false)
    expect(isStale(pin, STALE_AFTER_MS)).toBe(true)
  })
  test("age reads naturally", () => {
    expect(age(30_000)).toBe("0m")
    expect(age(5 * 60_000)).toBe("5m")
    expect(age(3 * 3_600_000)).toBe("3h")
    expect(age(25 * 3_600_000)).toBe("1d 1h")
    expect(age(48 * 3_600_000)).toBe("2d")
  })
  test("max defaults to 5 and accepts a positive integer option", () => {
    expect(maxPins(undefined)).toBe(5)
    expect(maxPins({ max: 3 })).toBe(3)
    expect(maxPins({ max: 0 })).toBe(5)
    expect(maxPins({ max: "7" })).toBe(5)
  })
})

describe("createLinear", () => {
  test("sends the key as-is and filters search to open issues", async () => {
    const { fetcher, calls } = fakeFetch(() => ({ body: { data: { searchIssues: { nodes: [issue()] } } } }))
    const result = await createLinear("lin_api_test", fetcher).search("plugin")
    expect(result).toHaveLength(1)
    expect(calls[0]!.variables).toEqual({ term: "plugin" })
    expect(calls[0]!.query).toContain('nin: ["completed","canceled","duplicate"]')
  })

  test("reports a rejected key as an auth error", async () => {
    const { fetcher } = fakeFetch(() => ({
      status: 401,
      body: { errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] },
    }))
    const error = await createLinear("bad", fetcher).viewer().catch((cause) => cause)
    expect(error).toBeInstanceOf(LinearError)
    expect(error.kind).toBe("auth")
  })

  test("lookup marks issues Linear can't find as deleted and keeps the rest", async () => {
    const { fetcher } = fakeFetch(({ query, variables }) => {
      if (query.includes("issues(")) return { body: { data: { issues: { nodes: [issue({ id: "a" })] } } } }
      expect(variables.id).toBe("b")
      return { status: 400, body: { errors: [{ message: "Entity not found: Issue" }], data: null } }
    })
    const result = await createLinear("key", fetcher).lookup(["a", "b"])
    expect(result.get("a")?.id).toBe("a")
    expect(result.has("b")).toBe(true)
    expect(result.get("b")).toBeNull()
  })

  test("lookup fails instead of guessing when Linear errors for another reason", async () => {
    const { fetcher } = fakeFetch(({ query }) =>
      query.includes("issues(")
        ? { body: { data: { issues: { nodes: [] } } } }
        : { status: 500, body: { errors: [{ message: "Internal error" }] } },
    )
    await expect(createLinear("key", fetcher).lookup(["a"])).rejects.toBeInstanceOf(LinearError)
  })

  test("complete moves the issue to the team's first completed state", async () => {
    const { fetcher, calls } = fakeFetch(({ query }) =>
      query.startsWith("mutation")
        ? { body: { data: { issueUpdate: { success: true, issue: issue({ stateName: "Done", stateType: "completed" }) } } } }
        : {
            body: {
              data: {
                issue: {
                  team: {
                    states: {
                      nodes: [
                        { id: "shipped", name: "Shipped", position: 5 },
                        { id: "done", name: "Done", position: 2 },
                      ],
                    },
                  },
                },
              },
            },
          },
    )
    const updated = await createLinear("key", fetcher).complete("id-1")
    expect(calls[1]!.variables).toEqual({ id: "id-1", stateId: "done" })
    expect(updated.state.name).toBe("Done")
  })
})
