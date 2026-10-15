/**
 * @file src/portable/errors.ts
 * @description The typed failures of the portable path.
 *
 * A {@link PortableRefusal} is a known no-effect outcome carrying a code a
 * caller can act on, such as an unsafe ledger key or an unreadable ledger
 * record. A {@link PortableHostError} is a registration or host-configuration
 * problem the operator must fix.
 */

import type { RefusalCode } from "./contracts.js";

/** A known refusal: nothing was written, and the code says why. */
export class PortableRefusal extends Error {
  constructor(readonly code: RefusalCode, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "PortableRefusal";
  }
}

/** A registration or host-configuration problem the operator must fix. */
export class PortableHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortableHostError";
  }
}
