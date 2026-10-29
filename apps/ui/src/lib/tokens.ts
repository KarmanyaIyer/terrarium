/** Rough token estimate for text the server hasn't counted yet (~3.8 chars per token for English and code). */
export const tokensOf = (s: string) => Math.max(1, Math.ceil(s.length / 3.8));
