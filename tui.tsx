/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { RGBA } from "@opentui/core"
import { spawn } from "node:child_process"
import { createSignal, For, Show } from "solid-js"
import { isStale, stateStyle, type Pin } from "./pins.ts"
import { LinearTodosRpc } from "./rpc.ts"

// Theme error colors can be soft (some are pastel pinks), so overdue pins use a fixed, loud red.
const URGENT = RGBA.fromHex("#ff3b30")
const ON_URGENT = RGBA.fromHex("#ffffff")
const RETRY_MS = 5_000

type State = { items: Pin[]; configured: boolean; problem?: { text: string; auth: boolean } }

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

function openUrl(url: string) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open"
  try {
    spawn(command, [url], { detached: true, stdio: "ignore" }).unref()
  } catch {}
}

function createTodos(ctx: Context) {
  const rpc = () => ctx.client.rpc(LinearTodosRpc)
  const options = () => ({ location: ctx.location })
  const [state, setState] = createSignal<State>()
  const [unreachable, setUnreachable] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())

  const toast = (text: string, variant: "info" | "success" | "warning" | "error" = "info") =>
    ctx.ui.toast.show({ title: "Linear TODOs", message: text, variant })

  let retry: ReturnType<typeof setTimeout> | undefined
  const load = async () => {
    clearTimeout(retry)
    try {
      setState((await rpc().list({}, options())) as State)
      setUnreachable(false)
    } catch {
      // The server part may still be loading; try again shortly.
      setUnreachable(true)
      retry = setTimeout(() => void load(), RETRY_MS)
    }
    setNow(Date.now())
  }

  const run = async (label: string, task: () => Promise<unknown>) => {
    try {
      await task()
    } catch (error) {
      toast(`${label}: ${message(error)}`, "error")
    }
    await load()
  }

  const complete = (pin: Pin) =>
    run(`Couldn't complete ${pin.identifier}`, async () => {
      const result = (await rpc().complete({ id: pin.id }, options())) as { state: string }
      toast(`${pin.identifier} moved to ${result.state}`, "success")
    })

  const unpin = (pin: Pin) => run(`Couldn't unpin ${pin.identifier}`, () => rpc().unpin({ id: pin.id }, options()))

  /**
   * Asks for an issue and pins it. When Linear can't find it or it's closed, the dialog opens again with the reason
   * and the text kept, until the issue is pinned or the dialog is dismissed.
   */
  const promptPin = async () => {
    let value = ""
    let problem: string | undefined
    while (true) {
      const entered = (
        await ctx.ui.dialog.prompt({
          title: "Pin a Linear issue",
          description: problem ?? "Enter an issue ID such as ENG-123, or paste its Linear URL.",
          placeholder: "ENG-123",
          value,
        })
      )?.trim()
      if (!entered) return
      value = entered
      try {
        const result = (await rpc().pin({ reference: entered }, options())) as { status: string; message: string }
        if (result.status === "pinned" || result.status === "already_pinned") {
          toast(result.message, result.status === "pinned" ? "success" : "info")
          await load()
          return
        }
        problem = `${result.message}. Try another issue.`
      } catch (error) {
        problem = `${message(error)}. Try again.`
      }
    }
  }

  const refresh = () =>
    run("Couldn't refresh", async () => {
      const { closed } = (await rpc().refresh({}, options())) as { closed: string[] }
      if (!closed.length) toast("Up to date with Linear")
    })

  const promptKey = async () => {
    if (process.env.LINEAR_API_KEY?.trim()) {
      toast("LINEAR_API_KEY is set in the environment, so it's used instead of a saved key.", "warning")
      return
    }
    const value = (
      await ctx.ui.dialog.prompt({
        title: "Linear API key",
        description:
          "Create a personal API key under Linear › Settings › Security & access. It's saved in OpenCode's plugin storage on this machine.",
        placeholder: "lin_api_…",
      })
    )?.trim()
    if (!value) return
    await run("Couldn't save the key", async () => {
      const { name } = (await rpc().setKey({ apiKey: value }, options())) as { name: string }
      toast(`Connected as ${name}`, "success")
    })
  }

  const actions = (pin: Pin) =>
    ctx.ui.dialog.show(() => (
      <ActionMenu
        ctx={ctx}
        title={`${pin.identifier} ${pin.title}`}
        onPick={(choice) => {
          ctx.ui.dialog.clear()
          if (choice === "done") void complete(pin)
          else if (choice === "unpin") void unpin(pin)
          else openUrl(pin.url)
        }}
      />
    ))

  const stopEvents = rpc().events.on("changed", (event) => {
    const closed = (event.data as { closed?: string[] }).closed
    if (closed?.length) toast(`Closed in Linear, so unpinned: ${closed.join(", ")}`, "success")
    void load()
  })
  const clock = setInterval(() => setNow(Date.now()), 60_000)
  void load()

  const dispose = () => {
    stopEvents()
    clearInterval(clock)
    clearTimeout(retry)
  }

  return { state, unreachable, now, load, refresh, promptKey, promptPin, actions, dispose }
}

type Todos = ReturnType<typeof createTodos>

const ACTIONS = [
  { title: "Mark done", value: "done" },
  { title: "Unpin", value: "unpin" },
  { title: "Open in Linear", value: "open" },
] as const

type Action = (typeof ACTIONS)[number]["value"]

/** What to do with one pin. A plain list: the built-in select dialog always adds a search field. */
function ActionMenu(props: { ctx: Context; title: string; onPick: (action: Action) => void }) {
  const theme = props.ctx.theme
  const [selected, setSelected] = createSignal(0)
  const move = (step: number) => setSelected((index) => (index + step + ACTIONS.length) % ACTIONS.length)

  props.ctx.keymap.layer(() => ({
    mode: "modal",
    priority: 10,
    commands: [
      { bind: "up", title: "Previous action", group: "Linear TODOs", run: () => move(-1) },
      { bind: "down", title: "Next action", group: "Linear TODOs", run: () => move(1) },
      { bind: "return", title: "Run action", group: "Linear TODOs", run: () => props.onPick(ACTIONS[selected()]!.value) },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between" gap={2}>
        <text flexShrink={1} fg={theme.text.base}>
          <b>{props.title}</b>
        </text>
        <text flexShrink={0} fg={theme.text.muted} onMouseUp={() => props.ctx.ui.dialog.clear()}>
          esc
        </text>
      </box>
      <box>
        <For each={ACTIONS}>
          {(action, index) => {
            const active = () => index() === selected()
            return (
              <box
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={active() ? theme.background.action.primary.focused : RGBA.fromInts(0, 0, 0, 0)}
                onMouseOver={() => setSelected(index())}
                onMouseUp={() => props.onPick(action.value)}
              >
                <text fg={active() ? theme.text.action.primary.focused : theme.text.base}>{action.title}</text>
              </box>
            )
          }}
        </For>
      </box>
    </box>
  )
}

/** The pinned list. `wide` lays each pin out on one line, for the home screen. */
function TodoList(props: { ctx: Context; todos: Todos; wide?: boolean }) {
  const { ctx, todos } = props
  const theme = ctx.theme
  const items = () => todos.state()?.items ?? []
  const configured = () => todos.state()?.configured ?? false
  const stale = () => items().filter((pin) => isStale(pin, todos.now())).length

  return (
    <box flexShrink={0}>
      <box flexDirection="row" justifyContent="space-between" gap={2}>
        <text>
          <span style={{ fg: theme.text.base }}>
            <b>Linear TODOs</b>
          </span>
          <Show when={configured() && stale()}>
            <span style={{ fg: URGENT }}>
              <b>{`  ${stale()} overdue`}</b>
            </span>
          </Show>
        </text>
        <Show when={configured()}>
          <text flexShrink={0} fg={theme.text.action.primary.base} onMouseUp={() => void todos.promptPin()}>
            <b>+</b>
          </text>
        </Show>
      </box>
      <Show when={todos.state()} fallback={<text fg={theme.text.muted}>{todos.unreachable() ? "Waiting for the OpenCode server…" : "Loading…"}</text>}>
        <Show
          when={configured()}
          fallback={
            <text fg={theme.text.feedback.warning.base} onMouseUp={() => void todos.promptKey()}>
              Click to add a Linear API key.
            </text>
          }
        >
          <For each={items()}>
            {(pin) => {
              const overdue = () => isStale(pin, todos.now())
              const state = () => {
                const style = stateStyle(pin)
                return (
                  <span style={{ fg: RGBA.fromHex(style.color) }}>
                    {overdue() ? <b>{`${style.icon} ${pin.stateName}`}</b> : `${style.icon} ${pin.stateName}`}
                  </span>
                )
              }
              const detail = () =>
                overdue() ? (
                  <>
                    <b>⚠ OVERDUE</b>
                    {" · "}
                    {state()}
                  </>
                ) : (
                  state()
                )
              const id = () =>
                overdue() ? (
                  <span style={{ fg: ON_URGENT, bg: URGENT }}>
                    <b>{` ${pin.identifier} `}</b>
                  </span>
                ) : (
                  <span style={{ fg: theme.text.muted }}>
                    <b>{pin.identifier}</b>
                  </span>
                )
              const title = () => (overdue() ? <b>{` ${pin.title}`}</b> : ` ${pin.title}`)
              return (
                <Show
                  when={props.wide}
                  fallback={
                    <box marginTop={1} onMouseUp={() => void todos.actions(pin)}>
                      <text fg={overdue() ? URGENT : theme.text.base}>
                        {id()}
                        {title()}
                      </text>
                      <text fg={overdue() ? URGENT : theme.text.muted}>{detail()}</text>
                    </box>
                  }
                >
                  <box flexDirection="row" gap={2} onMouseUp={() => void todos.actions(pin)}>
                    <text flexGrow={1} flexShrink={1} minWidth={0} wrapMode="none" fg={overdue() ? URGENT : theme.text.base}>
                      {id()}
                      {title()}
                    </text>
                    <text flexShrink={0} wrapMode="none" fg={overdue() ? URGENT : theme.text.muted}>
                      {detail()}
                    </text>
                  </box>
                </Show>
              )
            }}
          </For>
          <Show when={items().length === 0}>
            <text fg={theme.text.muted}>Nothing pinned</text>
          </Show>
          <Show when={todos.state()?.problem}>
            {(problem) => (
              <text
                marginTop={props.wide ? 0 : 1}
                fg={theme.text.feedback.error.base}
                onMouseUp={() => (problem().auth ? void todos.promptKey() : void todos.refresh())}
              >
                {problem().text}
              </text>
            )}
          </Show>
        </Show>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "local.linear-pins.tui",
  setup(ctx) {
    const todos = createTodos(ctx)

    const sidebar = () => <TodoList ctx={ctx} todos={todos} />
    const removeSidebar = ctx.ui.slot(
      ctx.options.position === "top" ? { prepend: "sidebar.content", render: sidebar } : { append: "sidebar.content", render: sidebar },
    )

    const removeHome = ctx.ui.slot({
      before: "home.footer",
      render: () => (
        <box flexDirection="row" justifyContent="center" flexShrink={0} paddingBottom={1}>
          <box width={90} maxWidth="90%">
            <TodoList ctx={ctx} todos={todos} wide />
          </box>
        </box>
      ),
    })

    const removeCommands = ctx.ui.slot({
      append: "app",
      render: () => {
        ctx.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "local.linear-pins.pin",
              title: "Pin a Linear issue",
              description: "Pin a Linear issue to your TODOs by its ID or URL",
              group: "Linear",
              slash: { name: "pin-linear-todo" },
              run: () => void todos.promptPin(),
            },
            {
              id: "local.linear-pins.refresh",
              title: "Refresh Linear TODOs",
              group: "Linear",
              palette: true,
              run: () => void todos.refresh(),
            },
            {
              id: "local.linear-pins.key",
              title: "Set Linear API key",
              group: "Linear",
              palette: true,
              run: () => void todos.promptKey(),
            },
          ],
        }))
        return null
      },
    })

    return () => {
      todos.dispose()
      removeSidebar()
      removeHome()
      removeCommands()
    }
  },
})
