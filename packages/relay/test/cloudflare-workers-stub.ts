/**
 * The Workers runtime module, stubbed for the tests.
 *
 * `cloudflare:workers` only exists inside the Workers runtime, so the Durable
 * Object base class is replaced with a plain one. The relay's own logic does not
 * depend on anything the base class does: the tests drive the Worker and the
 * session directly.
 */
export class DurableObject<Env = unknown> {
  protected readonly ctx: unknown;
  protected readonly env: Env;

  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkerEntrypoint<Env = unknown> {
  protected readonly ctx: unknown;
  protected readonly env: Env;

  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
