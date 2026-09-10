export default {
  execute(operation, context) {
    if (operation !== "example.create-card") throw new Error(`Unsupported operation: ${operation}`);
    const id = typeof context.input.id === "string" ? context.input.id : "example-card";
    const label = typeof context.input.label === "string" ? context.input.label : "Example card";
    return {
      expectedRevision: context.snapshot.revision,
      label: "Create example card",
      mutations: [{
        op: "upsert_object",
        object: { id, kind: "example.card", label, data: { source: "external-fixture" } },
      }],
    };
  },
};
