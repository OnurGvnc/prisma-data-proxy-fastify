import LRU from 'lru-cache'
import { Prisma } from '@prisma/client'
import { logger } from '../../../core/logger'
import { LOG } from '../../../server'

export function createLRUCacheMiddleware(
  condition: (params: Prisma.MiddlewareParams) => boolean,
  cache: LRU<string, any>,
): Prisma.Middleware<any> {
  return async (params, next) => {
    let result
    if (condition(params)) {
      const args = JSON.stringify(params.args)
      const cacheKey = `${params.model}_${params.action}_${args}`
      result = cache.get(cacheKey)

      if (result === undefined) {
        result = await next(params)
        cache.set(cacheKey, result)
      } else {
        if (LOG) {
          logger.info(`from cache ${cacheKey}`)
        }
      }
    } else {
      result = await next(params)
    }
    return result
  }
}
