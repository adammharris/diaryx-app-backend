import { Elysia } from "elysia";

//#region src/index.d.ts
type DiaryxNote = {
  id: string;
  body: string;
  metadata: {
    visibility?: string | string[];
    visibility_emails?: Record<string, string[]>;
    [k: string]: unknown;
  };
  frontmatter?: string;
  sourceName?: string;
  autoUpdateTimestamp?: boolean;
  lastModified: number;
};
declare const _default: Elysia<"", {
  decorator: {};
  store: {};
  derive: {};
  resolve: {};
}, {
  typebox: {};
  error: {};
}, {
  schema: {};
  standaloneSchema: {};
  macro: {};
  macroFn: {};
  parser: {};
  response: {};
}, {
  get: {
    body: unknown;
    params: {};
    query: unknown;
    headers: unknown;
    response: {
      200: string;
    };
  };
} & {
  health: {
    get: {
      body: unknown;
      params: {};
      query: unknown;
      headers: unknown;
      response: {
        200: string;
      };
    };
  };
} & {
  api: {
    notes: {
      get: {
        body: unknown;
        params: {};
        query: unknown;
        headers: unknown;
        response: {
          200: {
            error: string;
          } | {
            notes: {
              id: string;
              markdown: string;
              sourceName: string | null;
              lastModified: number;
            }[];
            visibilityTerms: {
              term: string;
              emails: string[];
            }[];
          } | {
            error: {
              message: any;
            };
          };
        };
      };
    };
  };
} & {
  api: {
    notes: {
      post: {
        body: unknown;
        params: {};
        query: unknown;
        headers: unknown;
        response: {
          200: {
            error: string;
          } | {
            notes: {
              id: string;
              markdown: string;
              sourceName: string | null;
              lastModified: number;
            }[];
            visibilityTerms: {
              term: string;
              emails: string[];
            }[];
          } | {
            error: {
              message: any;
            };
          };
        };
      };
    };
  };
} & {
  api: {
    notes: {
      ":id": {
        delete: {
          body: unknown;
          params: {
            id: string;
          };
          query: unknown;
          headers: unknown;
          response: {
            200: {
              error: string;
            } | {
              status: string;
            } | {
              error: {
                message: any;
              };
            };
            422: {
              type: "validation";
              on: string;
              summary?: string;
              message?: string;
              found?: unknown;
              property?: string;
              expected?: string;
            };
          };
        };
      };
    };
  };
} & {
  api: {
    "shared-notes": {
      get: {
        body: unknown;
        params: {};
        query: unknown;
        headers: unknown;
        response: {
          200: {
            error: string;
          } | {
            notes: DiaryxNote[];
          } | {
            error: {
              message: any;
            };
          };
        };
      };
    };
  };
}, {
  derive: {};
  resolve: {};
  schema: {};
  standaloneSchema: {};
  response: {};
}, {
  derive: {};
  resolve: {};
  schema: {};
  standaloneSchema: {};
  response: {};
}>;
//#endregion
export { _default as default };