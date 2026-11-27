import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, test } from "vitest";
import { createMcp } from "./index.js";

test("M-016 S1: initialize returns the requested response instructions", async () => {
  const server = createMcp("test", undefined, undefined, "1");
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  expect(client.getInstructions()).toContain(
    "Tono estricto: responde solo con el dato o la confirmación, en una línea, sin saludos, introducciones, resúmenes finales, ofertas de ayuda ni preguntas de seguimiento.",
  );
  expect(client.getInstructions()).toContain(
    "Explica solo si la pregunta pide una explicación (por qué, cómo, qué significa, qué puedo hacer); aun así, hazlo en el mínimo de líneas posible.",
  );
  expect(client.getInstructions()).not.toContain(
    "en una o dos líneas, salvo que el usuario pida detalle",
  );
  expect(client.getInstructions()).toContain(
    "Para totales, saldos o resúmenes, da solo el resultado final: no muestres cálculos, sumas intermedias ni el razonamiento, salvo que el usuario los pida. Tras registrar o deshacer algo, confirma en una línea con el monto y el ID de la operación.",
  );
  expect(client.getInstructions()).not.toContain("Mateo");
  expect(client.getInstructions()).toMatch(
    /cómo voy.*ver_metas.*una línea por meta/i,
  );

  expect(client.getInstructions()).toMatch(
    /no tiene movimientos.*saluda.*qué puede hacer.*primeros_pasos.*capturas.*preguntar.*no la repit/i,
  );

  await client.close();
});
