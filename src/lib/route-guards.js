function getId(item) {
  return item?.id ?? item?._id ?? null;
}

function sameId(a, b) {
  return String(a) === String(b);
}

export function validateMainTableRoutePath(tables, mainTableId, routePath) {
  const table = tables.find((item) => sameId(getId(item), mainTableId));
  if (!table) {
    throw new Error(`Unknown table id "${mainTableId}"`);
  }

  const canonicalPath = `/${table.name}`;
  if (routePath !== canonicalPath) {
    throw new Error(
      `mainTableId is only allowed for canonical table route "${canonicalPath}". ` +
      `Omit mainTableId for custom route "${routePath}" and query explicit repos in handlers/hooks.`
    );
  }

  return table;
}
