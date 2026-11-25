import { rowId } from "@finance-manager/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { UndoConflict } from "../ledger/audit.js";

export type ToolServer = McpServer;
type Mode = "read" | "write" | "destructive";

export function registerTool<
  Input extends z.ZodRawShape,
  Output extends z.ZodRawShape,
>(
  server: ToolServer,
  name: string,
  description: string,
  inputSchema: z.ZodObject<Input>,
  outputSchema: z.ZodObject<Output>,
  mode: Mode,
  run: (
    input: z.output<z.ZodObject<Input>>,
  ) =>
    | [z.input<z.ZodObject<Output>>, string]
    | Promise<[z.input<z.ZodObject<Output>>, string]>,
) {
  server.registerTool<z.ZodObject<Output>, z.ZodObject<Input>>(
    name,
    {
      description,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: mode === "read",
        destructiveHint: mode === "destructive",
        idempotentHint: mode === "read",
        openWorldHint: false,
      },
    },
    async (input): Promise<CallToolResult> => {
      try {
        const [data, text] = await run(input);
        const json = JSON.stringify(data);
        return {
          structuredContent: data,
          content: [
            { type: "text", text: text === json ? text : `${text}\n\n${json}` },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error &&
          (error.constructor === Error || error instanceof UndoConflict) &&
          !("code" in error) &&
          !("sql" in error)
            ? error.message
            : "No se pudo completar la operación.";
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );
}

export const money = z.object({
  monto: z.string(),
  moneda: z.string(),
  texto: z.string(),
});

export { decimalMoney as amount } from "@finance-manager/core";

export const pageInput = {
  limite: z.number().int().min(1).max(200).prefault(50),
};

export const idPageInput = {
  ...pageInput,
  cursor: rowId.optional(),
};

export function paginate<T>(
  rows: T[],
  limit: number,
  cursorOf: (item: T) => string,
) {
  return {
    rows: rows.slice(0, limit),
    cursor: rows.length > limit ? cursorOf(rows[limit - 1]) : null,
  };
}
