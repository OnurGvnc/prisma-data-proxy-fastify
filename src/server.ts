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

import { Prisma, PrismaClient } from '@prisma/client'
import { enginesVersion } from '@prisma/engines-version'

import { getDMMF } from '@prisma/sdk/dist/engine-commands/getDmmf.js'
import { getSchemaSync } from '@prisma/sdk/dist/cli/getSchema.js'
import LRU from 'lru-cache'

import { highlight } from 'cli-highlight'
import { format as sqlFormat } from 'sql-formatter'

import { camelCase } from './utils'
import { serializeRawResults } from './lib/prisma/serializeRawResult'
import { digAggregateField } from './lib/prisma/digAggregateField'

import { retryMiddleware } from './lib/prisma/middleware/retryMiddleware'
import { logger } from './core/logger'
import { createLRUCacheMiddleware } from './lib/prisma/middleware/createLRUCacheMiddleware'

const __filename = url.fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const LOG = false

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

  db.$use(retryMiddleware())

  if (LOG) {
    db.$use(async (params, next) => {
      const start = Date.now()
      const result = await next(params)
      const end = Date.now()
      const duration = end - start
      // prettier-ignore
      logger.info(` ${duration.toFixed(2).padStart(8, ' ')} ms ${params.model}.${params.action}`)
      return result
    })
  }

  // db.$use(
  //   createLRUCacheMiddleware(
  //     (params) => {
  //       return (
  //         false &&
  //         params.model === 'urun' &&
  //         ['findOne', 'queryRaw', `aggregate`, `findMany`].includes(
  //           params.action,
  //         )
  //       )
  //     },
  //     new LRU<string, any>({
  //       ttl: 500,
  //       maxAge: 1000 * 60 * 60,
  //     }),
  //   ),
  // )

  await db.$connect()
  marky.stop('prisma-connect')

  db.$on('query', (e) => {
    if (LOG) {
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

      logger.info(
        '🟧 onQuery\n' +
          highlight(query, {
            language: 'sql',
            ignoreIllegals: true,
          }) +
          '\n' +
          JSON.parse(e.params ?? '[]') +
          ' ' +
          e.duration +
          'ms',
      )
    }
  })

  let certsDir = path.join(__dirname, '..', 'certs')

  if (
    !fs.existsSync(path.join(certsDir, 'cert-key.pem')) ||
    !fs.existsSync(path.join(certsDir, 'cert.pem'))
  ) {
    logger.error('certs not found!', { certsDir })
    process.exit()
  }

  // FASTIFY INIT
  const app = Fastify({
    https: {
      key: fs.readFileSync(path.join(certsDir, 'cert-key.pem')),
      cert: fs.readFileSync(path.join(certsDir, 'cert.pem')),
    },
    logger: process.env.NODE_ENV == 'development' ? logger : false,
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
          let result = await db[camelCase(model.name)]
            .findUnique({ where: { [idFieldName]: parent[idFieldName] } })
            [field.name](args)

          if (LOG) {
            logger.info(
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

      const modelName = camelCase(model)

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
    // path: '/*',
    // path: '/4.3.0/1652b26cd5d76232b4f6130712465b4d89c28f0a05c9f2007753c76150c738dd/graphql',
    // prettier-ignore
    // @ts-ignore
    path: `/${Prisma.prismaVersion.client}/${Prisma.prismaVersion?.engine ?? enginesVersion}/graphql`,

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
    if (LOG) {
      logger.info(
        '🟦 preParsing\n' +
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
    if (LOG) {
      marky.getEntries().forEach((entry) => {
        app.log.info(
          `⏱  ${entry.duration.toFixed(2).padStart(8, ' ')} ms   ${entry.name}`,
        )
      })
    }
  } catch (err) {
    logger.error(err)
    process.exit(1)
  }
}

main()
