/**
 * Listener-attached request metadata that does not fit the fixed
 * HttpRequest contract (context.ts is immutable): the raw Content-Type
 * header is needed by the multipart transcription parser, and the handler
 * layer must not import the listener (circular).
 *
 * http.ts attaches metadata at dispatch; handlers read it through the
 * accessor. Anything not attached stays undefined.
 */
import type { HttpRequest } from './context.js';

export interface RequestMeta {
  /** First Content-Type header value, verbatim. */
  contentType?: string;
}

const META = new WeakMap<HttpRequest, RequestMeta>();

export const attachRequestMeta = (req: HttpRequest, meta: RequestMeta): void => {
  META.set(req, meta);
};

export const requestMeta = (req: HttpRequest): RequestMeta =>
  META.get(req) ?? {};
