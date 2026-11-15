/**
 * One text file the application reads and writes, such as the SOUL.md export. The application never
 * touches the file system itself; the adapter decides where the file lives.
 */
export interface TextFile {
  /** Where the file is, for messages to the owner. */
  readonly path: string;
  /** The file's text, or undefined when it does not exist. */
  read(): Promise<string | undefined>;
  /** Replaces the file's text, creating its folder when needed. */
  write(text: string): Promise<void>;
}
