// Per-invocation subrequest accounting (Workers Free: 50 subrequests per invocation, every fetch counts).
// The cron Worker routes all fetches through one of these and checks `remaining()` before each unit of work,
// so retries or a large backlog end the run early instead of failing mid-commit; the next run continues.

export class SubrequestBudgetExceeded extends Error {
  constructor(limit: number) {
    super(`subrequest budget of ${limit} exhausted`);
    this.name = 'SubrequestBudgetExceeded';
  }
}

export class SubrequestBudget {
  used = 0;
  constructor(
    readonly limit: number,
    private readonly inner: typeof fetch = (i, init) => fetch(i, init),
  ) {}

  remaining(): number {
    return this.limit - this.used;
  }

  /** Counting fetch; throws (without sending) once the limit is reached. */
  readonly fetch: typeof fetch = (input, init) => {
    if (this.used >= this.limit) return Promise.reject(new SubrequestBudgetExceeded(this.limit));
    this.used++;
    return this.inner(input, init);
  };
}
