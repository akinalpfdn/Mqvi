/**
 * Starts client error reporting. main.tsx imports this first: modules run in import order, so the
 * reporter is listening before any other module of the app has run, and errors thrown while
 * they load are reported too.
 */

import { installErrorReporting } from "./utils/errorReporter";

export const errorReporting = installErrorReporting();
