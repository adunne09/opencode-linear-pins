/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { RGBA, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { spawn } from "node:child_process"
import { createEffect, createMemo, createSignal, For, Index, on, onCleanup, Show } from "solid-js"
import { createLinear, LinearError, type Issue } from "./linear.ts"
import { age, isStale, maxPins, reconcile, toPin, type Pin } from "./pins.ts"

const POLL_MS = 60_000
const SEARCH_DEBOUNCE_MS = 250
const TRANSPARENT = RGBA.fromInts(0, 0, 0, 0)
// Theme error colors can be soft (some are pastel pinks), so overdue pins use a fixed, loud red.
const URGENT = RGBA.fromHex("#ff3b30")
const ON_URGENT = RGBA.fromHex("#ffffff")

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

function openUrl(url: string) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open"
  try {
    spawn(command, [url], { detached: true, stdio: "ignore" }).unref()
  } catch {}
}

function createPins(ctx: Context) {
  const max = maxPins(ctx.options)
  const [pins, updatePins] = ctx.storage.store("pins", { initial: { items: [] as Pin[] } })
  const [auth, updateAuth] = ctx.storage.store("auth", { initial: { apiKey: "" } })
  const [now, setNow] = createSignal(Date.now())
  const [problem, setProblem] = createSignal<{ text: string; auth: boolean }>()

  const apiKey = () => process.env.LINEAR_API_KEY?.trim() || auth.apiKey
  const linear = () => {
    const key = apiKey()
    return key ? createLinear(key) : undefined
  }
  const toast = (text: string, variant: "info" | "success" | "warning" | "error" = "info") =>
    ctx.ui.toast.show({ title: "Linear", message: text, variant })

  const report = (error: unknown) => {
    if (error instanceof LinearError && error.kind === "auth") {
      setProblem({ text: "Linear rejected the API key. Click to replace it.", auth: true })
    } else {
      setProblem({ text: message(error), auth: false })
    }
  }

  const remove = (id: string) =>
    updatePins((draft) => {
      draft.items = draft.items.filter((pin) => pin.id !== id)
    })

  let refreshing: Promise<string[]> | undefined
  /** Syncs the pins with Linear and returns the ones it unpinned because they closed. */
  const refresh = () => {
    refreshing ??= (async () => {
      setNow(Date.now())
      const client = linear()
      const ids = pins.items.map((pin) => pin.id)
      if (!client || ids.length === 0) return []
      try {
        const issues = await client.lookup(ids)
        setProblem(undefined)
        let closed: string[] = []
        await updatePins((draft) => {
          const next = reconcile(draft.items, issues)
          draft.items = next.items
          closed = next.closed
        })
        if (closed.length) toast(`Closed in Linear, so unpinned: ${closed.join(", ")}`, "success")
        return closed
      } catch (error) {
        report(error)
        return []
      }
    })().finally(() => (refreshing = undefined))
    return refreshing
  }

  const pin = async (issue: Issue) => {
    if (pins.items.some((item) => item.id === issue.id)) return true
    if (pins.items.length >= max) {
      toast(`You can pin up to ${max} issues. Unpin one first.`, "warning")
      return false
    }
    await updatePins((draft) => {
      draft.items.push(toPin(issue, Date.now()))
    })
    return true
  }

  const complete = async (item: Pin) => {
    const client = linear()
    if (!client) return
    try {
      const issue = await client.complete(item.id)
      await remove(item.id)
      toast(`${item.identifier} moved to ${issue.state.name}`, "success")
    } catch (error) {
      toast(`Couldn't complete ${item.identifier}: ${message(error)}`, "error")
    }
  }

  /** Asks for a personal API key, checks it with Linear, and saves it. */
  const promptKey = async () => {
    if (process.env.LINEAR_API_KEY?.trim()) {
      toast("LINEAR_API_KEY is set in the environment, so it's used instead of a saved key.", "warning")
      return undefined
    }
    const value = (
      await ctx.ui.dialog.prompt({
        title: "Linear API key",
        description:
          "Create a personal API key under Linear › Settings › Security & access. It's saved in OpenCode's plugin storage on this machine.",
        placeholder: "lin_api_…",
      })
    )?.trim()
    if (!value) return undefined
    try {
      const viewer = await createLinear(value).viewer()
      await updateAuth((draft) => {
        draft.apiKey = value
      })
      setProblem(undefined)
      toast(`Connected as ${viewer.name}`, "success")
      void refresh()
      return value
    } catch (error) {
      toast(message(error), "error")
      return undefined
    }
  }

  return { max, pins, now, setNow, problem, apiKey, linear, refresh, pin, remove, complete, promptKey, toast }
}

type Pins = ReturnType<typeof createPins>

type Row = { id: string; identifier: string; title: string; state: string; pinned: boolean; issue?: Issue }

function Picker(props: { ctx: Context; pins: Pins }) {
  const { ctx, pins } = props
  const theme = ctx.theme
  const dimensions = useTerminalDimensions()
  const [query, setQuery] = createSignal("")
  const [results, setResults] = createSignal<Issue[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string>()
  const [selected, setSelected] = createSignal(0)
  let scroll: ScrollBoxRenderable | undefined

  createEffect(
    on(query, (term) => {
      const controller = new AbortController()
      setLoading(true)
      const timer = setTimeout(
        async () => {
          const client = pins.linear()
          if (!client) return
          try {
            const issues = term.trim() ? await client.search(term.trim(), controller.signal) : await client.mine(controller.signal)
            if (controller.signal.aborted) return
            setResults(issues)
            setError(undefined)
            setSelected(0)
          } catch (cause) {
            if (!controller.signal.aborted) setError(message(cause))
          } finally {
            if (!controller.signal.aborted) setLoading(false)
          }
        },
        term ? SEARCH_DEBOUNCE_MS : 0,
      )
      onCleanup(() => {
        clearTimeout(timer)
        controller.abort()
      })
    }),
  )

  // Pinned issues the current results don't include come first; the results keep their order so rows don't jump when toggled.
  const rows = createMemo<Row[]>(() => {
    const pinned = new Set(pins.pins.items.map((item) => item.id))
    const found = results().map((issue) => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      state: issue.state.name,
      pinned: pinned.has(issue.id),
      issue,
    }))
    const shown = new Set(found.map((row) => row.id))
    const extra = pins.pins.items
      .filter((item) => !shown.has(item.id))
      .map((item) => ({ id: item.id, identifier: item.identifier, title: item.title, state: item.stateName, pinned: true }))
    return [...extra, ...found]
  })

  const move = (index: number) => {
    const next = Math.max(0, Math.min(rows().length - 1, index))
    setSelected(next)
    const row = scroll?.getChildren()[next]
    if (row) scroll?.scrollChildIntoView(row.id)
  }

  const toggle = async (index = selected()) => {
    const row = rows()[index]
    if (!row) return
    if (row.pinned) await pins.remove(row.id)
    else if (row.issue) await pins.pin(row.issue)
    move(Math.min(index, rows().length - 1))
  }

  ctx.keymap.layer(() => ({
    mode: "modal",
    priority: 10,
    commands: [
      { bind: "up", title: "Previous issue", group: "Linear pins", run: () => move(selected() - 1) },
      { bind: "down", title: "Next issue", group: "Linear pins", run: () => move(selected() + 1) },
      { bind: "return", title: "Pin or unpin", group: "Linear pins", run: () => void toggle() },
    ],
  }))

  const listHeight = () => Math.max(5, Math.min(24, dimensions().height - 16))
  const pinnedCount = () => pins.pins.items.length
  const notice = () =>
    error()
      ? { text: error()!, fg: theme.text.feedback.error.base }
      : loading() && results().length === 0
        ? { text: "Searching Linear…", fg: theme.text.muted }
        : !loading() && results().length === 0
          ? { text: query().trim() ? "No open issues match." : "No open issues are assigned to you.", fg: theme.text.muted }
          : undefined

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={theme.text.base}>
          <b>Pin Linear issues</b>
        </text>
        <text fg={pinnedCount() >= pins.max ? theme.text.feedback.warning.base : theme.text.muted}>
          {`${pinnedCount()}/${pins.max} pinned`}
        </text>
      </box>
      <input
        focused
        placeholder="Search open issues by title or ID. Leave empty for yours."
        onInput={(value: string) => setQuery(value)}
      />
      <Show when={notice()}>{(current) => <text fg={current().fg}>{current().text}</text>}</Show>
      <scrollbox
        ref={(element: ScrollBoxRenderable) => (scroll = element)}
        height={listHeight()}
        scrollX={false}
        scrollbarOptions={{ visible: false }}
      >
        <Index each={rows()}>
          {(row, index) => {
            const active = () => index === selected()
            const fg = () => (active() ? theme.text.action.primary.focused : theme.text.base)
            return (
              <box
                flexDirection="row"
                gap={1}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={active() ? theme.background.action.primary.focused : TRANSPARENT}
                onMouseDown={() => setSelected(index)}
                onMouseUp={() => void toggle(index)}
              >
                <text flexShrink={0} fg={active() ? fg() : row().pinned ? theme.text.feedback.success.base : theme.text.muted}>
                  {row().pinned ? "●" : "○"}
                </text>
                <text flexShrink={0} width={10} fg={active() ? fg() : theme.text.muted} wrapMode="none">
                  {row().identifier}
                </text>
                <text flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} fg={fg()} wrapMode="none">
                  {row().title}
                </text>
                <text flexShrink={0} width={12} fg={active() ? fg() : theme.text.muted} wrapMode="none">
                  {row().state}
                </text>
              </box>
            )
          }}
        </Index>
      </scrollbox>
      <box flexDirection="row" gap={3} flexShrink={0}>
        <For
          each={[
            ["↑↓", "select"],
            ["enter", "pin / unpin"],
            ["esc", "close"],
          ]}
        >
          {([key, label]) => (
            <text>
              <span style={{ fg: theme.text.base }}>
                <b>{key}</b>
              </span>
              <span style={{ fg: theme.text.muted }}>{` ${label}`}</span>
            </text>
          )}
        </For>
      </box>
    </box>
  )
}

function Sidebar(props: { ctx: Context; pins: Pins; openPicker: () => void; openActions: (pin: Pin) => void }) {
  const { ctx, pins } = props
  const theme = ctx.theme
  const items = () => pins.pins.items
  const stale = () => items().filter((item) => isStale(item, pins.now())).length

  return (
    <box flexShrink={0}>
      <text onMouseUp={() => (pins.apiKey() ? props.openPicker() : void pins.promptKey())}>
        <span style={{ fg: theme.text.base }}>
          <b>Linear TODOs</b>
        </span>
        <span style={{ fg: theme.text.muted }}>{pins.apiKey() ? `  ${items().length}/${pins.max}` : ""}</span>
        <Show when={pins.apiKey() && stale()}>
          <span style={{ fg: URGENT }}>
            <b>{`  ${stale()} overdue`}</b>
          </span>
        </Show>
      </text>
      <Show
        when={pins.apiKey()}
        fallback={
          <text fg={theme.text.feedback.warning.base} onMouseUp={() => void pins.promptKey()}>
            Click to add a Linear API key.
          </text>
        }
      >
        <For each={items()}>
          {(item) => {
            const overdue = () => isStale(item, pins.now())
            const since = () => age(pins.now() - item.pinnedAt)
            return (
              <box marginTop={1} onMouseUp={() => props.openActions(item)}>
                <Show
                  when={overdue()}
                  fallback={
                    <text fg={theme.text.base}>
                      <span style={{ fg: theme.text.muted }}>
                        <b>{item.identifier}</b>
                      </span>
                      {` ${item.title}`}
                    </text>
                  }
                >
                  <text fg={URGENT}>
                    <span style={{ fg: ON_URGENT, bg: URGENT }}>
                      <b>{` ${item.identifier} `}</b>
                    </span>
                    <b>{` ${item.title}`}</b>
                  </text>
                </Show>
                <text fg={overdue() ? URGENT : theme.text.muted}>
                  {overdue() ? <b>{`⚠ OVERDUE · pinned ${since()} ago · ${item.stateName}`}</b> : `${item.stateName} · pinned ${since()} ago`}
                </text>
              </box>
            )
          }}
        </For>
        <Show
          when={items().length > 0}
          fallback={
            <text fg={theme.text.muted} onMouseUp={props.openPicker}>
              Nothing pinned. Click to pick your TODOs.
            </text>
          }
        >
          <Show when={items().length < pins.max}>
            <text marginTop={1} fg={theme.text.muted} onMouseUp={props.openPicker}>
              + Pin an issue
            </text>
          </Show>
        </Show>
        <Show when={pins.problem()}>
          {(current) => (
            <text
              fg={theme.text.feedback.error.base}
              onMouseUp={() => (current().auth ? void pins.promptKey() : void pins.refresh())}
            >
              {current().text}
            </text>
          )}
        </Show>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "local.linear-pins.tui",
  setup(ctx) {
    const pins = createPins(ctx)

    const openPicker = async () => {
      if (!pins.apiKey() && !(await pins.promptKey())) return
      ctx.ui.dialog.show(
        () => <Picker ctx={ctx} pins={pins} />,
        () => void pins.refresh(),
      )
      ctx.ui.dialog.set({ size: "large" })
    }

    const openActions = async (item: Pin) => {
      const choice = await ctx.ui.dialog.select({
        title: `${item.identifier} ${item.title}`,
        options: [
          { title: "Mark done", value: "done" as const, description: "Move it to the team's done state in Linear" },
          { title: "Unpin", value: "unpin" as const, description: "Remove it from the list, without changing Linear" },
          { title: "Open in Linear", value: "open" as const },
        ],
      })
      if (choice === "done") await pins.complete(item)
      else if (choice === "unpin") await pins.remove(item.id)
      else if (choice === "open") openUrl(item.url)
    }

    void pins.refresh()
    const poll = setInterval(() => void pins.refresh(), POLL_MS)

    const render = () => (
      <Sidebar ctx={ctx} pins={pins} openPicker={() => void openPicker()} openActions={(item) => void openActions(item)} />
    )
    const removeSidebar = ctx.ui.slot(
      ctx.options.position === "top" ? { prepend: "sidebar.content", render } : { append: "sidebar.content", render },
    )

    const removeCommands = ctx.ui.slot({
      append: "app",
      render: () => {
        ctx.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "local.linear-pins.pick",
              title: "Pin Linear issues",
              description: "Search Linear and pin or unpin issues in the sidebar",
              group: "Linear",
              palette: true,
              slash: { name: "pins" },
              run: () => void openPicker(),
            },
            {
              id: "local.linear-pins.refresh",
              title: "Refresh pinned Linear issues",
              group: "Linear",
              palette: true,
              run: () =>
                void pins.refresh().then((closed) => {
                  if (!closed.length && !pins.problem()) pins.toast("Pinned issues are up to date")
                }),
            },
            {
              id: "local.linear-pins.key",
              title: "Set Linear API key",
              group: "Linear",
              palette: true,
              run: () => void pins.promptKey(),
            },
          ],
        }))
        return null
      },
    })

    return () => {
      clearInterval(poll)
      removeSidebar()
      removeCommands()
    }
  },
})
