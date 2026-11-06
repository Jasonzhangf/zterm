export interface VikunjaTask {
  id: number
  project_id: number
  title: string
  description?: string
  priority: number
  done: boolean
  done_at: string
}

export interface VikunjaComment {
  id: number
  comment: string
  created: string
  author?: { id: number; username?: string }
}

export interface VikunjaTaskPage {
  total?: number
  items: VikunjaTask[]
}

export interface VikunjaRequest {
  baseUrl: string
  token: string
}

export interface CreateTaskRequest extends VikunjaRequest {
  projectId: number
  title: string
  description?: string
  priority: number
}

export interface GetTaskRequest extends VikunjaRequest {
  taskId: number
}

export interface UpdateTaskRequest extends VikunjaRequest {
  taskId: number
  patch: { done?: boolean }
}

export interface CreateCommentRequest extends VikunjaRequest {
  taskId: number
  comment: string
}

export interface ListCommentsRequest extends VikunjaRequest {
  taskId: number
}

export interface ListTasksRequest extends VikunjaRequest {
  filter?: string
  sortBy?: string
  orderBy?: string
  perPage?: number
  page?: number
}

/**
 * A provider call either returns an HTTP status with a parsed body, or reports a
 * transport failure. Transport failure (timeout, refused connection, unparsable
 * body) is not the same as a provider rejection and must not be mapped to a
 * "failed" write.
 */
export type VikunjaResult<T> =
  | { kind: 'ok'; status: number; value: T | null }
  | { kind: 'transport-error'; cause: unknown }

export interface VikunjaClientPort {
  createTask(input: CreateTaskRequest): Promise<VikunjaResult<VikunjaTask>>
  getTask(input: GetTaskRequest): Promise<VikunjaResult<VikunjaTask>>
  updateTask(input: UpdateTaskRequest): Promise<VikunjaResult<VikunjaTask>>
  createComment(input: CreateCommentRequest): Promise<VikunjaResult<VikunjaComment>>
  listComments(input: ListCommentsRequest): Promise<VikunjaResult<VikunjaComment[]>>
  listTasks(input: ListTasksRequest): Promise<VikunjaResult<VikunjaTaskPage>>
}
