import { Prisma } from '@prisma/client'

import { format as sqlFormat } from 'sql-formatter'
import { highlight } from 'cli-highlight'

export function prismaQueryEvent(e: Prisma.QueryEvent) {
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
