/**
 * Where a file from the sandbox is put so a channel on `core`'s side can send it (F08, S41). The
 * sandbox may be a container `core` cannot read, so the bytes come through the sandbox port and are
 * written here, on `core`'s own disk (`workspace.send` calls it before a reply is delivered).
 */
export interface OutboundFiles {
  /** Writes the bytes under `name` and returns the absolute path the channel adapter reads. */
  stage(name: string, bytes: Uint8Array): Promise<string>;
}
