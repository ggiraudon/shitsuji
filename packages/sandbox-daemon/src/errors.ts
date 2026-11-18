import type { SandboxErrorCode } from '@shitsuji/sandbox-protocol';

/** An error that becomes a JSON reply: a status, a protocol code and a message safe to show. */
export class SandboxHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: SandboxErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SandboxHttpError';
  }
}

export const invalidRequest = (message: string) =>
  new SandboxHttpError(400, 'invalid_request', message);
export const unauthorized = () =>
  new SandboxHttpError(401, 'unauthorized', 'The sandbox token is missing or wrong.');
export const notFound = (what: string) => new SandboxHttpError(404, 'not_found', what);
export const outsideRoot = (path: string) =>
  new SandboxHttpError(
    403,
    'outside_root',
    `"${path}" is outside the sandbox's folders, or leads outside through a link.`,
  );
export const readOnly = (root: string) =>
  new SandboxHttpError(403, 'read_only', `The ${root} folder is read-only in this sandbox.`);
export const alreadyExists = (path: string) =>
  new SandboxHttpError(409, 'already_exists', `"${path}" already exists.`);
export const tooLarge = (limit: number) =>
  new SandboxHttpError(413, 'too_large', `The request is over the ${limit} byte limit.`);
