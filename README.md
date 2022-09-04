# Fastify + Mercurius based Alternative Prisma Data Proxy

credits:
This implementation is inspired by @aiji42's work on [prisma-data-proxy-alt](https://github.com/aiji42/prisma-data-proxy-alt).

<details>
<summary>`gql`s</summary>
## queryRaw

```gql
mutation {
  queryRaw(
    query: "select * from \"product\" where \"ID\"=$1"
    parameters: "[365]"
  )
}
```

## executeRaw

```gql
mutation {
  executeRaw(
    query: "update\n          \"urun\"\n        set\n          \"tmp\" = 'd!'\n        where\n          \"urun\".\"ID\" in ($1,$2)\n      "
    parameters: "[5,6]"
  )
}
```

## findMany

```gql
query {
  findManyProduct(where: { isActive: 1, isDraft: 0, ID: 365 }) {
    ID
    kategoriID
    # isActive
    # status
    # isDraft
    urun_ {
      id
      langCode
      adi
      # detay
      entityID
      createdAt
      updatedAt
    }
  }
}
```

## create

```gql
mutation {
  createOneProduct(data: { tmp: "deneme urunu1662252129727" }) {
    ID
    kategoriID
    isActive
    status
    tmp
  }
}
```

## createMany

```gql
mutation {
  createManyProduct(
    data: [
      { tmp: "deneme urunu1662253233994" }
      { tmp: "deneme urunu #21662253233994" }
    ]
  ) {
    count
  }
}
```

## deleteOne

```gql
mutation {
  deleteOneurun(where: { ID: 11 }) {
    ID
    kategoriID
    isActive
    status
    tmp
  }
}
```

## deleteMany

```gql
mutation {
  deleteManyurun(where: { ID: { in: [8, 9] } }) {
    count
  }
}
```

## updateOne

```gql
mutation {
  updateOneurun(data: { tmp: "heyooo!" }, where: { ID: 5 }) {
    ID
    kategoriID
    isActive
    status
    tmp
  }
}
```

## updateMany

```gql
mutation {
  updateManyurun(data: { tmp: "heyooo!" }, where: { ID: { in: [5, 6] } }) {
    count
  }
}
```

## upsert

```gql
mutation {
  upsertOneurun(
    where: { ID: 5 }
    update: { tmp: "dsadsa6" }
    create: { tmp: "dsadsa5" }
  ) {
    ID
    kategoriID
    isActive
    status
    tmp
  }
}
```

</details>
