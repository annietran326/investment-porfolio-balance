// Minimal ambient types for papaparse — it ships no bundled types and
// @types/papaparse would be a new dependency. Only the surface
// transactions.mjs actually uses is declared.
declare module "papaparse" {
  export interface ParseError {
    type: string;
    code: string;
    message: string;
    row?: number;
  }
  export interface ParseMeta {
    delimiter: string;
    linebreak: string;
    aborted: boolean;
    truncated: boolean;
    fields?: string[];
  }
  export interface ParseResult<T> {
    data: T[];
    errors: ParseError[];
    meta: ParseMeta;
  }
  export interface ParseConfig {
    header?: boolean;
    skipEmptyLines?: boolean | "greedy";
    dynamicTyping?: boolean;
    delimiter?: string;
  }
  export function parse<T = Record<string, string>>(input: string, config?: ParseConfig): ParseResult<T>;
  const Papa: { parse: typeof parse };
  export default Papa;
}
