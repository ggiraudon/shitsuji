import { injection } from './injection.js';
import { desktopCalcScreens, desktopCalcStructure } from './desktopCalc.js';
import { notifyAllowed } from './notifyAllowed.js';
import { notifyAsks } from './notifyAsks.js';
import { plainAnswer } from './plainAnswer.js';
import { workspaceFile } from './workspaceFile.js';
import { workspaceSend } from './workspaceSend.js';
import type { Scenario } from '../types.js';

/** Every scenario that runs by default (S38). */
export const scenarios: readonly Scenario[] = [
  plainAnswer,
  workspaceFile,
  workspaceSend,
  notifyAllowed,
  notifyAsks,
  injection,
  desktopCalcStructure,
  desktopCalcScreens,
];
