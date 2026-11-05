const ENDPOINT = "https://api.linear.app/graphql"

export const CLOSED_STATE_TYPES = ["completed", "canceled", "duplicate"] as const

export type Issue = {
  id: string
  identifier: string
  title: string
  url: string
  state: { name: string; type: string; color: string }
  team: { id: string; key: string }
  assignee?: { id: string; name: string } | null
  archivedAt?: string | null
  trashed?: boolean | null
}

export class LinearError extends Error {
  constructor(
    message: string,
    readonly kind: "auth" | "not_found" | "network" | "api",
  ) {
    super(message)
  }
}

const ISSUE_FIELDS = `
  id identifier title url archivedAt trashed
  state { name type color }
  team { id key }
  assignee { id name }
`

const OPEN = `{ state: { type: { nin: ${JSON.stringify(CLOSED_STATE_TYPES)} } } }`

export function createLinear(apiKey: string, fetcher: typeof fetch = fetch) {
  const request = async <T>(query: string, variables: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> => {
    let response: Response
    try {
      response = await fetcher(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: apiKey },
        body: JSON.stringify({ query, variables }),
        signal,
      })
    } catch (cause) {
      if (signal?.aborted) throw cause
      throw new LinearError(`Couldn't reach Linear: ${cause instanceof Error ? cause.message : String(cause)}`, "network")
    }
    const body = (await response.json().catch(() => undefined)) as
      | { data?: T; errors?: { message: string; extensions?: { code?: string; type?: string } }[] }
      | undefined
    const error = body?.errors?.[0]
    if (response.status === 401 || error?.extensions?.code === "AUTHENTICATION_ERROR" || error?.extensions?.type === "authentication error") {
      throw new LinearError("Linear rejected the API key", "auth")
    }
    if (error) {
      throw new LinearError(error.message, error.message.startsWith("Entity not found") ? "not_found" : "api")
    }
    if (!response.ok || !body?.data) throw new LinearError(`Linear returned HTTP ${response.status}`, "api")
    return body.data
  }

  return {
    async viewer(signal?: AbortSignal) {
      const data = await request<{ viewer: { id: string; name: string } }>(`query { viewer { id name } }`, {}, signal)
      return data.viewer
    },

    /** Open issues assigned to the viewer, most recently updated first. */
    async mine(signal?: AbortSignal) {
      const data = await request<{ viewer: { assignedIssues: { nodes: Issue[] } } }>(
        `query { viewer { assignedIssues(first: 30, orderBy: updatedAt, filter: ${OPEN}) { nodes { ${ISSUE_FIELDS} } } } }`,
        {},
        signal,
      )
      return data.viewer.assignedIssues.nodes
    },

    /** Open issues across the workspace that match the text or identifier. */
    async search(term: string, signal?: AbortSignal) {
      const data = await request<{ searchIssues: { nodes: Issue[] } }>(
        `query ($term: String!) { searchIssues(term: $term, first: 30, filter: ${OPEN}) { nodes { ${ISSUE_FIELDS} } } }`,
        { term },
        signal,
      )
      return data.searchIssues.nodes
    },

    /** The current state of each issue, keyed by ID. Issues that no longer exist map to null. */
    async lookup(ids: readonly string[], signal?: AbortSignal) {
      const result = new Map<string, Issue | null>()
      if (ids.length === 0) return result
      const data = await request<{ issues: { nodes: Issue[] } }>(
        `query ($ids: [ID!]) { issues(first: 50, includeArchived: true, filter: { id: { in: $ids } }) { nodes { ${ISSUE_FIELDS} } } }`,
        { ids },
        signal,
      )
      for (const issue of data.issues.nodes) result.set(issue.id, issue)
      // The list filter can leave out trashed issues, so ask for each missing one directly.
      for (const id of ids) {
        if (result.has(id)) continue
        try {
          const single = await request<{ issue: Issue }>(`query ($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`, { id }, signal)
          result.set(id, single.issue)
        } catch (error) {
          if (error instanceof LinearError && error.kind === "not_found") result.set(id, null)
          else throw error
        }
      }
      return result
    },

    /** Moves the issue to its team's first completed state and returns the updated issue. */
    async complete(id: string, signal?: AbortSignal) {
      const data = await request<{ issue: { team: { states: { nodes: { id: string; name: string; position: number }[] } } } }>(
        `query ($id: String!) { issue(id: $id) { team { states(filter: { type: { eq: "completed" } }) { nodes { id name position } } } } }`,
        { id },
        signal,
      )
      const state = data.issue.team.states.nodes.toSorted((a, b) => a.position - b.position)[0]
      if (!state) throw new LinearError("This issue's team has no completed state", "api")
      const updated = await request<{ issueUpdate: { success: boolean; issue: Issue } }>(
        `mutation ($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { ${ISSUE_FIELDS} } } }`,
        { id, stateId: state.id },
        signal,
      )
      if (!updated.issueUpdate.success) throw new LinearError("Linear didn't update the issue", "api")
      return updated.issueUpdate.issue
    },
  }
}

export type Linear = ReturnType<typeof createLinear>

/** Why a pinned issue should leave the list, or undefined while it's still open. */
export function closedReason(issue: Issue | null): string | undefined {
  if (issue === null) return "deleted"
  if (issue.trashed) return "deleted"
  if (issue.archivedAt) return "archived"
  if ((CLOSED_STATE_TYPES as readonly string[]).includes(issue.state.type)) return issue.state.name
  return undefined
}
