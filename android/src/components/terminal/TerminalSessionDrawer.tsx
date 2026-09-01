// Public drawer entrypoint. The implementation lives in a separate module so
// the route-facing component remains a small, stable import boundary.
export {
  TerminalSessionDrawer,
} from './TerminalSessionDrawerContent';
export type {
  TerminalSessionDrawerHost,
  TerminalSessionDrawerItem,
  TerminalSessionDrawerProps,
  TerminalSessionGroupLayoutAxis,
  TerminalSessionGroupSlotName,
} from './TerminalSessionDrawerContent';
