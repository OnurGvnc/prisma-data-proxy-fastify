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
    query: "update\n          \"product\"\n        set\n          \"name\" = 'product2!'\n        where\n          \"product\".\"ID\" in ($1,$2)\n      "
    parameters: "[5,6]"
  )
}
```

## findMany

```gql
query {
  findManyProduct(where: { isActive: 1, isDraft: 0, ID: 365 }) {
    ID
    status
    product_ {
      id
      langCode
      name
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
  createOneProduct(data: { name: "PRODUCT!" }) {
    ID
    name
    isActive
  }
}
```

## createMany

```gql
mutation {
  createManyProduct(data: [{ name: "PRODUCT 1" }, { name: "PRODUCT 2" }]) {
    count
  }
}
```

## deleteOne

```gql
mutation {
  deleteOneProduct(where: { ID: 11 }) {
    ID
  }
}
```

## deleteMany

```gql
mutation {
  deleteManyProduct(where: { ID: { in: [8, 9] } }) {
    count
  }
}
```

## updateOne

```gql
mutation {
  updateOneProduct(data: { name: "BLABLA!" }, where: { ID: 5 }) {
    ID
    name
    status
  }
}
```

## updateMany

```gql
mutation {
  updateManyProductn(data: { name: "BLABLA!" }, where: { ID: { in: [5, 6] } }) {
    count
  }
}
```

## upsert

```gql
mutation {
  upsertOneProduct(
    where: { ID: 5 }
    update: { name: "BLA1" }
    create: { name: "BLA2" }
  ) {
    ID
    name
    status
  }
}
```
