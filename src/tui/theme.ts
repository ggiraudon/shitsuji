export const theme = {
  colors: {
    background: '#1e1e1e',
    foreground: '#abb2bf',
    black: '#1e1e1e',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#abb2bf',
    brightBlack: '#5c6370',
    brightRed: '#e06c75',
    brightGreen: '#98c379',
    brightYellow: '#e5c07b',
    brightBlue: '#61afef',
    brightMagenta: '#c678dd',
    brightCyan: '#56b6c2',
    brightWhite: '#ffffff',
  },
  spacing: {
    xs: 1,
    sm: 2,
    md: 4,
    lg: 8,
    xl: 16,
  },
  border: {
    default: '#5c6370',
    focus: '#61afef',
  },
  font: {
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    italic: '\x1b[3m',
    underline: '\x1b[4m',
    reset: '\x1b[0m',
  },
};

export type Theme = typeof theme;
