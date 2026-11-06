import { Plugin } from "@opencode/plugin"
import { createLinear, LinearError } from "./linear.ts"
import { addPins, describe, findPin, pinNote, reconcile, type Pin } from "./pins.ts"
import { LinearTodosRpc } from "./rpc.ts"

const POLL_MS = 60_000

// The server loads one instance of the plugin per directory, all sharing one list, and a reload can briefly run a new
// copy of this module beside the old one. Every change reads and writes storage inside one queue kept on globalThis,
// so concurrent tool calls, clicks and syncs from any instance can't drop each other's changes.
const shared = globalThis as { linearTodosQueue?: Promise<unknown> }
const serial = <T>(task: () => Promise<T>) => {
  const run = (shared.linearTodosQueue ?? Promise.resolve()).then(task)
  shared.linearTodosQueue = run.catch(() => {})
  return run
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const referencesInput = {
  type: "object",
  properties: {
    issues: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      description: "Linear issue identifiers such as ENG-123, or issue URLs.",
    },
  },
  required: ["issues"],
  additionalProperties: false,
} as const

export default Plugin.define({
  id: "local.linear-pins",
  async setup(ctx) {
    let problem: { text: string; auth: boolean } | undefined

    const read = async () => ((await ctx.storage.get("pins")) as { items?: Pin[] } | undefined)?.items ?? []
    const write = (items: Pin[]) => ctx.storage.set("pins", { items })

    const apiKey = async () => process.env.LINEAR_API_KEY?.trim() || ((await ctx.storage.get("apiKey")) as string | undefined) || ""
    const linear = async () => {
      const key = await apiKey()
      if (!key) throw new LinearError("No Linear API key is set. Set LINEAR_API_KEY or use Set Linear API key in the TUI.", "auth")
      return createLinear(key)
    }

    /** Looks each reference up in Linear and pins the open issues. Changes nothing unless something new is pinned. */
    const pin = async (references: readonly string[], signal?: AbortSignal) => {
      const client = await linear()
      const found = await Promise.all(references.map(async (reference) => ({ reference, issue: await client.get(reference, signal) })))
      const { results, added } = await serial(async () => {
        const next = addPins(await read(), found, Date.now())
        if (next.added) await write(next.items)
        return next
      })
      if (added) await changed()
      return results
    }

    const registration = await ctx.rpc.register(LinearTodosRpc, {
      list: async () => ({ items: await read(), configured: Boolean(await apiKey()), ...(problem ? { problem } : {}) }),
      pin: async (input) => {
        const [result] = await pin([(input as { reference: string }).reference])
        return { ...result!, message: pinNote(result!) }
      },
      unpin: async (input) => {
        const { id } = input as { id: string }
        const removed = await serial(async () => {
          const items = await read()
          const next = items.filter((pin) => pin.id !== id)
          if (next.length !== items.length) await write(next)
          return next.length !== items.length
        })
        if (removed) await changed()
        return {}
      },
      complete: async (input) => {
        const { id } = input as { id: string }
        const issue = await (await linear()).complete(id)
        await serial(async () => write((await read()).filter((pin) => pin.id !== id)))
        await changed()
        return { state: issue.state.name }
      },
      setKey: async (input) => {
        const value = (input as { apiKey: string }).apiKey.trim()
        const viewer = await createLinear(value).viewer()
        await ctx.storage.set("apiKey", value)
        problem = undefined
        void refresh()
        return { name: viewer.name }
      },
      refresh: async () => ({ closed: await refresh() }),
    })

    const changed = (closed: string[] = []) => registration.events.emit("changed", closed.length ? { closed } : {})

    /** Syncs the pins with Linear and returns the ones it unpinned because they closed. */
    const refresh = async () => {
      const before = problem?.text
      try {
        if (!(await apiKey()) || (await read()).length === 0) return []
        const client = await linear()
        const closed = await serial(async () => {
          const items = await read()
          const next = reconcile(items, await client.lookup(items.map((pin) => pin.id)))
          if (JSON.stringify(next.items) !== JSON.stringify(items)) await write(next.items)
          return next
        })
        problem = undefined
        await changed(closed.closed)
        return closed.closed
      } catch (error) {
        problem =
          error instanceof LinearError && error.kind === "auth"
            ? { text: "Linear rejected the API key. Click to replace it.", auth: true }
            : { text: message(error), auth: false }
        if (problem.text !== before) await changed()
        return []
      }
    }

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "linear_todos",
        description: "The user's pinned Linear TODOs, shown in the OpenCode sidebar and home screen.",
      })

      editor.add({
        name: "list",
        description:
          "List the Linear issues pinned as the user's TODOs. They show in the OpenCode sidebar and home screen. Pins over 24 hours old are marked OVERDUE.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "linear_todos" },
        execute: async () => ({ content: describe(await read(), Date.now()) }),
      })

      editor.add({
        name: "pin",
        description:
          "Pin Linear issues as the user's TODOs, shown in the OpenCode sidebar and home screen. Only open issues can be pinned; done, canceled, duplicate, archived and deleted issues are refused, and so are identifiers Linear can't find. Pinning an issue that's already pinned changes nothing. Use this when the user asks to add something to their TODOs, today's list or their pins.",
        input: referencesInput,
        options: { namespace: "linear_todos" },
        execute: async (input, context) => {
          const results = await pin((input as { issues: string[] }).issues, context.signal)
          return { content: [...results.map(pinNote), "", describe(await read(), Date.now())].join("\n") }
        },
      })

      editor.add({
        name: "unpin",
        description:
          "Unpin Linear issues from the user's TODOs without changing them in Linear. Use this when the user asks to remove something from their TODOs.",
        input: referencesInput,
        options: { namespace: "linear_todos" },
        execute: async (input) => {
          const { issues } = input as { issues: string[] }
          const notes: string[] = []
          const removed = await serial(async () => {
            const before = await read()
            let items = before
            for (const reference of issues) {
              const pin = findPin(items, reference)
              if (!pin) {
                notes.push(`${reference}: not pinned`)
                continue
              }
              items = items.filter((item) => item.id !== pin.id)
              notes.push(`${pin.identifier}: unpinned`)
            }
            if (items.length !== before.length) await write(items)
            return before.length - items.length
          })
          if (removed) await changed()
          return { content: [...notes, "", describe(await read(), Date.now())].join("\n") }
        },
      })
    })

    void refresh()
    const poll = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(poll)
  },
})
