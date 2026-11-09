/** Throw this from a route to send a 404 with a clean message. */
export const notFound = (what: string) => Object.assign(new Error(`${what} not found`), { statusCode: 404 });