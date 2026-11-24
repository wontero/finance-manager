if (process.versions.node.split(".")[0] !== "22") {
  console.error(
    `FinanceManager requiere Node.js 22. Versión actual: ${process.version}.`,
  );
  process.exitCode = 1;
}
