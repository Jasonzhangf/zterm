import type {
  CreateCommentRequest,
  CreateTaskRequest,
  GetTaskRequest,
  ListCommentsRequest,
  ListTasksRequest,
  UpdateTaskRequest,
  VikunjaClientPort,
  VikunjaComment,
  VikunjaResult,
  VikunjaTask,
  VikunjaTaskPage,
} from '../../ports/vikunja-client.ts'

export interface VikunjaV2AdapterOptions {
  fetchImpl?: typeof fetch
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeComments(value: unknown): VikunjaComment[] {
  if (Array.isArray(value)) return value as VikunjaComment[]
  if (isObject(value) && Array.isArray(value.comments)) return value.comments as VikunjaComment[]
  if (isObject(value) && Array.isArray(value.items)) return value.items as VikunjaComment[]
  return []
}

/**
 * Vikunja v2.7.1 /api/v2 client. It only maps transport and status; the service
 * owns the business meaning of each status and the unknown/failed distinction.
 */
export class VikunjaV2Adapter implements VikunjaClientPort {
  readonly #fetchImpl: typeof fetch

  constructor(options: VikunjaV2AdapterOptions = {}) {
    this.#fetchImpl = options.fetchImpl ?? fetch
  }

  async createTask(input: CreateTaskRequest): Promise<VikunjaResult<VikunjaTask>> {
    return this.#request<VikunjaTask>('POST', `/projects/${input.projectId}/tasks`, input, {
      title: input.title,
      description: input.description,
      priority: input.priority,
    })
  }

  async getTask(input: GetTaskRequest): Promise<VikunjaResult<VikunjaTask>> {
    return this.#request<VikunjaTask>('GET', `/tasks/${input.taskId}`, input)
  }

  async updateTask(input: UpdateTaskRequest): Promise<VikunjaResult<VikunjaTask>> {
    return this.#request<VikunjaTask>('PATCH', `/tasks/${input.taskId}`, input, input.patch)
  }

  async createComment(input: CreateCommentRequest): Promise<VikunjaResult<VikunjaComment>> {
    return this.#request<VikunjaComment>('POST', `/tasks/${input.taskId}/comments`, input, {
      comment: input.comment,
    })
  }

  async listComments(input: ListCommentsRequest): Promise<VikunjaResult<VikunjaComment[]>> {
    const result = await this.#request<unknown>('GET', `/tasks/${input.taskId}/comments`, input)
    if (result.kind === 'transport-error') return result
    return { kind: 'ok', status: result.status, value: normalizeComments(result.value) }
  }

  async listTasks(input: ListTasksRequest): Promise<VikunjaResult<VikunjaTaskPage>> {
    const query = new URLSearchParams()
    if (input.filter) query.set('filter', input.filter)
    if (input.sortBy) query.set('sort_by', input.sortBy)
    if (input.orderBy) query.set('order_by', input.orderBy)
    if (input.perPage) query.set('per_page', String(input.perPage))
    if (input.page) query.set('page', String(input.page))
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    const result = await this.#request<unknown>('GET', `/tasks${suffix}`, input)
    if (result.kind === 'transport-error') return result
    const value = Array.isArray(result.value)
      ? { items: result.value as VikunjaTask[] }
      : isObject(result.value)
        ? { total: typeof result.value.total === 'number' ? result.value.total : undefined, items: Array.isArray(result.value.items) ? (result.value.items as VikunjaTask[]) : [] }
        : { items: [] }
    return { kind: 'ok', status: result.status, value }
  }

  async #request<T>(
    method: string,
    path: string,
    request: { baseUrl: string; token: string },
    body?: unknown,
  ): Promise<VikunjaResult<T>> {
    try {
      const response = await this.#fetchImpl(`${request.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${request.token}`,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (response.status >= 200 && response.status < 300) {
        const text = await response.text()
        const value = text.length > 0 ? (JSON.parse(text) as T) : null
        return { kind: 'ok', status: response.status, value }
      }
      return { kind: 'ok', status: response.status, value: null }
    } catch (cause) {
      return { kind: 'transport-error', cause }
    }
  }
}
