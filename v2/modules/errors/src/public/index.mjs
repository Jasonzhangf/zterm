// Public boundary for the typed error contract. Keep this entry explicit:
// consumers may import the shared error shape, not the internal storage,
// redaction, or future sink/query ports.
export { TypedError, asTypedError } from "../typed-error.mjs";
