````md
# Catalog Write (Writer) — Emissão de mudanças para o Delta Sync

Este documento descreve a parte **write** do módulo de catálogo: o **CatalogWriterService** e os endpoints **admin** usados para testar o delta sync “de verdade”.

> Contexto: o frontend mantém um catálogo offline. O delta sync (`GET /catalog/changes`) só funciona se **toda mudança no catálogo** gerar um registro em `ProductChange`.

---

## Por que existe um “Writer”?

No offline sync, o cliente não pode ficar baixando o catálogo inteiro (3000 itens) a cada reconexão. Em vez disso, ele pergunta:

- “O que mudou desde a versão X?”

Isso é possível porque o backend mantém um log de mudanças:

- `ProductChange` com `version` (autoincrement) + `type` (UPSERT/DELETE)

✅ Logo, a regra é simples:

> Qualquer alteração em `Product`, `ProductPrice` ou `Inventory` deve gerar um `ProductChange` e atualizar a versão global (`CatalogState.currentVersion`).

O **CatalogWriterService** centraliza essa regra para evitar “buracos” no delta.

---

## Componentes

### 1) `CatalogWriterService`
Service interno responsável por:

- Executar **transações** de escrita no catálogo
- Emitir `ProductChange` (UPSERT/DELETE)
- Atualizar `CatalogState.currentVersion` de forma **monótona** (sem regredir)

### 2) `AdminCatalogController`
Endpoints simples para testar mudanças:

- `POST /admin/products/upsert`
- `DELETE /admin/products/:id`

> Esses endpoints simulam um “ERP/painel/admin/job” alterando produtos para você validar o delta sync.

### 3) `AdminGuard`
Protege os endpoints admin:

- Em **dev/test**: libera para facilitar testes
- Em **produção**: exige token `x-admin-token` (via ConfigService)

---

## Fluxo do UPSERT (create/update)

### Objetivo
Criar ou atualizar um produto, seu preço e estoque, e emitir um `ProductChange` do tipo `UPSERT`.

### Passos (dentro de uma transação)

1. **Garantir `CatalogState`**
   - Cria `CatalogState(id="global")` caso não exista.

2. **Upsert Product**
   - Se vier `id`, faz upsert por `id`.
   - Senão, se vier `sku`, faz upsert por `sku` (unique).
   - Senão, cria um novo produto.

3. **Upsert ProductPrice (1:1)**
   - Atualiza ou cria preço do produto.

4. **Upsert Inventory (1:1)**
   - Atualiza ou cria estoque do produto.

5. **Criar ProductChange (UPSERT)**
   - Registra a mudança com `version` autoincrement.
   - Payload mínimo (opcional) para debug/replay.

6. **Atualizar CatalogState.currentVersion (monótono)**
   - Atualiza somente se `currentVersion < change.version`.

### Por que atualizar a versão “monótona”?
Em concorrência, duas transações podem commitar fora de ordem:

- Tx B gera version 101 e commita primeiro.
- Tx A gera version 100 e commita depois.

Se você fizer `currentVersion = 100` no final da Tx A, você **regrediria** o catálogo.
Para evitar isso, o writer faz:

- `updateMany where currentVersion < newVersion`

---

## Fluxo do DELETE (tombstone / soft delete)

### Objetivo
Remover um produto do catálogo do cliente, sem apagar o registro do banco.

### Passos (dentro de uma transação)

1. **Garantir `CatalogState`**
2. **Verificar existência**
3. **Soft delete**
   - Atualiza `Product.deletedAt = now()`

4. **Criar ProductChange (DELETE)**
   - Registra no log para o cliente remover localmente.

5. **Atualizar `currentVersion` (monótono)**

> Preferimos soft delete porque:
> - mantém histórico
> - preserva referência com `ProductChange -> Product` (onDelete: Restrict)
> - evita inconsistências em audit/logs

---

## Contratos (Admin)

### `POST /admin/products/upsert`

**Body (exemplo)**
```json
{
  "sku": "SKU-000001",
  "name": "Produto X",
  "description": "Nova descrição",
  "imageUrl": "https://picsum.photos/seed/test/600/600",
  "priceCents": 12990,
  "currency": "BRL",
  "stockOnHand": 10,
  "emitPayload": true
}
````

**Response**

```json
{
  "productId": "9a2d1b7f-7d8d-4f87-9f0b-2a0d1e2c3d4f",
  "changeVersion": 3001,
  "currentVersion": 3001
}
```

### `DELETE /admin/products/:id`

**Request**

```http
DELETE /admin/products/9a2d1b7f-7d8d-4f87-9f0b-2a0d1e2c3d4f
```

**Response**

```json
{
  "productId": "9a2d1b7f-7d8d-4f87-9f0b-2a0d1e2c3d4f",
  "changeVersion": 3002,
  "currentVersion": 3002
}
```

---

## Teste completo do delta sync (com curl)

1. Faça um UPSERT (gera UPSERT change):

```bash
curl -X POST http://localhost:3001/admin/products/upsert \
  -H "Content-Type: application/json" \
  -d '{"sku":"SKU-000001","name":"Produto X","priceCents":12990,"stockOnHand":10}'
```

2. Consulte delta desde a versão 0:

```bash
curl "http://localhost:3001/catalog/changes?sinceVersion=0&limit=10"
```

3. Faça um DELETE (gera DELETE change):

```bash
curl -X DELETE http://localhost:3001/admin/products/<productId-uuid>
```

4. Consulte delta desde a última versão:

```bash
curl "http://localhost:3001/catalog/changes?sinceVersion=<lastVersion>&limit=10"
```

---

## Regras importantes (para manter o delta correto)

* **Nunca** atualize `ProductPrice` / `Inventory` direto em outros pontos do código

  * sempre use o **CatalogWriterService**
* Toda mudança deve:

  * gerar `ProductChange`
  * atualizar `CatalogState.currentVersion`
* Use update monótono para evitar regressão de versão em concorrência
* `DELETE` deve ser tombstone (soft delete), não hard delete

---

## Próximos passos sugeridos

* Adicionar endpoint admin para **bulk update de preços** (simular cenário real)
* Adicionar job/worker para importar do “ERP” e emitir changes em lote
* Adicionar testes e2e garantindo:

  * UPSERT gera change
  * DELETE gera change
  * currentVersion nunca regrede
