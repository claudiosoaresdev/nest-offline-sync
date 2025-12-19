# nest-offline-sync

Backend API desenvolvido em **NestJS + TypeScript** com **Prisma + PostgreSQL** para suportar sincronização offline-first de catálogo grande (≈3000 produtos) e criação de pedidos com reprecificação no servidor.

## 📋 Visão Geral

Este backend resolve o desafio de manter um catálogo grande sincronizado com clientes offline, permitindo que pedidos sejam montados localmente e validados/reprecificados no servidor quando a conexão é restaurada. O sistema utiliza:

- **Snapshot + Delta Sync**: versionamento global do catálogo com log de mudanças
- **Reprecificação server-side**: validação de preços e estoque com retorno de diffs
- **Fluxo de confirmação**: pedidos podem requerer confirmação após diffs (`REQUIRES_CONFIRMATION`)
- **Eventos em tempo real**: SSE (Server-Sent Events) com replay automático
- **Idempotência**: proteção contra duplicidade usando header `Idempotency-Key`

## ✨ Principais Features

- ✅ **Sync offline-first do catálogo** com snapshot paginado e delta incremental
- ✅ **Versionamento global** do catálogo (monótono, crescente)
- ✅ **Criação de pedidos offline** com validação e reprecificação no servidor
- ✅ **Diffs de pedido** (preço mudou, item removido, sem estoque)
- ✅ **Fluxo de confirmação** para pedidos com mudanças (`REQUIRES_CONFIRMATION`)
- ✅ **SSE com replay** para eventos do pedido em tempo real
- ✅ **Idempotência** para evitar duplicidade em retries (TTL configurável)
- ✅ **Swagger/OpenAPI** integrado em `/docs`
- ✅ **Validação com Zod** em todos os endpoints
- ✅ **CORS configurado** para aceitar `Idempotency-Key` e `Last-Event-ID`

## 🏗️ Arquitetura

### Módulos

- **`catalog`**: Leitura do catálogo (snapshot, changes, history)
- **`catalog-write`**: Escrita admin do catálogo (upsert, delete) - protegido com `AdminGuard`
- **`orders`**: Criação, validação, confirmação e cancelamento de pedidos
- **`events`**: SSE para eventos do pedido com replay
- **`idempotency`**: Interceptor e service para idempotência via header
- **`notifications`**: Gateway WebSocket (Socket.IO) para notificações
- **`prisma`**: Service e módulo do Prisma Client

### Fluxo de Sincronização do Catálogo

```
Cliente (offline)                    Servidor
     |                                    |
     |--- GET /catalog/snapshot ---------->|
     |                                    | Retorna produtos paginados
     |<-- {currentVersion, items[]} ------|
     |                                    |
     | [Salva no IndexedDB]               |
     |                                    |
     | [Quando volta online]              |
     |--- GET /catalog/changes?sinceVersion=X ->|
     |                                    | Retorna mudanças desde X
     |<-- {currentVersion, changes[]} ---|
     |                                    |
     | [Aplica delta localmente]         |
```

### Fluxo de Pedido Offline + Reprecificação

```
Cliente (offline)                    Servidor
     |                                    |
     | [Monta pedido localmente]          |
     |                                    |
     |--- POST /orders ------------------>|
     |    {items, clientCatalogVersion,   |
     |     Idempotency-Key}               |
     |                                    | Valida produtos
     |                                    | Recalcula preços
     |                                    | Checa estoque
     |<-- {status: REQUIRES_CONFIRMATION, |
     |     diffs: [{type: PRICE_CHANGED}]}|
     |                                    |
     | [Usuário aceita diffs]            |
     |--- POST /orders/:id/confirm ------>|
     |                                    | Revalida preços/estoque
     |                                    | Confirma pedido
     |                                    | Decrementa estoque
     |                                    | Emite ProductChange (delta sync)
     |<-- {status: CONFIRMED} ------------|
```

### Fluxo SSE (Eventos do Pedido)

```
Cliente                              Servidor
     |                                    |
     |--- GET /orders/:id/events (SSE) ->|
     |                                    | [Replay eventos antigos]
     |<-- event: ORDER_CREATED ----------|
     |<-- event: ORDER_VALIDATED --------|
     |                                    | [Stream ao vivo]
     |<-- event: PRICE_CHANGED -----------|
     |<-- event: READY_TO_CONFIRM -------|
```

## 🛠️ Stack

- **Runtime**: Node.js 18+
- **Framework**: NestJS 11
- **Linguagem**: TypeScript 5.7
- **ORM**: Prisma 7
- **Banco de Dados**: PostgreSQL 17
- **Validação**: Zod 4
- **Documentação**: Swagger/OpenAPI (nestjs-zod)
- **WebSockets**: Socket.IO (notifications)
- **SSE**: RxJS Observables

## 🚀 Como Rodar Localmente

### Pré-requisitos

- Node.js 18 ou superior
- npm ou pnpm
- Docker e Docker Compose (opcional, para PostgreSQL)
- PostgreSQL 17+ (se não usar Docker)

### Instalação

```bash
# Clone o repositório
git clone <repo-url>
cd nest-offline-sync

# Instale as dependências
npm install

# Ou com pnpm
pnpm install
```

### Banco de Dados

#### Opção 1: Docker Compose (recomendado)

```bash
# Inicie o PostgreSQL
docker-compose up -d postgres

# Verifique se está rodando
docker-compose ps
```

O PostgreSQL estará disponível em `localhost:5432` com:
- **Usuário**: `postgres` (ou `POSTGRES_USER` do `.env`)
- **Senha**: `postgres` (ou `POSTGRES_PASSWORD` do `.env`)
- **Database**: `offline_sync_db` (ou `POSTGRES_DB` do `.env`)

#### Opção 2: PostgreSQL Local

Configure uma instância PostgreSQL e defina `DATABASE_URL` no `.env`.

### Variáveis de Ambiente

Crie um arquivo `.env` na raiz do projeto:

```env
# Ambiente
NODE_ENV=development

# Servidor
PORT=3333

# Banco de Dados
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/offline_sync_db

# Admin (opcional, para endpoints protegidos)
ADMIN_TOKEN=seu-token-admin-aqui
```

**Variáveis disponíveis** (definidas em `src/config/env.schema.ts`):

| Variável | Tipo | Obrigatória | Padrão | Descrição |
|----------|------|-------------|--------|-----------|
| `NODE_ENV` | `development \| production \| test` | Não | `development` | Ambiente de execução |
| `PORT` | `number` | Não | `3333` | Porta do servidor HTTP |
| `DATABASE_URL` | `string` | **Sim** | - | URL de conexão PostgreSQL (deve começar com `postgresql://`) |
| `ADMIN_TOKEN` | `string` | Não | - | Token para endpoints admin em produção (`/catalog/products/*`). Em dev/test, endpoints são liberados automaticamente |

### Migrations

```bash
# Execute as migrations
npx prisma migrate dev

# Ou com tsx (se configurado)
npx tsx prisma/migrate.ts
```

### Gerar Prisma Client

```bash
# Gera o cliente Prisma em src/generated/prisma
npx prisma generate
```

### Seed (3000 Produtos)

O seed cria 3000 produtos com preços, estoque e registra mudanças no log de versão:

```bash
# Execute o seed
npx tsx --env-file=.env prisma/seed.ts

# Ou via Prisma (se configurado)
npx prisma db seed
```

O seed:
- Limpa produtos existentes (dev only)
- Cria 3000 produtos com dados fake (faker com seed fixo)
- Cria preços (R$ 1,99 a R$ 1.999,99)
- Cria estoque (0 a 200 unidades)
- Emite `ProductChange` (UPSERT) para cada produto
- Atualiza `CatalogState.currentVersion` para o último change

**Saída esperada**:
```
Seed OK ✅ products=3000 currentVersion=3000
```

### Iniciar Servidor de Desenvolvimento

```bash
npm run start:dev
```

O servidor estará disponível em `http://localhost:3333` (ou a porta definida em `PORT`).

**Swagger/OpenAPI** estará disponível em: `http://localhost:3333/docs`

## 📡 Endpoints

### Catálogo

#### `GET /catalog/snapshot`

Primeira carga do catálogo (snapshot completo paginado).

**Query Parameters**:
- `limit` (opcional): Tamanho da página (1..1000). Default: `200`
- `cursor` (opcional): UUID do `Product.id` para paginação cursor-based
- `withTotal` (opcional): Se `true`, inclui `totalItems` na resposta. Default: `false`

**Resposta**:
```json
{
  "currentVersion": 3000,
  "totalItems": 3000,
  "items": [
    {
      "id": "uuid",
      "sku": "SKU-000001",
      "name": "Product Name",
      "description": "...",
      "imageUrl": "https://...",
      "priceCents": 1090,
      "currency": "BRL",
      "stockOnHand": 42
    }
  ],
  "nextCursor": "uuid" // se houver próxima página
}
```

**Exemplo**:
```bash
curl "http://localhost:3333/catalog/snapshot?limit=200"
curl "http://localhost:3333/catalog/snapshot?limit=200&cursor=9a2d1b7f-7d8d-4f87-9f0b-2a0d1e2c3d4f"
```

#### `GET /catalog/changes`

Delta sync: retorna mudanças desde uma versão específica.

**Query Parameters**:
- `sinceVersion` (obrigatório): Versão que o cliente já possui. Retorna mudanças com `version > sinceVersion`
- `limit` (opcional): Máximo de mudanças por página (1..5000). Default: `500`

**Resposta**:
```json
{
  "currentVersion": 1350,
  "changes": [
    {
      "type": "UPSERT",
      "version": 1201,
      "productId": "uuid",
      "product": { /* ProductDto completo */ }
    },
    {
      "type": "DELETE",
      "version": 1202,
      "productId": "uuid"
    }
  ]
}
```

**Exemplo**:
```bash
curl "http://localhost:3333/catalog/changes?sinceVersion=0"
curl "http://localhost:3333/catalog/changes?sinceVersion=1200&limit=500"
```

#### `GET /catalog/history`

Histórico de mudanças com paginação descendente (útil para debug/admin).

**Query Parameters**:
- `sinceVersion` (opcional): Limite inferior. Default: `0`
- `beforeVersion` (opcional): Cursor para paginação DESC (exclusivo)
- `limit` (opcional): Tamanho da página (1..5000). Default: `500`

**Exemplo**:
```bash
curl "http://localhost:3333/catalog/history?limit=1000"
```

### Pedidos

#### `POST /orders`

Cria um pedido com itens montados offline. Valida produtos, recalcula preços e retorna diffs.

**Headers**:
- `Idempotency-Key` (recomendado): Chave única para evitar duplicidade

**Body**:
```json
{
  "clientCatalogVersion": 3000,
  "items": [
    {
      "productId": "uuid",
      "qty": 2,
      "clientPriceCents": 1090
    }
  ],
  "clientRequestId": "optional-client-request-id"
}
```

**Resposta**:
```json
{
  "orderId": "uuid",
  "status": "REQUIRES_CONFIRMATION",
  "totalCents": 2180,
  "currency": "BRL",
  "diffs": [
    {
      "kind": "PRICE_CHANGED",
      "productId": "uuid",
      "clientPriceCents": 1090,
      "serverPriceCents": 1290,
      "message": "Preço mudou desde o offline"
    }
  ],
  "items": [
    {
      "productId": "uuid",
      "qty": 2,
      "clientPriceCents": 1090,
      "serverPriceCents": 1290,
      "productNameSnapshot": "Product Name",
      "productSkuSnapshot": "SKU-000001",
      "productImageSnapshot": "https://..."
    }
  ]
}
```

**Status possíveis**:
- `PENDING_VALIDATION`: Status inicial do pedido (antes da validação)
- `REQUIRES_CONFIRMATION`: Requer confirmação do usuário (há diffs aceitáveis, principalmente mudança de preço)
- `CONFIRMED`: Confirmado pelo usuário via `POST /orders/:id/confirm` (após aceitar diffs)
- `REJECTED`: Rejeitado (produto deletado, sem estoque, etc.)
- `CANCELLED`: Cancelado pelo usuário

**Nota**: Pedidos **não são confirmados automaticamente** mesmo quando não há diffs. Sempre requerem confirmação explícita via `POST /orders/:id/confirm`.

**Exemplo**:
```bash
curl -X POST http://localhost:3333/orders \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-unique-key-123" \
  -d '{
    "clientCatalogVersion": 3000,
    "items": [
      {"productId": "uuid-do-produto", "qty": 2, "clientPriceCents": 1090}
    ]
  }'
```

#### `POST /orders/:id/confirm`

Confirma um pedido após o usuário aceitar os diffs. Revalida preços/estoque antes de confirmar e decrementa o estoque.

**Headers**:
- `Idempotency-Key` (recomendado)

**Body** (opcional):
```json
{
  "expectedTotalCents": 2180 // Opcional: validação de segurança contra UI desatualizada
}
```

**Exemplo**:
```bash
curl -X POST http://localhost:3333/orders/uuid-do-pedido/confirm \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: confirm-key-456" \
  -d '{"expectedTotalCents": 2180}'

# Ou sem body (vazio)
curl -X POST http://localhost:3333/orders/uuid-do-pedido/confirm \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: confirm-key-456" \
  -d '{}'
```

#### `GET /orders/:id`

Retorna o estado atual do pedido com itens e eventos.

**Exemplo**:
```bash
curl http://localhost:3333/orders/uuid-do-pedido
```

#### `GET /orders`

Lista pedidos com paginação.

**Query Parameters**:
- `limit` (opcional): Tamanho da página
- `cursor` (opcional): Cursor para paginação

**Exemplo**:
```bash
curl "http://localhost:3333/orders?limit=20"
```

#### `POST /orders/:id/cancel`

Cancela um pedido.

**Exemplo**:
```bash
curl -X POST http://localhost:3333/orders/uuid-do-pedido/cancel
```

### Eventos (SSE)

#### `GET /orders/:id/events`

Stream de eventos do pedido via Server-Sent Events com replay automático.

**Query Parameters**:
- `since` (opcional): ISO datetime para replay a partir de um instante
- `limit` (opcional): Limite de eventos no replay (1..200)

**Headers**:
- `Last-Event-ID` (opcional): ID do último evento recebido (reconnect automático)

**Resposta**: Stream SSE com eventos:
```
event: ORDER_CREATED
data: {"id":"uuid","type":"ORDER_CREATED","payload":{...}}

event: ORDER_VALIDATED
data: {"id":"uuid","type":"ORDER_VALIDATED","payload":{...}}

event: PRICE_CHANGED
data: {"id":"uuid","type":"PRICE_CHANGED","payload":{...}}
```

**Tipos de eventos** (`OrderEventType`):
- `ORDER_CREATED`: Pedido criado
- `ORDER_VALIDATED`: Validação concluída
- `PRICE_CHANGED`: Preço mudou
- `READY_TO_CONFIRM`: Pronto para confirmação
- `ORDER_CONFIRMED`: Pedido confirmado
- `ORDER_REJECTED`: Pedido rejeitado
- `ORDER_CANCELLED`: Pedido cancelado

**Exemplo** (curl):
```bash
curl -N -H "Accept: text/event-stream" \
  http://localhost:3333/orders/uuid-do-pedido/events
```

**Exemplo** (JavaScript):
```javascript
const eventSource = new EventSource('http://localhost:3333/orders/uuid-do-pedido/events');

eventSource.addEventListener('ORDER_CREATED', (e) => {
  const data = JSON.parse(e.data);
  console.log('Pedido criado:', data);
});

eventSource.addEventListener('PRICE_CHANGED', (e) => {
  const data = JSON.parse(e.data);
  console.log('Preço mudou:', data);
});
```

### Admin (Catálogo Write)

**⚠️ Proteção**: Em **produção**, requer header `x-admin-token` com valor igual a `ADMIN_TOKEN`. Em **desenvolvimento/teste**, o endpoint é liberado automaticamente (sem token).

#### `POST /catalog/products/upsert`

Cria ou atualiza um produto e emite mudança no log de versão.

**Headers**:
- `x-admin-token` (obrigatório em produção, opcional em dev/test)
- `Idempotency-Key` (recomendado)

**Body**:
```json
{
  "sku": "SKU-000001",
  "name": "Produto X",
  "description": "Descrição...",
  "imageUrl": "https://...",
  "priceCents": 12990,
  "currency": "BRL",
  "stockOnHand": 10
}
```

**Exemplo**:
```bash
# Em desenvolvimento (sem token necessário)
curl -X POST http://localhost:3333/catalog/products/upsert \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: upsert-key-789" \
  -d '{
    "sku": "SKU-000001",
    "name": "Produto X",
    "priceCents": 12990,
    "stockOnHand": 10
  }'

# Em produção (com token)
curl -X POST http://localhost:3333/catalog/products/upsert \
  -H "Content-Type: application/json" \
  -H "x-admin-token: seu-token-admin" \
  -H "Idempotency-Key: upsert-key-789" \
  -d '{
    "sku": "SKU-000001",
    "name": "Produto X",
    "priceCents": 12990,
    "stockOnHand": 10
  }'
```

#### `DELETE /catalog/products/:id`

Remove um produto (soft delete) e emite mudança DELETE no log.

**Headers**:
- `x-admin-token` (obrigatório em produção, opcional em dev/test)

**Exemplo**:
```bash
# Em desenvolvimento (sem token necessário)
curl -X DELETE http://localhost:3333/catalog/products/uuid-do-produto

# Em produção (com token)
curl -X DELETE http://localhost:3333/catalog/products/uuid-do-produto \
  -H "x-admin-token: seu-token-admin"
```

## 🔄 SSE (Como Testar)

### Teste Básico com curl

```bash
# Conecte ao stream
curl -N -H "Accept: text/event-stream" \
  http://localhost:3333/orders/uuid-do-pedido/events

# Com replay limitado
curl -N -H "Accept: text/event-stream" \
  "http://localhost:3333/orders/uuid-do-pedido/events?limit=10"

# Com reconnect (Last-Event-ID)
curl -N -H "Accept: text/event-stream" \
  -H "Last-Event-ID: uuid-do-evento" \
  http://localhost:3333/orders/uuid-do-pedido/events
```

### Como Funciona o Replay

1. Ao conectar, o servidor busca eventos antigos do banco (`OrderEvent`)
2. Envia todos os eventos encontrados (replay)
3. Mantém conexão aberta e emite novos eventos em tempo real
4. Se o cliente desconectar e reconectar com `Last-Event-ID`, o replay começa após esse evento

## 🔐 Idempotência (Como Testar)

### Teste Básico

```bash
# Primeira requisição (processa normalmente)
curl -X POST http://localhost:3333/orders \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: test-key-123" \
  -d '{"clientCatalogVersion": 3000, "items": [...]}'

# Segunda requisição com mesma key (retorna resposta cacheada)
curl -X POST http://localhost:3333/orders \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: test-key-123" \
  -d '{"clientCatalogVersion": 3000, "items": [...]}'
```

A segunda requisição retorna a mesma resposta da primeira (mesmo status code e body) sem processar novamente.

### Como Funciona

1. Interceptor (`IdempotencyInterceptor`) captura o header `Idempotency-Key` (case-insensitive)
2. Verifica se a chave já existe no banco (`IdempotencyKey`)
3. Se existe e não expirou:
   - Valida hash do request (evita reuso indevido com payload diferente)
   - Retorna resposta cacheada (`responseBody`, `responseStatus`) sem processar novamente
4. Se não existe: processa request, salva resposta e retorna
5. TTL padrão: 7 dias (definido no código, verifique `src/modules/idempotency/idempotency.service.ts`)

**Validação de hash**: Se a mesma key for usada com payload diferente (método/path/body), retorna `409 Conflict`.

**Nota**: O header é opcional. Se não for enviado, a requisição é processada normalmente sem idempotência.

## 🐛 Troubleshooting

### CORS Preflight e Header `Idempotency-Key`

Se encontrar erro de CORS ao enviar `Idempotency-Key`, verifique:

1. O servidor está configurado para aceitar o header (já está em `main.ts`):
   ```typescript
   allowedHeaders: ['Idempotency-Key', 'idempotency-key', ...]
   ```

2. O cliente está enviando o header corretamente (case-insensitive)

3. Se usar preflight (`OPTIONS`), o servidor deve retornar os headers permitidos

### Seed/Migrate Comuns

**Erro**: "Migration failed"
```bash
# Verifique se o banco está rodando
docker-compose ps

# Verifique a DATABASE_URL
echo $DATABASE_URL

# Force reset (CUIDADO: apaga dados)
npx prisma migrate reset
```

**Erro**: "Prisma Client not generated"
```bash
npx prisma generate
```

**Seed não cria produtos**:
- Verifique logs do seed
- Verifique se `CatalogState` existe (singleton `id="global"`)
- Verifique se há produtos já existentes (seed limpa antes de criar)

### Porta em Uso

```bash
# Linux/Mac: encontre processo na porta 3333
lsof -i :3333

# Mate o processo
kill -9 <PID>

# Ou mude a porta no .env
PORT=3334
```

### Erro de Conexão com Banco

```bash
# Verifique se PostgreSQL está rodando
docker-compose ps

# Verifique logs
docker-compose logs postgres

# Teste conexão manual
psql $DATABASE_URL
```

### Swagger não carrega

- Acesse `http://localhost:3333/docs` (não `/swagger`)
- Verifique se o servidor está rodando
- Verifique console do navegador para erros CORS

## 📝 Scripts Disponíveis

| Script | Descrição |
|--------|-----------|
| `npm run build` | Compila TypeScript para JavaScript |
| `npm run start` | Inicia servidor (produção) |
| `npm run start:dev` | Inicia servidor em modo watch (desenvolvimento) |
| `npm run start:debug` | Inicia servidor em modo debug |
| `npm run start:prod` | Executa build compilado |
| `npm run lint` | Executa ESLint |
| `npm run format` | Formata código com Prettier |
| `npm run test` | Executa testes unitários |
| `npm run test:watch` | Executa testes em modo watch |
| `npm run test:cov` | Executa testes com cobertura |
| `npm run test:e2e` | Executa testes end-to-end |

## 📚 Estrutura do Projeto

```
nest-offline-sync/
├── prisma/
│   ├── schema.prisma          # Schema do Prisma (modelos, enums)
│   ├── migrations/             # Migrations do banco
│   └── seed.ts                 # Seed de 3000 produtos
├── src/
│   ├── app.module.ts           # Módulo raiz
│   ├── main.ts                 # Bootstrap (CORS, Swagger, porta)
│   ├── config/
│   │   └── env.schema.ts       # Schema Zod para variáveis de ambiente
│   ├── common/
│   │   ├── guards/             # Guards (AdminGuard)
│   │   └── pipes/              # Pipes (ZodValidationPipe)
│   ├── generated/
│   │   └── prisma/             # Prisma Client gerado
│   ├── infra/
│   │   └── database/           # PrismaModule e PrismaService
│   └── modules/
│       ├── catalog/             # Leitura do catálogo
│       ├── catalog-write/      # Escrita admin do catálogo
│       ├── orders/             # Pedidos (create, confirm, cancel)
│       ├── events/             # SSE para eventos do pedido
│       ├── idempotency/        # Interceptor e service de idempotência
│       └── notifications/      # Gateway WebSocket (Socket.IO)
├── docker-compose.yml           # PostgreSQL
├── package.json
└── README.md
```

## 🔍 Modelos do Banco (Prisma)

### Catálogo

- **`CatalogState`**: Singleton com `currentVersion` global
- **`Product`**: Produtos (soft delete via `deletedAt`)
- **`ProductPrice`**: Preços (1:1 com Product)
- **`Inventory`**: Estoque (1:1 com Product)
- **`ProductChange`**: Log de mudanças (UPSERT/DELETE) com versionamento

### Pedidos

- **`Order`**: Pedidos com status (`PENDING_VALIDATION`, `REQUIRES_CONFIRMATION`, `CONFIRMED`, `REJECTED`, `CANCELLED`)
- **`OrderItem`**: Itens do pedido (com `clientPriceCents` e `serverPriceCents`)
- **`OrderEvent`**: Eventos do pedido para SSE

### Idempotência

- **`IdempotencyKey`**: Chaves de idempotência com TTL e resposta cacheada

## 🎯 Próximos Passos

- [ ] Adicionar autenticação/autorização de usuários
- [ ] Implementar WebSocket para notificações push (já existe estrutura básica)
- [ ] Adicionar métricas e logging estruturado
- [ ] Implementar rate limiting
- [ ] Adicionar testes E2E completos
- [ ] Configurar TTL de idempotência via variável de ambiente
- [ ] Implementar suporte multi-instância para SSE (Redis PubSub/Kafka)

## 📄 Licença

UNLICENSED (projeto privado)

## 🤝 Contribuição

Este é um projeto interno. Para contribuições, verifique as issues ou entre em contato com a equipe.
