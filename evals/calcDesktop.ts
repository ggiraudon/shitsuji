import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  DesktopA11yActRequest,
  DesktopA11yActResult,
  DesktopA11yFindQuery,
  DesktopA11yStatus,
  DesktopA11yTree,
  DesktopA11yTreeQuery,
  DesktopAction,
  DesktopCapability,
  DesktopImage,
  DesktopOcrResult,
  DesktopRect,
  DesktopState,
  DesktopWindow,
} from '../packages/core/src/ports/SandboxDriver.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

/**
 * A tiny LibreOffice Calc for the offline eval (S56): enough tree, cells and a Save action to run
 * the same two tool paths as the real desktop without Docker. It writes `calc.csv` in the workspace
 * on Save, so the scenario's `workspace.exec` read is real.
 */
export class CalcDesktop implements DesktopCapability {
  readonly accessibility = true;
  readonly screenshots = true;
  private readonly cells = { A1: '', B1: '' };
  private focus: 'A1' | 'B1' = 'A1';
  private open = false;

  constructor(private readonly workspaceDir: string) {}

  async state(): Promise<DesktopState> {
    return { display: ':0', width: 1440, height: 900 };
  }

  async screenshot(): Promise<DesktopImage> {
    return {
      mediaType: 'image/png',
      data: new Uint8Array(PNG),
      width: 1,
      height: 1,
      originalWidth: 1440,
      originalHeight: 900,
      scale: 1,
    };
  }

  async windows(): Promise<DesktopWindow[]> {
    return this.open
      ? [
          {
            id: '0x1',
            title: 'calc.csv - LibreOffice Calc',
            x: 0,
            y: 0,
            width: 1440,
            height: 900,
            desktop: 0,
          },
        ]
      : [];
  }

  async act(action: DesktopAction): Promise<void> {
    switch (action.kind) {
      case 'launch_app':
        this.open = true;
        return;
      case 'click':
      case 'double_click':
      case 'right_click':
        if (action.y < 60) await this.save();
        else this.focus = action.x < 300 ? 'A1' : 'B1';
        return;
      case 'type':
        this.cells[this.focus] += action.text;
        return;
      case 'key':
        if (action.key === 'Tab') this.focus = this.focus === 'A1' ? 'B1' : 'A1';
        if (action.key === 'ctrl+s') await this.save();
        return;
      case 'move':
      case 'drag':
      case 'scroll':
        return;
    }
  }

  async ocr(opts: { region?: DesktopRect } = {}): Promise<DesktopOcrResult> {
    void opts;
    return { text: `A1 ${this.cells.A1} B1 ${this.cells.B1}` };
  }

  async readClipboard(): Promise<string> {
    return '';
  }

  async writeClipboard(): Promise<void> {
    return;
  }

  async inspect(_request: DesktopA11yTreeQuery): Promise<DesktopA11yTree> {
    return this.tree();
  }

  async find(_request: DesktopA11yFindQuery): Promise<DesktopA11yTree> {
    return this.tree();
  }

  async actOnElement(request: DesktopA11yActRequest): Promise<DesktopA11yActResult> {
    if (request.action === 'set_text') {
      if (request.ref === 'e3') this.cells.A1 = request.text ?? '';
      else if (request.ref === 'e4') this.cells.B1 = request.text ?? '';
      else throw new Error('That cell is not editable.');
    } else if (request.ref === 'e5') {
      await this.save();
    } else if (request.ref === 'e3' || request.ref === 'e4') {
      this.focus = request.ref === 'e3' ? 'A1' : 'B1';
    } else {
      throw new Error('The element has no click action.');
    }
    return {
      action: request.action,
      role: request.ref === 'e5' ? 'push button' : 'table cell',
      name: request.ref === 'e5' ? 'Save' : request.ref === 'e3' ? 'A1' : 'B1',
      window: 'calc.csv - LibreOffice Calc',
      app: 'libreoffice',
    };
  }

  async accessibilityStatus(): Promise<DesktopA11yStatus> {
    return {
      helper: true,
      apps: [{ app: 'libreoffice', tree: true, nodes: 5 }],
      missing: [],
    };
  }

  private tree(): DesktopA11yTree {
    return {
      app: 'libreoffice',
      window: 'calc.csv - LibreOffice Calc',
      snapshot: 's1',
      nodes: [
        {
          ref: 'e1',
          depth: 0,
          role: 'frame',
          name: 'calc.csv - LibreOffice Calc',
          states: [],
          actions: [],
        },
        { ref: 'e2', depth: 1, role: 'table', name: 'Sheet1', states: [], actions: [] },
        {
          ref: 'e3',
          depth: 2,
          role: 'table cell',
          name: 'A1',
          value: this.cells.A1,
          states: [],
          actions: ['click'],
        },
        {
          ref: 'e4',
          depth: 2,
          role: 'table cell',
          name: 'B1',
          value: this.cells.B1,
          states: [],
          actions: ['click'],
        },
        {
          ref: 'e5',
          depth: 1,
          role: 'push button',
          name: 'Save',
          states: [],
          actions: ['click'],
        },
      ],
      total: 5,
      truncated: false,
    };
  }

  private async save(): Promise<void> {
    if (!this.open) this.open = true;
    await fs.mkdir(this.workspaceDir, { recursive: true });
    await fs.writeFile(
      path.join(this.workspaceDir, 'calc.csv'),
      `A1,B1\n${this.cells.A1},${this.cells.B1}\n`,
    );
  }
}
