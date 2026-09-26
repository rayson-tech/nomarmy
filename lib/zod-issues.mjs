// Zod 4 helpers shared by nomArmy's config schemas and their issue formatters.

/**
 * The `error` option for a primitive schema: "is required" when the field is
 * absent, "must be <expected>" when it has the wrong type. Zod 4 replaced
 * zod 3's required_error and invalid_type_error with this single function.
 * @param {string} expected e.g. "a string"
 */
export const typeError = (expected) => (issue) => (issue.input === undefined ? "is required" : `must be ${expected}`);

/** A field that is absent entirely, with no custom message of its own. */
export const isMissingField = (issue) => issue.code === "invalid_type" && / received undefined$/.test(issue.message);

/** A discriminated union whose discriminator matched none of its options. */
export const isUnknownDiscriminator = (issue) => issue.code === "invalid_union" && issue.note === "No matching discriminator";
