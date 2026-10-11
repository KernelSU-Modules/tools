// Minimal fake of the Telegram Serverless `sdk` module (api proxy + fetch), recording calls.
export class BotApiError extends Error {
  constructor(method, code, description, parameters) {
    super(description);
    this.method = method;
    this.code = code;
    this.description = description;
    this.parameters = parameters;
  }
}

export const state = {
  /** Bot API calls: [{ method, params }] */
  apiCalls: [],
  /** method -> Error to throw */
  apiErrors: {},
  /** (url, init) => Promise<Response-like>; defaults to the real global fetch */
  fetch: (...args) => globalThis.fetch(...args),
  reset() {
    this.apiCalls = [];
    this.apiErrors = {};
    this.fetch = (...args) => globalThis.fetch(...args);
  },
};

export const api = new Proxy(
  {},
  {
    get: (_t, method) => async (params) => {
      state.apiCalls.push({ method: String(method), params });
      if (state.apiErrors[method]) throw state.apiErrors[method];
      return true;
    },
  },
);

export const fetch = (url, init) => state.fetch(url, init);
export const db = new Proxy({}, { get: () => () => { throw new Error('db not available in the harness'); } });
export class InputFile {}
export class EndpointError extends Error {}
