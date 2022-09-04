import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

import Fastify, { FastifyRequest } from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifyEnv from '@fastify/env'
import pino from 'pino'
import GracefulServer from '@gquittet/graceful-server'
import marky from 'marky'

import mercurius, { IFieldResolver } from 'mercurius'
import { SelectionNode } from 'graphql'

import { Prisma, PrismaClient } from '@prisma/client'
import { getDMMF } from '@prisma/sdk/dist/engine-commands/getDmmf.js'
import { getSchemaSync } from '@prisma/sdk/dist/cli/getSchema.js'

import { format as sqlFormat } from 'sql-formatter'
import { highlight } from 'cli-highlight'

import Decimal from 'decimal.js'

const __filename = url.fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

marky.mark('ready')
const dotenvSchema = {
  type: 'object',
  required: ['PORT', 'DATA_PROXY_API_KEY', 'NODE_ENV', 'PRISMA_SCHEMA_PATH'],
  properties: {
    PORT: {
      type: 'string',
      default: 3010,
    },
    PRISMA_SCHEMA_PATH: {
      type: 'string',
      default: path.join(__dirname, 'prisma', 'schema.prisma'),
    },
    NODE_ENV: {
      type: 'string',
      default: 'production',
    },
  },
}

const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
    },
  },
})

async function main() {
  // PRISMA INIT
  marky.mark('prisma-connect')
  const db = new PrismaClient(
    process.env.NODE_ENV == 'development'
      ? // prettier-ignore
        {
          log: [ { emit: 'event', level: 'query' }, { emit: 'stdout', level: 'error' }, { emit: 'stdout', level: 'info' }, { emit: 'stdout', level: 'warn' } ],
        }
      : undefined,
  )
  await db.$connect()
  marky.stop('prisma-connect')

  db.$on('query', prismaQueryEvent)

  let certsDir = path.join(__dirname, '..', 'certs')

  if (
    !fs.existsSync(path.join(certsDir, 'cert-key.pem')) ||
    !fs.existsSync(path.join(certsDir, 'cert.pem'))
  ) {
    console.error('certs not found!', { certsDir })
    process.exit()
  }

  // FASTIFY INIT
  const app = Fastify({
    https: {
      key: fs.readFileSync(path.join(certsDir, 'cert-key.pem')),
      cert: fs.readFileSync(path.join(certsDir, 'cert.pem')),
    },
    logger,
  })

  const gracefulServer = GracefulServer(app.server)
  gracefulServer.on(GracefulServer.READY, () => {
    logger.info('Server is ready')
  })

  gracefulServer.on(GracefulServer.SHUTTING_DOWN, () => {
    console.warn('Server is shutting down')
    db.$disconnect()
    app.close()
  })

  gracefulServer.on(GracefulServer.SHUTDOWN, (error) => {
    // console.error('Server is down because of', error.message)
    db.$disconnect()
    app.close()
  })

  // FASTIFY PLUGINS
  app.register(fastifyEnv, {
    schema: dotenvSchema,
    dotenv: {
      path: path.join(__dirname, '.env'),
    },
  })

  app.register(fastifyCors, { origin: '*' })

  // AUTH
  app.addHook(
    'onRequest',
    (
      req: FastifyRequest<{
        Querystring: {
          authkey: string
        }
      }>,
      reply,
      done,
    ) => {
      // support request by @prisma/client/edge
      if (req.method === 'POST')
        req.headers['content-type'] = 'application/json'

      // auth check
      if (
        process.env.NODE_ENV == 'development' &&
        req.url.startsWith('/graphiql')
      ) {
        // noop
      } else {
        const token = req.headers.authorization || (req.query?.authkey ?? '')
        if (
          req.method !== 'OPTIONS' &&
          token != `Bearer ${process.env.DATA_PROXY_API_KEY}`
        ) {
          return reply
            .status(401)
            .send({ success: false, status: 401, message: 'Unauthorized' })
        }
      }

      done()
    },
  )

  // HOME PATH
  app.get('/', async (req, reply) => {
    return {
      success: true,
      message: 'prisma-data-proxy',
      data: {},
    }
  })

  // TYPEDEFS

  marky.mark('dmmf')
  const dmmf = await getDMMF({
    datamodel: getSchemaSync(process.env.PRISMA_SCHEMA_PATH),
  })
  marky.stop('dmmf')

  const getTypeDefs = () => {
    const enums = [
      ...dmmf.schema.enumTypes.prisma,
      ...(dmmf.schema.enumTypes.model ?? []),
    ].map(({ name, values }) => {
      return `
        enum ${name} {
          ${values.join(' ')}
        }
      `
    })

    const types = [
      ...dmmf.schema.outputObjectTypes.prisma,
      ...dmmf.schema.outputObjectTypes.model,
    ].map((m) => {
      return `
        type ${m.name} {
          ${m.fields
            .map((f) => {
              return `${f.name}${
                f.args.length > 0
                  ? `(${f.args.map(({ name }) => `${name}: Any`).join(' ')})`
                  : ''
              }: ${
                f.outputType.isList
                  ? `[${f.outputType.type}]`
                  : `${f.outputType.type}`
              }${f.isNullable ? '' : '!'}`
            })
            .join(' ')}
        }
        `
    })

    return `
      scalar Any
      scalar DateTime
      scalar Json
      ${enums.join('\n')}
      ${types.join('\n')}
    `
  }

  // RESOLVERS
  const getResolvers = () => {
    const resolvers: {
      [k: string]: {
        [k: string]: IFieldResolver<Record<string, unknown>, unknown>
      }
    } = {
      Query: {},
      Mutation: {},
    }

    dmmf.datamodel.models.forEach((model) => {
      resolvers[model.name] = {}
      model.fields.forEach((field) => {
        resolvers[model.name][field.name] = async (
          parent,
          args,
          context,
          info,
        ) => {
          const idFieldName = model.fields.find(({ isId }) => isId)?.name
          if (!idFieldName || !field?.relationName) {
            return parent[field.name]
          }

          if (!args.select) {
            args.select = {}
          }

          ;(info?.fieldNodes?.[0]?.selectionSet?.selections ?? []).forEach(
            (selection) => {
              if (selection.kind === 'Field') {
                args.select[selection.name.value] = true
              }
            },
          )

          // @ts-ignore
          let result = await db[toLowerFirstLetter(model.name)]
            .findUnique({ where: { [idFieldName]: parent[idFieldName] } })
            [field.name](args)

          if (process.env.NODE_ENV == 'development') {
            console.log(
              `🔗 ${model.name}.${field.name}(${JSON.stringify(args)})`,
              result[0],
            )
          }

          return result
        }
      })
    })

    dmmf.mappings.modelOperations.forEach((modelOperation) => {
      const { model, plural } = modelOperation

      // actionOperationMap
      //    https://github.com/prisma/prisma/blob/577d4aa672eea74ba216d36917c5470b75c3e20c/packages/client/src/runtime/getPrismaClient.ts#L280
      const m = {
        // ----------------------
        // query
        aggregate: modelOperation.aggregate!,
        findFirst: modelOperation.findFirst!,
        findMany: modelOperation.findMany!,
        findUnique: modelOperation.findUnique!,
        groupBy: modelOperation.groupBy!,
        // ----------------------
        // mutation
        // @ts-ignore
        createOne: modelOperation?.createOne!,
        createMany: modelOperation.createMany!,
        // @ts-ignore
        deleteOne: modelOperation.deleteOne!,
        deleteMany: modelOperation.deleteMany!,
        // @ts-ignore
        updateOne: modelOperation.updateOne!,
        updateMany: modelOperation.updateMany!,
        // @ts-ignore
        upsertOne: modelOperation.upsertOne!,
      }

      const modelName = toLowerFirstLetter(model)

      resolvers.Query[m.findFirst] = async (root, args, context, info) => {
        // @ts-ignore
        return db[modelName].findFirst(args)
      }

      resolvers.Query[m.findMany] = async (root, args, context, info) => {
        ;(info?.fieldNodes?.[0]?.selectionSet?.selections ?? []).forEach(
          (selection) => {
            if (selection.kind === 'Field') {
              if (!args.select) {
                args.select = {}
              }
              args.select[selection.name.value] = true
            }
          },
        )

        // @ts-ignore
        return db[modelName].findMany(args)
      }

      resolvers.Query[m.findUnique] = async (root, args, context, info) => {
        // @ts-ignore
        return db[modelName].findUnique(args)
      }

      // + db[modelName].count
      resolvers.Query[m.aggregate] = async (root, args, context, info) => {
        const newArgs = {
          ...digAggregateField(
            info.fieldNodes[0].selectionSet?.selections ?? [],
          ),
          ...args,
        }
        // @ts-ignore
        return db[modelName].aggregate(newArgs)
      }

      resolvers.Query[m.groupBy] = async (root, args, context, info) => {
        const newArgs = {
          ...digAggregateField(
            info.fieldNodes[0].selectionSet?.selections ?? [],
          ),
          ...args,
        }
        // @ts-ignore
        return db[modelName].groupBy(newArgs)
      }

      // mutations

      resolvers.Mutation.queryRaw = async (root, args, context, info) => {
        const params = JSON.parse(args.parameters) ?? []
        const result: any[] = await db.$queryRawUnsafe(args.query, ...params)

        return serializeRawResults(result)
      }

      resolvers.Mutation.executeRaw = async (root, args, context, info) => {
        const params = JSON.parse(args.parameters) ?? []
        const result: number = await db.$executeRawUnsafe(args.query, ...params)

        return result
      }

      resolvers.Mutation[m.createOne] = async (root, args, context, info) => {
        // @ts-ignore
        return db[modelName].create(args)
      }

      // prettier-ignore
      resolvers.Mutation[m.createMany] = async (root, args, context, info) => {
          // @ts-ignore
          return db[modelName].createMany(args)
        }

      resolvers.Mutation[m.deleteOne] = async (root, args, context, info) => {
        // @ts-ignore
        return db[modelName].delete(args)
      }

      // prettier-ignore
      resolvers.Mutation[m.deleteMany] = async (root, args, context, info) => {
          // @ts-ignore
          return db[modelName].deleteMany(args)
        }

      resolvers.Mutation[m.updateOne] = async (root, args, context, info) => {
        // @ts-ignore
        return db[modelName].update(args)
      }

      // prettier-ignore
      resolvers.Mutation[m.updateMany] = async (root, args, context, info) => {
          // @ts-ignore
          return db[modelName].updateMany(args)
        }

      // prettier-ignore
      resolvers.Mutation[m.upsertOne] = async (root, args, context, info) => {
          // @ts-ignore
          return db[modelName].upsert(args)
        }
    })

    return resolvers
  }

  marky.mark('schema + resolvers')
  const schema = getTypeDefs()
  const resolvers = getResolvers()
  marky.stop('schema + resolvers')

  marky.mark('mercurius')
  app.register(mercurius, {
    // path: '/4.3.0/1652b26cd5d76232b4f6130712465b4d89c28f0a05c9f2007753c76150c738dd/graphql',
    path: '/*',
    schema,
    resolvers,
    graphiql: true,
    // validationRules: [NoSchemaIntrospectionCustomRule],
    errorFormatter: (execution, context) => {
      // execution.data = { ID: 344 }
      return { statusCode: 400, response: execution }
      // execution.errors = []
      return { statusCode: 200, response: execution }
    },
  })

  await app.ready()
  marky.stop('mercurius')

  // hooks
  //  preParsing | preValidation | preExecution | onResolution
  app.graphql.addHook('preParsing', async function (schema, source, context) {
    if (process.env.NODE_ENV == 'development') {
      logger.info('preParsing')
      console.log(''.padStart(100, '🟦'))
      console.log(
        highlight(source, {
          language: 'json',
          ignoreIllegals: true,
        }),
      )
    }
  })

  const port = parseInt(process.env.PORT + '', 10)
  try {
    app.listen({ port, host: '0.0.0.0' }).catch(console.error)
    app.log.info(
      `🏁 Started on port ${port}  processid:${process.pid} [${process.env.NODE_ENV}]`,
    )
    gracefulServer.setReady()
    marky.stop('ready')
    marky.getEntries().forEach((entry) => {
      app.log.info(
        `⏱  ${entry.duration.toFixed(2).padStart(8, ' ')} ms   ${entry.name}`,
      )
    })
  } catch (err) {
    logger.error(err)
    process.exit(1)
  }
}

main()

// -------------------------------------------------------------------------- //
// digAggregateField
//
// credits:
// - https://github.com/aiji42/prisma-data-proxy-alt/blob/b9d7faea38b21e899903fcc9fa221f0f3d87db7c/src/helpers/makeResolver.ts#L29

interface AggregateField {
  [x: string]: true | AggregateField
}

function digAggregateField(
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

// -------------------------------------------------------------------------- //
// utils
//

function toLowerFirstLetter(str: string) {
  return str.charAt(0).toLowerCase() + str.substring(1)
}

// -------------------------------------------------------------------------- //
// prismaQueryEvent
//

function prismaQueryEvent(e: Prisma.QueryEvent) {
  if (process.env.NODE_ENV == 'development') {
    console.log('')
    console.log(''.padStart(100, '🟧'))

    let query = e.query.replaceAll('"public".', '')

    ;(JSON.parse(e.params ?? '[]') as any[]).forEach((val, index) => {
      if (typeof val == 'string') {
        val = `'${val}'`
      }
      if (typeof val == 'boolean') {
        val = val ? 'true' : 'false'
      }
      query = query.replace(`$${index + 1}`, val)
    })

    query = sqlFormat(query, {
      language: 'postgresql',
      tabWidth: 2,
      keywordCase: 'lower',
      linesBetweenQueries: 2,
      tabulateAlias: true,
    })

    console.log(
      highlight(query, {
        language: 'sql',
        ignoreIllegals: true,
      }),
    )

    console.log('')
    console.log(JSON.parse(e.params ?? '[]'), e.duration + 'ms')

    console.log(''.padStart(100, '🟩'))
  }
}

// -------------------------------------------------------------------------- //
// serializeRawResults
//
// credits:
// - https://github.com/prisma/prisma/blob/main/packages/client/src/runtime/utils/deserializeRawResults.ts
// - https://github.com/prisma/prisma/blob/main/packages/client/src/runtime/utils/serializeRawParameters.ts

// prettier-ignore
type PrismaType = 'int' | 'bigint' | 'float' | 'double' | 'string' | 'enum' | 'bytes' | 'bool' | 'char' | 'decimal' | 'json' | 'xml' | 'uuid' | 'datetime' | 'date' | 'time' | 'array' | 'null'

type TypedValue = {
  prisma__type: PrismaType
  prisma__value: unknown
}

function serializeRawResults(
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
