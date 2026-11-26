import {
  AliasNode,
  IdentifierNode,
  JoinNode,
  OperationNodeTransformer,
  ParensNode,
  TableNode,
  WhereNode,
  sql,
  type KyselyPlugin,
  type OperationNode,
  type SelectQueryNode,
} from "kysely";

const ownedTables = new Set([
  "accounts",
  "operations",
  "loans",
  "transactions",
  "postings",
  "tags",
  "transaction_tags",
  "custom_field_definitions",
  "exchange_rates",
  "audit_log",
]);

// Los SELECT del ledger se acotan incluso en subconsultas y uniones.
// El SQL escrito a mano debe indicar la propiedad de las filas explícitamente.
export function userScope(userId: string): KyselyPlugin {
  const filter = (relation: OperationNode) => {
    const alias = AliasNode.is(relation) ? relation.alias : undefined;
    const table = AliasNode.is(relation) ? relation.node : relation;
    if (!TableNode.is(table)) return;
    const name = table.table.identifier.name;
    if (!ownedTables.has(name)) {
      if (name !== "currencies")
        throw new Error(`Tabla sin alcance contable: ${name}.`);
      return;
    }
    return sql<boolean>`${sql.ref((alias && IdentifierNode.is(alias) ? alias.name : name) + ".user_id")} = ${userId}`.toOperationNode();
  };
  const scoped = new (class extends OperationNodeTransformer {
    protected override transformSelectQuery(node: SelectQueryNode) {
      let query = super.transformSelectQuery(node);
      for (const relation of query.from?.froms ?? []) {
        const owner = filter(relation);
        if (owner)
          query = {
            ...query,
            where: query.where
              ? WhereNode.cloneWithOperation(
                  WhereNode.create(ParensNode.create(query.where.where)),
                  "And",
                  owner,
                )
              : WhereNode.create(owner),
          };
      }
      return query;
    }

    protected override transformJoin(node: JoinNode) {
      const join = super.transformJoin(node);
      const owner = filter(join.table);
      return owner ? JoinNode.cloneWithOn(join, owner) : join;
    }
  })();
  return {
    transformQuery: ({ node }) => scoped.transformNode(node),
    transformResult: async ({ result }) => result,
  };
}
