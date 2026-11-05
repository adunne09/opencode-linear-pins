import { Plugin } from "@opencode/plugin"
import { closedReason, createLinear, LinearError } from "./linear.ts"
import { describe, findPin, maxPins, reconcile, toPin, type Pin } from "./pins.ts"
import { LinearTodosRpc } from "./rpc.ts"

const POLL_MS = 60_000

// The server loads one instance of the plugin per directory, all sharing one list. Every change reads and writes
// storage inside this module-level queue, so concurrent tool calls and syncs can't drop each other's changes.
let queue: Promise<unknown> = Promise.resolve()
const serial = <T>(task: () => Promise<T>) => {
  const run = queue.then(task)
  queue = run.catch(() => {})
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
    const max = maxPins(ctx.options)
    let problem: { text: string; auth: boolean } | undefined

    const read = async () => ((await ctx.storage.get("pins")) as { items?: Pin[] } | undefined)?.items ?? []
    const write = (items: Pin[]) => ctx.storage.set("pins", { items })

    const apiKey = async () => process.env.LINEAR_API_KEY?.trim() || ((await ctx.storage.get("apiKey")) as string | undefined) || ""
    const linear = async () => {
      const key = await apiKey()
      if (!key) throw new LinearError("No Linear API key is set. Set LINEAR_API_KEY or use Set Linear API key in the TUI.", "auth")
      return createLinear(key)
    }

    const registration = await ctx.rpc.register(LinearTodosRpc, {
      list: async () => ({ items: await read(), max, configured: Boolean(await apiKey()), ...(problem ? { problem } : {}) }),
      unpin: async (input) => {
        const { id } = input as { id: string }
        await serial(async () => write((await read()).filter((pin) => pin.id !== id)))
        await changed()
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
      editor.add({
        name: "linear_todos_list",
        description:
          "List the Linear issues pinned as the user's TODOs. They show in the OpenCode sidebar and home screen. Pins over 24 hours old are marked OVERDUE.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: false },
        execute: async () => ({ content: describe(await read(), max, Date.now()) }),
      })

      editor.add({
        name: "linear_todos_pin",
        description: `Pin Linear issues as the user's TODOs, shown in the OpenCode sidebar and home screen. At most ${max} can be pinned. Only open issues can be pinned; done, canceled, duplicate, archived and deleted issues are refused. Use this when the user asks to add something to their TODOs, today's list or their pins.`,
        input: referencesInput,
        options: { codemode: false },
        execute: async (input, context) => {
          const { issues } = input as { issues: string[] }
          const client = await linear()
          const found = await Promise.all(issues.map(async (reference) => ({ reference, issue: await client.get(reference, context.signal) })))
          const notes: string[] = []
          await serial(async () => {
            const items = await read()
            for (const { reference, issue } of found) {
              if (!issue) {
                notes.push(`${reference}: not found in Linear`)
                continue
              }
              const reason = closedReason(issue)
              if (reason) notes.push(`${issue.identifier}: not pinned, it's ${reason === "deleted" || reason === "archived" ? reason : reason.toLowerCase()}`)
              else if (items.some((pin) => pin.id === issue.id)) notes.push(`${issue.identifier}: already pinned`)
              else if (items.length >= max) notes.push(`${issue.identifier}: not pinned, the list is full (${max}/${max}). Unpin something first.`)
              else {
                items.push(toPin(issue, Date.now()))
                notes.push(`${issue.identifier}: pinned`)
              }
            }
            await write(items)
          })
          await changed()
          return { content: [...notes, "", describe(await read(), max, Date.now())].join("\n") }
        },
      })

      editor.add({
        name: "linear_todos_unpin",
        description:
          "Unpin Linear issues from the user's TODOs without changing them in Linear. Use this when the user asks to remove something from their TODOs.",
        input: referencesInput,
        options: { codemode: false },
        execute: async (input) => {
          const { issues } = input as { issues: string[] }
          const notes: string[] = []
          await serial(async () => {
            let items = await read()
            for (const reference of issues) {
              const pin = findPin(items, reference)
              if (!pin) {
                notes.push(`${reference}: not pinned`)
                continue
              }
              items = items.filter((item) => item.id !== pin.id)
              notes.push(`${pin.identifier}: unpinned`)
            }
            await write(items)
          })
          await changed()
          return { content: [...notes, "", describe(await read(), max, Date.now())].join("\n") }
        },
      })
    })

    void refresh()
    const poll = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(poll)
  },
})
