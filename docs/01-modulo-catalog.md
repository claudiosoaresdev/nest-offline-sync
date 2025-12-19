````md
# Módulo Catalog (Offline Sync)

Este módulo implementa o **catálogo offline-first** do projeto, permitindo:

- **Primeira carga (snapshot)** do catálogo de produtos com paginação
- **Atualização incremental (delta sync)** baseada em versões (`sinceVersion`)
- Contrato validado com **Zod** e documentado no **Swagger** via `nestjs-zod`

---

## Objetivo do fluxo

O frontend precisa manter um catálogo local (ex.: IndexedDB) com ~3000 produtos (nome, imagem, preço, estoque) e conseguir:

1. Baixar o catálogo completo (sem depender de internet constante)
2. Atualizar somente o que mudou (principalmente preço) quando voltar a internet
3. Manter consistência por **versões** para não baixar tudo sempre

---

## Visão geral do modelo (Prisma)

Principais tabelas usadas pelo módulo:

- **`CatalogState`**: guarda o `currentVersion` global do catálogo (`id="global"`)
- **`Product`**: dados do produto (com soft delete via `deletedAt`)
- **`ProductPrice`**: preço 1:1 do produto (em centavos)
- **`Inventory`**: estoque 1:1 do produto
- **`ProductChange`**: log de mudanças (UPSERT/DELETE) com `version` autoincrement

> O cursor do delta sync é o próprio `ProductChange.version`.

---

## Endpoints

### 1) `GET /catalog/snapshot`
**Uso:** primeira carga do app (ou recarga completa).

**Query**
- `limit` (default: 200, max: 1000)
- `cursor` (UUID do Product.id, opcional)

**Response**
- `currentVersion`: versão atual do catálogo no servidor
- `items`: lista de produtos com preço/estoque
- `nextCursor`: se existir, indica que há próxima página

**Exemplos**
```http
GET /catalog/snapshot
GET /catalog/snapshot?limit=200
GET /catalog/snapshot?limit=200&cursor=<productId-uuid>
````

---

### 2) `GET /catalog/changes?sinceVersion=...`

**Uso:** atualização incremental (delta sync).

**Query**

* `sinceVersion` (obrigatório, int >= 0)
* `limit` (default: 500, max: 5000)

**Response**

* `currentVersion`
* `changes`: lista ordenada por `version`, contendo:

  * `UPSERT`: inclui `product` completo
  * `DELETE`: inclui apenas `productId`

**Exemplos**

```http
GET /catalog/changes?sinceVersion=0
GET /catalog/changes?sinceVersion=1200&limit=500
```

---

## Regras de paginação e consistência

### Snapshot: paginação por `Product.id` (UUID)

* Ordenação fixa: `orderBy: { id: 'asc' }`
* Cursor: `Product.id` (único e consistente)
* Técnica: busca `limit + 1` para descobrir se existe próxima página

**Por que `id` e não `updatedAt`?**

* Cursor no Prisma precisa apontar para campo único.
* `updatedAt` não é único (a menos que você crie chave composta).

---

### Changes: paginação por `ProductChange.version` (autoincrement)

* Ordenação fixa: `orderBy: { version: 'asc' }`
* Cursor do cliente: `sinceVersion`
* Retorna até `limit` changes por chamada

---

## Fluxo completo recomendado (cliente)

### Primeira sincronização (instalação / cache vazio)

1. **Snapshot completo (paginado)**

* Chamar `/catalog/snapshot` sem cursor
* Guardar `baseVersion = currentVersion` da **primeira resposta**
* Persistir `items` localmente
* Enquanto `nextCursor` existir:

  * chamar `/catalog/snapshot?cursor=<nextCursor>`
  * persistir `items` localmente

2. **Delta pós-snapshot**

* Depois de finalizar todas as páginas do snapshot, chamar:

  * `/catalog/changes?sinceVersion=<baseVersion>`
* Aplicar `changes` localmente
* Atualizar `lastVersion = currentVersion`

> Essa etapa garante que mudanças ocorridas durante o snapshot não sejam perdidas.

---

### Sincronizações seguintes (app já tem catálogo)

1. Chamar:

* `/catalog/changes?sinceVersion=<lastVersion>`

2. Aplicar changes em ordem:

* `UPSERT`: inserir/atualizar produto local
* `DELETE`: remover produto local (ou marcar deletado)

3. Atualizar:

* `lastVersion = currentVersion`

---

## Como o backend monta o delta (service)

Passos internos do `CatalogService.changes()`:

1. Lê `currentVersion` em `CatalogState`
2. Busca `ProductChange` onde `version > sinceVersion`
3. Separa `productIds` de UPSERT
4. Busca produtos completos (com preço e estoque) somente para UPSERTs
5. Monta `changes`:

   * DELETE → `{ type, version, productId }`
   * UPSERT → `{ type, version, productId, product: ProductDto }`
6. Se UPSERT estiver inconsistente (produto não encontrado ou `deletedAt`), degrada para DELETE

---

## Contratos (Zod)

Os contratos são definidos via Zod schemas:

* `CatalogSnapshotQuerySchema`
* `CatalogSnapshotResponseSchema`
* `CatalogChangesQuerySchema`
* `CatalogChangesResponseSchema`
* `ProductSchema`
* `CatalogChangeSchema` (discriminated union: UPSERT/DELETE)

Benefícios:

* Validação forte no boundary (HTTP)
* Coerção de tipos em query (ex.: `z.coerce.number()`)
* Tipagem automática no TypeScript via `z.infer<>`

---

## Erros comuns e comportamento esperado

* **Cursor inválido no snapshot**:

  * Deve retornar 400 (BadRequest) indicando cursor inválido

* **Cliente já atualizado**:

  * Se `sinceVersion >= currentVersion` → `changes: []`

* **Produto “sumiu” mas change é UPSERT**:

  * Backend degrada para DELETE para o cliente remover localmente

---

## Checklist do módulo (pronto para produção)

* [x] Seed cria `CatalogState` (`id="global"`)
* [x] Seed cria 3000 produtos + changes
* [x] Snapshot paginado por `Product.id`
* [x] Delta paginado por `ProductChange.version`
* [x] Zod valida queries e estrutura de responses
* [x] Swagger documenta as rotas via `nestjs-zod`

---

## Próximos passos do projeto

* Implementar o **writer** do catálogo (UPSERT/DELETE + criação de `ProductChange`)
* Criar fluxo de **Orders** com reprecificação + confirmação
* Adicionar **SSE** com `OrderEvent` (replay + eventos ao vivo)
