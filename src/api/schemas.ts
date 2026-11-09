// Provider's match status codes
export const MATCH_STATUS = { live: 3, upcoming: 1, completed: 2, cancelled: 4 } as const;
export type MatchStatusName = keyof typeof MATCH_STATUS;

export const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "integer", minimum: 1 } },
} as const;

export const byQuery = {
  by: {
    type: "string",
    enum: ["id", "provider"],
    default: "id",
    description: "Use provider to look up by the provider's id (the ids used in Firebase live data)",
  },
} as const;

export const pageQuery = {
  limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
  offset: { type: "integer", minimum: 0, default: 0 },
} as const;