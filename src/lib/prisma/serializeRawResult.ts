// -------------------------------------------------------------------------- //
// serializeRawResults
//
// credits:
// - https://github.com/prisma/prisma/blob/main/packages/client/src/runtime/utils/deserializeRawResults.ts
// - https://github.com/prisma/prisma/blob/main/packages/client/src/runtime/utils/serializeRawParameters.ts

import Decimal from 'decimal.js'

// prettier-ignore
type PrismaType = 'int' | 'bigint' | 'float' | 'double' | 'string' | 'enum' | 'bytes' | 'bool' | 'char' | 'decimal' | 'json' | 'xml' | 'uuid' | 'datetime' | 'date' | 'time' | 'array' | 'null'

type TypedValue = {
  prisma__type: PrismaType
  prisma__value: unknown
}

export function serializeRawResults(
  rows: Array<Record<string, PrismaType>>,
): Record<string, TypedValue>[] {
  return rows.map((row) => {
    const mappedRow = {} as Record<string, TypedValue>

    for (const key of Object.keys(row)) {
      mappedRow[key] = serializeValue(row[key])
    }
    return mappedRow
  })
}

function serializeValue(val: PrismaType): TypedValue {
  if (typeof val === 'bigint') {
    return {
      prisma__type: 'bigint',
      prisma__value: (val as bigint).toString(),
    }
  }

  if (isDate(val)) {
    return {
      prisma__type: 'date',
      prisma__value: val.toJSON(),
    }
  }

  if (Decimal.isDecimal(val)) {
    return {
      prisma__type: 'decimal',
      prisma__value: val.toJSON(),
    }
  }

  if (Buffer.isBuffer(val)) {
    return {
      prisma__type: 'bytes',
      prisma__value: val.toString('base64'),
    }
  }

  if (isArrayBufferLike(val) || ArrayBuffer.isView(val)) {
    return {
      prisma__type: 'bytes',
      prisma__value: Buffer.from(val as ArrayBuffer).toString('base64'),
    }
  }

  if (typeof val === 'object' && val !== null) {
    return {
      prisma__type: 'json',
      prisma__value: JSON.stringify(val),
    }
  }

  if (isArrayBufferLike(val) || ArrayBuffer.isView(val)) {
    return {
      prisma__type: 'bytes',
      prisma__value: Buffer.from(val as ArrayBuffer).toString('base64'),
    }
  }

  if (val == null) {
    return {
      prisma__type: 'null',
      prisma__value: null,
    }
  }

  return {
    // @ts-ignore
    prisma__type: typeof val,
    prisma__value: val,
  }
}

function isDate(value: any): value is Date {
  if (value instanceof Date) {
    return true
  }

  // Support dates created in another V8 context
  // Note: dates don't have Symbol.toStringTag defined
  return (
    Object.prototype.toString.call(value) === '[object Date]' &&
    typeof value.toJSON === 'function'
  )
}

function isArrayBufferLike(value: any): value is ArrayBufferLike {
  if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
    return true
  }

  if (typeof value === 'object' && value !== null) {
    return (
      value[Symbol.toStringTag] === 'ArrayBuffer' ||
      value[Symbol.toStringTag] === 'SharedArrayBuffer'
    )
  }

  return false
}
