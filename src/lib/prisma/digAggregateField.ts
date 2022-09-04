// -------------------------------------------------------------------------- //
// digAggregateField
//
// credits:
// - https://github.com/aiji42/prisma-data-proxy-alt/blob/b9d7faea38b21e899903fcc9fa221f0f3d87db7c/src/helpers/makeResolver.ts#L29

import { SelectionNode } from 'graphql'

export interface AggregateField {
  [x: string]: true | AggregateField
}

export function digAggregateField(
  selections: readonly SelectionNode[],
  isRoot: boolean = true,
): AggregateField {
  return selections.reduce((res, selection) => {
    if (
      'name' in selection &&
      'selectionSet' in selection &&
      !(isRoot && !selection.name.value.startsWith('_'))
    ) {
      const dug = digAggregateField(
        selection.selectionSet?.selections ?? [],
        false,
      )
      return {
        ...res,
        [selection.name.value]: Object.keys(dug).length ? dug : true,
      }
    }
    return res
  }, {})
}
