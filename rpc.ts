import { Rpc } from "@opencode/plugin/rpc"

const loose = { type: "object" } as const
const empty = { type: "object", additionalProperties: false } as const
const byId = { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } as const

export const LinearTodosRpc = Rpc.define({
  id: "linear-todos",
  methods: {
    /** `{ items: Pin[], configured, problem? }` */
    list: { input: empty, output: loose },
    /** Looks the issue up in Linear and pins it if it's open. Returns a `PinResult` plus a `message`. */
    pin: {
      input: { type: "object", properties: { reference: { type: "string" } }, required: ["reference"], additionalProperties: false },
      output: loose,
    },
    unpin: { input: byId, output: loose },
    /** Moves the issue to its team's done state, then unpins it. Returns `{ state }`. */
    complete: { input: byId, output: loose },
    /** Checks the key with Linear and saves it. Returns `{ name }`. */
    setKey: {
      input: { type: "object", properties: { apiKey: { type: "string" } }, required: ["apiKey"], additionalProperties: false },
      output: loose,
    },
    /** Syncs with Linear now. Returns `{ closed }`. */
    refresh: { input: empty, output: loose },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: { closed: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    },
  },
})
