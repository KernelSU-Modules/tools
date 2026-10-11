const FAKE_SDK = new URL('./fake-sdk.mjs', import.meta.url).href;
const FAKE_ENV = new URL('./fake-env.mjs', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === 'sdk' || specifier.startsWith('sdk/')) return { url: FAKE_SDK, shortCircuit: true };
  if (specifier.endsWith('/lib/env.js') && context.parentURL && context.parentURL.includes('/tgcloud/handlers/'))
    return { url: FAKE_ENV, shortCircuit: true };
  return next(specifier, context);
}
