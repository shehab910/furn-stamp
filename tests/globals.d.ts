// What the app exposes to page.evaluate code in the tests.
import type { layout } from '../src/stamp';

declare global {
  interface Window { layout: typeof layout }
}
