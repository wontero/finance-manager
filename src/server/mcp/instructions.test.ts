import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, test } from "vitest";
import { createMcp } from "./index.js";

test("M-016 S1: initialize returns the requested response instructions", async () => {
  const server = createMcp("test", undefined, undefined);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  expect(client.getInstructions()).toContain(
    "Responde breve y directo, en una o dos líneas, salvo que Mateo pida detalle.",
  );
  expect(client.getInstructions()).toContain(
    "Para totales, saldos o resúmenes, da solo el resultado final: no muestres cálculos, sumas intermedias ni el razonamiento, salvo que Mateo los pida. Tras registrar o deshacer algo, confirma en una línea con el monto y el ID de la operación.",
  );

  await client.close();
});
