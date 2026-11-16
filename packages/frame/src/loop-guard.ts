/**
 * Transpile-time protection against runaway loops. Many browsers run an
 * opaque-origin iframe on the embedding page's thread, so a `while (true)` in
 * generated code would freeze the host before any watchdog timer could fire.
 * Every synchronous loop gets a time check that throws once the loop has run
 * longer than the limit. Loops that await or yield are left alone: they do
 * not block the thread, and wall-clock time would include their pauses.
 */

export type RenderifyLoopGuardLanguage = "js" | "jsx" | "ts" | "tsx";

export interface BabelLike {
  transform(
    code: string,
    options: Record<string, unknown>,
  ): { code?: string | null } | null;
}

interface NodeLike {
  type: string;
  await?: boolean;
  loc?: { start: { line: number } } | null;
}

interface PathLike {
  node: NodeLike;
  scope: { generateUidIdentifier(name: string): unknown };
  get(key: string): PathLike;
  isBlockStatement(): boolean;
  replaceWith(node: unknown): void;
  insertBefore(node: unknown): void;
  unshiftContainer(key: string, node: unknown): void;
  traverse(visitor: Record<string, (path: PathLike) => void>): void;
  skip(): void;
}

interface BabelTypesLike {
  variableDeclaration(kind: string, declarations: unknown[]): unknown;
  variableDeclarator(id: unknown, init: unknown): unknown;
  callExpression(callee: unknown, args: unknown[]): unknown;
  memberExpression(object: unknown, property: unknown): unknown;
  identifier(name: string): unknown;
  ifStatement(test: unknown, consequent: unknown): unknown;
  binaryExpression(operator: string, left: unknown, right: unknown): unknown;
  numericLiteral(value: number): unknown;
  throwStatement(argument: unknown): unknown;
  newExpression(callee: unknown, args: unknown[]): unknown;
  stringLiteral(value: string): unknown;
  blockStatement(body: unknown[]): unknown;
}

export const DEFAULT_LOOP_TIMEOUT_MS = 1_500;

export function createLoopGuardPlugin(limitMs: number) {
  const guarded = new WeakSet<object>();
  return ({ types: t }: { types: BabelTypesLike }) => {
    const now = () =>
      t.callExpression(
        t.memberExpression(t.identifier("Date"), t.identifier("now")),
        [],
      );
    return {
      name: "renderify-loop-guard",
      visitor: {
        Loop(path: PathLike) {
          if (guarded.has(path.node) || path.node.await) {
            return;
          }
          guarded.add(path.node);

          let pauses = false;
          path.traverse({
            Function(inner) {
              inner.skip();
            },
            AwaitExpression() {
              pauses = true;
            },
            YieldExpression() {
              pauses = true;
            },
          });
          if (pauses) {
            return;
          }

          const line = path.node.loc?.start.line;
          const start = path.scope.generateUidIdentifier("renderifyLoopStart");
          const check = t.ifStatement(
            t.binaryExpression(
              ">",
              t.binaryExpression("-", now(), start),
              t.numericLiteral(limitMs),
            ),
            t.throwStatement(
              t.newExpression(t.identifier("Error"), [
                t.stringLiteral(
                  `Renderify stopped a loop that ran longer than ${limitMs} ms${
                    line ? ` (line ${line})` : ""
                  }.`,
                ),
              ]),
            ),
          );

          const body = path.get("body");
          if (!body.isBlockStatement()) {
            body.replaceWith(t.blockStatement([body.node]));
          }
          path.get("body").unshiftContainer("body", check);
          path.insertBefore(
            t.variableDeclaration("let", [t.variableDeclarator(start, now())]),
          );
        },
      },
    };
  };
}

/** Adds loop guards to source code, keeping JSX and TypeScript syntax intact. */
export function guardSourceLoops(
  babel: BabelLike,
  code: string,
  options: { language?: RenderifyLoopGuardLanguage; limitMs?: number } = {},
): string {
  const limitMs = options.limitMs ?? DEFAULT_LOOP_TIMEOUT_MS;
  if (limitMs <= 0) {
    return code;
  }
  const language = options.language ?? "jsx";
  const parserPlugins =
    language === "tsx"
      ? ["jsx", "typescript"]
      : language === "ts"
        ? ["typescript"]
        : ["jsx"];
  const result = babel.transform(code, {
    babelrc: false,
    configFile: false,
    sourceType: "module",
    retainLines: true,
    parserOpts: { plugins: parserPlugins },
    plugins: [createLoopGuardPlugin(limitMs)],
  });
  if (!result?.code) {
    throw new Error("Loop guard transform produced no output");
  }
  return result.code;
}
