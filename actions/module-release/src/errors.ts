import type { Issue } from './validator-api.ts';

/** An expected failure: printed as a plain error annotation (no stack trace). */
export class ActionFailed extends Error {
  constructor(
    message: string,
    readonly issues: Issue[] = [],
  ) {
    super(message);
    this.name = 'ActionFailed';
  }
}
