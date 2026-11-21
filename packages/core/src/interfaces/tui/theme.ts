/** The TUI's palette and spacing: one dark theme, so the terminal UI looks the same everywhere. */
export const theme = {
  /** ANSI colour names, as the Ink components use them. */
  colors: {
    /** The terminal background; also the `black` slot. */
    background: '#1e1e1e',
    /** Default text. */
    foreground: '#abb2bf',
    /** `black` in Ink's palette. */
    black: '#1e1e1e',
    /** Errors and failures. */
    red: '#e06c75',
    /** Success and the assistant's text accents. */
    green: '#98c379',
    /** Warnings and approval cards. */
    yellow: '#e5c07b',
    /** Links and focus. */
    blue: '#61afef',
    /** Tool names and notes. */
    magenta: '#c678dd',
    /** Timestamps and ids. */
    cyan: '#56b6c2',
    /** Default text, matching `foreground`. */
    white: '#abb2bf',
    /** Muted text: hints and placeholders. */
    brightBlack: '#5c6370',
    /** Bright red, for emphasis on an error. */
    brightRed: '#e06c75',
    /** Bright green. */
    brightGreen: '#98c379',
    /** Bright yellow. */
    brightYellow: '#e5c07b',
    /** Bright blue. */
    brightBlue: '#61afef',
    /** Bright magenta. */
    brightMagenta: '#c678dd',
    /** Bright cyan. */
    brightCyan: '#56b6c2',
    /** Pure white, for the strongest emphasis. */
    brightWhite: '#ffffff',
  },
  /** Column counts for gaps between blocks. */
  spacing: {
    /** One column. */
    xs: 1,
    /** Two columns. */
    sm: 2,
    /** Four columns, the usual gap. */
    md: 4,
    /** Eight columns. */
    lg: 8,
    /** Sixteen columns, around a page section. */
    xl: 16,
  },
  /** Border colours for boxes and inputs. */
  border: {
    /** An unfocused box. */
    default: '#5c6370',
    /** The box that has focus. */
    focus: '#61afef',
  },
  /** ANSI escape codes for text styles Ink cannot express with a prop. */
  font: {
    /** Bold. */
    bold: '\x1b[1m',
    /** Dimmed. */
    dim: '\x1b[2m',
    /** Italic. */
    italic: '\x1b[3m',
    /** Underlined. */
    underline: '\x1b[4m',
    /** Resets every style above. */
    reset: '\x1b[0m',
  },
};

/** The shape of the theme, for components that take one as a prop. */
export type Theme = typeof theme;
